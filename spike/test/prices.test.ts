// Cost rules (Argus N13, P1, P2): an unknown cost is held UNRESOLVED (usd null), never settled at $0.
import { test } from "node:test";
import assert from "node:assert/strict";
import { geminiCostFromUsage } from "../lib/prices.ts";
import { geminiCost, isTextOnlyAnswer, isF9TextOnly, outputImages, outputText, stepTypes } from "../lib/gemini-shape.ts";
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
  for (const st of [400, 401, 403, 404]) {
    const rejected = geminiCost(resp(st, { error: { code: st } }), 0.075);
    assert.equal(rejected.usd, 0, `HTTP ${st}`); assert.match(rejected.basis, /no usage/);
  }
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

// ---- Argus Q1 / Amendment 1 row F9 (:190) and F15 (:196) ----
// A no-image 200 is priced at the token estimate only when ALL four F9 conditions hold; otherwise F15.
const TEXT_REPLY = { status: "completed", steps: [{ type: "thought", content: [] }, { type: "model_output", content: [{ type: "text", text: "I can't" }] }] };
const textUsage = (out: number, mods?: unknown) => ({ total_input_tokens: 40, total_output_tokens: out, total_thought_tokens: 0, ...(mods ? { output_tokens_by_modality: mods } : {}) });
const TEXT_RATE = (out: number) => Math.round((40 * 0.5 + out * 3) / 1e6 * 1e6) / 1e6;

test("Q1/F9: Argus's $0.0047 example (image outside content, 1549 output tokens, no modality list) is held UNRESOLVED", () => {
  const hole = { status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: "Here is your image" }], images: [{ data: "AAAA", mime_type: "image/png" }] }], usage: { total_input_tokens: 26, total_output_tokens: 1549, total_thought_tokens: 0 } };
  assert.equal(isF9TextOnly(hole as never), false);
  NO_COST(geminiCost(resp(200, hole), 0.075), "image elsewhere, 1549 tokens");
  assert.match(geminiCost(resp(200, hole), 0.075).basis, /F15/);
});

test("Q1/F9: all four conditions hold -> priced at the token estimate (refusal $0.000074; boundary 1119 tokens)", () => {
  const ok = geminiCost(resp(200, { ...TEXT_REPLY, usage: textUsage(18) }), 0.075);
  assert.equal(Math.round((ok.usd as number) * 1e6), 74); assert.match(ok.basis, /F9 text-only/);
  const edge = geminiCost(resp(200, { ...TEXT_REPLY, usage: textUsage(1119, [{ modality: "text", tokens: 1119 }]) }), 0.075);
  assert.equal(Math.round((edge.usd as number) * 1e6), Math.round(TEXT_RATE(1119) * 1e6));
});

test("Q1/F9 condition 1 fails alone (a step that is not thought/model_output) -> F15, unresolved", () => {
  const j = { status: "completed", steps: [...TEXT_REPLY.steps, { type: "image_output", content: [] }], usage: textUsage(18) };
  assert.equal(isF9TextOnly(j as never), false);
  NO_COST(geminiCost(resp(200, j), 0.075), "unknown step type");
});

test("Q1/F9 condition 2 fails alone (a block that is not {type:text,text}) -> F15, unresolved", () => {
  for (const [name, steps] of [
    ["unknown block type", [{ type: "model_output", content: [{ type: "text", text: "hi" }, { type: "generated_image", inline_data: { data: "AAAA" } }] }]],
    ["text not a string (B4)", [{ type: "model_output", content: [{ type: "text", text: "hi" }, { type: "text", text: 5 }] }]],
    ["blocks not an array (B2)", [{ type: "model_output", content: [{ type: "text", text: "hi" }] }, { type: "thought", summary: "thinking" }]],
    ["only a thought summary, no model_output text (B3)", [{ type: "thought", summary: [{ type: "text", text: "t" }] }]],
  ] as Array<[string, unknown[]]>) {
    const j = { status: "completed", steps, usage: textUsage(18) };
    assert.equal(isTextOnlyAnswer(j as never), false, name);
    NO_COST(geminiCost(resp(200, j), 0.075), name);
  }
});

test("Q1/F9 condition 3 fails alone (an image modality entry, any case) -> F15: settled from image-rate usage, not the text rate", () => {
  for (const name of ["IMAGE", "Image", "image"]) {
    const j = { ...TEXT_REPLY, usage: textUsage(1000, [{ modality: name, tokens: 900 }, { modality: "TEXT", tokens: 100 }]) };
    assert.equal(isF9TextOnly(j as never), false, name);
    const c = geminiCost(resp(200, j), 0.075);
    assert.equal(Math.round((c.usd as number) * 1e6), 54320, name); // 40 x $0.5/M + 100 x $3/M + 900 x $60/M
    assert.match(c.basis, /F15/);
  }
  // with an image returned, an upper-case "IMAGE" modality is still read as image tokens (case-insensitive)
  const img = geminiCost(resp(200, withImage({ ...OK_USAGE, output_tokens_by_modality: [{ modality: "IMAGE", tokens: 1120 }] })), 0.075);
  assert.equal(Math.round((img.usd as number) * 1e6), 68500);
});

test("Q1/F9 condition 4 fails alone (total_output_tokens >= 1120) -> F15, unresolved", () => {
  for (const out of [1120, 1549]) {
    const j = { ...TEXT_REPLY, usage: textUsage(out, [{ modality: "text", tokens: out }]) };
    assert.equal(isTextOnlyAnswer(j as never), true);
    assert.equal(isF9TextOnly(j as never), false, String(out));
    NO_COST(geminiCost(resp(200, j), 0.075), `${out} output tokens`);
  }
});

// ---- Argus Q2: schema-breaking 200s never throw in the shape helpers ----
test("Q2: null steps/blocks and non-array steps/content are tolerated by every helper", () => {
  for (const [name, j] of [
    ["null step", { steps: [null] }],
    ["steps not an array", { steps: "oops" }],
    ["steps an object", { steps: { type: "model_output", content: [] } }],
    ["steps a number", { steps: 7 }],
    ["content not an array", { steps: [{ type: "model_output", content: { type: "image", data: "AAAA" } }] }],
    ["null block", { steps: [{ type: "model_output", content: [null, { type: "text", text: "hi" }] }] }],
    ["body is a number", 5],
    ["body is an array", [1, 2]],
  ] as Array<[string, unknown]>) {
    assert.doesNotThrow(() => { outputImages(j as never); outputText(j as never); stepTypes(j as never); isTextOnlyAnswer(j as never); }, name);
    const c = geminiCost(resp(200, j), 0.075);
    assert.equal(c.usd, null, name);
  }
  assert.deepEqual(outputText({ steps: [{ type: "model_output", content: [null, { type: "text", text: "hi" }] }] } as never), ["hi"]);
  assert.deepEqual(stepTypes({ steps: [null, { type: "thought" }] } as never), [null, "thought"]);
  assert.equal(stepTypes({ steps: "x" } as never), null);
});

// ---- Argus Q3: the xAI $0 rule needs a NON-JSON 422 body that STARTS with the deserialize phrase ----
test("Q3 xAI: a 422 JSON body, or the phrase mid-string, is held unresolved", () => {
  NO_COST(xaiCost(resp(422, { error: "Failed to deserialize the JSON body: prompt flagged by moderation" }), 0.06), "422 JSON containing the phrase");
  NO_COST(xaiCost(resp(422, "Request rejected. Failed to deserialize the JSON body into the target type"), 0.06), "phrase mid-string");
  NO_COST(xaiCost(resp(422, "failed to deserialize the json body (lower case)"), 0.06), "case differs");
  NO_COST(xaiCost(resp(400, "Failed to deserialize the JSON body into the target type"), 0.06), "same text but HTTP 400");
  // r.json === null is required too (defence in depth: today a body starting with "F" never parses as JSON)
  NO_COST(xaiCost(resp(422, "Failed to deserialize the JSON body into the target type", { json: { error: "x" } }), 0.06), "parsed JSON body");
  assert.equal(xaiCost(resp(422, "Failed to deserialize the JSON body into the target type: aspect_ratio: unknown variant `4:5`"), 0.06).usd, 0);
});
