// One HTTP attempt to xAI, with the result in the spike's CallResult shape (spike/lib/http.ts:19-29) so the
// spike's cost rule (spike/lib/xai-shape.ts xaiCost) applies unchanged. Unlike spike/lib/http.ts call(),
// this never retries by itself: Amendment 1 needs one ledger row and one cap check per attempt (F4, G2),
// and narrows the automatic connection retry to "no connection established" (section 3.3, line 239).
import type { CallResult } from "../../../spike/lib/http.ts";
import { isoNY } from "../../../spike/lib/ledger.ts";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const CLOUD_TIMEOUT_MS = 120_000; // Amendment 1 F3 (T:153)
export const MAX_BODY_BYTES = 25 * 1024 * 1024; // F15

/** Error codes meaning no connection was ever established, so nothing was sent (F2). */
const NO_CONNECTION = new Set([
  "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT",
  "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
  "ERR_TLS_CERT_ALTNAME_INVALID", "ERR_SSL_WRONG_VERSION_NUMBER", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
]);

export interface AttemptResult extends CallResult {
  /** True only when the error proves no connection was made (F2). Timeouts and dropped sockets are false (F3). */
  noConnection: boolean;
  errorCode: string | null;
  oversize: boolean;
}

function errCode(e: unknown): string | null {
  let cur = e as { code?: unknown; cause?: unknown } | undefined;
  for (let i = 0; i < 4 && cur; i++) {
    if (typeof cur.code === "string") return cur.code;
    cur = cur.cause as typeof cur;
  }
  return null;
}

export async function attemptOnce(fetchImpl: FetchLike, spec: { method: "GET" | "POST"; url: string; headers: Record<string, string>; body?: unknown; timeoutMs: number }): Promise<AttemptResult> {
  const startedAt = isoNY();
  const t0 = performance.now();
  try {
    const res = await fetchImpl(spec.url, {
      method: spec.method,
      headers: { ...(spec.body !== undefined ? { "Content-Type": "application/json" } : {}), ...spec.headers },
      body: spec.body !== undefined ? JSON.stringify(spec.body) : undefined,
      signal: AbortSignal.timeout(spec.timeoutMs),
      redirect: "error",
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { if (k !== "set-cookie") headers[k] = v; });
    const oversize = buf.length > MAX_BODY_BYTES;
    const text = oversize ? "" : buf.toString("utf8");
    let json: unknown = null;
    if (!oversize && text) { try { json = JSON.parse(text); } catch { json = null; } }
    const ms = Math.round(performance.now() - t0);
    return {
      outcome: res.status >= 200 && res.status < 300 ? "ok" : "http_error", status: res.status, headers, text, json,
      latency_ms: ms, total_ms: ms, attempts: [{ started_at: startedAt, status: res.status, latency_ms: ms, retry_after: headers["retry-after"] ?? null }],
      retry_decision: "single attempt (retries are decided per attempt by the adapter)", noConnection: false, errorCode: null, oversize,
    };
  } catch (e) {
    const ms = Math.round(performance.now() - t0);
    const name = (e as Error)?.name ?? "Error";
    const timeout = name === "TimeoutError" || name === "AbortError";
    const code = errCode(e);
    const noConnection = !timeout && code !== null && NO_CONNECTION.has(code);
    return {
      outcome: timeout ? "timeout" : "connection_error", status: null, headers: {}, text: "", json: null,
      latency_ms: ms, total_ms: ms, attempts: [{ started_at: startedAt, status: null, latency_ms: ms, error: `${name}${code ? ` (${code})` : ""}` }],
      retry_decision: "single attempt", noConnection, errorCode: code, oversize: false,
    };
  }
}

/** retry-after in seconds (number or HTTP date), or null when absent/unreadable. */
export function parseRetryAfter(v: string | undefined, now = Date.now()): number | null {
  if (v === undefined || v.trim() === "") return null;
  const n = Number(v);
  if (Number.isFinite(n) && n >= 0) return n;
  const d = Date.parse(v);
  return Number.isFinite(d) ? Math.max(0, (d - now) / 1000) : null;
}
