// B2 unit tests: Prompt optimization (TECH-PLAN-v1-AMENDMENT-1.md B2).
// Tests prompt rewriting, parser, token cost math, fake Google provider integration,
// real-person blocking, and ledger spend cap enforcement.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, fakeProviders, jsonRes } from "./helpers.ts";
import { googleDepsOf } from "../src/server/execute.ts";
import { toMicros } from "../spike/lib/ledger.ts";
import {
  buildOptimizePrompt,
  parseOptimizeReply,
  optimizeCostFromUsage,
  optimizePrompt,
  OptimizeInputError,
  OPTIMIZE_MODEL,
} from "../src/server/optimize.ts";

const optOk = (optimized: string, usage: Record<string, unknown> = { total_input_tokens: 150, total_output_tokens: 80, total_thought_tokens: 0 }) =>
  () => jsonRes(200, {
    id: "int-opt-1",
    status: "completed",
    model: OPTIMIZE_MODEL,
    steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify({ optimized }) }] }],
    usage,
  }, { "x-request-id": "opt-req-1" });

test("B2 prompt builder & parser: strict JSON schema parsing and whitespace trimming", () => {
  const p = buildOptimizePrompt("red sports car");
  assert.match(p, /red sports car/);
  assert.match(p, /expert prompt engineer/);

  const good = parseOptimizeReply(JSON.stringify({ optimized: "  A sleek red sports car under neon city lights.  " }));
  assert.equal(good.ok, true);
  if (good.ok) {
    assert.equal(good.optimized, "A sleek red sports car under neon city lights.");
  }

  const badJson = parseOptimizeReply("not json");
  assert.equal(badJson.ok, false);
  if (!badJson.ok) assert.match(badJson.error, /not JSON/);

  const missingKey = parseOptimizeReply(JSON.stringify({ wrong_key: "something" }));
  assert.equal(missingKey.ok, false);
  if (!missingKey.ok) assert.match(missingKey.error, /did not contain an optimized prompt/);

  const emptyText = parseOptimizeReply(JSON.stringify({ optimized: "   " }));
  assert.equal(emptyText.ok, false);
  if (!emptyText.ok) assert.match(emptyText.error, /did not contain an optimized prompt/);
});

test("B2 cost math: Flash-Lite rates from usage tokens ($0.25 in / $1.50 out per 1M)", () => {
  // 1000 in ($0.00025) + 200 out ($0.00030) = $0.00055 = 550 micro-USD
  const a = optimizeCostFromUsage({ total_input_tokens: 1000, total_output_tokens: 200, total_thought_tokens: 0 });
  assert.ok(!("error" in a));
  if (!("error" in a)) {
    assert.equal(toMicros(a.usd), 550);
    assert.match(a.detail, /1000 input/);
  }

  // With thought tokens
  const b = optimizeCostFromUsage({ total_input_tokens: 500, total_output_tokens: 50, total_thought_tokens: 50 });
  assert.ok(!("error" in b));
  if (!("error" in b)) {
    // 500 * 0.25 + 100 * 1.5 = 125 + 150 = 275 micro-USD
    assert.equal(toMicros(b.usd), 275);
  }

  assert.ok("error" in optimizeCostFromUsage({}));
  assert.ok("error" in optimizeCostFromUsage({ total_input_tokens: -1 }));
});

test("B2 optimizePrompt: rewrites prompt via fake Google, settles cost from tokens into spend_ledger", async () => {
  const p = fakeProviders({
    google: {
      interactions: [optOk("A cherry red vintage sports car gleaming under wet asphalt and ambient neon reflection, 35mm photograph.")]
    }
  });
  const t = makeApp({ fetch: p.fetch });
  const out = await optimizePrompt(googleDepsOf(t.app), t.app.promptMethod, "red sports car");

  assert.equal(out.kind, "ok", JSON.stringify(out));
  assert.equal(out.prompt, "red sports car");
  assert.equal(out.optimized, "A cherry red vintage sports car gleaming under wet asphalt and ambient neon reflection, 35mm photograph.");
  assert.equal(out.model, "gemini-3.1-flash-lite");
  assert.ok(out.cost);
  assert.equal(out.cost?.source, "estimated_tokens");

  // Verify interaction request sent to Google
  const sent = p.google.posts().filter((r) => r.path === "/v1beta/interactions");
  assert.equal(sent.length, 1);
  const body = sent[0].body as { model: string; store: boolean; response_format: { type: string; mime_type: string }; input: Array<{ type: string; text?: string }> };
  assert.equal(body.model, "gemini-3.1-flash-lite");
  assert.equal(body.store, false, "store: false on Google interactions");
  assert.equal(body.response_format.type, "text");
  assert.equal(body.response_format.mime_type, "application/json");
  assert.match(body.input[0].text ?? "", /red sports car/);

  // Check ledger entry
  const row = t.app.db.prepare("SELECT * FROM spend_ledger WHERE id = ?").get(out.clientRequestId) as Record<string, unknown>;
  assert.ok(row);
  assert.equal(row.kind, "prompt_optimize");
  assert.equal(row.provider, "google");
  assert.equal(row.model, "gemini-3.1-flash-lite");
  assert.equal(row.status, "settled");
  assert.equal(row.cost_source, "estimated_tokens");
  assert.ok(Number(row.actual_micro_usd) > 0);
});

test("B2 optimizePrompt: real-person check blocks prompt before sending (zero spend, no network call)", async () => {
  const p = fakeProviders();
  const t = makeApp({ fetch: p.fetch });
  // Stub check flags names from names.txt ("Tom Hanks" is seeded in makeApp)
  const out = await optimizePrompt(googleDepsOf(t.app), t.app.promptMethod, "Tom Hanks driving a sports car");
  assert.equal(out.kind, "blocked");
  assert.equal(out.optimized, null);
  assert.equal(out.cost?.micros, 0);

  // Zero calls made to Google
  const sent = p.google.posts().filter((r) => r.path === "/v1beta/interactions");
  assert.equal(sent.length, 0);
});

test("B2 optimizePrompt: input validation throws OptimizeInputError for empty prompts", async () => {
  const p = fakeProviders();
  const t = makeApp({ fetch: p.fetch });
  await assert.rejects(
    () => optimizePrompt(googleDepsOf(t.app), t.app.promptMethod, "   "),
    (err: unknown) => err instanceof OptimizeInputError && err.message === "Type a prompt first."
  );
});

test("B2 optimizePrompt: unreadable reply reports error and settles billed usage", async () => {
  const p = fakeProviders({
    google: {
      interactions: [() => jsonRes(200, {
        id: "int-opt-unreadable",
        status: "completed",
        model: OPTIMIZE_MODEL,
        steps: [{ type: "model_output", content: [{ type: "text", text: "This is not valid json {" }] }],
        usage: { total_input_tokens: 150, total_output_tokens: 40, total_thought_tokens: 0 },
      })]
    }
  });
  const t = makeApp({ fetch: p.fetch });
  const out = await optimizePrompt(googleDepsOf(t.app), t.app.promptMethod, "cozy reading nook");
  assert.equal(out.kind, "error");
  assert.equal(out.code, "unreadable");
  assert.equal(out.optimized, null);
  assert.match(out.message ?? "", /not JSON/);
  // Cost is still recorded for unreadable reply
  assert.ok(out.cost && out.cost.micros !== null && out.cost.micros > 0);
});

test("B2 optimizePrompt: cap refusal prevents network send", async () => {
  const p = fakeProviders();
  // Set cap to $0 so any reservation fails
  const t = makeApp({ fetch: p.fetch, capUsd: 0 });

  const out = await optimizePrompt(googleDepsOf(t.app), t.app.promptMethod, "mountain vista");
  assert.equal(out.kind, "error");
  assert.equal(out.code, "cap");
  assert.match(out.message ?? "", /Monthly cap/);
  // Zero network calls
  assert.equal(p.google.posts().length, 0);
});

test("B2 POST /api/optimize route: answers 200 with result, guards against bad input", async () => {
  const p = fakeProviders({
    google: {
      interactions: [optOk("A sunny meadow with wildflowers, golden hour backlight, macro depth of field.")]
    }
  });
  const t = makeApp({ fetch: p.fetch });
  const g = globalThis as typeof globalThis & { __rsrApp?: unknown };
  g.__rsrApp = t.app;
  try {
    const { POST: optimizeRoute } = await import("../src/app/api/optimize/route.ts");
    const req = new Request("http://localhost:3000/api/optimize", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-rsr": "1", host: "localhost:3000" },
      body: JSON.stringify({ prompt: "sunny meadow" }),
    });
    const res = await optimizeRoute(req);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok?: boolean; kind: string; optimized?: string };
    assert.equal(body.kind, "ok");
    assert.equal(body.optimized, "A sunny meadow with wildflowers, golden hour backlight, macro depth of field.");

    // Bad request: empty prompt
    const badReq = new Request("http://localhost:3000/api/optimize", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-rsr": "1", host: "localhost:3000" },
      body: JSON.stringify({ prompt: "   " }),
    });
    const badRes = await optimizeRoute(badReq);
    assert.equal(badRes.status, 400);
  } finally {
    delete g.__rsrApp;
    t.cleanup();
  }
});
