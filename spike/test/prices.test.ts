// Gemini cost rule (Argus N13): a usage block without the expected token fields fails CLOSED.
import { test } from "node:test";
import assert from "node:assert/strict";
import { geminiCostFromUsage } from "../lib/prices.ts";
import { geminiCost } from "../lib/gemini-shape.ts";
import type { CallResult } from "../lib/http.ts";

const OK_USAGE = { total_input_tokens: 26, total_output_tokens: 1549, total_thought_tokens: 0, output_tokens_by_modality: [{ modality: "image", tokens: 1120 }] };
const resp = (status: number, json: unknown): CallResult => ({ outcome: status < 400 ? "ok" : "http_error", status, headers: {}, text: JSON.stringify(json), json, latency_ms: 1, total_ms: 1, attempts: [], retry_decision: "x" });
const withImage = (usage: unknown) => ({ status: "completed", steps: [{ type: "model_output", content: [{ type: "image", data: "AAAA" }] }], usage });
const textOnly = (usage: unknown) => ({ status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: "no" }] }], usage });

test("N13: complete usage is priced from tokens (matches the 10/03 generate: $0.0685)", () => {
  const c = geminiCostFromUsage(OK_USAGE, { imageReturned: true });
  assert.ok(!("error" in c));
  assert.equal(Math.round(c.usd * 1e6), 68500);
});

for (const [name, usage, image] of [
  ["no usage at all", undefined, true],
  ["usage {}", {}, true],
  ["renamed fields", { input_tokens: 26, output_tokens: 1549 }, true],
  ["zero output tokens", { total_input_tokens: 26, total_output_tokens: 0 }, false],
  ["non-integer tokens", { ...OK_USAGE, total_input_tokens: "26" }, true],
  ["image returned but no image modality", { total_input_tokens: 26, total_output_tokens: 1549 }, true],
  ["image tokens > total output", { ...OK_USAGE, total_output_tokens: 100 }, true],
  ["malformed modality list", { ...OK_USAGE, output_tokens_by_modality: [{ modality: "image" }] }, true],
] as Array<[string, unknown, boolean]>) {
  test(`N13: ${name} -> error (no $0 price)`, () => {
    assert.ok("error" in geminiCostFromUsage(usage, { imageReturned: image }));
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
