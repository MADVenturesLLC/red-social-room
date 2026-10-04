// Cost rules (Argus N13, P1, P2): an unknown cost is held UNRESOLVED (usd null), never settled at $0.
import { test } from "node:test";
import assert from "node:assert/strict";
import { geminiCostFromUsage } from "../lib/prices.ts";
import { geminiCost, isTextOnlyAnswer } from "../lib/gemini-shape.ts";
import { xaiCost } from "../lib/xai-shape.ts";
import type { CallResult } from "../lib/http.ts";

const OK_USAGE = { total_input_tokens: 26, total_output_tokens: 1549, total_thought_tokens: 0, output_tokens_by_modality: [{ modality: "image", tokens: 1120 }] };
const resp = (status: number | null, json: unknown, o: Partial<CallResult> = {}): CallResult => ({ outcome: status !== null && status < 400 ? "ok" : "http_error", status, headers: {}, text: typeof json === "string" ? json : JSON.stringify(json), json: typeof json === "string" ? null : json, latency_ms: 1, total_ms: 1, attempts: [], retry_decision: "x", ...o });
const withImage = (usage: unknown) => ({ status: "completed", steps: [{ type: "model_output", content: [{ type: "image", data: "AAAA" }] }], usage });
const textOnly = (usage: unknown) => ({ status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: "no" }] }], usage });

test("N13: complete usage is priced from tokens (matches the 10/03 generate: $0.0685)", () => {
  const c = geminiCostFromUsage(OK_USAGE, { imageTokensRequired: true });
  assert.ok(!("error" in c));
  assert.equal(Math.round(c.usd * 1e6), 68500);
});

for (const [name, usage, image] of [
  ["no usage at all", undefined, true],
  ["usage {}", {}, true],
  ["renamed fields", { input_tokens: 26, output_tokens: 1549 }, true],
  ["zero output tokens", { total_input_tokens: 26, total_output_tokens: 0 }, false],
  ["zero input tokens (P1)", { total_input_tokens: 0, total_output_tokens: 18 }, false],
  ["thought tokens not a count (P4/A20)", { total_input_tokens: 40, total_output_tokens: 18, total_thought_tokens: "x" }, false],
  ["malformed entry next to a valid image entry (P4/A15)", { ...OK_USAGE, output_tokens_by_modality: [{ modality: "image", tokens: 1120 }, { modality: "text", tokens: "5" }] }, true],
  ["non-integer tokens", { ...OK_USAGE, total_input_tokens: "26" }, true],
  ["image returned but no image modality", { total_input_tokens: 26, total_output_tokens: 1549 }, true],
  ["image tokens > total output", { ...OK_USAGE, total_output_tokens: 100 }, true],
  ["malformed modality list", { ...OK_USAGE, output_tokens_by_modality: [{ modality: "image" }] }, true],
] as Array<[string, unknown, boolean]>) {
  test(`N13: ${name} -> error (no $0 price)`, () => {
    assert.ok("error" in geminiCostFromUsage(usage, { imageTokensRequired: image }));
  });
}

test("N13: geminiCost holds a 200 with incomplete usage as unresolved (usd null), not $0", () => {
  for (const u of [undefined, {}, { total_input_tokens: 26, total_output_tokens: 1549 }]) {
    const c = geminiCost(resp(200, withImage(u)), 0.075);
    assert.equal(c.usd, null);
    assert.match(c.basis, /^unresolved/);
  }
  const refusal = geminiCost(resp(200, textOnly({ total_input_tokens: 40, total_output_tokens: 18, total_thought_tokens: 0 })), 0.075);
  assert.equal(Math.round((refusal.usd as number) * 1e6), 74); // text-only refusal is priced (no image tokens expected)
  assert.equal(geminiCost(resp(400, { error: { code: 400 } }), 0.075).usd, 0); // 4xx with no usage: $0 (unchanged)
});

// ---- Argus P1: every hold-unknown-cost path, one row per status class ----
const NO_COST = (c: { usd: number | null; basis: string }, why: string) => { assert.equal(c.usd, null, why); assert.match(c.basis, /^unresolved/, why); };

test("P1 Gemini: 4xx WITH usage, 429, 5xx, timeout and connection error are held unresolved; 4xx without usage is $0", () => {
  NO_COST(geminiCost(resp(400, { error: { code: 400 }, usage: OK_USAGE }), 0.075), "4xx with usage (tokens were reported)");
  NO_COST(geminiCost(resp(429, { error: { code: 429 } }), 0.075), "429");
  NO_COST(geminiCost(resp(500, { error: { code: 500 } }), 0.075), "500");
  NO_COST(geminiCost(resp(503, withImage(OK_USAGE)), 0.075), "503 even with a usage block");
  NO_COST(geminiCost(resp(null, null, { outcome: "timeout", text: "" }), 0.075), "timeout");
  NO_COST(geminiCost(resp(null, null, { outcome: "connection_error", text: "" }), 0.075), "connection error");
  const rejected = geminiCost(resp(404, { error: { code: 404 } }), 0.075);
  assert.equal(rejected.usd, 0); assert.match(rejected.basis, /no usage/);
  assert.equal(Math.round((geminiCost(resp(200, withImage(OK_USAGE)), 0.075).usd as number) * 1e6), 68500); // full usage: priced
});

test("P1 xAI: billed ticks win; 200 without usage = estimate; only the deserialize 422 is $0; other 4xx/429/5xx/timeout are unresolved", () => {
  const billed = xaiCost(resp(200, { data: [], usage: { cost_in_usd_ticks: 400000000 } }), 0.06);
  assert.equal(billed.usd, 0.04); assert.equal(billed.billed, true);
  assert.equal(xaiCost(resp(400, { error: "guideline", usage: { cost_in_usd_ticks: 200000000 } }), 0.06).usd, 0.02); // charged violation
  assert.equal(xaiCost(resp(200, { data: [] }), 0.06).usd, 0.06);
  const deser = xaiCost(resp(422, "Failed to deserialize the JSON body into the target type: aspect_ratio: unknown variant `4:5`"), 0.06);
  assert.equal(deser.usd, 0); assert.match(deser.basis, /deserialization/);
  NO_COST(xaiCost(resp(422, { error: "Unprocessable: prompt rejected by moderation" }), 0.06), "422 that is not a deserialize error (A19)");
  for (const st of [400, 403, 404]) NO_COST(xaiCost(resp(st, { error: "x" }), 0.06), `HTTP ${st} (A18)`);
  const rl = xaiCost(resp(429, { error: "slow down" }), 0.06);
  NO_COST(rl, "429");
  assert.doesNotMatch(rl.basis, /guideline/, "a 429 is a rate limit, not a guideline-violation charge");
  NO_COST(xaiCost(resp(500, { error: "x" }), 0.06), "500");
  NO_COST(xaiCost(resp(null, null, { outcome: "timeout", text: "" }), 0.06), "timeout");
});

// ---- Argus P2: an unrecognised image block shape must not be priced at the text rate ----
test("P2: no image parsed + no per-modality list -> unresolved unless the answer is plain text", () => {
  const noModalities = { total_input_tokens: 26, total_output_tokens: 1549, total_thought_tokens: 0 };
  const shapes: Array<[string, unknown]> = [
    ["image block renamed", { status: "completed", steps: [{ type: "model_output", content: [{ type: "generated_image", inline_data: { data: "AAAA" } }] }] }],
    ["image block with data moved", { status: "completed", steps: [{ type: "model_output", content: [{ type: "image", inline_data: "AAAA" }] }] }],
    ["image in a new step type next to text", { status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: "here" }] }, { type: "image_output", content: [] }] }],
    ["no steps at all", { status: "completed" }],
    ["empty model_output", { status: "completed", steps: [{ type: "model_output", content: [] }] }],
  ];
  for (const [name, j] of shapes) {
    assert.equal(isTextOnlyAnswer(j as never), false, name);
    NO_COST(geminiCost(resp(200, { ...(j as object), usage: noModalities }), 0.075), name);
  }
  // the recorded refusal shape (thought step + text answer, no per-modality list) is still priced
  const refusal = { status: "completed", steps: [{ type: "thought", content: [], summary: [{ type: "text", text: "thinking" }] }, { type: "model_output", content: [{ type: "text", text: "I can't" }] }], usage: { total_input_tokens: 40, total_output_tokens: 18, total_thought_tokens: 0 } };
  assert.equal(isTextOnlyAnswer(refusal as never), true);
  assert.equal(Math.round((geminiCost(resp(200, refusal), 0.075).usd as number) * 1e6), 74);
});
