// One HTTP call to a paid provider, following TECH-PLAN-v1.md section 7:
//  - hard timeout 120 s for cloud calls (plan :153)
//  - ONE automatic retry only for connection errors before any response (plan :153)
//  - 429: ONE retry after the provider's retry-after, max 30 s (plan :154). If retry-after is
//    missing or > 30 s the plan is ambiguous, so we do NOT retry and the caller stops (see PLAN-GAPS).
//  - 5xx / 401 / 403 / 402: no retry (a response came back and may have billed); the caller stops.
// Every request/response is dumped with secrets redacted and large base64 payloads elided.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { authHeaders, redactHeaders, scrub, type KeyName } from "./secrets.ts";
import { isoNY } from "./ledger.ts";

export const CLOUD_TIMEOUT_MS = 120_000;
export const MAX_RETRY_AFTER_S = 30;

export type Outcome = "ok" | "http_error" | "timeout" | "connection_error";

export interface CallResult {
  outcome: Outcome;
  status: number | null;
  headers: Record<string, string>;
  text: string;
  json: unknown;
  latency_ms: number; // wall clock of the final attempt, request start -> full body read
  total_ms: number; // including any retry wait
  attempts: Array<{ started_at: string; status: number | null; latency_ms: number; error?: string; retry_after?: string | null }>;
  retry_decision: string;
}

export interface CallSpec {
  keyName: KeyName;
  method: "GET" | "POST" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

async function attempt(spec: CallSpec): Promise<{ status: number | null; headers: Record<string, string>; text: string; ms: number; error?: string; kind?: "timeout" | "connection_error" }> {
  const t0 = performance.now();
  try {
    const res = await fetch(spec.url, {
      method: spec.method,
      headers: { ...(spec.body !== undefined ? { "Content-Type": "application/json" } : {}), ...(spec.headers ?? {}), ...authHeaders(spec.keyName) },
      body: spec.body !== undefined ? JSON.stringify(spec.body) : undefined,
      signal: AbortSignal.timeout(spec.timeoutMs ?? CLOUD_TIMEOUT_MS),
    });
    const text = await res.text();
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    return { status: res.status, headers, text, ms: performance.now() - t0 };
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } };
    const isTimeout = e.name === "TimeoutError" || e.name === "AbortError";
    return { status: null, headers: {}, text: "", ms: performance.now() - t0, error: scrub(`${e.name}: ${e.message}${e.cause?.code ? ` (${e.cause.code})` : ""}`), kind: isTimeout ? "timeout" : "connection_error" };
  }
}

function parseRetryAfter(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  const d = Date.parse(v);
  return Number.isFinite(d) ? Math.max(0, (d - Date.now()) / 1000) : null;
}

export async function call(spec: CallSpec): Promise<CallResult> {
  const attempts: CallResult["attempts"] = [];
  const tStart = performance.now();
  let retryDecision = "no retry needed";
  let a = await attempt(spec);
  attempts.push({ started_at: isoNY(), status: a.status, latency_ms: Math.round(a.ms), error: a.error, retry_after: a.headers["retry-after"] ?? null });

  if (a.kind === "connection_error") {
    retryDecision = "connection error before any response: one automatic retry (plan :153)";
    a = await attempt(spec);
    attempts.push({ started_at: isoNY(), status: a.status, latency_ms: Math.round(a.ms), error: a.error });
  } else if (a.kind === "timeout") {
    retryDecision = "timeout after request was sent: no retry (may have billed; plan :153)";
  } else if (a.status === 429) {
    const ra = parseRetryAfter(a.headers["retry-after"]);
    if (ra !== null && ra <= MAX_RETRY_AFTER_S) {
      retryDecision = `429 with retry-after=${ra}s: one retry after waiting (plan :154)`;
      await new Promise((r) => setTimeout(r, Math.ceil(ra * 1000)));
      a = await attempt(spec);
      attempts.push({ started_at: isoNY(), status: a.status, latency_ms: Math.round(a.ms), error: a.error, retry_after: a.headers["retry-after"] ?? null });
    } else {
      retryDecision = `429 with retry-after=${a.headers["retry-after"] ?? "missing"}: plan :154 does not say what to do; not retrying, caller stops`;
    }
  } else if (a.status !== null && a.status >= 500) {
    retryDecision = `${a.status}: no retry (a response came back and may have billed; plan :153); caller stops`;
  }

  let json: unknown = null;
  try { json = a.text ? JSON.parse(a.text) : null; } catch { json = null; }
  const outcome: Outcome = a.kind ?? (a.status !== null && a.status >= 200 && a.status < 300 ? "ok" : "http_error");
  return { outcome, status: a.status, headers: a.headers, text: a.text, json, latency_ms: Math.round(a.ms), total_ms: Math.round(performance.now() - tStart), attempts, retry_decision: retryDecision };
}

/** Replace long base64 payloads with a short descriptor so dumps stay small and readable. */
export function elideBase64(v: unknown, path = ""): unknown {
  if (typeof v === "string") {
    const m = v.match(/^data:([^;]+);base64,(.*)$/s);
    const raw = m ? m[2] : v;
    if (raw.length > 256 && /^[A-Za-z0-9+/=_\-\r\n]+$/.test(raw)) {
      const bytes = Buffer.from(raw, "base64");
      return `[base64 elided${m ? ` data-URI ${m[1]}` : ""}: ${raw.length} chars, ${bytes.length} bytes, sha256 ${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}…]`;
    }
    return v;
  }
  if (Array.isArray(v)) return v.map((x, i) => elideBase64(x, `${path}[${i}]`));
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = elideBase64(x, `${path}.${k}`);
    return o;
  }
  return v;
}

/** Write a redacted request/response dump. Auth headers are never included in the request copy. */
export function dump(path: string, spec: CallSpec, r: CallResult, extra: Record<string, unknown> = {}): void {
  const reqHeaders = redactHeaders({ ...(spec.body !== undefined ? { "Content-Type": "application/json" } : {}), ...(spec.headers ?? {}), ...(spec.keyName === "XAI_API_KEY" ? { Authorization: "x" } : { "x-goog-api-key": "x" }) });
  const out = {
    ...extra,
    request: { method: spec.method, url: spec.url, headers: reqHeaders, body: elideBase64(spec.body ?? null) },
    response: { outcome: r.outcome, status: r.status, headers: redactHeaders(r.headers), body: r.json !== null ? elideBase64(r.json) : r.text.slice(0, 20000) },
    latency_ms: r.latency_ms, total_ms: r.total_ms, attempts: r.attempts, retry_decision: r.retry_decision,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, scrub(JSON.stringify(out, null, 2)) + "\n");
}
