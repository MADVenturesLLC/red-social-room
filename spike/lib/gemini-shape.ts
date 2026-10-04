// Gemini Interactions response helpers and the per-call cost rule. Pure (no I/O), so tests can import it
// without running gemini.ts.
import type { CallResult } from "./http.ts";
import type { StepCost } from "./step.ts";
import { SOURCES, geminiCostFromUsage } from "./prices.ts";

export interface Block { type?: string; text?: string; data?: string; mime_type?: string }
export interface Step { type?: string; content?: Block[]; summary?: Block[] }
export interface Interaction { id?: string; model?: string; status?: string; steps?: Step[]; usage?: Record<string, unknown>; error?: unknown }

/**
 * Cost of one Interactions call. Exported for tests. A 200 whose usage block is missing or incomplete is
 * held UNRESOLVED at its reservation (Argus N13), never settled at ~$0.
 */
export function geminiCost(r: CallResult, _estimate: number): StepCost {
  const j = r.json as Interaction | null;
  if (r.status !== null && r.status >= 400 && r.status < 500 && r.status !== 429 && !j?.usage) {
    return { usd: 0, basis: `estimated $0: HTTP ${r.status} error with no usage (Google bills on tokens; none reported)`, billed: false };
  }
  if (r.outcome !== "ok") return { usd: null, basis: `unresolved: ${r.outcome} status=${r.status}; reservation kept`, billed: false };
  const c = geminiCostFromUsage(j?.usage, { imageReturned: outputImages(j).length > 0 });
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

