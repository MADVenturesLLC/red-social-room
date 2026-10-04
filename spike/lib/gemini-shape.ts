// Gemini Interactions response helpers and the per-call cost rule. Pure (no I/O), so tests can import it
// without running gemini.ts.
import type { CallResult } from "./http.ts";
import type { StepCost } from "./step.ts";
import { SOURCES, geminiCostFromUsage } from "./prices.ts";

export interface Block { type?: string; text?: string; data?: string; mime_type?: string }
export interface Step { type?: string; content?: Block[]; summary?: Block[] }
export interface Interaction { id?: string; model?: string; status?: string; steps?: Step[]; usage?: Record<string, unknown>; error?: unknown }

/**
 * Cost of one Interactions call. Every call gemini.ts makes asks for an image (response_format type "image").
 * - 4xx (not 429) with no usage block: $0 (rejected; Google bills on tokens and reported none).
 * - Any other non-ok outcome (4xx WITH usage, 429, 5xx, timeout, connection error): UNRESOLVED.
 * - 200: priced from usage tokens. A missing or incomplete usage block is UNRESOLVED (Argus N13).
 *   Image-rate tokens (output_tokens_by_modality "image") are required unless the response is a
 *   recognised text-only answer (Argus P2): if Google changes the image block shape, the image is not
 *   recognised, the answer is not "text only", so the call is held unresolved instead of priced at the
 *   $3/M text rate. A plain text refusal (05-refusal-probe.json has no per-modality list) is still priced.
 */
export function geminiCost(r: CallResult, _estimate: number): StepCost {
  const j = r.json as Interaction | null;
  if (r.status !== null && r.status >= 400 && r.status < 500 && r.status !== 429 && !j?.usage) {
    return { usd: 0, basis: `estimated $0: HTTP ${r.status} error with no usage (Google bills on tokens; none reported)`, billed: false };
  }
  if (r.outcome !== "ok") return { usd: null, basis: `unresolved: ${r.outcome} status=${r.status}; reservation kept`, billed: false };
  const c = geminiCostFromUsage(j?.usage, { imageTokensRequired: outputImages(j).length > 0 || !isTextOnlyAnswer(j) });
  if ("error" in c) return { usd: null, basis: `unresolved: HTTP ${r.status} but ${c.error}; reservation kept until checked against Google Cloud billing`, billed: false };
  return { usd: c.usd, basis: `estimated from API usage tokens x published rates (${SOURCES.geminiPricing}): ${c.detail}; Gemini returns no billed-cost field`, billed: false };
}

export function outputImages(j: Interaction | null): Block[] {
  const out: Block[] = [];
  for (const s of j?.steps ?? []) if (s.type === "model_output") for (const b of s.content ?? []) if (b.type === "image" && b.data) out.push(b);
  return out;
}
export function outputText(j: Interaction | null): string[] {
  const out: string[] = [];
  for (const s of j?.steps ?? []) if (s.type === "model_output") for (const b of s.content ?? []) if (b.type === "text" && b.text) out.push(b.text);
  return out;
}

/**
 * True only for a response we fully recognise as text: every step is "thought" or "model_output", every
 * content/summary block is {type:"text", text}, and there is at least one model_output text block.
 * Anything else (an unknown step or block type, an image block without data) is NOT text-only.
 */
export function isTextOnlyAnswer(j: Interaction | null): boolean {
  const steps = j?.steps;
  if (!Array.isArray(steps) || steps.length === 0) return false;
  let texts = 0;
  for (const s of steps) {
    if (!s || (s.type !== "thought" && s.type !== "model_output")) return false;
    for (const key of ["content", "summary"] as const) {
      const blocks = s[key];
      if (blocks === undefined) continue;
      if (!Array.isArray(blocks)) return false;
      for (const b of blocks) {
        if (!b || b.type !== "text" || typeof b.text !== "string") return false;
        if (s.type === "model_output" && key === "content") texts++;
      }
    }
  }
  return texts > 0;
}
