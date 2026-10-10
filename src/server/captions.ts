// A5: captions (TECH-PLAN-v1.md :214-216, section 6). One caption call writes strict JSON for every
// ticked platform: two caption options, hashtags and alt text each, plus suggested post tags. The model
// is Gemini 3.1 Flash-Lite on the paid tier ($0.25/$1.50 per 1M tokens; FD:11 keeps it the only text
// model) through the same Interactions endpoint and the same Google key as the image calls, with the
// recorded structured-output shape: response_format {type:"text", mime_type:"application/json", schema}
// (https://ai.google.dev/gemini-api/docs/structured-output, read 2026-10-10). store:false on every body
// (D4). Cost is always estimated from API usage tokens like every Google call (item 8).
//
// Rules honored here: the real-person check runs on the free text before anything is sent (D1/F10);
// the cap is checked per attempt and a refused call is never sent; over-limit captions are flagged, never
// silently cut (section 6). If the reply is not readable JSON the app says so, records what was billed and
// never retries on its own (flagged default; a click again is a new call).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isoNY, toMicros } from "../../spike/lib/ledger.ts";
import type { Interaction } from "../../spike/lib/gemini-shape.ts";
import { outputText } from "../../spike/lib/gemini-shape.ts";
import { attemptOnce, parseRetryAfter, CLOUD_TIMEOUT_MS } from "./xai/http.ts";
import { CapRefused, markUnresolved, recordLateResult, reserve, RowNotReserved, settle, fmtUsd, type CostSource } from "./ledger.ts";
import { estimate } from "./prices.ts";
import { checkPrompt, type PromptCheckMethod } from "./prompt-check.ts";
import { REPO_ROOT } from "./config.ts";
import { readStored } from "./store.ts";
import { checkGoogleKey, classifyGoogleError, invalidateKeyCheck, API_REVISION } from "./google/adapter.ts";
import type { GoogleDeps } from "./google/adapter.ts";
import type { CostInfo, AttemptLog, ErrorCode } from "./xai/adapter.ts";
import type { DB } from "./db.ts";

export const CAPTION_MODEL = "gemini-3.1-flash-lite";
export const CAPTION_KIND = "caption";
export const CAPTION_RESOLUTION = "text";
/** Flash-Lite paid-tier rates, per 1M tokens (RESEARCH-models.md:124). */
export const CAPTION_INPUT_USD_PER_M = 0.25;
export const CAPTION_OUTPUT_USD_PER_M = 1.5;
export const NOTES_MAX = 500;
export const BRAND_VOICE_MAX = 2000;
export const MAX_ATTEMPTS = 3;
export const MAX_RETRY_AFTER_S = 30;
/** Sanity bound for a single caption before the reply counts as unreadable (a limit is never cut; this is not a cut). */
const CAPTION_SANITY_MAX = 20000;

// ---- config ----

export interface PlatformDef { id: string; label: string; captionLimit: number; visibleBeforeMore: number | null; verified: boolean }
export interface ToneDef { id: string; label: string; direction: string }

export function loadPlatforms(path = join(REPO_ROOT, "config", "platforms.json")): readonly PlatformDef[] {
  const f = JSON.parse(readFileSync(/*turbopackIgnore: true*/ path, "utf8")) as { version?: unknown; platforms?: unknown };
  if (f.version !== 1 || !Array.isArray(f.platforms)) throw new Error(`${path}: expected { version: 1, platforms: [...] }`);
  const out = f.platforms.map((p: PlatformDef, i: number) => {
    if (typeof p.id !== "string" || !/^[a-z0-9-]+$/.test(p.id)) throw new Error(`${path}: platform ${i} id`);
    if (typeof p.label !== "string" || !p.label) throw new Error(`${path}: platform ${i} label`);
    if (!Number.isSafeInteger(p.captionLimit) || p.captionLimit <= 0) throw new Error(`${path}: platform ${i} captionLimit`);
    return Object.freeze({ id: p.id, label: p.label, captionLimit: p.captionLimit, visibleBeforeMore: p.visibleBeforeMore ?? null, verified: p.verified !== false });
  });
  return Object.freeze(out);
}

export function loadTones(path = join(REPO_ROOT, "config", "tones.json")): readonly ToneDef[] {
  const f = JSON.parse(readFileSync(/*turbopackIgnore: true*/ path, "utf8")) as { version?: unknown; tones?: unknown };
  if (f.version !== 1 || !Array.isArray(f.tones)) throw new Error(`${path}: expected { version: 1, tones: [...] }`);
  const out = f.tones.map((t: ToneDef, i: number) => {
    for (const k of ["id", "label", "direction"] as const) if (typeof t[k] !== "string" || !t[k]) throw new Error(`${path}: tone ${i} ${k}`);
    return Object.freeze({ id: t.id, label: t.label, direction: t.direction });
  });
  return Object.freeze(out);
}

// ---- prompt + schema (pure; exported for tests) ----

export function buildCaptionPrompt(o: { prompt: string; platforms: readonly PlatformDef[]; tone: ToneDef; notes: string; brandVoice: string }): string {
  const lines: string[] = [
    "You write social-media captions for ONE finished image (attached).",
    `The image was made from this prompt: ${JSON.stringify(o.prompt)}`,
  ];
  if (o.brandVoice.trim()) lines.push(`Brand voice (always obey it): ${JSON.stringify(o.brandVoice.trim())}`);
  lines.push(`Tone: ${o.tone.label} — ${o.tone.direction}`);
  if (o.notes.trim()) lines.push(`Things to include from the maker: ${JSON.stringify(o.notes.trim())}`);
  lines.push("For EVERY platform below, return two different caption options that each fit within that platform's character limit (count every character, spaces included), a short hashtag list (no # symbols, at most 8), and alt text for screen readers (at most 300 characters).");
  lines.push("Platform limits: " + o.platforms.map((p) => `${p.id} <= ${p.captionLimit}`).join(", ") + ".");
  lines.push("Also suggest up to 8 post tags (single words or short phrases, no # symbols).");
  lines.push("Return only JSON that matches the schema.");
  return lines.join("\n");
}

export function buildCaptionSchema(platformIds: readonly string[]): Record<string, unknown> {
  const platformProps: Record<string, unknown> = {};
  for (const id of platformIds) {
    platformProps[id] = {
      type: "object",
      properties: {
        captions: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2 },
        hashtags: { type: "array", items: { type: "string" }, maxItems: 8 },
        alt_text: { type: "string" },
      },
      required: ["captions", "hashtags", "alt_text"],
    };
  }
  return {
    type: "object",
    properties: {
      platforms: { type: "object", properties: platformProps, required: [...platformIds] },
      tags: { type: "array", items: { type: "string" }, maxItems: 8 },
    },
    required: ["platforms", "tags"],
  };
}

export interface ParsedPlatform { captions: string[]; hashtags: string[]; altText: string }
export type ParsedCaptionReply = { ok: true; platforms: Record<string, ParsedPlatform>; tags: string[] } | { ok: false; error: string };

const clean = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Strict parse + sanity bounds. Structural problems make the whole reply unreadable; over-limit text is kept (flagged, never cut). */
export function parseCaptionReply(text: string, platformIds: readonly string[]): ParsedCaptionReply {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return { ok: false, error: "The reply was not JSON." }; }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, error: "The reply was not a JSON object." };
  const obj = v as { platforms?: unknown; tags?: unknown };
  if (!obj.platforms || typeof obj.platforms !== "object" || Array.isArray(obj.platforms)) return { ok: false, error: "The reply had no platforms object." };
  const platforms: Record<string, ParsedPlatform> = {};
  for (const id of platformIds) {
    const p = (obj.platforms as Record<string, unknown>)[id] as { captions?: unknown; hashtags?: unknown; alt_text?: unknown } | undefined;
    if (!p || typeof p !== "object") return { ok: false, error: `The reply was missing ${id}.` };
    if (!Array.isArray(p.captions) || p.captions.length < 1 || p.captions.length > 3 || !p.captions.every((c) => typeof c === "string")) return { ok: false, error: `The reply's ${id} captions were not readable.` };
    const captions = (p.captions as string[]).map(clean);
    if (captions.some((c) => !c || c.length > CAPTION_SANITY_MAX)) return { ok: false, error: `The reply's ${id} captions were not readable.` };
    if (!Array.isArray(p.hashtags) || p.hashtags.length > 16 || !p.hashtags.every((h) => typeof h === "string" && h.length <= 200)) return { ok: false, error: `The reply's ${id} hashtags were not readable.` };
    const hashtags = (p.hashtags as string[]).map((h) => clean(h).replace(/^#+/, "")).filter(Boolean);
    if (typeof p.alt_text !== "string" || p.alt_text.length > 2000) return { ok: false, error: `The reply's ${id} alt text was not readable.` };
    platforms[id] = { captions, hashtags, altText: clean(p.alt_text) };
  }
  if (!Array.isArray(obj.tags) || obj.tags.length > 16 || !obj.tags.every((t) => typeof t === "string" && t.length <= 100)) return { ok: false, error: "The reply's tags were not readable." };
  const tags = (obj.tags as string[]).map((t) => clean(t).replace(/^#+/, "")).filter(Boolean).slice(0, 10);
  return { ok: true, platforms, tags };
}

// ---- cost (item 8: always from usage tokens; no billed figure exists for Google) ----

export function captionCostFromUsage(usage: unknown): { usd: number; detail: string } | { error: string } {
  const u = usage as { total_input_tokens?: unknown; total_output_tokens?: unknown; total_thought_tokens?: unknown } | null | undefined;
  const num = (x: unknown): number | null => (typeof x === "number" && Number.isSafeInteger(x) && x >= 0 ? x : null);
  const inp = num(u?.total_input_tokens);
  const out = num(u?.total_output_tokens);
  const thought = u?.total_thought_tokens === undefined ? 0 : num(u?.total_thought_tokens);
  if (inp === null || out === null || thought === null) return { error: "usage tokens missing" };
  const usd = (inp * CAPTION_INPUT_USD_PER_M + (out + thought) * CAPTION_OUTPUT_USD_PER_M) / 1e6;
  return { usd, detail: `${inp} input x $${CAPTION_INPUT_USD_PER_M}/M + ${out} output + ${thought} thinking x $${CAPTION_OUTPUT_USD_PER_M}/M` };
}

// ---- the call ----

export interface CaptionRequest { postId: number; platforms: readonly string[]; tone: string; notes: string }
export interface CaptionPlatformResult { captions: string[]; hashtags: string[]; altText: string; limit: number; overLimit: boolean }
export interface CaptionOutcome {
  kind: "ok" | "blocked" | "error";
  code: string | null;
  message: string | null;
  platforms: Record<string, CaptionPlatformResult> | null;
  tags: string[] | null;
  cost: CostInfo | null;
  clientRequestId: string | null;
  model: string;
}

export class CaptionInputError extends Error {
  constructor(message: string) { super(message); this.name = "CaptionInputError"; }
}

interface CaptionPlan { url: string; body: Record<string, unknown>; estMicros: number; estSource: string }

export async function generateCaptions(d: GoogleDeps, promptMethod: PromptCheckMethod, imagesDir: string, req: CaptionRequest): Promise<CaptionOutcome> {
  const err = (code: string, message: string, cost: CostInfo | null = null): CaptionOutcome =>
    ({ kind: "error", code, message, platforms: null, tags: null, cost, clientRequestId: null, model: CAPTION_MODEL });
  const log = (m: string) => d.log?.(d.keys.scrub(m));
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = d.random ?? Math.random;

  // 1) Input validation — nothing is sent for a bad request.
  const platforms = loadPlatforms();
  const tones = loadTones();
  const ids = [...new Set(req.platforms)];
  if (!ids.length || ids.length > platforms.length) throw new CaptionInputError("Pick at least one platform.");
  for (const id of ids) if (!platforms.some((p) => p.id === id)) throw new CaptionInputError(`Unknown platform "${id}".`);
  const tone = tones.find((t) => t.id === req.tone);
  if (!tone) throw new CaptionInputError("Pick a tone.");
  const notes = typeof req.notes === "string" ? req.notes.trim() : "";
  if (notes.length > NOTES_MAX) throw new CaptionInputError(`Notes are limited to ${NOTES_MAX} characters.`);
  const brandVoice = getBrandVoice(d.db);
  const post = d.db.prepare("SELECT p.id, p.prompt, p.asset_id, p.generation_id, a.mime FROM posts p JOIN assets a ON a.id = p.asset_id WHERE p.id = ?").get(req.postId) as { id: number; prompt: string; asset_id: string; generation_id: string; mime: string } | undefined;
  if (!post) throw new CaptionInputError("Unknown post.");

  // 2) Real-person check on the free text (D1/F10) — a block or an unavailable check sends nothing.
  const freeText = [notes, brandVoice].filter(Boolean).join("\n");
  if (freeText) {
    const pc = checkPrompt(freeText, promptMethod, d.switches.promptCheck, d.db);
    if (!pc.allowed) return { kind: "blocked", code: pc.result, message: pc.message, platforms: null, tags: null, cost: { micros: 0, source: "not_sent", heldMicros: 0 }, clientRequestId: null, model: CAPTION_MODEL };
  }

  // 3) Free key check before the first paid call (F1), through Google's own stores.
  const kc = await checkGoogleKey(d);
  if (!kc.ok) return err(kc.code === "auth" ? "auth" : "unavailable", kc.message);

  // 4) Reservation estimate (item 2b/2d) from prices.json.
  const est = estimate(d.db, d.prices, { provider: "google", model: CAPTION_MODEL, kind: CAPTION_KIND, resolution: CAPTION_RESOLUTION, quality: null });
  let image: Buffer;
  try { image = readStored(imagesDir, post.asset_id, post.mime); }
  catch { return err("bad_input", "The image file is missing from the store."); }
  const plan: CaptionPlan = {
    url: `${d.baseUrl ?? "https://generativelanguage.googleapis.com"}/v1beta/interactions`,
    body: {
      model: CAPTION_MODEL,
      input: [
        { type: "text", text: buildCaptionPrompt({ prompt: post.prompt, platforms: platforms.filter((p) => ids.includes(p.id)), tone, notes, brandVoice }) },
        { type: "image", mime_type: post.mime, data: image.toString("base64") },
      ],
      store: false,
      response_format: { type: "text", mime_type: "application/json", schema: buildCaptionSchema(ids) },
    },
    estMicros: est.micros,
    estSource: est.source,
  };

  // 5) The attempt loop mirrors the image calls' rules: cap check per attempt, connection retry once (F2),
  //    timeout/connection hold (F3), bounded 429 retry (F4), quota settle (F8), auth invalidates the key
  //    check (F1). The successful body is parsed strictly; unreadable replies settle what was billed.
  const attempts: AttemptLog[] = [];
  let retries429 = 0, retriedConnection = false;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = reserve(d.db, { provider: "google", model: CAPTION_MODEL, kind: CAPTION_KIND, resolution: CAPTION_RESOLUTION, quality: null, generationId: post.generation_id, attempt, estimateMicros: plan.estMicros, estimateSource: plan.estSource });
    } catch (e) {
      if (e instanceof CapRefused) {
        log(`caption attempt=${attempt} refused by cap before sending`);
        return err("cap", e.message);
      }
      throw e;
    }
    const id = res.id;
    const r = await attemptOnce(d.fetch, { method: "POST", url: plan.url, headers: { ...d.keys.authHeader(), "Api-Revision": API_REVISION }, body: plan.body, timeoutMs: d.timeoutMs ?? CLOUD_TIMEOUT_MS });
    const j = r.json as Interaction | null;
    const providerRequestId = j && typeof j === "object" && typeof (j as { id?: unknown }).id === "string" ? (j as { id: string }).id : null;
    const trace: string | null = (() => { const t: Record<string, string> = {}; for (const h of ["x-request-id", "traceparent"]) if (r.headers[h]) t[h] = r.headers[h]; return Object.keys(t).length ? JSON.stringify(t) : null; })();

    const late = (e: unknown, x: { httpStatus: number | null; outcome: string; actualMicros: number | null; costSource: string | null; reason: string; note: string | null }): CostInfo => {
      if (!(e instanceof RowNotReserved)) throw e;
      const now = recordLateResult(d.db, id, { ...x, providerRequestId, providerTrace: trace });
      log(`caption ref=${id} attempt=${attempt} late result: row was already ${now.status ?? "missing"}`);
      return now.status === "settled" ? { micros: now.actualMicros, source: (now.costSource ?? "unresolved") as CostInfo["source"], heldMicros: 0 } : { micros: null, source: "unresolved", heldMicros: now.countedMicros };
    };
    if (r.noConnection) {
      try { settle(d.db, id, { actualMicros: 0, costSource: "not_sent", costDetail: JSON.stringify({ error: r.errorCode }), httpStatus: null, outcome: "no_connection" }); }
      catch (e) { late(e, { httpStatus: null, outcome: "no_connection", actualMicros: 0, costSource: "not_sent", reason: `no connection (${r.errorCode ?? "unknown"})`, note: null }); }
      attempts.push({ clientRequestId: id, status: null, outcome: "no_connection", costMicros: 0, costSource: "not_sent" });
      if (!retriedConnection && attempt < MAX_ATTEMPTS) { retriedConnection = true; continue; }
      return err("unavailable", `Couldn't reach Google (${r.errorCode === "ECONNREFUSED" ? "connection refused" : r.errorCode ?? "no connection"}).`);
    }
    const st = r.status;
    const note = st === 429 ? d.keys.scrub(r.text ?? "").slice(0, 500) : null;
    const hold = (reason: string): CostInfo => {
      try { markUnresolved(d.db, id, { reason, providerRequestId, providerTrace: trace, httpStatus: st, outcome: r.outcome, note }); }
      catch (e) { return late(e, { httpStatus: st, outcome: r.outcome, actualMicros: null, costSource: null, reason, note }); }
      return { micros: null, source: "unresolved", heldMicros: plan.estMicros };
    };
    const settleAt = (usd: number, source: CostSource, basis: string): CostInfo => {
      let micros: number | null = null;
      try {
        micros = toMicros(usd);
        settle(d.db, id, { actualMicros: micros, costSource: source, costDetail: JSON.stringify({ basis, usage: (j?.usage as Record<string, unknown> | undefined) ?? null }), providerRequestId, providerTrace: trace, httpStatus: st, outcome: r.outcome, note });
        return { micros, source, heldMicros: 0 };
      } catch (e) {
        if (e instanceof RowNotReserved) return late(e, { httpStatus: st, outcome: r.outcome, actualMicros: micros, costSource: source, reason: basis, note });
        return hold(`unresolved: settling failed (${(e as Error).name}); reservation kept`);
      }
    };
    const finish = (costInfo: CostInfo, code: string, message: string): CaptionOutcome => {
      attempts.push({ clientRequestId: id, status: st, outcome: r.outcome, costMicros: costInfo.micros, costSource: costInfo.source });
      log(`caption ref=${id} attempt=${attempt} outcome=${r.outcome} status=${st} latency=${r.latency_ms}ms cost=${costInfo.micros === null ? `held ${fmtUsd(plan.estMicros)}` : fmtUsd(costInfo.micros)} (${costInfo.source})`);
      return { kind: "error", code, message, platforms: null, tags: null, cost: costInfo, clientRequestId: id, model: CAPTION_MODEL };
    };
    const held = fmtUsd(plan.estMicros);
    const usage = captionCostFromUsage(j?.usage);
    const fromUsage = (fallbackSource: CostSource, basis: string): CostInfo => "error" in usage ? hold(`${basis}; usage tokens missing`) : settleAt(usage.usd, "estimated_tokens", `${basis}: ${usage.detail}`);

    if (r.outcome === "timeout") return finish(hold(`unresolved: HTTP timeout after send (F3); ${held} kept until checked against Google Cloud billing`), "timeout", `Google timed out after ${Math.round((d.timeoutMs ?? CLOUD_TIMEOUT_MS) / 1000)} s. It may still have been charged; ${held} is held against your cap until you check.`);
    if (r.outcome === "connection_error") return finish(hold(`unresolved: connection error after send (F3); ${held} kept until checked against Google Cloud billing`), "unavailable", `The connection to Google dropped after the request was sent${r.errorCode ? ` (${r.errorCode})` : ""}. It may still have been charged; ${held} is held against your cap until you check.`);

    if (st === 429) {
      const cls = classifyGoogleError(st, j, r, d.keys);
      const costInfo = cls.code === "quota" ? settleAt(0, "assumed_zero_rejected", `estimated $0: Google quota/billing 429 (F8)${cls.detail ? `: ${cls.detail}` : ""}`) : fromUsage("assumed_zero_429", "estimated from API usage tokens on a 429 (F4)");
      if (cls.code === "quota") { invalidateKeyCheck(d); return finish(costInfo, "quota", "Google prepaid credit is used up or billing is disabled — check Google AI Studio / Cloud Billing."); }
      const ra = parseRetryAfter(r.headers["retry-after"]);
      const asked = ra !== null ? ` Google asked to wait ${Math.ceil(ra)} s.` : "";
      let waitMs: number | null = null;
      if (ra !== null) { if (ra <= MAX_RETRY_AFTER_S && retries429 === 0) waitMs = Math.ceil(ra * 1000); }
      else if (retries429 < 2) waitMs = Math.round((retries429 === 0 ? 2000 : 4000) * (0.8 + 0.4 * random()));
      if (waitMs !== null && attempt < MAX_ATTEMPTS) {
        retries429++;
        attempts.push({ clientRequestId: id, status: st, outcome: r.outcome, costMicros: costInfo.micros, costSource: costInfo.source });
        log(`caption waiting for rate limit ${waitMs} ms`);
        await sleep(waitMs);
        continue;
      }
      return finish(costInfo, "rate_limit", `Rate limited by Google.${asked} Try again.`);
    }

    if (st !== null && st >= 200 && st < 300) {
      if (r.oversize || j === null || typeof j !== "object") {
        return finish(fromUsage("estimated_tokens", "malformed 200 (F15):"), "unavailable", `Google sent a response the app couldn't read (HTTP ${st}).`);
      }
      const ecode = j.error && typeof (j.error as { code?: unknown }).code === "string" ? (j.error as { code: string }).code : null;
      if (ecode && /safety|prohibited|blocklist|recitation|blocked/i.test(ecode)) {
        const detail = (() => { const e = (j as { error?: { message?: unknown } }).error; return d.keys.scrub(typeof e?.message === "string" ? e.message : r.text ?? "").slice(0, 500); })();
        const costInfo = fromUsage("estimated_tokens", "blocked reply:");
        return { kind: "blocked", code: ecode, message: `Refused by Google (${ecode}).${detail ? ` ${detail}` : ""}`, platforms: null, tags: null, cost: costInfo, clientRequestId: id, model: CAPTION_MODEL };
      }
      if (j.status === "failed" || j.status === "cancelled") {
        const costInfo = fromUsage("estimated_tokens", `interaction ${j.status}:`);
        return j.status === "cancelled"
          ? finish(costInfo, "timeout", `Google cancelled this call. It may still have been charged; ${costInfo.micros === null ? `${held} is held against your cap until you check.` : `settled at ${fmtUsd(costInfo.micros)}.`}`)
          : finish(costInfo, "unavailable", "Google reported the interaction as failed.");
      }
      const text = outputText(j).join("\n").trim();
      const parsed = parseCaptionReply(text, ids);
      if (!parsed.ok) {
        const costInfo = fromUsage("estimated_tokens", "unreadable reply (billed anyway):");
        return finish(costInfo, "unreadable", `${parsed.error} The call was still billed; nothing is retried automatically — press “Write captions” again.`);
      }
      const costInfo = fromUsage("estimated_tokens", "captions:");
      const out: Record<string, CaptionPlatformResult> = {};
      for (const p of platforms.filter((x) => ids.includes(x.id))) {
        const parsedP = parsed.platforms[p.id];
        out[p.id] = { captions: parsedP.captions, hashtags: parsedP.hashtags, altText: parsedP.altText, limit: p.captionLimit, overLimit: parsedP.captions.some((c) => c.length > p.captionLimit) };
      }
      attempts.push({ clientRequestId: id, status: st, outcome: r.outcome, costMicros: costInfo.micros, costSource: costInfo.source });
      return { kind: "ok", code: null, message: null, platforms: out, tags: parsed.tags, cost: costInfo, clientRequestId: id, model: CAPTION_MODEL };
    }

    const cls = classifyGoogleError(st, j, r, d.keys);
    const costInfo = "error" in usage ? hold(`${cls.code} error (F table)` ) : settleAt(usage.usd, "estimated_tokens", `${cls.code} error with usage:`);
    if (cls.code === "auth") { invalidateKeyCheck(d); return finish(costInfo, "auth", `Key rejected (HTTP ${st}). Check the Google key in Settings.`); }
    if (cls.code === "quota") return finish(costInfo, "quota", "Google prepaid credit is used up or billing is disabled — check Google AI Studio / Cloud Billing.");
    if (cls.code === "bad_input") return finish(costInfo, "bad_input", st === 404 ? `Model not available: ${cls.detail}` : `Google rejected the request: ${cls.detail}`);
    if (cls.code === "rate_limit") return finish(costInfo, "rate_limit", "Rate limited by Google. Try again.");
    if (cls.code === "timeout") return finish(costInfo, "timeout", `Google cancelled the call (HTTP ${st}).`);
    return finish(costInfo, "unavailable", `Google error ${st}. Retry.`);
  }
  throw new Error("caption call: attempt loop ended without a result");
}

// ---- store (captions, tags, brand voice) ----

export class CaptionStoreError extends Error {
  constructor(message: string) { super(message); this.name = "CaptionStoreError"; }
}

export interface SavedCaption { platform: string; text: string; hashtags: string; altText: string; model: string; createdAt: string }

export function listCaptions(db: DB, postId: number): SavedCaption[] {
  const rows = db.prepare("SELECT platform, text, hashtags, alt_text, model, created_at FROM captions WHERE post_id = ? ORDER BY platform").all(postId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({ platform: String(r.platform), text: String(r.text), hashtags: String(r.hashtags), altText: String(r.alt_text), model: String(r.model), createdAt: String(r.created_at) }));
}

function refreshCaptionText(db: DB, postId: number): void {
  db.prepare("UPDATE posts SET caption_text = COALESCE((SELECT group_concat(text, ' ') FROM (SELECT text FROM captions WHERE post_id = ? ORDER BY platform)), '') WHERE id = ?").run(postId, postId);
}

/** Save one platform's caption (the chosen option, as edited). Over-limit text saves as-is; the UI flags it. */
export function saveCaption(db: DB, postId: unknown, platformRaw: unknown, textRaw: unknown, hashtagsRaw: unknown, altRaw: unknown): SavedCaption {
  const id = Number(postId);
  if (!Number.isInteger(id) || id <= 0) throw new CaptionStoreError("Unknown post.");
  if (!db.prepare("SELECT 1 FROM posts WHERE id = ?").get(id)) throw new CaptionStoreError("Unknown post.");
  const platform = typeof platformRaw === "string" ? platformRaw : "";
  const def = loadPlatforms().find((p) => p.id === platform);
  if (!def) throw new CaptionStoreError("Unknown platform.");
  const text = typeof textRaw === "string" ? textRaw.trim() : "";
  if (!text) throw new CaptionStoreError("The caption is empty.");
  if (text.length > CAPTION_SANITY_MAX) throw new CaptionStoreError("That caption is far over every platform's limit; shorten it before saving.");
  const hashtags = typeof hashtagsRaw === "string" ? hashtagsRaw.trim().slice(0, 2000) : "";
  const altText = typeof altRaw === "string" ? altRaw.trim().slice(0, 2000) : "";
  const at = isoNY();
  db.prepare(`INSERT INTO captions (post_id, platform, text, hashtags, alt_text, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(post_id, platform) DO UPDATE SET text = excluded.text, hashtags = excluded.hashtags, alt_text = excluded.alt_text, model = excluded.model, created_at = excluded.created_at`).run(id, platform, text, hashtags, altText, CAPTION_MODEL, at);
  refreshCaptionText(db, id);
  return { platform, text, hashtags, altText, model: CAPTION_MODEL, createdAt: at };
}

export interface PostTag { id: number; name: string }

export function listPostTags(db: DB, postId: number): PostTag[] {
  const rows = db.prepare("SELECT t.id, t.name FROM post_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.post_id = ? ORDER BY t.name").all(postId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({ id: Number(r.id), name: String(r.name) }));
}

function refreshTagText(db: DB, postId: number): void {
  db.prepare("UPDATE posts SET tag_text = COALESCE((SELECT group_concat(name, ' ') FROM (SELECT t.name FROM post_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.post_id = ? ORDER BY t.name)), '') WHERE id = ?").run(postId, postId);
}

/** Accept tags the user ticked. Nothing is ever added silently (T:103). Max 10 at a time, each <= 50 chars. */
export function acceptTags(db: DB, postId: unknown, tagsRaw: unknown): PostTag[] {
  const id = Number(postId);
  if (!Number.isInteger(id) || id <= 0) throw new CaptionStoreError("Unknown post.");
  if (!db.prepare("SELECT 1 FROM posts WHERE id = ?").get(id)) throw new CaptionStoreError("Unknown post.");
  if (!Array.isArray(tagsRaw)) throw new CaptionStoreError("Expected a list of tags.");
  const names = [...new Set((tagsRaw as unknown[]).map((t) => (typeof t === "string" ? t.replace(/^#+/, "").replace(/\s+/g, " ").trim() : "")).filter(Boolean))];
  if (!names.length) throw new CaptionStoreError("Pick at least one tag.");
  if (names.length > 10) throw new CaptionStoreError("Up to 10 tags at a time.");
  for (const n of names) if (n.length > 50) throw new CaptionStoreError("A tag is limited to 50 characters.");
  const at = isoNY();
  for (const n of names) {
    db.prepare("INSERT INTO tags (name, created_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING").run(n, at);
    const t = db.prepare("SELECT id FROM tags WHERE name = ?").get(n) as { id: number };
    db.prepare("INSERT OR IGNORE INTO post_tags (post_id, tag_id) VALUES (?, ?)").run(id, t.id);
  }
  refreshTagText(db, id);
  return listPostTags(db, id);
}

export function getBrandVoice(db: DB): string {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'brand_voice'").get() as { value: string } | undefined;
  return row?.value ?? "";
}

export function setBrandVoice(db: DB, textRaw: unknown): string {
  if (typeof textRaw !== "string") throw new CaptionStoreError("Expected text.");
  const text = textRaw.trim();
  if (text.length > BRAND_VOICE_MAX) throw new CaptionStoreError(`The brand voice is limited to ${BRAND_VOICE_MAX} characters.`);
  db.prepare("INSERT INTO settings (key, value) VALUES ('brand_voice', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(text);
  return text;
}
