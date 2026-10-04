// runPaidStep with a fake network call (no network, no keys): outputs must be written before the ledger
// is settled, so a busy lock after a paid call cannot lose the result (Argus F3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, LedgerBusy } from "../lib/ledger.ts";
import { runPaidStep } from "../lib/step.ts";
import type { CallResult, CallSpec } from "../lib/http.ts";

const fakeOk = (body: unknown): CallResult => ({ outcome: "ok", status: 200, headers: { "content-type": "application/json" }, text: JSON.stringify(body), json: body, latency_ms: 5, total_ms: 5, attempts: [{ started_at: "t", status: 200, latency_ms: 5 }], retry_decision: "no retry needed" });
const spec: CallSpec = { keyName: "XAI_API_KEY", method: "POST", url: "https://example.invalid/never-called", body: { prompt: "x" } };

async function inDir(fn: (dir: string, l: Ledger) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "rsr-step-"));
  try { await fn(dir, Ledger.init(join(dir, "ledger.json"), { settleLockRetries: 3, settleLockRetryMs: 5 })); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("normal path: reserve -> call -> dump + persist -> settle", () => inDir(async (dir, l) => {
  const logs: string[] = [];
  const o = await runPaidStep({ ledger: l, provider: "xai", model: "m", label: "01-gen", outDir: dir, estimateUsd: 0.06, estimateBasis: "t", spec, log: (m) => logs.push(m),
    costOf: () => ({ usd: 0.04, basis: "billed", billed: true }), doCall: async () => fakeOk({ data: [] }),
    persist: () => { writeFileSync(join(dir, "img.bin"), "x"); return "saved"; } });
  assert.equal(o.persisted, "saved"); assert.equal(o.stop, false);
  assert.ok(existsSync(join(dir, "01-gen.json")));
  assert.equal(l.entries()[0].status, "settled"); assert.equal(l.totals().spikeAllTime, 0.04);
}));

test("F3: lock busy after the paid call -> dump and image are on disk, then LedgerBusy is rethrown", () => inDir(async (dir, l) => {
  const logs: string[] = [];
  const p = runPaidStep({ ledger: l, provider: "xai", model: "m", label: "01-gen", outDir: dir, estimateUsd: 0.06, estimateBasis: "t", spec, log: (m) => logs.push(m),
    costOf: () => ({ usd: 0.04, basis: "billed", billed: true }),
    doCall: async () => { writeFileSync(l.lockPath, ""); return fakeOk({ data: [{ b64_json: "AAAA" }] }); }, // another run grabs the lock
    persist: () => { writeFileSync(join(dir, "01-generated.jpg"), "img"); return "saved"; } });
  await assert.rejects(p, LedgerBusy);
  assert.ok(existsSync(join(dir, "01-gen.json")), "dump written");
  assert.equal(readFileSync(join(dir, "01-generated.jpg"), "utf8"), "img", "image written");
  assert.ok(logs.some((m) => m.startsWith("LEDGER UPDATE FAILED") && m.includes("Outputs already written")));
  unlinkSync(l.lockPath);
  assert.equal(l.entries()[0].status, "reserved", "reservation stays counted");
  assert.equal(l.totals().spikeAllTime, 0.06);
}));

test("F4 via step: a NaN cost from costOf is rejected after outputs are written", () => inDir(async (dir, l) => {
  await assert.rejects(runPaidStep({ ledger: l, provider: "google", model: "m", label: "02", outDir: dir, estimateUsd: 0.08, estimateBasis: "t", spec, log: () => {},
    costOf: () => ({ usd: NaN, basis: "bad", billed: false }), doCall: async () => fakeOk({}) }), RangeError);
  assert.ok(existsSync(join(dir, "02.json")));
  assert.equal(l.totals().spikeAllTime, 0.08);
}));

test("spend guard refusal returns before the call is made", () => inDir(async (dir, l) => {
  let called = false;
  const o = await runPaidStep({ ledger: l, provider: "xai", model: "m", label: "big", outDir: dir, estimateUsd: 3.5, estimateBasis: "t", spec, log: () => {},
    costOf: () => ({ usd: 0, basis: "x", billed: false }), doCall: async () => { called = true; return fakeOk({}); } });
  assert.equal(called, false); assert.equal(o.stop, true); assert.ok(o.refusedBySpendGuard);
}));

// ---- Argus Q2: a cost rule that throws must not lose the paid response ----
test("Q2: costOf throws -> response still dumped, row held UNRESOLVED (not settled), no throw, results recorded", () => inDir(async (dir, l) => {
  const logs: string[] = []; const recorded: unknown[] = [];
  const body = { id: "v1_x", steps: [null], usage: { total_input_tokens: 26, total_output_tokens: 1549 } };
  const o = await runPaidStep({ ledger: l, provider: "google", model: "m", label: "01-generate-3x4", outDir: dir, estimateUsd: 0.075, estimateBasis: "t", spec, log: (m) => logs.push(m),
    costOf: () => { throw new TypeError("Cannot read properties of null (reading 'type')"); }, doCall: async () => fakeOk(body),
    record: (x) => recorded.push(x) });
  const dump = JSON.parse(readFileSync(join(dir, "01-generate-3x4.json"), "utf8"));
  assert.deepEqual(dump.response.body, body, "raw response dumped");
  assert.equal(dump.cost.usd, null);
  assert.equal(o.ledgerStatus, "unresolved"); assert.equal(o.cost?.usd, null);
  assert.match(o.cost?.basis ?? "", /^unresolved: cost rule threw \(TypeError: /);
  const e = l.entries()[0];
  assert.equal(e.status, "unresolved"); assert.equal(e.actual_usd, null);
  assert.equal(l.totals().spikeAllTime, 0.075, "still counted at the estimate");
  assert.equal(recorded.length, 1);
  assert.ok(logs.some((m) => m.startsWith("COST RULE FAILED for 01-generate-3x4")));
}));
