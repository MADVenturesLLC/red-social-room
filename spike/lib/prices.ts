// Price table used ONLY for pre-call estimates (spend guard) and as a fallback when a provider
// returns no billed cost. Every number cites its source. Read on 2026-10-03.

export const SOURCES = {
  xaiPricing: "https://docs.x.ai/developers/pricing",
  xaiModel: "https://docs.x.ai/developers/models/grok-imagine-image-2.0",
  xaiCostTracking: "https://docs.x.ai/developers/cost-tracking",
  research: "madc-rulings/docs-drafts/red-social-room/RESEARCH-models.md:47-50",
  geminiPricing: "https://ai.google.dev/gemini-api/docs/pricing",
} as const;

// xAI. Live pricing page and model page (2026-10-03) say a flat "$0.04 / image" for grok-imagine-image-2.0.
// RESEARCH-models.md:48-50 recorded a tiered table (1K low $0.04, 1K medium $0.06, + $0.01 per input image,
// edit ~ $0.07). For the spend guard we use the HIGHER research numbers so the estimate is conservative.
export const XAI = {
  model: "grok-imagine-image-2.0",
  generateEstimateUsd: 0.06, // research 1K medium $0.06 (auto=low $0.04 for generation; guard rounds up)
  editEstimateUsd: 0.07, // research: $0.01 input + $0.06 1K medium output
  basis: `conservative: RESEARCH-models.md tiered price (1K medium $0.06 + $0.01/input image); live ${SOURCES.xaiPricing} lists flat $0.04/image`,
  ticksPerUsd: 1e10, // ${SOURCES.xaiCostTracking}: "One USD cent equals 100,000,000 ticks"
};

// Google gemini-3.1-flash-image (Nano Banana 2), standard paid tier, per 1M tokens (source: geminiPricing):
// input $0.50 (text/image); output $3 (text and thinking); output images $60 ("$0.067 per 1K image", 1120 tokens).
export const GEMINI = {
  model: "gemini-3.1-flash-image",
  inputPerMTok: 0.5,
  textThinkingOutputPerMTok: 3,
  imageOutputPerMTok: 60,
  per1KImageUsd: 0.067,
  generateEstimateUsd: 0.075, // $0.067 image + headroom for thinking/text tokens
  editEstimateUsd: 0.08, // + input image tokens
  basis: `${SOURCES.geminiPricing}: $0.067 per 1K image ($60/1M image output tokens) + $0.50/1M input + $3/1M text+thinking, rounded up`,
};

export interface GeminiUsage { total_input_tokens?: number; total_output_tokens?: number; total_thought_tokens?: number; output_tokens_by_modality?: Array<{ modality?: string; tokens?: number }> }

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/**
 * Usage-based Gemini cost: tokens reported by the API x published per-token rates. Not a billed figure.
 * Fails CLOSED (Argus N13): returns { error } instead of a number when the usage block is missing or lacks
 * the token fields the price depends on, so the caller keeps the reservation (unresolved) instead of
 * settling a billed call at ~$0. Required: total_input_tokens and total_output_tokens as integers > 0;
 * total_thought_tokens, if present, an integer >= 0; and, when the response carried an image, an
 * output_tokens_by_modality entry for "image" with tokens > 0 (otherwise $60/M image tokens would be
 * priced at the $3/M text rate).
 */
export function geminiCostFromUsage(u: unknown, opts: { imageReturned: boolean }): { usd: number; detail: string } | { error: string } {
  if (!u || typeof u !== "object" || Array.isArray(u)) return { error: "no usage block" };
  const g = u as GeminiUsage;
  const missing: string[] = [];
  if (!isCount(g.total_input_tokens) || g.total_input_tokens === 0) missing.push("total_input_tokens");
  if (!isCount(g.total_output_tokens) || g.total_output_tokens === 0) missing.push("total_output_tokens");
  if (g.total_thought_tokens !== undefined && !isCount(g.total_thought_tokens)) missing.push("total_thought_tokens (not a count)");
  const mods = g.output_tokens_by_modality;
  if (mods !== undefined && (!Array.isArray(mods) || mods.some((m) => !m || typeof m.modality !== "string" || !isCount(m.tokens)))) missing.push("output_tokens_by_modality (malformed)");
  const imgOut = Array.isArray(mods) ? mods.filter((m) => m?.modality === "image" && isCount(m.tokens)).reduce((a, m) => a + (m.tokens as number), 0) : 0;
  if (opts.imageReturned && imgOut === 0) missing.push("output_tokens_by_modality[image]");
  if (missing.length) return { error: `usage block missing/invalid: ${missing.join(", ")}` };
  const input = g.total_input_tokens as number;
  const thought = g.total_thought_tokens ?? 0;
  const out = g.total_output_tokens as number;
  if (imgOut > out) return { error: `usage block inconsistent: image tokens ${imgOut} > total_output_tokens ${out}` };
  const textOut = out - imgOut;
  const usd = (input * GEMINI.inputPerMTok + (textOut + thought) * GEMINI.textThinkingOutputPerMTok + imgOut * GEMINI.imageOutputPerMTok) / 1e6;
  return { usd, detail: `input ${input} tok x $0.50/M + text ${textOut} + thought ${thought} tok x $3/M + image ${imgOut} tok x $60/M` };
}
