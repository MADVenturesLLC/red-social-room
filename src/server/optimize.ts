// B2: Prompt optimization (TECH-PLAN-v1-AMENDMENT-1.md B2). Takes a basic prompt and rewrites it into an
// expanded, visually rich image prompt using Gemini 3.1 Flash-Lite on the paid tier ($0.25/$1.50 per 1M tokens)
// through the existing Google Interactions endpoint with store:false (D4) and structured JSON output.
//
// Rules honored here:
// - Real-person check runs on the prompt before sending (D1/F10); a blocked prompt sends nothing and costs $0.
// - Cap check before sending; reserved under kind 'prompt_optimize', settled from API usage tokens like every Google call.
// - B2 requirement: box changes only when clicked; one-click undo restores previous text; no image provider touched.
import { isoNY, toMicros } from "../../spike/lib/ledger.ts";
import type { Interaction } from "../../spike/lib/gemini-shape.ts";
import { outputText } from "../../spike/lib/gemini-shape.ts";
import { attemptOnce, parseRetryAfter, CLOUD_TIMEOUT_MS } from "./xai/http.ts";
import { CapRefused, markUnresolved, recordLateResult, reserve, RowNotReserved, settle, fmtUsd, type CostSource } from "./ledger.ts";
import { estimate } from "./prices.ts";
import { checkPrompt, type PromptCheckMethod } from "./prompt-check.ts";
import { checkGoogleKey, classifyGoogleError, invalidateKeyCheck, API_REVISION } from "./google/adapter.ts";
import type { GoogleDeps } from "./google/adapter.ts";
import type { CostInfo, AttemptLog } from "./xai/adapter.ts";

export const OPTIMIZE_MODEL = "gemini-3.1-flash-lite";
export const OPTIMIZE_KIND = "prompt_optimize";
export const OPTIMIZE_RESOLUTION = "text";
export const OPTIMIZE_INPUT_USD_PER_M = 0.25;
export const OPTIMIZE_OUTPUT_USD_PER_M = 1.5;
export const MAX_ATTEMPTS = 3;
export const MAX_RETRY_AFTER_S = 30;

export class OptimizeInputError extends Error {
  constructor(message: string) { super(message); this.name = "OptimizeInputError"; }
}

export function buildOptimizePrompt(userPrompt: string, hasAttachedImage = false): string {
  const baseRules = [
    "You are an expert prompt engineer for AI image generation and photo editing models (Grok Imagine 2.0, Gemini Nano Banana 2, and OpenAI GPT Image).",
    hasAttachedImage
      ? "The user has attached their own photo to be edited/enhanced. Rewrite their instruction into a clear, vivid photo-editing prompt that enhances the attached photo while strictly preserving the identity, facial features, expressions, and core subjects of the original photo."
      : "Your task is to take the user's raw or basic image prompt and rewrite it into an expanded, high-yield image prompt that produces an extraordinary visual result.",
    "",
    "Rules:",
    "1. Preserve the user's core subject, concept, and intent. Do NOT replace their idea with a completely different subject.",
    "2. Add rich, concrete visual descriptions: lighting (direction, quality, mood), composition and framing, environment/background context, materials, and textures.",
    "3. Use evocative photography or art direction terminology when appropriate (e.g. lens focal length, natural depth of field, dramatic backlight, soft diffuse shadow).",
    "4. Do NOT prefix the output with 'Prompt:' or 'Optimized prompt:'. Return only the prompt text itself inside the JSON.",
    "5. Keep the optimized prompt concise, punchy, and vivid (typically 1 to 3 rich sentences, under 600 characters).",
    "6. Output ONLY JSON matching the requested schema with the key 'optimized'.",
    "",
    `User's prompt: ${JSON.stringify(userPrompt)}`,
  ];
  return baseRules.join("\n");
}

export const OPTIMIZE_SCHEMA = {
  type: "object",
  properties: {
    optimized: { type: "string" },
  },
  required: ["optimized"],
};

export function parseOptimizeReply(text: string): { ok: true; optimized: string } | { ok: false; error: string } {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return { ok: false, error: "The reply was not JSON." }; }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, error: "The reply was not a JSON object." };
  const obj = v as { optimized?: unknown };
  if (typeof obj.optimized !== "string" || !obj.optimized.trim()) {
    return { ok: false, error: "The reply did not contain an optimized prompt." };
  }
  const cleaned = obj.optimized.trim().replace(/^(?:optimized\s+)?prompt\s*:\s*/i, "").trim();
  return { ok: true, optimized: cleaned || obj.optimized.trim() };
}

export function optimizeCostFromUsage(usage: unknown): { usd: number; detail: string } | { error: string } {
  const u = usage as { total_input_tokens?: unknown; total_output_tokens?: unknown; total_thought_tokens?: unknown } | null | undefined;
  const num = (x: unknown): number | null => (typeof x === "number" && Number.isSafeInteger(x) && x >= 0 ? x : null);
  const inp = num(u?.total_input_tokens);
  const out = num(u?.total_output_tokens);
  const thought = u?.total_thought_tokens === undefined ? 0 : num(u?.total_thought_tokens);
  if (inp === null || out === null || thought === null) return { error: "usage tokens missing" };
  const usd = (inp * OPTIMIZE_INPUT_USD_PER_M + (out + thought) * OPTIMIZE_OUTPUT_USD_PER_M) / 1e6;
  return { usd, detail: `${inp} input x $${OPTIMIZE_INPUT_USD_PER_M}/M + ${out} output + ${thought} thinking x $${OPTIMIZE_OUTPUT_USD_PER_M}/M` };
}

export interface OptimizeOutcome {
  kind: "ok" | "blocked" | "error";
  code: string | null;
  message: string | null;
  prompt: string;
  optimized: string | null;
  cost: CostInfo | null;
  clientRequestId: string | null;
  model: string;
  latencyMs: number | null;
}

export async function optimizePrompt(
  d: GoogleDeps,
  promptMethod: PromptCheckMethod,
  userPrompt: string,
  opts: { hasAttachedImage?: boolean } = {}
): Promise<OptimizeOutcome> {
  const trimmed = userPrompt.trim();
  if (!trimmed) throw new OptimizeInputError("Type a prompt first.");
  if (trimmed.length > 64000) throw new OptimizeInputError("Prompts are limited to 64,000 characters.");

  const err = (code: string, message: string, cost: CostInfo | null = null): OptimizeOutcome =>
    ({ kind: "error", code, message, prompt: trimmed, optimized: null, cost, clientRequestId: null, model: OPTIMIZE_MODEL, latencyMs: null });
  const log = (m: string) => d.log?.(d.keys.scrub(m));
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = d.random ?? Math.random;

  // 1) Real-person check on the prompt (D1/F10) — blocked sends nothing.
  const pc = checkPrompt(trimmed, promptMethod, d.switches.promptCheck, d.db);
  if (!pc.allowed) {
    return {
      kind: "blocked",
      code: pc.result,
      message: pc.message,
      prompt: trimmed,
      optimized: null,
      cost: { micros: 0, source: "not_sent", heldMicros: 0 },
      clientRequestId: null,
      model: OPTIMIZE_MODEL,
      latencyMs: null,
    };
  }

  // 2) Free key check before the paid call (F1).
  const kc = await checkGoogleKey(d);
  if (!kc.ok) return err(kc.code === "auth" ? "auth" : "unavailable", kc.message);

  // 3) Reservation estimate from prices.json.
  const est = estimate(d.db, d.prices, { provider: "google", model: OPTIMIZE_MODEL, kind: OPTIMIZE_KIND, resolution: OPTIMIZE_RESOLUTION, quality: null });

  const plan = {
    url: `${d.baseUrl ?? "https://generativelanguage.googleapis.com"}/v1beta/interactions`,
    body: {
      model: OPTIMIZE_MODEL,
      input: [
        { type: "text", text: buildOptimizePrompt(trimmed, !!opts.hasAttachedImage) },
      ],
      store: false,
      response_format: { type: "text", mime_type: "application/json", schema: OPTIMIZE_SCHEMA },
    },
    estMicros: est.micros,
    estSource: est.source,
  };

  // 4) Attempt loop: cap check per attempt, connection retry, timeout/connection hold, 429 retry, quota settle.
  const attempts: AttemptLog[] = [];
  let retries429 = 0, retriedConnection = false;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = reserve(d.db, {
        provider: "google",
        model: OPTIMIZE_MODEL,
        kind: OPTIMIZE_KIND,
        resolution: OPTIMIZE_RESOLUTION,
        quality: null,
        generationId: null,
        attempt,
        estimateMicros: plan.estMicros,
        estimateSource: plan.estSource,
      });
    } catch (e) {
      if (e instanceof CapRefused) {
        log(`optimize attempt=${attempt} refused by cap before sending`);
        return err("cap", e.message);
      }
      throw e;
    }
    const id = res.id;
    const r = await attemptOnce(d.fetch, {
      method: "POST",
      url: plan.url,
      headers: { ...d.keys.authHeader(), "Api-Revision": API_REVISION },
      body: plan.body,
      timeoutMs: d.timeoutMs ?? CLOUD_TIMEOUT_MS,
    });
    const j = r.json as Interaction | null;
    const providerRequestId = j && typeof j === "object" && typeof (j as { id?: unknown }).id === "string" ? (j as { id: string }).id : null;
    const trace: string | null = (() => {
      const t: Record<string, string> = {};
      for (const h of ["x-request-id", "traceparent"]) if (r.headers[h]) t[h] = r.headers[h];
      return Object.keys(t).length ? JSON.stringify(t) : null;
    })();

    const late = (e: unknown, x: { httpStatus: number | null; outcome: string; actualMicros: number | null; costSource: string | null; reason: string; note: string | null }): CostInfo => {
      if (!(e instanceof RowNotReserved)) throw e;
      const now = recordLateResult(d.db, id, { ...x, providerRequestId, providerTrace: trace });
      log(`optimize ref=${id} attempt=${attempt} late result: row was already ${now.status ?? "missing"}`);
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

    const finish = (costInfo: CostInfo, code: string, message: string): OptimizeOutcome => {
      attempts.push({ clientRequestId: id, status: st, outcome: r.outcome, costMicros: costInfo.micros, costSource: costInfo.source });
      log(`optimize ref=${id} attempt=${attempt} outcome=${r.outcome} status=${st} latency=${r.latency_ms}ms cost=${costInfo.micros === null ? `held ${fmtUsd(plan.estMicros)}` : fmtUsd(costInfo.micros)} (${costInfo.source})`);
      return { kind: "error", code, message, prompt: trimmed, optimized: null, cost: costInfo, clientRequestId: id, model: OPTIMIZE_MODEL, latencyMs: r.latency_ms };
    };

    const held = fmtUsd(plan.estMicros);
    const usage = optimizeCostFromUsage(j?.usage);
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
        log(`optimize waiting for rate limit ${waitMs} ms`);
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
        return { kind: "blocked", code: ecode, message: `Refused by Google (${ecode}).${detail ? ` ${detail}` : ""}`, prompt: trimmed, optimized: null, cost: costInfo, clientRequestId: id, model: OPTIMIZE_MODEL, latencyMs: r.latency_ms };
      }
      if (j.status === "failed" || j.status === "cancelled") {
        const costInfo = fromUsage("estimated_tokens", `interaction ${j.status}:`);
        return j.status === "cancelled"
          ? finish(costInfo, "timeout", `Google cancelled this call. It may still have been charged; ${costInfo.micros === null ? `${held} is held against your cap until you check.` : `settled at ${fmtUsd(costInfo.micros)}.`}`)
          : finish(costInfo, "unavailable", "Google reported the interaction as failed.");
      }
      const text = outputText(j).join("\n").trim();
      const parsed = parseOptimizeReply(text);
      if (!parsed.ok) {
        const costInfo = fromUsage("estimated_tokens", "unreadable reply (billed anyway):");
        return finish(costInfo, "unreadable", `${parsed.error} The call was still billed.`);
      }
      const costInfo = fromUsage("estimated_tokens", "optimize:");
      attempts.push({ clientRequestId: id, status: st, outcome: "ok", costMicros: costInfo.micros, costSource: costInfo.source });
      log(`optimize ref=${id} attempt=${attempt} ok latency=${r.latency_ms}ms cost=${costInfo.micros === null ? `held ${held}` : fmtUsd(costInfo.micros)}`);
      return {
        kind: "ok",
        code: null,
        message: null,
        prompt: trimmed,
        optimized: parsed.optimized,
        cost: costInfo,
        clientRequestId: id,
        model: OPTIMIZE_MODEL,
        latencyMs: r.latency_ms,
      };
    }

    // 4xx / 5xx
    const cls = classifyGoogleError(st, j, r, d.keys);
    const costInfo = "error" in usage ? hold(`${cls.code} error (F table)`) : settleAt(usage.usd, "estimated_tokens", `${cls.code} error with usage:`);
    if (cls.code === "auth") {
      invalidateKeyCheck(d);
      return finish(costInfo, "auth", `Google rejected your API key (${st}). Check it in Settings.`);
    }
    if (cls.code === "quota") return finish(costInfo, "quota", "Google prepaid credit is used up or billing is disabled — check Google AI Studio / Cloud Billing.");
    if (cls.code === "bad_input") return finish(costInfo, "bad_input", st === 404 ? `Model not available: ${cls.detail}` : `Google rejected the request: ${cls.detail}`);
    if (cls.code === "rate_limit") return finish(costInfo, "rate_limit", "Rate limited by Google. Try again.");
    if (cls.code === "timeout") return finish(costInfo, "timeout", `Google cancelled the call (HTTP ${st}).`);
    return finish(costInfo, "unavailable", `Google error ${st}. Retry.`);
  }
  return err("unavailable", "Google could not be reached after 3 attempts.");
}
