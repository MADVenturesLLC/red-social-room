// Grok Imagine 2.0 adapter (TECH-PLAN-v1.md:68-74 interface; Amendment 1 sections 3.2/3.3, xAI column).
// generate() and edit() share one attempt loop (performXaiCall): capabilities check (G6/F11) -> free key
// check (F1) -> per attempt: cap check + reservation (G2/F20) -> one HTTP attempt -> cost (spike/lib/
// xai-shape.ts xaiCost, P7 switch) -> settle or hold -> map the result. The real-person check (G7 step 1)
// runs before this, in runs.ts.
// A3: edit() posts to /v1/images/edits with the source image inline as a data URI (spike-results/xai/
// 02-edit-background-red.json: model, prompt, image {type:"image_url", url}, n, response_format; no
// quality field, A1 pin 2). Edits reserve and reconcile at the observed $0.07 (Amendment 1 item 2b).
// Raw request/response bodies are never stored or logged (G5); only parsed fields leave this file.
import { xaiCost } from "../../../spike/lib/xai-shape.ts";
import type { XaiResp } from "../../../spike/lib/xai-shape.ts";
import type { StepCost } from "../../../spike/lib/step.ts";
import { toMicros } from "../../../spike/lib/ledger.ts";
import { attemptOnce, parseRetryAfter, CLOUD_TIMEOUT_MS, type AttemptResult, type FetchLike } from "./http.ts";
import { CapRefused, markUnresolved, recordLateResult, reserve, RowNotReserved, settle, fmtUsd, type CostSource } from "../ledger.ts";
import { estimate, type PriceRow } from "../prices.ts";
import { qualityFor, resolutionFor, type Switches } from "../config.ts";
import type { KeyStore } from "../keys.ts";
import type { DB } from "../db.ts";

export const XAI_BASE_URL = "https://api.x.ai";
export const MODEL = "grok-imagine-image-2.0";
export const MAX_RETRY_AFTER_S = 30; // F4
export const MAX_ATTEMPTS = 3; // F4: at most 3 attempts per user action

/** capabilities() (T:69, Amendment 1 item 1, item 27): hard-coded, with sources. */
export const CAPABILITIES = Object.freeze({
  generate: true, edit: true, mask: false, maxN: 1,
  // A3: editing by description is documented (RESEARCH-models.md:43, POST /v1/images/edits with the source
  // image plus a prompt) and was billed twice in the spike ($0.07, 2 of 2). References for generation:
  // none documented for /v1/images/generations, so a reference request is refused before any network call.
  maxReferenceImages: 0,
  // Official enum, https://api.x.ai/api-docs/openapi.json ImageAspectRatio (Amendment 1 item 1).
  ratios: Object.freeze(["1:1", "3:4", "4:3", "9:16", "16:9", "2:3", "3:2", "9:19.5", "19.5:9", "9:20", "20:9", "1:2", "2:1", "21:9", "5:2", "auto"] as const),
  // Ratios offered in the A1 picker. 4:5 is made as 3:4 then cropped (D2).
  pickerRatios: Object.freeze(["4:5", "1:1", "3:4", "9:16", "16:9", "2:3", "3:2"] as const),
  resolutions: Object.freeze(["1k"] as const), // A1 asks for 1K only (P5 option A)
  maxPromptChars: 64000, // max_prompt_length for grok-imagine-image-2.0, spike-results/preflight/xai-image-generation-models.json
});

export type ErrorCode = "timeout" | "rate_limit" | "quota" | "auth" | "unavailable" | "bad_input" | "cap" | "no_key";

export interface CostInfo { micros: number | null; source: CostSource | "unresolved"; heldMicros: number }
export interface AttemptLog { clientRequestId: string; status: number | null; outcome: string; costMicros: number | null; costSource: string }

export type XaiOutcome =
  | { kind: "ok"; image: Buffer; mime: string | null; clientRequestId: string; providerRequestId: string | null; providerTrace: string | null; cost: CostInfo; latencyMs: number; attempts: AttemptLog[]; modelVersionListing: string | null; sentRatio: string | null }
  | { kind: "refused"; message: string; clientRequestId: string; providerRequestId: string | null; cost: CostInfo; attempts: AttemptLog[]; sentRatio: string | null }
  | { kind: "error"; code: ErrorCode; message: string; clientRequestId: string | null; providerRequestId: string | null; cost: CostInfo | null; attempts: AttemptLog[]; sentRatio: string | null };

export interface KeyCheckCache { fingerprint: string | null; ok: boolean; versionListing: string | null; message?: string | null }

export interface XaiDeps {
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

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Requested ratio -> what is sent. Anything off the list is refused before any network call (F11, item 1). */
export function mapRatio(requested: string): { send: string; crop: [number, number] | null } | { error: string } {
  if (requested === "4:5") return { send: "3:4", crop: [4, 5] }; // D2
  if ((CAPABILITIES.ratios as readonly string[]).includes(requested)) return { send: requested, crop: null };
  return { error: `Not supported by Grok: aspect ratio ${requested}` };
}

function providerText(r: AttemptResult, keys: KeyStore): string {
  const j = r.json as { error?: unknown; message?: unknown } | null;
  let t: string;
  if (j && typeof j.error === "string") t = j.error;
  else if (j && j.error && typeof (j.error as { message?: unknown }).message === "string") t = (j.error as { message: string }).message;
  else if (j && typeof j.message === "string") t = j.message;
  else t = r.text;
  return keys.scrub(t).slice(0, 500);
}

/** Characters of a 429 body kept in the ledger row's note (Surface ruling, room 2026-10-07 11:38 PM ET, A1 pin 15, line 366). */
export const BODY_NOTE_CHARS = 500;

/**
 * The first 500 characters (Unicode code points, never a split surrogate pair) of a provider body, after the key
 * scrubber (known key values, xAI-key-shaped strings, any "Bearer <token>"). Scrubbing runs on the whole body
 * first, so a key straddling the cut is still removed.
 */
export function bodyNote(text: string, keys: KeyStore): string {
  return Array.from(keys.scrub(text ?? "")).slice(0, BODY_NOTE_CHARS).join("");
}

// ---- free key check (F1, item 19) ----

export type KeyCheckResult = { ok: true; versionListing: string | null } | { ok: false; code: "auth" | "unavailable" | "bad_input" | "no_key"; message: string };

export async function checkKey(d: XaiDeps, opts: { force?: boolean } = {}): Promise<KeyCheckResult> {
  const r = await checkKeyInner(d, opts);
  d.keyCheck.message = r.ok ? null : r.message;
  return r;
}

async function checkKeyInner(d: XaiDeps, opts: { force?: boolean }): Promise<KeyCheckResult> {
  const fp = d.keys.fingerprint();
  if (!fp) return { ok: false, code: "no_key", message: "No xAI key is set. Add it in Settings." };
  if (!opts.force && d.keyCheck.ok && d.keyCheck.fingerprint === fp) return { ok: true, versionListing: d.keyCheck.versionListing };
  d.keyCheck.ok = false; d.keyCheck.fingerprint = fp; d.keyCheck.versionListing = null;
  const base = d.baseUrl ?? XAI_BASE_URL;
  const t = d.keyCheckTimeoutMs ?? 20_000;
  const a = await attemptOnce(d.fetch, { method: "GET", url: `${base}/v1/api-key`, headers: d.keys.authHeader(), timeoutMs: t });
  if (a.status === null) return { ok: false, code: "unavailable", message: `Couldn't check the xAI key (${a.outcome}${a.errorCode ? `, ${a.errorCode}` : ""}). Nothing was sent.` };
  if (a.status === 400 || a.status === 401 || a.status === 403) return { ok: false, code: "auth", message: "Key rejected. Check the xAI key in Settings." };
  if (a.status !== 200 || !a.json || typeof a.json !== "object") return { ok: false, code: "unavailable", message: `Couldn't check the xAI key (HTTP ${a.status}). Nothing was sent.` };
  const k = a.json as { api_key_blocked?: unknown; api_key_disabled?: unknown; team_blocked?: unknown };
  if (k.api_key_disabled === true) return { ok: false, code: "auth", message: "Key disabled. Check the xAI key in Settings." };
  if (k.api_key_blocked === true) return { ok: false, code: "auth", message: "Key rejected (blocked by xAI). Check the xAI key in Settings." };
  if (k.team_blocked === true) return { ok: false, code: "auth", message: "Team blocked by xAI. Check console.x.ai." };
  const m = await attemptOnce(d.fetch, { method: "GET", url: `${base}/v1/image-generation-models`, headers: d.keys.authHeader(), timeoutMs: t });
  if (m.status !== 200 || !m.json) return { ok: false, code: m.status === 401 || m.status === 403 ? "auth" : "unavailable", message: m.status === 401 || m.status === 403 ? "Key rejected. Check the xAI key in Settings." : `Couldn't check the xAI model list (${m.status === null ? m.outcome : `HTTP ${m.status}`}). Nothing was sent.` };
  const models = (m.json as { models?: Array<{ id?: unknown; version?: unknown; fingerprint?: unknown }> }).models;
  const entry = Array.isArray(models) ? models.find((x) => x && x.id === MODEL) : undefined;
  if (!entry) return { ok: false, code: "bad_input", message: `Model not available: ${MODEL} is not in this key's model list.` };
  const versionListing = [entry.version, entry.fingerprint].filter((x) => typeof x === "string").join(" / ") || null;
  d.keyCheck.ok = true; d.keyCheck.versionListing = versionListing;
  return { ok: true, versionListing };
}

/** Words that mark an xAI 429 as a quota/billing problem rather than a rate limit (xAI documents no shape).
 *  A1 pin 15, line 366: quota, billing, credit or credits, spending limit, insufficient funds, balance, payment -
 *  each matched on its own and without regard to case. A1 pin 18 (c), line 369 (Amendment 1 at 5c773d7): anywhere in
 *  the body, even inside longer words; "credit(s)" must not be followed by a letter (so credit_limit, credit2 and
 *  "credit limit" match, creditor does not); a space, underscore, hyphen or nothing between the two-word phrases. */
export const QUOTA_429_RE = /quota|billing|credits?(?![a-z])|spending[ _-]?limit|insufficient[ _-]?funds|balance|payment/i;

export function invalidateKeyCheck(d: XaiDeps): void { d.keyCheck.ok = false; }

// ---- cost (spike rule + P7 switch) ----

/** Cost of one attempt. Starts from the spike's xaiCost; adds the F9/F15 rule that a 200 without an image and
 *  without usage is held (not priced from the table), and the P7 alternative when the switch says so. */
/** Largest believable bill for one image call: 1e12 ticks = $100. */
export const MAX_TICKS = 1_000_000_000_000;

/**
 * Argus L2 on fa3d359: usage.cost_in_usd_ticks is used only if it is a safe, non-negative integer no larger than
 * MAX_TICKS. Returns why it is unusable, or null when it is absent or fine.
 */
export function ticksProblem(json: unknown): string | null {
  const u = (json as { usage?: unknown } | null)?.usage;
  if (!u || typeof u !== "object" || !("cost_in_usd_ticks" in u)) return null;
  const t = (u as { cost_in_usd_ticks: unknown }).cost_in_usd_ticks;
  if (typeof t === "number" && Number.isSafeInteger(t) && t >= 0 && t <= MAX_TICKS) return null;
  const shown = typeof t === "number" ? String(t) : (JSON.stringify(t) ?? String(t)).slice(0, 100);
  return `invalid usage.cost_in_usd_ticks: ${shown} (not a whole number of ticks from 0 to ${MAX_TICKS})`;
}

export function attemptCost(r: AttemptResult, estimateMicros: number, hasImage: boolean, s: Switches): StepCost {
  const bad = ticksProblem(r.json);
  if (bad) return { usd: null, basis: `unresolved: ${bad}; reservation kept until console check`, billed: false };
  const base = xaiCost(r, estimateMicros / 1e6);
  if (r.outcome === "ok" && !base.billed && !hasImage) {
    return { usd: null, basis: "unresolved: HTTP 200 with no image and no usage field (Amendment 1 F9/F15); reservation kept", billed: false };
  }
  if (s.xaiRejectionCost === "item16_assumed_zero" && base.usd === null && r.status !== null && [400, 404, 405, 415, 422].includes(r.status)) {
    return { usd: 0, basis: `estimated $0: HTTP ${r.status} rejected request (Amendment 1 item 16, P7 option); confirm against console`, billed: false };
  }
  return base;
}

function costSourceOf(c: StepCost): CostSource {
  if (c.billed) return "billed_provider";
  if (c.usd === 0) return "assumed_zero_rejected";
  return "estimated_price_table";
}

function traceOf(r: AttemptResult): string | null {
  const t: Record<string, string> = {};
  for (const h of ["cf-ray", "traceparent"]) if (r.headers[h]) t[h] = r.headers[h];
  return Object.keys(t).length ? JSON.stringify(t) : null;
}

const STATUS_TEXT: Record<number, string> = { 500: "internal server error", 502: "bad gateway", 503: "service unavailable" };

// ---- the shared attempt loop (A3: generate and edit both run through it) ----

interface XaiCallPlan {
  kind: "generate" | "edit";
  url: string;
  body: Record<string, unknown>;
  /** Log prefix including the generation id, e.g. `xai edit gen=<uuid>`. */
  logTag: string;
  generationId: string;
  sentRatio: string | null;
  estMicros: number;
  estSource: string;
  versionListing: string | null;
}

async function performXaiCall(d: XaiDeps, plan: XaiCallPlan): Promise<XaiOutcome> {
  const log = (m: string) => d.log?.(d.keys.scrub(m));
  const sleep = d.sleep ?? realSleep;
  const random = d.random ?? Math.random;
  const attempts: AttemptLog[] = [];

  let retries429 = 0, retriedConnection = false;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = reserve(d.db, { provider: "xai", model: MODEL, kind: plan.kind, resolution: resolutionFor(d.switches), quality: qualityFor(d.switches, plan.kind).priceQuality, generationId: plan.generationId, attempt, estimateMicros: plan.estMicros, estimateSource: plan.estSource });
    } catch (e) {
      if (e instanceof CapRefused) {
        log(`${plan.logTag} attempt=${attempt} refused by cap before sending`);
        return { kind: "error", code: "cap", message: e.message, clientRequestId: null, providerRequestId: null, cost: null, attempts, sentRatio: plan.sentRatio };
      }
      throw e;
    }
    const id = res.id;
    const r = await attemptOnce(d.fetch, { method: "POST", url: plan.url, headers: d.keys.authHeader(), body: plan.body, timeoutMs: d.timeoutMs ?? CLOUD_TIMEOUT_MS });
    const providerRequestId = r.headers["x-request-id"] ?? null;
    const trace = traceOf(r);
    if (d.switches.xaiDataRetention === "zdr") log(`xai x-zero-data-retention=${r.headers["x-zero-data-retention"] ?? "(absent)"}`);
    if (r.headers["x-ratelimit-remaining-requests"]) log(`xai rate-limit remaining=${r.headers["x-ratelimit-remaining-requests"]} limit=${r.headers["x-ratelimit-limit-requests"] ?? "?"}`);

    // Argus L1 on f63676e: the row left `reserved` while this call was out (e.g. swept as interrupted). Record the
    // real result as a `late_result` event instead of failing the request; the row keeps counting as it stands.
    const late = (e: unknown, x: { httpStatus: number | null; outcome: string; actualMicros: number | null; costSource: string | null; reason: string; note: string | null }): CostInfo => {
      if (!(e instanceof RowNotReserved)) throw e;
      const now = recordLateResult(d.db, id, { ...x, providerRequestId, providerTrace: trace });
      log(`${plan.logTag} ref=${id} attempt=${attempt} late result: row was already ${now.status ?? "missing"}; recorded as a late_result event`);
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
      log(`${plan.logTag} ref=${id} attempt=${attempt} no connection (${r.errorCode})`);
      if (!retriedConnection && attempt < MAX_ATTEMPTS) { retriedConnection = true; continue; }
      return { kind: "error", code: "unavailable", message: `Couldn't reach xAI (${r.errorCode === "ECONNREFUSED" ? "connection refused" : r.errorCode ?? "no connection"}).`, clientRequestId: id, providerRequestId: null, cost: { micros: 0, source: "not_sent", heldMicros: 0 }, attempts, sentRatio: plan.sentRatio };
    }

    // Parse the image (if any) before costing: a 200 without an image is held, not priced (F9/F15).
    const j = r.json as XaiResp | null;
    const first = r.outcome === "ok" && j && Array.isArray(j.data) ? j.data[0] : undefined;
    const b64 = first && typeof first.b64_json === "string" && first.b64_json.length > 0 ? first.b64_json : null;
    let cost: StepCost;
    try { cost = attemptCost(r, plan.estMicros, b64 !== null, d.switches); } catch (e) {
      cost = { usd: null, basis: `unresolved: cost rule threw (${(e as Error).name})`, billed: false };
    }
    // Every 429 (quota-matched or not) keeps its scrubbed body excerpt so the quota word list can be tightened
    // once a real xAI quota body is seen (A1 pin 15, line 366).
    // An unusable tick value (Argus L2) is noted on the row; a 429 row keeps its body excerpt (A1 pin 15, line 366)
    // and the tick problem stays in cost_detail.
    const badTicks = ticksProblem(r.json);
    const note = r.status === 429 ? bodyNote(r.text, d.keys) : badTicks;
    const hold = (reason: string): CostInfo => {
      try {
        markUnresolved(d.db, id, { reason, providerRequestId, providerTrace: trace, httpStatus: r.status, outcome: r.outcome, note });
      } catch (e) {
        return late(e, { httpStatus: r.status, outcome: r.outcome, actualMicros: null, costSource: null, reason, note });
      }
      return { micros: null, source: "unresolved", heldMicros: plan.estMicros };
    };
    let costInfo: CostInfo;
    if (cost.usd === null) costInfo = hold(cost.basis);
    else {
      // A settle that throws (e.g. an amount the ledger refuses) must not leave the row stuck as `reserved`.
      let micros: number | null = null, src: CostSource | null = null;
      try {
        micros = toMicros(cost.usd);
        src = costSourceOf(cost);
        settle(d.db, id, { actualMicros: micros, costSource: src, costDetail: JSON.stringify({ basis: cost.basis, ticks: j?.usage?.cost_in_usd_ticks ?? null }), providerRequestId, providerTrace: trace, httpStatus: r.status, outcome: r.outcome, note });
        costInfo = { micros, source: src, heldMicros: 0 };
      } catch (e) {
        costInfo = e instanceof RowNotReserved
          ? late(e, { httpStatus: r.status, outcome: r.outcome, actualMicros: micros, costSource: src, reason: cost.basis, note })
          : hold(`unresolved: settling failed (${(e as Error).name}: ${(e as Error).message.slice(0, 200)}); reservation kept`);
      }
    }
    attempts.push({ clientRequestId: id, status: r.status, outcome: r.outcome, costMicros: costInfo.micros, costSource: costInfo.source });
    log(`${plan.logTag} ref=${id} attempt=${attempt} outcome=${r.outcome} status=${r.status} latency=${r.latency_ms}ms cost=${costInfo.micros === null ? `held ${fmtUsd(plan.estMicros)}` : fmtUsd(costInfo.micros)} (${costInfo.source})`);
    const held = fmtUsd(plan.estMicros);
    const err = (code: ErrorCode, message: string): XaiOutcome => ({ kind: "error", code, message, clientRequestId: id, providerRequestId, cost: costInfo, attempts, sentRatio: plan.sentRatio });

    if (r.outcome === "timeout") return err("timeout", `Grok timed out after ${Math.round((d.timeoutMs ?? CLOUD_TIMEOUT_MS) / 1000)} s. It may still have been charged; ${held} is held against your cap until you check.`);
    if (r.outcome === "connection_error") return err("unavailable", `The connection to xAI dropped after the request was sent${r.errorCode ? ` (${r.errorCode})` : ""}. It may still have been charged; ${held} is held against your cap until you check.`);

    const st = r.status as number;
    if (st >= 200 && st < 300) {
      if (r.oversize || j === null || typeof j !== "object") return err("unavailable", `xAI sent a response the app couldn't read (HTTP ${st}).`);
      if (b64 === null) return { kind: "refused", message: `Refused by xAI: xAI returned no image.${r.text && !Array.isArray(j.data) ? ` ${providerText(r, d.keys)}` : ""}`, clientRequestId: id, providerRequestId, cost: costInfo, attempts, sentRatio: plan.sentRatio };
      if (first?.respect_moderation === false) return { kind: "refused", message: "Refused by xAI: xAI marked this image as filtered.", clientRequestId: id, providerRequestId, cost: costInfo, attempts, sentRatio: plan.sentRatio };
      const image = Buffer.from(b64, "base64");
      return { kind: "ok", image, mime: typeof first?.mime_type === "string" ? first.mime_type : null, clientRequestId: id, providerRequestId, providerTrace: trace, cost: costInfo, latencyMs: r.latency_ms, attempts, modelVersionListing: plan.versionListing, sentRatio: plan.sentRatio };
    }
    // Amendment 1 item 19 / F8 / A1 pin 10, line 361 / A1 pin 15, line 366: a 429 that is about quota, credits or
    // billing (xAI's shape is UNVERIFIED, so this matches the words in the body, case-insensitively) is a quota
    // error, not a rate limit: no retry, and the key check re-runs before the next paid call.
    if (st === 429 && QUOTA_429_RE.test(r.text ?? "")) { invalidateKeyCheck(d); return err("quota", "xAI quota or billing limit reached (HTTP 429) — check console.x.ai."); }
    if (st === 429) {
      const ra = parseRetryAfter(r.headers["retry-after"]);
      const asked = ra !== null ? ` xAI asked to wait ${Math.ceil(ra)} s.` : "";
      let waitMs: number | null = null;
      if (ra !== null) { if (ra <= MAX_RETRY_AFTER_S && retries429 === 0) waitMs = Math.ceil(ra * 1000); }
      else if (retries429 < 2) waitMs = Math.round((retries429 === 0 ? 2000 : 4000) * (0.8 + 0.4 * random()));
      if (waitMs !== null && attempt < MAX_ATTEMPTS) {
        retries429++;
        log(`${plan.logTag} waiting for rate limit ${waitMs} ms`);
        await sleep(waitMs);
        continue;
      }
      return err("rate_limit", `Rate limited by xAI.${asked} Try again.`);
    }
    if (st === 400) {
      invalidateKeyCheck(d);
      const again = await checkKey(d, { force: true });
      if (!again.ok && again.code === "auth") return err("auth", again.message);
      return err("bad_input", `xAI rejected the request: ${providerText(r, d.keys)}`);
    }
    if (st === 401 || st === 403) { invalidateKeyCheck(d); return err("auth", `Key rejected (HTTP ${st}). Check the xAI key in Settings.`); }
    if (st === 402) { invalidateKeyCheck(d); return err("quota", "xAI credits exhausted — top up in console.x.ai."); }
    if (st === 404) return err("bad_input", `Model not available: ${providerText(r, d.keys)}`);
    if (st === 405 || st === 415 || st === 422) return err("bad_input", `xAI rejected the request: ${providerText(r, d.keys)}`);
    if (st === 500 || st === 502 || st === 503) return err("unavailable", `xAI error ${st} (${STATUS_TEXT[st]}). Retry.`);
    return err("unavailable", `xAI returned HTTP ${st}: ${providerText(r, d.keys)}`);
  }
  // Unreachable: every loop path returns or continues with attempt < MAX_ATTEMPTS.
  throw new Error("xai call: attempt loop ended without a result");
}

// ---- generate ----

export async function generate(d: XaiDeps, req: { prompt: string; ratio: string; generationId: string }): Promise<XaiOutcome> {
  // Capabilities (G6, F11): nothing is sent for an unsupported setting.
  const mapped = mapRatio(req.ratio);
  if ("error" in mapped) return { kind: "error", code: "bad_input", message: mapped.error, clientRequestId: null, providerRequestId: null, cost: null, attempts: [], sentRatio: null };
  const prompt = req.prompt.trim();
  if (!prompt) return { kind: "error", code: "bad_input", message: "Type a prompt first.", clientRequestId: null, providerRequestId: null, cost: null, attempts: [], sentRatio: null };
  if (prompt.length > CAPABILITIES.maxPromptChars) return { kind: "error", code: "bad_input", message: `Not supported by Grok: prompts over ${CAPABILITIES.maxPromptChars} characters`, clientRequestId: null, providerRequestId: null, cost: null, attempts: [], sentRatio: null };

  // Reference images: none documented for xAI generation (capabilities). Refused before any network call.
  if ((req as { reference?: unknown }).reference) return { kind: "error", code: "bad_input", message: "Not supported by Grok: reference images. Try the Google cards, or use Edit.", clientRequestId: null, providerRequestId: null, cost: null, attempts: [], sentRatio: null };

  // Free key check before the first paid call (F1).
  const kc = await checkKey(d);
  if (!kc.ok) return { kind: "error", code: kc.code, message: kc.message, clientRequestId: null, providerRequestId: null, cost: null, attempts: [], sentRatio: mapped.send };

  const est = estimate(d.db, d.prices, { provider: "xai", model: MODEL, kind: "generate", resolution: resolutionFor(d.switches), quality: qualityFor(d.switches, "generate").priceQuality });
  const q = qualityFor(d.switches, "generate");
  const body: Record<string, unknown> = { model: MODEL, prompt, n: 1, aspect_ratio: mapped.send, resolution: resolutionFor(d.switches), response_format: "b64_json" };
  if (q.send) body.quality = q.priceQuality;

  return performXaiCall(d, {
    kind: "generate",
    url: `${d.baseUrl ?? XAI_BASE_URL}/v1/images/generations`,
    body,
    logTag: `xai generate gen=${req.generationId}`,
    generationId: req.generationId,
    sentRatio: mapped.send,
    estMicros: est.micros,
    estSource: est.source,
    versionListing: kc.versionListing,
  });
}

// ---- edit (A3) ----

export interface XaiEditReq { instruction: string; image: Buffer; mime: string | null; generationId: string }

/** Edit by description: the source image rides inline as a data URI (spike-results/xai/02-edit-background-red.json).
 *  No aspect_ratio is sent: the edit keeps the source ratio (D2's crop path is an xAI-generate rule only). */
export async function edit(d: XaiDeps, req: XaiEditReq): Promise<XaiOutcome> {
  const instruction = req.instruction.trim();
  if (!instruction) return { kind: "error", code: "bad_input", message: "Type an instruction first.", clientRequestId: null, providerRequestId: null, cost: null, attempts: [], sentRatio: null };
  if (instruction.length > CAPABILITIES.maxPromptChars) return { kind: "error", code: "bad_input", message: `Not supported by Grok: instructions over ${CAPABILITIES.maxPromptChars} characters`, clientRequestId: null, providerRequestId: null, cost: null, attempts: [], sentRatio: null };
  if (!CAPABILITIES.edit) return { kind: "error", code: "bad_input", message: "Not supported by Grok: edits.", clientRequestId: null, providerRequestId: null, cost: null, attempts: [], sentRatio: null };
  if (!req.image || req.image.length === 0) return { kind: "error", code: "bad_input", message: "The source image is missing; nothing was sent.", clientRequestId: null, providerRequestId: null, cost: null, attempts: [], sentRatio: null };

  // Free key check before the first paid call (F1).
  const kc = await checkKey(d);
  if (!kc.ok) return { kind: "error", code: kc.code, message: kc.message, clientRequestId: null, providerRequestId: null, cost: null, attempts: [], sentRatio: null };

  const est = estimate(d.db, d.prices, { provider: "xai", model: MODEL, kind: "edit", resolution: resolutionFor(d.switches), quality: qualityFor(d.switches, "edit").priceQuality });
  const dataUri = `data:${req.mime ?? "image/jpeg"};base64,${req.image.toString("base64")}`;
  const body: Record<string, unknown> = { model: MODEL, prompt: instruction, image: { type: "image_url", url: dataUri }, n: 1, response_format: "b64_json" };

  return performXaiCall(d, {
    kind: "edit",
    url: `${d.baseUrl ?? XAI_BASE_URL}/v1/images/edits`,
    body,
    logTag: `xai edit gen=${req.generationId}`,
    generationId: req.generationId,
    sentRatio: null,
    estMicros: est.micros,
    estSource: est.source,
    versionListing: kc.versionListing,
  });
}
