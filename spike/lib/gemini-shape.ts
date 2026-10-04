// Gemini Interactions response helpers and the per-call cost rule. Pure (no I/O), so tests can import it
// without running gemini.ts.
import type { CallResult } from "./http.ts";
import type { StepCost } from "./step.ts";
import { SOURCES, GEMINI, geminiCostFromUsage, normModality } from "./prices.ts";

export interface Block { type?: string; text?: string; data?: string; mime_type?: string }
export interface Step { type?: string; content?: Block[]; summary?: Block[] }
export interface Interaction { id?: string; model?: string; status?: string; steps?: Step[]; usage?: Record<string, unknown>; error?: unknown }

/**
 * Cost of one Interactions call. Every call gemini.ts makes asks for an image (response_format type "image").
 * - 4xx (not 429) with no usage block: $0 (rejected; Google bills on tokens and reported none).
 * - Any other non-ok outcome (4xx WITH usage, 429, 5xx, timeout, connection error): UNRESOLVED.
 * - 200 with an image: priced from usage tokens, image-rate tokens required (Argus N13).
 * - 200 with no image (TECH-PLAN-v1-AMENDMENT-1.md row F9, :192): priced at the token estimate ONLY when
 *   isF9TextOnly() passes. Any other no-image 200 is row F15 (:198): settle from image-rate usage if it is
 *   present, otherwise UNRESOLVED; never priced at the $3/M text rate (Argus P2, Q1).
 * - A missing or incomplete usage block is always UNRESOLVED.
 */
export function geminiCost(r: CallResult, _estimate: number): StepCost {
  const j = r.json as Interaction | null;
  if (r.status !== null && r.status >= 400 && r.status < 500 && r.status !== 429 && !j?.usage) {
    return { usd: 0, basis: `estimated $0: HTTP ${r.status} error with no usage (Google bills on tokens; none reported)`, billed: false };
  }
  if (r.outcome !== "ok") return { usd: null, basis: `unresolved: ${r.outcome} status=${r.status}; reservation kept`, billed: false };
  const hasImage = outputImages(j).length > 0;
  const f9 = !hasImage && isF9TextOnly(j);
  const rule = hasImage ? "image returned" : f9 ? "F9 text-only reply" : "F15 no image, not text-only";
  const c = geminiCostFromUsage(j?.usage, { imageTokensRequired: !f9 });
  if ("error" in c) return { usd: null, basis: `unresolved: HTTP ${r.status} (${rule}) but ${c.error}; reservation kept until checked against Google Cloud billing`, billed: false };
  return { usd: c.usd, basis: `estimated from API usage tokens x published rates (${SOURCES.geminiPricing}) (${rule}): ${c.detail}; Gemini returns no billed-cost field`, billed: false };
}

/**
 * Amendment 1 row F9 (:192) text-only test. ALL must hold:
 * (1) every step is "thought" or "model_output"; (2) every block is {type:"text", text} with at least one
 * model_output text block (both in isTextOnlyAnswer); (3) no output_tokens_by_modality entry is an image,
 * compared after trim + lower case; (4) total_output_tokens is a count < 1120 (one 1K image).
 */
export function isF9TextOnly(j: Interaction | null): boolean {
  return isTextOnlyAnswer(j) && !hasImageModality(j) && belowOneImage(j);
}

/** Any output_tokens_by_modality entry whose modality is "image" in any letter case, spaces trimmed (F9 condition 3, Argus R2). */
function hasImageModality(j: Interaction | null): boolean {
  const mods = (isObj(j) && isObj(j.usage) ? j.usage.output_tokens_by_modality : undefined) as unknown;
  return Array.isArray(mods) && mods.some((m) => isObj(m) && typeof m.modality === "string" && normModality(m.modality) === "image");
}

/** total_output_tokens is a count below one 1K image's 1120 tokens (F9 condition 4, Argus Q1). */
function belowOneImage(j: Interaction | null): boolean {
  const out = (isObj(j) && isObj(j.usage) ? j.usage.total_output_tokens : undefined) as unknown;
  return typeof out === "number" && Number.isInteger(out) && out >= 0 && out < GEMINI.imageTokensPer1KImage;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * model_output content blocks, tolerating a response that breaks the schema (Argus Q2): a null step,
 * a `steps` or `content` that is not an array, or a null block is skipped instead of throwing.
 */
function outputBlocks(j: Interaction | null): Block[] {
  const out: Block[] = [];
  const steps = isObj(j) ? j.steps : undefined;
  if (!Array.isArray(steps)) return out;
  for (const s of steps) {
    if (!isObj(s) || s.type !== "model_output" || !Array.isArray(s.content)) continue;
    for (const b of s.content) if (isObj(b)) out.push(b as Block);
  }
  return out;
}
export function outputImages(j: Interaction | null): Block[] {
  return outputBlocks(j).filter((b) => b.type === "image" && typeof b.data === "string" && b.data.length > 0);
}
export function outputText(j: Interaction | null): string[] {
  return outputBlocks(j).filter((b) => b.type === "text" && typeof b.text === "string" && b.text.length > 0).map((b) => b.text as string);
}
/** Step types for results.json, null for a step that is not an object (Argus Q2); [] when there is no steps array (R4). */
export function stepTypes(j: Interaction | null): Array<string | null> {
  const steps = isObj(j) ? j.steps : undefined;
  return Array.isArray(steps) ? steps.map((s) => (isObj(s) && typeof s.type === "string" ? s.type : null)) : [];
}

/**
 * F9 conditions (1) and (2): every step is "thought" or "model_output", every content/summary block is
 * {type:"text", text}, and there is at least one model_output text block.
 * Anything else (an unknown step or block type, an image block without data) is NOT text-only.
 */
export function isTextOnlyAnswer(j: Interaction | null): boolean {
  const steps = j?.steps;
  if (!Array.isArray(steps) || steps.length === 0) return false;
  let texts = 0;
  for (const s of steps) {
    if (!isObj(s) || (s.type !== "thought" && s.type !== "model_output")) return false;
    for (const key of ["content", "summary"] as const) {
      const blocks = s[key];
      if (blocks === undefined) continue;
      if (!Array.isArray(blocks)) return false;
      for (const b of blocks) {
        if (!isObj(b) || b.type !== "text" || typeof b.text !== "string") return false;
        if (s.type === "model_output" && key === "content") texts++;
      }
    }
  }
  return texts > 0;
}
