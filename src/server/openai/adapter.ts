// OpenAI (ChatGPT / GPT Image) adapter — gpt-image-1.
// Follows the same attempt loop as xAI and Google: capabilities -> free key check (/v1/models) ->
// per attempt: cap check + reservation -> one HTTP attempt -> settle or hold -> map result.
import { toMicros } from "../../../spike/lib/ledger.ts";
import { parseRetryAfter, CLOUD_TIMEOUT_MS, type FetchLike } from "../xai/http.ts";
import { CapRefused, markUnresolved, recordLateResult, reserve, RowNotReserved, settle, fmtUsd, type CostSource } from "../ledger.ts";
import { estimate, type PriceRow } from "../prices.ts";
import { resolutionFor, type Switches } from "../config.ts";
import { bodyNote, type CostInfo, type AttemptLog, type ErrorCode, type KeyCheckCache } from "../xai/adapter.ts";
import type { KeyStore } from "../keys.ts";
import type { DB } from "../db.ts";

export const OPENAI_BASE_URL = "https://api.openai.com";
export const MODEL = "gpt-image-1";
export const MAX_RETRY_AFTER_S = 30;
export const MAX_ATTEMPTS = 3;

export const CAPABILITIES = Object.freeze({
  generate: true,
  edit: true,
  mask: false,
  maxN: 1,
  maxReferenceImages: 1,
  ratios: Object.freeze(["1:1", "3:4", "4:3", "4:5", "9:16", "16:9", "2:3", "3:2"] as const),
  pickerRatios: Object.freeze(["4:5", "1:1", "3:4", "9:16", "16:9", "2:3", "3:2"] as const),
  resolutions: Object.freeze(["1k"] as const),
  maxPromptChars: 32000,
});

export interface OpenAiDeps {
  readonly kind: "openai";
  db: DB;
  keys: KeyStore;
  prices: readonly PriceRow[];
  switches: Switches;
  fetch: FetchLike;
  baseUrl?: string;
  timeoutMs?: number;
  keyCheckTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  log?: (m: string) => void;
  keyCheck: KeyCheckCache;
}

export type OpenAiOutcome =
  | { kind: "ok"; image: Buffer; mime: string | null; note: string | null; clientRequestId: string; providerRequestId: string | null; providerTrace: string | null; cost: CostInfo; latencyMs: number; attempts: AttemptLog[]; modelVersionListing: string | null; sentRatio: string | null }
  | { kind: "refused"; message: string; clientRequestId: string; providerRequestId: string | null; cost: CostInfo; attempts: AttemptLog[]; sentRatio: string | null }
  | { kind: "error"; code: ErrorCode; message: string; clientRequestId: string | null; providerRequestId: string | null; cost: CostInfo | null; attempts: AttemptLog[]; sentRatio: string | null };

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function mapRatio(requested: string): { size: "1024x1024" | "1024x1536" | "1536x1024"; send: string; crop: [number, number] | null } | { error: string } {
  if (requested === "1:1") return { size: "1024x1024", send: "1:1", crop: null };
  if (requested === "4:5") return { size: "1024x1536", send: "2:3", crop: [4, 5] };
  if (requested === "3:4" || requested === "2:3" || requested === "9:16") return { size: "1024x1536", send: requested, crop: null };
  if (requested === "4:3" || requested === "3:2" || requested === "16:9") return { size: "1536x1024", send: requested, crop: null };
  return { error: `Not supported by ChatGPT (GPT Image): aspect ratio ${requested}` };
}

interface OpenAiHttpResult {
  outcome: "ok" | "http_error" | "timeout" | "connection_error";
  status: number | null;
  headers: Record<string, string>;
  text: string;
  json: unknown;
  latency_ms: number;
}

function providerDetail(r: OpenAiHttpResult, keys: KeyStore): string {
  const j = r.json as { error?: { message?: unknown } } | null;
  const m = j?.error && typeof j.error.message === "string" ? j.error.message : r.text;
  return keys.scrub(m ?? "").slice(0, 500);
}

async function performOpenAiHttp(
  fetchFn: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<OpenAiHttpResult> {
  const t0 = Date.now();
  try {
    const res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const latency_ms = Date.now() - t0;
    const text = await res.text();
    let json: unknown = null;
    try { json = JSON.parse(text); } catch { json = null; }
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    return {
      outcome: res.ok ? "ok" : "http_error",
      status: res.status,
      headers,
      text,
      json,
      latency_ms,
    };
  } catch (e) {
    const latency_ms = Date.now() - t0;
    const err = e as Error & { cause?: { code?: string } };
    const isTimeout = err.name === "TimeoutError" || err.name === "AbortError";
    return {
      outcome: isTimeout ? "timeout" : "connection_error",
      status: null,
      headers: {},
      text: "",
      json: null,
      latency_ms,
    };
  }
}

export async function checkOpenAiKey(d: OpenAiDeps, opts: { force?: boolean } = {}): Promise<{ ok: true; versionListing: string | null } | { ok: false; code: ErrorCode; message: string }> {
  const st = d.keys.status();
  if (!st.set) return { ok: false, code: "no_key", message: "No OpenAI key — add it in Settings." };
  const fp = d.keys.fingerprint();
  if (!opts.force && fp && d.keyCheck.fingerprint === fp && d.keyCheck.ok) {
    return { ok: true, versionListing: d.keyCheck.versionListing };
  }
  const base = d.baseUrl ?? OPENAI_BASE_URL;
  const tms = d.keyCheckTimeoutMs ?? 10_000;
  const r = await performOpenAiHttp(d.fetch, `${base}/v1/models`, { method: "GET", headers: d.keys.authHeader() }, tms);
  if (r.outcome === "ok" && r.status === 200) {
    const listing = MODEL;
    d.keyCheck.fingerprint = fp;
    d.keyCheck.ok = true;
    d.keyCheck.versionListing = listing;
    d.keyCheck.message = null;
    return { ok: true, versionListing: listing };
  }
  const s = r.status;
  const detail = providerDetail(r, d.keys);
  const fail = (code: ErrorCode, message: string) => {
    d.keyCheck.fingerprint = fp;
    d.keyCheck.ok = false;
    d.keyCheck.versionListing = null;
    d.keyCheck.message = message;
    return { ok: false as const, code, message };
  };
  if (s === 401 || s === 403) return fail("auth", `Key rejected (HTTP ${s}). Check the OpenAI key in Settings.`);
  if (s === 429) return fail("rate_limit", `OpenAI key check rate-limited (HTTP 429). Try again shortly.`);
  if (r.outcome === "timeout") return fail("timeout", "OpenAI key check timed out.");
  if (r.outcome === "connection_error") return fail("unavailable", "Could not reach OpenAI to check the key.");
  return fail("unavailable", `OpenAI key check failed (HTTP ${s ?? "error"})${detail ? `: ${detail}` : "."}`);
}

export function invalidateOpenAiKeyCheck(d: OpenAiDeps): void {
  d.keyCheck.fingerprint = null;
  d.keyCheck.ok = false;
}

function estimateFromOpenAiUsage(j: unknown, fallbackMicros: number): { micros: number; source: CostSource; basis: string } {
  const u = (j && typeof j === "object" ? (j as { usage?: unknown }).usage : undefined) as {
    input_tokens?: unknown;
    output_tokens?: unknown;
    input_tokens_details?: { text_tokens?: unknown; image_tokens?: unknown };
  } | undefined;
  if (u && typeof u.input_tokens === "number" && typeof u.output_tokens === "number" && u.output_tokens > 0) {
    const textIn = typeof u.input_tokens_details?.text_tokens === "number" ? u.input_tokens_details.text_tokens : u.input_tokens;
    const imgIn = typeof u.input_tokens_details?.image_tokens === "number" ? u.input_tokens_details.image_tokens : 0;
    // gpt-image-1 rates: $5/1M text input, $10/1M image input, $40/1M image output
    const usd = (textIn * 5 + imgIn * 10 + u.output_tokens * 40) / 1e6;
    if (Number.isFinite(usd) && usd > 0) {
      return { micros: Math.max(1, toMicros(usd)), source: "estimated_tokens", basis: `openai_tokens in=${u.input_tokens} out=${u.output_tokens}` };
    }
  }
  return { micros: fallbackMicros, source: "estimated_price_table", basis: "prices.json fallback" };
}

interface CallPlan {
  kind: "generate" | "edit";
  model: string;
  url: string;
  buildInit: () => RequestInit;
  logTag: string;
  generationId: string;
  sentRatio: string | null;
  estMicros: number;
  estSource: string;
  versionListing: string | null;
}

async function performOpenAiCall(d: OpenAiDeps, plan: CallPlan): Promise<OpenAiOutcome> {
  const sleep = d.sleep ?? realSleep;
  const timeoutMs = d.timeoutMs ?? CLOUD_TIMEOUT_MS;
  const log = d.log ?? (() => {});
  const attempts: AttemptLog[] = [];
  let netRetried = false;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: { id: string; warn: boolean };
    try {
      res = reserve(d.db, {
        provider: "openai",
        model: plan.model,
        kind: plan.kind,
        resolution: resolutionFor(d.switches),
        quality: null,
        generationId: plan.generationId,
        attempt,
        estimateMicros: plan.estMicros,
        estimateSource: plan.estSource,
      });
    } catch (e) {
      if (e instanceof CapRefused) {
        return { kind: "error", code: "cap", message: e.message, clientRequestId: null, providerRequestId: null, cost: null, attempts, sentRatio: plan.sentRatio };
      }
      throw e;
    }
    const id = res.id;

    const r = await performOpenAiHttp(d.fetch, plan.url, plan.buildInit(), timeoutMs);
    const st = r.status;
    const providerRequestId = r.headers["x-request-id"] ?? null;
    const trace = r.headers["x-request-id"] ? JSON.stringify({ "x-request-id": r.headers["x-request-id"] }) : null;
    const note = st === 429 ? bodyNote(r.text, d.keys) : null;

    const settleAt = (micros: number, source: CostSource, basis: string): CostInfo => {
      try {
        settle(d.db, id, {
          actualMicros: micros,
          costSource: source,
          costDetail: JSON.stringify({ basis }),
          providerRequestId,
          providerTrace: trace,
          httpStatus: st,
          outcome: r.outcome,
          note,
        });
      } catch (e) {
        if (!(e instanceof RowNotReserved)) throw e;
        recordLateResult(d.db, id, { httpStatus: st, outcome: r.outcome, providerRequestId, providerTrace: trace, actualMicros: micros, costSource: source, reason: basis, note });
      }
      return { micros, source, heldMicros: 0 };
    };

    const hold = (reason: string): CostInfo => {
      try {
        markUnresolved(d.db, id, { reason, providerRequestId, providerTrace: trace, httpStatus: st, outcome: r.outcome, note });
      } catch (e) {
        if (!(e instanceof RowNotReserved)) throw e;
        recordLateResult(d.db, id, { httpStatus: st, outcome: r.outcome, providerRequestId, providerTrace: trace, actualMicros: null, costSource: null, reason, note });
      }
      return { micros: null, source: "unresolved", heldMicros: plan.estMicros };
    };

    const finish = (costInfo: CostInfo, code: ErrorCode, message: string): OpenAiOutcome => {
      attempts.push({ clientRequestId: id, status: st, outcome: r.outcome, costMicros: costInfo.micros, costSource: costInfo.source });
      log(`${plan.logTag} ref=${id} attempt=${attempt} outcome=${r.outcome} status=${st ?? "none"} latency=${r.latency_ms}ms cost=${costInfo.micros === null ? `held:${fmtUsd(costInfo.heldMicros)}` : fmtUsd(costInfo.micros)}`);
      return { kind: "error", code, message, clientRequestId: id, providerRequestId, cost: costInfo, attempts, sentRatio: plan.sentRatio };
    };

    if (r.outcome === "connection_error") {
      const costInfo = settleAt(0, "not_sent", "connection_error");
      attempts.push({ clientRequestId: id, status: null, outcome: r.outcome, costMicros: 0, costSource: "not_sent" });
      if (!netRetried && attempt < MAX_ATTEMPTS) {
        netRetried = true;
        continue;
      }
      return { kind: "error", code: "unavailable", message: "Could not reach OpenAI (no connection). Nothing was charged.", clientRequestId: id, providerRequestId: null, cost: costInfo, attempts, sentRatio: plan.sentRatio };
    }

    if (r.outcome === "timeout") {
      const costInfo = hold("timeout after send");
      return finish(costInfo, "timeout", `OpenAI timed out after ${Math.round(timeoutMs / 1000)} s (Ref ${id.slice(0, 8)}). Cost is held until you check the OpenAI console.`);
    }

    const j = r.json as {
      data?: Array<{ b64_json?: unknown }>;
      error?: { code?: unknown; message?: unknown; type?: unknown };
    } | null;

    if (st === 200) {
      const b64 = j?.data?.[0]?.b64_json;
      if (typeof b64 === "string" && b64.length > 0) {
        const c = estimateFromOpenAiUsage(j, plan.estMicros);
        const costInfo = settleAt(c.micros, c.source, c.basis);
        attempts.push({ clientRequestId: id, status: st, outcome: r.outcome, costMicros: costInfo.micros, costSource: costInfo.source });
        log(`${plan.logTag} ref=${id} attempt=${attempt} outcome=ok status=200 latency=${r.latency_ms}ms cost=${fmtUsd(costInfo.micros ?? 0)}`);
        return {
          kind: "ok",
          image: Buffer.from(b64, "base64"),
          mime: "image/png",
          note: null,
          clientRequestId: id,
          providerRequestId,
          providerTrace: trace,
          cost: costInfo,
          latencyMs: r.latency_ms,
          attempts,
          modelVersionListing: plan.versionListing,
          sentRatio: plan.sentRatio,
        };
      }
      const costInfo = hold("200 without image data");
      return finish(costInfo, "unavailable", "OpenAI returned 200 without an image.");
    }

    const errCode = typeof j?.error?.code === "string" ? j.error.code : "";
    const detail = providerDetail(r, d.keys);

    if (st === 400 && (errCode === "moderation_blocked" || errCode === "content_policy_violation" || /safety|moderation|policy/i.test(detail))) {
      const costInfo = settleAt(0, "assumed_zero_rejected", errCode || "moderation_blocked");
      attempts.push({ clientRequestId: id, status: st, outcome: "refused", costMicros: 0, costSource: "assumed_zero_rejected" });
      return { kind: "refused", message: `OpenAI blocked this request: ${detail || "content policy"}`, clientRequestId: id, providerRequestId, cost: costInfo, attempts, sentRatio: plan.sentRatio };
    }

    if (st === 401 || st === 403) {
      invalidateOpenAiKeyCheck(d);
      const costInfo = settleAt(0, "assumed_zero_rejected", `http_${st}`);
      return finish(costInfo, "auth", `Key rejected (HTTP ${st}). Check the OpenAI key in Settings.`);
    }

    if (st === 429) {
      const isQuota = errCode === "insufficient_quota" || errCode === "billing_hard_limit_reached" || /quota|billing|credit|insufficient/i.test(detail);
      const costInfo = settleAt(0, "assumed_zero_429", isQuota ? "quota_429" : "rate_limit_429");
      if (isQuota) {
        invalidateOpenAiKeyCheck(d);
        return finish(costInfo, "quota", `OpenAI quota or billing limit reached: ${detail || "check OpenAI Platform billing."}`);
      }
      const ra = parseRetryAfter(r.headers["retry-after"]);
      if (ra !== null && ra > MAX_RETRY_AFTER_S) {
        return finish(costInfo, "rate_limit", `Rate limited by OpenAI. OpenAI asked to wait ${ra} s. Try again.`);
      }
      if (attempt < MAX_ATTEMPTS) {
        attempts.push({ clientRequestId: id, status: st, outcome: r.outcome, costMicros: 0, costSource: "assumed_zero_429" });
        await sleep((ra ? ra * 1000 : 2000 * Math.pow(2, attempt - 1)));
        continue;
      }
      return finish(costInfo, "rate_limit", "Rate limited by OpenAI. Try again in a moment.");
    }

    if (st !== null && st >= 400 && st < 500) {
      const costInfo = settleAt(0, "assumed_zero_rejected", `http_${st}`);
      return finish(costInfo, "bad_input", `OpenAI rejected the request (HTTP ${st}): ${detail}`);
    }

    const costInfo = hold(`http_${st ?? "unknown"}`);
    return finish(costInfo, "unavailable", `OpenAI error ${st ?? "unknown"}. Retry.`);
  }

  throw new Error("openai call: attempt loop ended without a result");
}

export interface OpenAiGenerateReq {
  prompt: string;
  ratio: string;
  generationId: string;
  model?: string;
  reference?: { image: Buffer; mime: string | null } | null;
}

export async function generate(d: OpenAiDeps, req: OpenAiGenerateReq): Promise<OpenAiOutcome> {
  const mapped = mapRatio(req.ratio);
  if ("error" in mapped) return { kind: "error", code: "bad_input", message: mapped.error, clientRequestId: null, providerRequestId: null, cost: null, attempts: [], sentRatio: null };
  const prompt = req.prompt.trim();
  if (!prompt) return { kind: "error", code: "bad_input", message: "Type a prompt first.", clientRequestId: null, providerRequestId: null, cost: null, attempts: [], sentRatio: null };
  if (prompt.length > CAPABILITIES.maxPromptChars) return { kind: "error", code: "bad_input", message: `Prompts over ${CAPABILITIES.maxPromptChars} characters are not supported by ChatGPT (GPT Image).`, clientRequestId: null, providerRequestId: null, cost: null, attempts: [], sentRatio: null };

  // When a reference image is provided, route through the image edit endpoint with the target size.
  if (req.reference) {
    return edit(d, {
      instruction: prompt,
      image: req.reference.image,
      mime: req.reference.mime,
      generationId: req.generationId,
      model: req.model,
      size: mapped.size,
      sentRatio: mapped.send,
    });
  }

  const kc = await checkOpenAiKey(d);
  if (!kc.ok) return { kind: "error", code: kc.code, message: kc.message, clientRequestId: null, providerRequestId: null, cost: null, attempts: [], sentRatio: mapped.send };

  const model = req.model ?? MODEL;
  const est = estimate(d.db, d.prices, { provider: "openai", model, kind: "generate", resolution: resolutionFor(d.switches), quality: null });
  const body = JSON.stringify({
    model,
    prompt,
    n: 1,
    size: mapped.size,
    quality: "medium",
  });

  return performOpenAiCall(d, {
    kind: "generate",
    model,
    url: `${d.baseUrl ?? OPENAI_BASE_URL}/v1/images/generations`,
    buildInit: () => ({
      method: "POST",
      headers: { ...d.keys.authHeader(), "content-type": "application/json" },
      body,
    }),
    logTag: `openai generate gen=${req.generationId}`,
    generationId: req.generationId,
    sentRatio: mapped.send,
    estMicros: est.micros,
    estSource: est.source,
    versionListing: kc.versionListing,
  });
}

export interface OpenAiEditReq {
  instruction: string;
  image: Buffer;
  mime: string | null;
  generationId: string;
  model?: string;
  size?: "1024x1024" | "1024x1536" | "1536x1024";
  sentRatio?: string | null;
}

export async function edit(d: OpenAiDeps, req: OpenAiEditReq): Promise<OpenAiOutcome> {
  const instruction = req.instruction.trim();
  if (!instruction) return { kind: "error", code: "bad_input", message: "Type an instruction first.", clientRequestId: null, providerRequestId: null, cost: null, attempts: [], sentRatio: null };
  if (instruction.length > CAPABILITIES.maxPromptChars) return { kind: "error", code: "bad_input", message: `Instructions over ${CAPABILITIES.maxPromptChars} characters are not supported by ChatGPT (GPT Image).`, clientRequestId: null, providerRequestId: null, cost: null, attempts: [], sentRatio: null };
  if (!req.image || req.image.length === 0) return { kind: "error", code: "bad_input", message: "The source image is missing; nothing was sent.", clientRequestId: null, providerRequestId: null, cost: null, attempts: [], sentRatio: null };

  const kc = await checkOpenAiKey(d);
  if (!kc.ok) return { kind: "error", code: kc.code, message: kc.message, clientRequestId: null, providerRequestId: null, cost: null, attempts: [], sentRatio: null };

  const model = req.model ?? MODEL;
  const est = estimate(d.db, d.prices, { provider: "openai", model, kind: "edit", resolution: resolutionFor(d.switches), quality: null });
  const mime = req.mime ?? "image/jpeg";
  const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";

  return performOpenAiCall(d, {
    kind: "edit",
    model,
    url: `${d.baseUrl ?? OPENAI_BASE_URL}/v1/images/edits`,
    buildInit: () => {
      const form = new FormData();
      form.append("model", model);
      form.append("prompt", instruction);
      form.append("n", "1");
      form.append("quality", "medium");
      if (req.size) form.append("size", req.size);
      form.append("image", new Blob([new Uint8Array(req.image)], { type: mime }), `source.${ext}`);
      return {
        method: "POST",
        headers: d.keys.authHeader(),
        body: form,
      };
    },
    logTag: `openai edit gen=${req.generationId}`,
    generationId: req.generationId,
    sentRatio: req.sentRatio ?? null,
    estMicros: est.micros,
    estSource: est.source,
    versionListing: kc.versionListing,
  });
}
