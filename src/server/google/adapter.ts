// Google (Gemini Interactions API) adapter — Nano Banana 2 (gemini-3.1-flash-image). A2 (Amendment 1 section 4).
// Same shape as the xAI adapter: capabilities (G6/F11) -> free key check (F1) -> per attempt: cap check +
// reservation (G2/F20) -> one HTTP attempt -> cost (item 8: always estimated from usage tokens; Google
// returns no billed figure) -> settle or hold -> map the result.
// Google extras:
// - store:false on every request body (D4 / item 12) and never a previous_interaction_id (item 12).
// - Both error-body shapes are mapped (items 6, 29): newer {error:{code:"..."}} and classic
//   {error:{code:<number>,status:"...",details:[{reason}]}}; anything else falls back to the HTTP status
//   and shows the first 500 characters (scrubbed).
// - Refusal classification (item 23/F9) and the F15 malformed-response rule are the spike's rule from
//   spike/lib/gemini-shape.ts geminiCost, which was built against the recorded live responses in
//   spike-results/gemini/ (request shape: 01-generate-3x4.json; headers incl. Api-Revision there).
// - Raw request/response bodies are never stored or logged (G5); only parsed fields leave this file.
//   The response is stripped on arrival (item 26): id, status, usage token counts and the image bytes only.
import { geminiCostFromUsage, normModality } from "../../../spike/lib/prices.ts";
import { geminiCost, isF9TextOnly, outputImages, outputText, type Interaction } from "../../../spike/lib/gemini-shape.ts";
import type { StepCost } from "../../../spike/lib/step.ts";
import { toMicros } from "../../../spike/lib/ledger.ts";
import { attemptOnce, parseRetryAfter, CLOUD_TIMEOUT_MS, type AttemptResult, type FetchLike } from "../xai/http.ts";
import { CapRefused, markUnresolved, recordLateResult, reserve, RowNotReserved, settle, fmtUsd, type CostSource } from "../ledger.ts";
import { estimate, type PriceRow } from "../prices.ts";
import { resolutionFor, type Switches } from "../config.ts";
import type { KeyStore } from "../keys.ts";
import type { DB } from "../db.ts";
import type { CostInfo, AttemptLog, ErrorCode, KeyCheckCache } from "../xai/adapter.ts";

export const GOOGLE_BASE_URL = "https://generativelanguage.googleapis.com";
export const MODEL = "gemini-3.1-flash-image";
/** FD:11: Nano Banana Pro, its own roster card. Id and price confirmed against
 *  https://ai.google.dev/gemini-api/docs/pricing on 2026-10-09 ($120/1M image tokens; 1120 tokens per 1K/2K image = about $0.134). */
export const PRO_MODEL = "gemini-3-pro-image";
export const MAX_RETRY_AFTER_S = 30; // F4
export const MAX_ATTEMPTS = 3; // F4: at most 3 attempts per user action
/** Fixed request header for the Interactions API (spike/gemini.ts; recorded in spike-results/gemini/*). */
export const API_REVISION = "2026-05-20";

/** capabilities() (item 1, item 27): the app-used subset of the Interactions aspect-ratio enum, with sources.
 *  4:5 is supported directly by Google (no crop; D2's crop note is an xAI-only path). */
export const CAPABILITIES = Object.freeze({
  generate: true, edit: true, mask: false, maxN: 1,
  ratios: Object.freeze(["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"] as const),
  pickerRatios: Object.freeze(["4:5", "1:1", "3:4", "9:16", "16:9", "2:3", "3:2"] as const),
  resolutions: Object.freeze(["1k"] as const), // A2 asks for 1K only (P5 option A)
  maxPromptChars: 64000,
});

export interface GoogleDeps {
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

export type GoogleOutcome =
  | { kind: "ok"; image: Buffer; mime: string | null; note: string | null; clientRequestId: string; providerRequestId: string | null; providerTrace: string | null; cost: CostInfo; latencyMs: number; attempts: AttemptLog[]; modelVersionListing: string | null; sentRatio: string }
  | { kind: "refused"; message: string; clientRequestId: string; providerRequestId: string | null; cost: CostInfo; attempts: AttemptLog[]; sentRatio: string }
  | { kind: "error"; code: ErrorCode; message: string; clientRequestId: string | null; providerRequestId: string | null; cost: CostInfo | null; attempts: AttemptLog[]; sentRatio: string | null };

/** Requested ratio -> what is sent. Anything off the list is refused before any network call (F11, item 1). */
export function mapRatio(requested: string): { send: string } | { error: string } {
  if ((CAPABILITIES.ratios as readonly string[]).includes(requested)) return { send: requested };
  return { error: `Not supported by Nano Banana 2: aspect ratio ${requested}` };
}

function providerDetail(r: AttemptResult, keys: KeyStore): string {
  const j = r.json as { error?: { message?: unknown } } | null;
  const m = j?.error && typeof j.error.message === "string" ? j.error.message : r.text;
  return keys.scrub(m ?? "").slice(0, 500);
}

/** Words that mark a 429 as a quota/billing problem for bodies that are not in either documented shape (item 29 fallback). */
const QUOTA_WORDS_RE = /quota|billing|credit|insufficient|balance|payment/i;

/** "generation blocked" codes (item 6 §3.3): shown verbatim as a refusal, never retried. `no_image` included. */
export const BLOCKED_CODES: ReadonlySet<string> = new Set([
  "safety", "prohibited_content", "blocklist", "spii", "recitation", "language", "content_blocked",
  "image_safety", "image_prohibited_content", "image_recitation", "image_other", "no_image",
]);

export interface GoogleClass { code: ErrorCode; detail: string }

/**
 * Map an error response to an error code (items 6, 29). Handles both shapes in order: the newer
 * {error:{code:<string>}} code list, then the classic {error:{code:<number>,status,details[]}} list; if
 * neither fits (or the body is not JSON) the HTTP status alone decides. The caller picks the message and
 * the ledger outcome; `detail` is the scrubbed provider text for the tile.
 */
export function classifyGoogleError(status: number | null, j: unknown, r: AttemptResult, keys: KeyStore): GoogleClass {
  const detail = providerDetail(r, keys);
  const e = (j && typeof j === "object" ? (j as { error?: unknown }).error : undefined) as { code?: unknown; status?: unknown; details?: unknown } | undefined;
  const ccode = typeof e?.code === "string" ? e.code : null;               // newer shape
  const cstatus = typeof e?.status === "string" ? e.status : null;         // classic shape
  const reasons = Array.isArray(e?.details) ? (e.details as Array<{ reason?: unknown }>).map((d) => (d && typeof d === "object" ? d.reason : undefined)).filter((x): x is string => typeof x === "string") : [];
  const apiKeyInvalid = reasons.includes("API_KEY_INVALID");
  if (ccode) {
    switch (ccode) {
      case "authentication": case "permission_denied": return { code: "auth", detail };
      case "payment_required": case "quota_exceeded": case "failed_precondition": return { code: "quota", detail };
      case "rate_limit_exceeded": case "too_many_requests": return { code: "rate_limit", detail };
      case "invalid_request": case "parameter_unknown": case "out_of_range": case "not_found": case "model_not_found": return { code: "bad_input", detail };
      default: break; // fall through to the status-based mapping
    }
  }
  if (apiKeyInvalid) return { code: "auth", detail };
  if (cstatus === "FAILED_PRECONDITION") return { code: "quota", detail };
  if (cstatus === "INVALID_ARGUMENT") return { code: "bad_input", detail };
  if (cstatus === "RESOURCE_EXHAUSTED") return { code: status === 402 ? "quota" : "rate_limit", detail };
  if (cstatus === "PERMISSION_DENIED" || cstatus === "UNAUTHENTICATED") return { code: "auth", detail };
  if (cstatus === "NOT_FOUND") return { code: "bad_input", detail };
  if (status === null) return { code: "unavailable", detail };
  if (status === 401 || status === 403) return { code: "auth", detail };
  if (status === 402) return { code: "quota", detail };
  if (status === 404 || status === 400 || status === 405 || status === 415) return { code: "bad_input", detail };
  if (status === 429) return { code: QUOTA_WORDS_RE.test(r.text ?? "") ? "quota" : "rate_limit", detail };
  if (status === 499 || status === 504 || status === 408) return { code: "timeout", detail };
  if (status >= 500) return { code: "unavailable", detail };
  return { code: "unavailable", detail };
}

// ---- free key check (F1, item 19) ----

export type GoogleKeyCheckResult = { ok: true; versionListing: string | null } | { ok: false; code: "auth" | "unavailable" | "bad_input" | "no_key"; message: string };

/** Free GET /v1beta/models/<model> before the first paid call; cached per key (F1/F7). */
export async function checkGoogleKey(d: GoogleDeps, opts: { force?: boolean } = {}): Promise<GoogleKeyCheckResult> {
  const r = await checkGoogleKeyInner(d, opts);
  d.keyCheck.message = r.ok ? null : r.message;
  return r;
}

async function checkGoogleKeyInner(d: GoogleDeps, opts: { force?: boolean }): Promise<GoogleKeyCheckResult> {
  const fp = d.keys.fingerprint();
  if (!fp) return { ok: false, code: "no_key", message: "No Google key is set. Add it in Settings." };
  if (!opts.force && d.keyCheck.ok && d.keyCheck.fingerprint === fp) return { ok: true, versionListing: d.keyCheck.versionListing };
  d.keyCheck.ok = false; d.keyCheck.fingerprint = fp; d.keyCheck.versionListing = null;
  const base = d.baseUrl ?? GOOGLE_BASE_URL;
  const t = d.keyCheckTimeoutMs ?? 20_000;
  const a = await attemptOnce(d.fetch, { method: "GET", url: `${base}/v1beta/models/${MODEL}`, headers: d.keys.authHeader(), timeoutMs: t });
  if (a.status === null) return { ok: false, code: "unavailable", message: `Couldn't check the Google key (${a.outcome}${a.errorCode ? `, ${a.errorCode}` : ""}). Nothing was sent.` };
  if (a.status === 400 || a.status === 401 || a.status === 403) return { ok: false, code: "auth", message: "Key rejected. Check the Google key in Settings." };
  if (a.status !== 200 || !a.json || typeof a.json !== "object") return { ok: false, code: "unavailable", message: `Couldn't check the Google key (HTTP ${a.status}). Nothing was sent.` };
  const m = a.json as { name?: unknown; version?: unknown };
  if (typeof m.name === "string" && m.name && !m.name.endsWith(`/${MODEL}`)) return { ok: false, code: "bad_input", message: `Model not available: ${MODEL} is not what this key's model endpoint returns.` };
  const versionListing = [typeof m.name === "string" ? m.name : null, typeof m.version === "string" ? m.version : null].filter((x): x is string => !!x).join(" / ") || null;
  d.keyCheck.ok = true; d.keyCheck.versionListing = versionListing;
  return { ok: true, versionListing };
}

export function invalidateKeyCheck(d: GoogleDeps): void { d.keyCheck.ok = false; }

// ---- cost (item 8: estimated from usage tokens; no billed figure exists for Google) ----

/** Estimated cost of a 5xx/4xx-with-usage response from its token counts; null when unusable. */
function usageCost(j: unknown, imageTokensRequired: boolean, usePro: boolean): { usd: number; detail: string } | null {
  const c = usePro ? proCostFromUsage((j as Interaction | null)?.usage, { imageTokensRequired }) : geminiCostFromUsage((j as Interaction | null)?.usage, { imageTokensRequired });
  return "error" in c ? null : { usd: c.usd, detail: c.detail };
}

/** Pro rates (FD:11; pricing page read 2026-10-09): input $2/1M, text+thinking $12/1M, image output $120/1M.
 *  Same fail-closed validation as spike/lib/prices.ts geminiCostFromUsage (Argus N13), different rates. */
const PRO_RATES = Object.freeze({ inputPerMTok: 2, textThinkingOutputPerMTok: 12, imageOutputPerMTok: 120 });

export function proCostFromUsage(u: unknown, opts: { imageTokensRequired: boolean }): { usd: number; detail: string } | { error: string } {
  if (!u || typeof u !== "object" || Array.isArray(u)) return { error: "no usage block" };
  const g = u as { total_input_tokens?: unknown; total_output_tokens?: unknown; total_thought_tokens?: unknown; output_tokens_by_modality?: unknown };
  const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
  const missing: string[] = [];
  if (!isCount(g.total_input_tokens) || g.total_input_tokens === 0) missing.push("total_input_tokens");
  if (!isCount(g.total_output_tokens) || g.total_output_tokens === 0) missing.push("total_output_tokens");
  if (g.total_thought_tokens !== undefined && !isCount(g.total_thought_tokens)) missing.push("total_thought_tokens (not a count)");
  const mods = g.output_tokens_by_modality;
  if (mods !== undefined && (!Array.isArray(mods) || mods.some((m) => !m || typeof (m as { modality?: unknown }).modality !== "string" || !isCount((m as { tokens?: unknown }).tokens)))) missing.push("output_tokens_by_modality (malformed)");
  const imgOut = Array.isArray(mods) ? mods.filter((m) => typeof (m as { modality?: unknown }).modality === "string" && normModality((m as { modality: string }).modality) === "image" && isCount((m as { tokens?: unknown }).tokens)).reduce((a, m) => a + ((m as { tokens: number }).tokens), 0) : 0;
  if (opts.imageTokensRequired && imgOut === 0) missing.push("output_tokens_by_modality[image]");
  if (missing.length) return { error: `usage block missing/invalid: ${missing.join(", ")}` };
  const input = g.total_input_tokens as number;
  const thought = (g.total_thought_tokens as number | undefined) ?? 0;
  const out = g.total_output_tokens as number;
  if (imgOut > out) return { error: `usage block inconsistent: image tokens ${imgOut} > total_output_tokens ${out}` };
  const textOut = out - imgOut;
  const usd = (input * PRO_RATES.inputPerMTok + (textOut + thought) * PRO_RATES.textThinkingOutputPerMTok + imgOut * PRO_RATES.imageOutputPerMTok) / 1e6;
  return { usd, detail: `input ${input} tok x $2/M + text ${textOut} + thought ${thought} tok x $12/M + image ${imgOut} tok x $120/M` };
}

/** The Pro twin of geminiCost: identical F9/F15/F6 classification, Pro rates. */
function proCost(r: AttemptResult, _estimate: number): StepCost {
  const j = r.json as Interaction | null;
  if (r.status !== null && r.status >= 400 && r.status < 500 && r.status !== 429 && !j?.usage) {
    return { usd: 0, basis: `estimated $0: HTTP ${r.status} error with no usage (Google bills on tokens; none reported)`, billed: false };
  }
  if (r.outcome !== "ok") return { usd: null, basis: `unresolved: ${r.outcome} status=${r.status}; reservation kept`, billed: false };
  const hasImage = outputImages(j).length > 0;
  const f9 = !hasImage && isF9TextOnly(j);
  const rule = hasImage ? "image returned" : f9 ? "F9 text-only reply" : "F15 no image, not text-only";
  const c = proCostFromUsage(j?.usage, { imageTokensRequired: !f9 });
  if ("error" in c) return { usd: null, basis: `unresolved: HTTP ${r.status} (${rule}) but ${c.error}; reservation kept until checked against Google Cloud billing`, billed: false };
  return { usd: c.usd, basis: `estimated from API usage tokens x Pro rates (${rule}): ${c.detail}; Gemini returns no billed-cost field`, billed: false };
}

/**
 * Cost and ledger source of one attempt, in the F-table's terms for Google:
 * - timeout / connection error after send: unresolved (F3), unless the body carried usage (never the case).
 * - non-429 4xx: $0 assumed_zero_rejected (F6/F7/F8; Google bills on tokens and a rejection reports none).
 * - 5xx: settle from usage if present (F5), otherwise unresolved.
 * - 2xx: the spike's geminiCost rule (image / F9 text-only / F15), priced from tokens.
 * - 429 is settled by the caller (F4: $0 assumed_zero_429 unless the body has usage; F8 quota: $0 rejected).
 */
function googleAttemptCost(r: AttemptResult, estMicros: number, usePro: boolean): { usd: number | null; basis: string; source: CostSource | null } {
  if (r.outcome === "timeout" || r.outcome === "connection_error") {
    return { usd: null, basis: `unresolved: ${r.outcome} after send; reservation kept until checked against Google Cloud billing`, source: null };
  }
  const st = r.status;
  if (st !== null && st >= 400 && st < 500 && st !== 429) {
    return { usd: 0, basis: `estimated $0: HTTP ${st} rejection with no usage (F6/F7/F8; Google bills on tokens; none reported); confirm against Google Cloud billing`, source: "assumed_zero_rejected" };
  }
  if (st !== null && st >= 500) {
    const c = usageCost(r.json, false, usePro);
    return c
      ? { usd: c.usd, basis: `estimated from API usage tokens (HTTP ${st} error carried usage, F5): ${c.detail}`, source: "estimated_tokens" }
      : { usd: null, basis: `unresolved: HTTP ${st} with no usage; reservation kept until checked against Google Cloud billing`, source: null };
  }
  const c: StepCost = usePro ? proCost(r, estMicros) : geminiCost(r, estMicros);
  if (c.usd === null) return { usd: null, basis: c.basis, source: null };
  return { usd: c.usd, basis: c.basis, source: "estimated_tokens" };
}

function traceOf(r: AttemptResult): string | null {
  const t: Record<string, string> = {};
  for (const h of ["x-request-id", "traceparent"]) if (r.headers[h]) t[h] = r.headers[h];
  return Object.keys(t).length ? JSON.stringify(t) : null;
}

// ---- generate ----

export async function generate(d: GoogleDeps, req: { prompt: string; ratio: string; generationId: string; model?: string }): Promise<GoogleOutcome> {
  const log = (m: string) => d.log?.(d.keys.scrub(m));
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = d.random ?? Math.random;
  const attempts: AttemptLog[] = [];

  // Capabilities (G6, F11): nothing is sent for an unsupported setting.
  const mapped = mapRatio(req.ratio);
  if ("error" in mapped) return { kind: "error", code: "bad_input", message: mapped.error, clientRequestId: null, providerRequestId: null, cost: null, attempts, sentRatio: null };
  const prompt = req.prompt.trim();
  if (!prompt) return { kind: "error", code: "bad_input", message: "Type a prompt first.", clientRequestId: null, providerRequestId: null, cost: null, attempts, sentRatio: null };
  if (prompt.length > CAPABILITIES.maxPromptChars) return { kind: "error", code: "bad_input", message: `Not supported by Nano Banana 2: prompts over ${CAPABILITIES.maxPromptChars} characters`, clientRequestId: null, providerRequestId: null, cost: null, attempts, sentRatio: null };
  const resolution = resolutionFor(d.switches);
  const model = req.model ?? MODEL; // FD:11: the Pro card passes its own model id
  const usePro = model === PRO_MODEL;

  // Free key check before the first paid call (F1).
  const kc = await checkGoogleKey(d);
  if (!kc.ok) return { kind: "error", code: kc.code, message: kc.message, clientRequestId: null, providerRequestId: null, cost: null, attempts, sentRatio: mapped.send };

  const est = estimate(d.db, d.prices, { provider: "google", model, kind: "generate", resolution, quality: null });
  // item 12/D4: store:false is a constant on every body; the prompt goes out as input; 1K image requested.
  const body: Record<string, unknown> = {
    model,
    input: prompt,
    response_format: { type: "image", aspect_ratio: mapped.send, image_size: "1K" },
    store: false,
  };

  let retries429 = 0, retriedConnection = false;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = reserve(d.db, { provider: "google", model, kind: "generate", resolution, quality: null, generationId: req.generationId, attempt, estimateMicros: est.micros, estimateSource: est.source });
    } catch (e) {
      if (e instanceof CapRefused) {
        log(`google generate gen=${req.generationId} attempt=${attempt} refused by cap before sending`);
        return { kind: "error", code: "cap", message: e.message, clientRequestId: null, providerRequestId: null, cost: null, attempts, sentRatio: mapped.send };
      }
      throw e;
    }
    const id = res.id;
    const r = await attemptOnce(d.fetch, {
      method: "POST", url: `${d.baseUrl ?? GOOGLE_BASE_URL}/v1beta/interactions`,
      headers: { ...d.keys.authHeader(), "Api-Revision": API_REVISION }, body, timeoutMs: d.timeoutMs ?? CLOUD_TIMEOUT_MS,
    });
    const j = r.json as Interaction | null;
    const providerRequestId = j && typeof j === "object" && typeof (j as { id?: unknown }).id === "string" ? (j as { id: string }).id : null;
    const trace = traceOf(r);

    // Argus L1 on f63676e pattern: the row left `reserved` while this call was out (e.g. swept as
    // interrupted). Record the real result as a `late_result` event instead of failing the request.
    const late = (e: unknown, x: { httpStatus: number | null; outcome: string; actualMicros: number | null; costSource: string | null; reason: string; note: string | null }): CostInfo => {
      if (!(e instanceof RowNotReserved)) throw e;
      const now = recordLateResult(d.db, id, { ...x, providerRequestId, providerTrace: trace });
      log(`google generate gen=${req.generationId} ref=${id} attempt=${attempt} late result: row was already ${now.status ?? "missing"}; recorded as a late_result event`);
      return now.status === "settled" ? { micros: now.actualMicros, source: (now.costSource ?? "unresolved") as CostInfo["source"], heldMicros: 0 } : { micros: null, source: "unresolved", heldMicros: now.countedMicros };
    };

    // F2: no connection was ever made -> nothing billed; release at $0 and retry once.
    if (r.noConnection) {
      try {
        settle(d.db, id, { actualMicros: 0, costSource: "not_sent", costDetail: JSON.stringify({ error: r.errorCode }), httpStatus: null, outcome: "no_connection" });
      } catch (e) {
        late(e, { httpStatus: null, outcome: "no_connection", actualMicros: 0, costSource: "not_sent", reason: `no connection (${r.errorCode ?? "unknown"})`, note: null });
      }
      attempts.push({ clientRequestId: id, status: null, outcome: "no_connection", costMicros: 0, costSource: "not_sent" });
      log(`google generate gen=${req.generationId} ref=${id} attempt=${attempt} no connection (${r.errorCode})`);
      if (!retriedConnection && attempt < MAX_ATTEMPTS) { retriedConnection = true; continue; }
      return { kind: "error", code: "unavailable", message: `Couldn't reach Google (${r.errorCode === "ECONNREFUSED" ? "connection refused" : r.errorCode ?? "no connection"}).`, clientRequestId: id, providerRequestId: null, cost: { micros: 0, source: "not_sent", heldMicros: 0 }, attempts, sentRatio: mapped.send };
    }

    const st = r.status;
    const note = st === 429 ? d.keys.scrub(r.text ?? "").slice(0, 500) : null;
    const hold = (reason: string): CostInfo => {
      try {
        markUnresolved(d.db, id, { reason, providerRequestId, providerTrace: trace, httpStatus: st, outcome: r.outcome, note });
      } catch (e) {
        return late(e, { httpStatus: st, outcome: r.outcome, actualMicros: null, costSource: null, reason, note });
      }
      return { micros: null, source: "unresolved", heldMicros: est.micros };
    };
    const settleAt = (usd: number, source: CostSource, basis: string): CostInfo => {
      let micros: number | null = null;
      try {
        const m = toMicros(usd);
        micros = m;
        settle(d.db, id, { actualMicros: m, costSource: source, costDetail: JSON.stringify({ basis, usage: (j?.usage as Record<string, unknown> | undefined) ?? null }), providerRequestId, providerTrace: trace, httpStatus: st, outcome: r.outcome, note });
        return { micros: m, source, heldMicros: 0 };
      } catch (e) {
        if (e instanceof RowNotReserved) return late(e, { httpStatus: st, outcome: r.outcome, actualMicros: micros, costSource: source, reason: basis, note });
        return hold(`unresolved: settling failed (${(e as Error).name}: ${(e as Error).message.slice(0, 200)}); reservation kept`);
      }
    };
    const finish = (costInfo: CostInfo, code: ErrorCode, message: string): GoogleOutcome => {
      attempts.push({ clientRequestId: id, status: st, outcome: r.outcome, costMicros: costInfo.micros, costSource: costInfo.source });
      log(`google generate gen=${req.generationId} ref=${id} attempt=${attempt} outcome=${r.outcome} status=${st} latency=${r.latency_ms}ms cost=${costInfo.micros === null ? `held ${fmtUsd(est.micros)}` : fmtUsd(costInfo.micros)} (${costInfo.source})`);
      return { kind: "error", code, message, clientRequestId: id, providerRequestId, cost: costInfo, attempts, sentRatio: mapped.send };
    };
    const held = fmtUsd(est.micros);

    // Timeout / dropped connection after send (F3): the call may have been billed; hold the reservation.
    if (r.outcome === "timeout") return finish(hold(`unresolved: HTTP timeout after send (F3); ${held} kept until checked against Google Cloud billing`), "timeout", `Google timed out after ${Math.round((d.timeoutMs ?? CLOUD_TIMEOUT_MS) / 1000)} s. It may still have been charged; ${held} is held against your cap until you check.`);
    if (r.outcome === "connection_error") return finish(hold(`unresolved: connection error after send (F3); ${held} kept until checked against Google Cloud billing`), "unavailable", `The connection to Google dropped after the request was sent${r.errorCode ? ` (${r.errorCode})` : ""}. It may still have been charged; ${held} is held against your cap until you check.`);

    // 429: quota (F8: no retry) or rate limit (F4's bounded rule). This attempt's row settles now — one
    // row per attempt (F4/G2); a retried attempt never stays `reserved`. xAI narrows its 429 rows to
    // `unresolved` in A1; for Google the F table settles: $0 `assumed_zero_429`, or from usage when the
    // body has it.
    if (st === 429) {
      const cls = classifyGoogleError(st, j, r, d.keys);
      const c2 = usageCost(j, false, usePro);
      const costInfo = cls.code === "quota"
        ? settleAt(0, "assumed_zero_rejected", `estimated $0: Google quota/billing 429 (F8)${cls.detail ? `: ${cls.detail}` : ""}`)
        : c2 ? settleAt(c2.usd, "estimated_tokens", `estimated from API usage tokens on a 429 (F4): ${c2.detail}`)
             : settleAt(0, "assumed_zero_429", "estimated $0: Google 429 with no usage (F4)");
      if (cls.code === "quota") {
        invalidateKeyCheck(d);
        return finish(costInfo, "quota", "Google prepaid credit is used up or billing is disabled — check Google AI Studio / Cloud Billing.");
      }
      const ra = parseRetryAfter(r.headers["retry-after"]);
      const asked = ra !== null ? ` Google asked to wait ${Math.ceil(ra)} s.` : "";
      let waitMs: number | null = null;
      if (ra !== null) { if (ra <= MAX_RETRY_AFTER_S && retries429 === 0) waitMs = Math.ceil(ra * 1000); }
      else if (retries429 < 2) waitMs = Math.round((retries429 === 0 ? 2000 : 4000) * (0.8 + 0.4 * random()));
      if (waitMs !== null && attempt < MAX_ATTEMPTS) {
        retries429++;
        attempts.push({ clientRequestId: id, status: st, outcome: r.outcome, costMicros: costInfo.micros, costSource: costInfo.source });
        log(`google generate gen=${req.generationId} waiting for rate limit ${waitMs} ms`);
        await sleep(waitMs);
        continue;
      }
      return finish(costInfo, "rate_limit", `Rate limited by Google.${asked} Try again.`);
    }

    const cost = googleAttemptCost(r, est.micros, usePro);

    if (st !== null && st >= 200 && st < 300) {
      // Malformed / oversized 200 (F15): settle from usage if present, otherwise hold. Never priced at the text rate.
      if (r.oversize || j === null || typeof j !== "object") {
        const costInfo = cost.usd === null ? hold(cost.basis) : settleAt(cost.usd, cost.source ?? "estimated_tokens", cost.basis);
        return finish(costInfo, "unavailable", `Google sent a response the app couldn't read (HTTP ${st}).`);
      }
      // Generation blocked (item 6): refused, code shown verbatim; cost settles from usage if present.
      const ecode = j.error && typeof (j.error as { code?: unknown }).code === "string" ? (j.error as { code: string }).code : null;
      if (ecode && BLOCKED_CODES.has(ecode)) {
        const detail = providerDetail(r, d.keys);
        const costInfo = cost.usd === null ? hold(cost.basis) : settleAt(cost.usd, cost.source ?? "estimated_tokens", cost.basis);
        attempts.push({ clientRequestId: id, status: st, outcome: r.outcome, costMicros: costInfo.micros, costSource: costInfo.source });
        return { kind: "refused", message: `Refused by Google (${ecode}).${detail ? ` ${detail}` : ""}`, clientRequestId: id, providerRequestId, cost: costInfo, attempts, sentRatio: mapped.send };
      }
      if (j.status === "failed" || j.status === "cancelled") {
        const costInfo = cost.usd === null ? hold(cost.basis) : settleAt(cost.usd, cost.source ?? "estimated_tokens", cost.basis);
        return j.status === "cancelled"
          ? finish(costInfo, "timeout", `Google cancelled this call. It may still have been charged; ${costInfo.micros === null ? `${held} is held against your cap until you check.` : `settled at ${fmtUsd(costInfo.micros)}.`}`)
          : finish(costInfo, "unavailable", "Google reported the interaction as failed.");
      }
      const images = outputImages(j);
      if (!images.length) {
        const costInfo = cost.usd === null ? hold(cost.basis) : settleAt(cost.usd, cost.source ?? "estimated_tokens", cost.basis);
        if (isF9TextOnly(j)) {
          const text = outputText(j).join(" ").replace(/\s+/g, " ").trim();
          attempts.push({ clientRequestId: id, status: st, outcome: r.outcome, costMicros: costInfo.micros, costSource: costInfo.source });
          return { kind: "refused", message: `Google returned no image: ${d.keys.scrub(text).slice(0, 500) || "(no text)"}`, clientRequestId: id, providerRequestId, cost: costInfo, attempts, sentRatio: mapped.send };
        }
        return finish(costInfo, "unavailable", `Google sent a response the app couldn't read (HTTP ${st}).`);
      }
      const costInfo = cost.usd === null ? hold(cost.basis) : settleAt(cost.usd, cost.source ?? "estimated_tokens", cost.basis);
      attempts.push({ clientRequestId: id, status: st, outcome: r.outcome, costMicros: costInfo.micros, costSource: costInfo.source });
      log(`google generate gen=${req.generationId} ref=${id} attempt=${attempt} outcome=${r.outcome} status=${st} latency=${r.latency_ms}ms cost=${fmtUsd(costInfo.micros ?? 0)} (${costInfo.source})`);
      return {
        kind: "ok",
        image: Buffer.from(images[0].data as string, "base64"),
        mime: typeof images[0].mime_type === "string" ? images[0].mime_type : null,
        note: j.status === "incomplete" ? "Google marked this result incomplete" : null,
        clientRequestId: id, providerRequestId, providerTrace: trace, cost: costInfo,
        latencyMs: r.latency_ms, attempts, modelVersionListing: kc.versionListing, sentRatio: mapped.send,
      };
    }

    // Non-429 4xx / 5xx: classify (both shapes), settle per the F table, invalidate the key check on auth.
    const cls = classifyGoogleError(st, j, r, d.keys);
    const costInfo = cost.usd === null ? hold(cost.basis) : settleAt(cost.usd, cost.source ?? "assumed_zero_rejected", cost.basis);
    if (cls.code === "auth") invalidateKeyCheck(d);
    if (cls.code === "auth") return finish(costInfo, "auth", `Key rejected (HTTP ${st}). Check the Google key in Settings.`);
    if (cls.code === "quota") return finish(costInfo, "quota", "Google prepaid credit is used up or billing is disabled — check Google AI Studio / Cloud Billing.");
    if (cls.code === "bad_input") return finish(costInfo, st === 404 ? "bad_input" : "bad_input", st === 404 ? `Model not available: ${cls.detail}` : `Google rejected the request: ${cls.detail}`);
    if (cls.code === "rate_limit") return finish(costInfo, "rate_limit", `Rate limited by Google. Try again.`);
    if (cls.code === "timeout") return finish(costInfo, "timeout", `Google cancelled the call (HTTP ${st}).`);
    return finish(costInfo, "unavailable", `Google error ${st}. Retry.`);
  }
  // Unreachable: every loop path returns or continues with attempt < MAX_ATTEMPTS.
  throw new Error("google generate: attempt loop ended without a result");
}
