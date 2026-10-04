// xAI image response types and the per-call cost rule. Pure (no I/O), so tests can import it without
// running xai.ts (Argus P1).
import type { CallResult } from "./http.ts";
import type { StepCost } from "./step.ts";
import { XAI, SOURCES } from "./prices.ts";

export interface XaiImage { b64_json?: string; url?: string; mime_type?: string; revised_prompt?: string; respect_moderation?: boolean }
export interface XaiResp { data?: XaiImage[]; model?: string; usage?: { cost_in_usd_ticks?: number; [k: string]: unknown }; error?: unknown; code?: unknown }

/**
 * Cost of one xAI call. A billed figure (usage.cost_in_usd_ticks) wins whatever the status. Without it:
 * a 200 is priced at the estimate; the one observed pre-generation rejection (a non-JSON 422 body starting
 * "Failed to deserialize the JSON body") is $0; any other 4xx, a 429, a 5xx, a timeout or a connection
 * error is held UNRESOLVED at the reservation.
 */
export function xaiCost(r: CallResult, estimate: number): StepCost {
  const j = r.json as XaiResp | null;
  const ticks = j?.usage?.cost_in_usd_ticks;
  if (typeof ticks === "number") return { usd: ticks / XAI.ticksPerUsd, basis: `billed: usage.cost_in_usd_ticks=${ticks} (${SOURCES.xaiCostTracking})`, billed: true };
  if (r.outcome === "ok") return { usd: estimate, basis: `estimated (no usage field returned): ${XAI.basis}`, billed: false };
  if (r.status === 422 && r.json === null && /^Failed to deserialize the JSON body/.test(r.text)) {
    // Observed: schema/enum validation failures come back as a 422 text/plain body that STARTS with this
    // phrase, before any generation. A JSON body, or the phrase elsewhere in the text, is held (Argus Q3).
    return { usd: 0, basis: "estimated $0: HTTP 422 request-body deserialization error (rejected before generation, no usage field); confirm against console", billed: false };
  }
  if (r.status !== null && r.status >= 400 && r.status < 500 && r.status !== 429) {
    // xAI pricing page: "When your request is deemed to be in violation of our usage guideline by our system, we will still charge".
    return { usd: null, basis: `unresolved: HTTP ${r.status} with no usage field; xAI may still charge for guideline violations (${SOURCES.xaiPricing}); reservation kept until console check`, billed: false };
  }
  return { usd: null, basis: `unresolved: ${r.outcome} status=${r.status}; reservation kept`, billed: false };
}
