// Leak-scan pattern rules and opt-in flags (offline).
import { test } from "node:test";
import assert from "node:assert/strict";
import { PATTERN_RULES, patternSelfTest, scanText, syntheticSamples, entropy } from "../lib/scan.ts";
import { FLAGS, optIn } from "../lib/flags.ts";

test("F5: every pattern rule fires on a synthetic sample; none fire on the negatives", () => {
  assert.deepEqual(patternSelfTest(), []);
  assert.ok(PATTERN_RULES.some((r) => r.id === "xai_key") && PATTERN_RULES.some((r) => r.id === "google_aq_key") && PATTERN_RULES.some((r) => r.id === "google_aiza_key") && PATTERN_RULES.some((r) => r.id === "generic_high_entropy_kv"));
});

test("F5: findings carry rule, line and length only (no matched text)", () => {
  const { positive } = syntheticSamples();
  const hits = scanText(`line one\n${positive.xai_key}\n`);
  assert.equal(hits.length, 1);
  assert.deepEqual(Object.keys(hits[0]).sort(), ["length", "line", "rule"]);
  assert.equal(hits[0].line, 2);
});

test("F5: generic key=value needs high entropy", () => {
  assert.equal(scanText(`api_key = "aaaaaaaaaaaaaaaaaaaaaaaa1"`).length, 0);
  assert.ok(entropy("abcd") === 2);
});

test("F1: refusal probe and xAI 4:5 probe are off by default and need exactly '1'", () => {
  for (const f of [FLAGS.refusalProbe, FLAGS.xai4x5Probe]) {
    assert.equal(optIn(f, {}), false);
    assert.equal(optIn(f, { [f]: "true" }), false);
    assert.equal(optIn(f, { [f]: "0" }), false);
    assert.equal(optIn(f, { [f]: "1" }), true);
  }
});

test("F1: in both scripts the real-person prompt is only reachable after the opt-in guard", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  for (const f of ["xai.ts", "gemini.ts"]) {
    const src = readFileSync(join(import.meta.dirname, "..", f), "utf8");
    const guard = src.indexOf("if (!optIn(FLAGS.refusalProbe))");
    const use = src.indexOf("PROMPTS.refusal");
    assert.ok(guard > 0, `${f}: guard missing`);
    assert.ok(use > guard, `${f}: PROMPTS.refusal used before the guard`);
    assert.equal(src.indexOf("PROMPTS.refusal", use + 1), -1, `${f}: PROMPTS.refusal used more than once`);
  }
  const x = readFileSync(join(import.meta.dirname, "..", "xai.ts"), "utf8");
  assert.ok(x.indexOf("if (optIn(FLAGS.xai4x5Probe))") > 0 && x.indexOf('genBody("4:5")') > x.indexOf("if (optIn(FLAGS.xai4x5Probe))"));
});
