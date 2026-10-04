// Behaviour tests for the paid scripts with a FAKE transport (Argus N2, N3, N9, N10, N13, P2, P6, Q1, Q2, Q5).
// Each test copies spike/ into a temp dir and runs the copy as a child process with:
//   - `--import fixtures/fetch-stub.mjs` (fetch replaced; every request recorded, nothing leaves the box)
//   - dummy key values only (the real XAI_API_KEY / GEMINI_API_KEY are never passed to the child)
//   - a fresh temp ledger, so the repo's spike-results/ is never touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Ledger } from "../lib/ledger.ts";
import { EXIT_SPEND_GUARD } from "../lib/step.ts";
import { PROMPTS } from "../prompts.ts";

const REPO = join(import.meta.dirname, "..", "..");
const STUB = join(import.meta.dirname, "fixtures", "fetch-stub.mjs");
interface Req { method: string; host: string; path: string; prompt: string | null; aspect_ratio: string | null; has_store: boolean; store: unknown }

function sandbox(opts: { priorXaiResults?: boolean; geminiDumps?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rsr-script-"));
  cpSync(join(REPO, "spike"), join(dir, "spike"), { recursive: true });
  cpSync(join(REPO, "package.json"), join(dir, "package.json"));
  mkdirSync(join(dir, "spike-results", "xai"), { recursive: true });
  mkdirSync(join(dir, "spike-results", "gemini"), { recursive: true });
  Ledger.init(join(dir, "spike-results", "ledger.json"));
  if (opts.priorXaiResults) cpSync(join(REPO, "spike-results", "xai", "results.json"), join(dir, "spike-results", "xai", "results.json"));
  if (opts.geminiDumps) {
    const src = join(REPO, "spike-results", "gemini");
    for (const f of readdirSync(src).filter((f) => f.endsWith(".json"))) cpSync(join(src, f), join(dir, "spike-results", "gemini", f));
    cpSync(join(src, "deletes"), join(dir, "spike-results", "gemini", "deletes"), { recursive: true });
  }
  return dir;
}

function run(dir: string, script: string, env: Record<string, string> = {}) {
  const log = join(dir, "requests.jsonl");
  const r = spawnSync(process.execPath, ["--import", STUB, join(dir, "spike", script)], {
    cwd: dir, encoding: "utf8", timeout: 60_000,
    env: { PATH: process.env.PATH ?? "", HOME: dir, STUB_LOG: log, XAI_API_KEY: "dummy-xai", GEMINI_API_KEY: "dummy-gem", ...env },
  });
  const reqs: Req[] = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { status: r.status, out: r.stdout + r.stderr, reqs, posts: reqs.filter((q) => q.method === "POST") };
}
const isRefusal = (q: Req) => q.prompt === PROMPTS.refusal;
const withSandbox = (fn: (dir: string) => void, o?: Parameters<typeof sandbox>[0]) => () => { const d = sandbox(o); try { fn(d); } finally { rmSync(d, { recursive: true, force: true }); } };

test("N2 xAI default run: sends gen 3:4 + 2 edits, no real-person probe, no 4:5", withSandbox((dir) => {
  const r = run(dir, "xai.ts");
  assert.equal(r.status, 0, r.out);
  assert.equal(r.posts.length, 3, r.out);
  assert.deepEqual(r.posts.map((q) => q.aspect_ratio), ["3:4", null, "16:9"]);
  assert.equal(r.posts.filter(isRefusal).length, 0);
  assert.equal(r.reqs.filter((q) => q.aspect_ratio === "4:5").length, 0);
  assert.match(r.out, /refusal probe skipped/);
  assert.match(r.out, /4:5 probe skipped/);
  // results.json describes this run's calls (recorded by runPaidStep after the ledger update)
  const OUT = join(dir, "spike-results", "xai");
  const res = JSON.parse(readFileSync(join(OUT, "results.json"), "utf8"));
  for (const label of ["01b-generate-3x4", "02-edit-background-red", "03-edit-aspect-16x9"]) {
    const dump = JSON.parse(readFileSync(join(OUT, `${label}.json`), "utf8"));
    assert.equal(res.steps[label].ledger_status, "settled", label);
    assert.equal(res.steps[label].latency_ms, dump.latency_ms, label);
  }
  assert.equal(res.steps["03-edit-aspect-16x9"].requested_aspect_ratio, "16:9");
  assert.equal(new Ledger(join(dir, "spike-results", "ledger.json")).totals().spikeAllTime, 0.18); // 0.04 + 0.07 + 0.07 billed
}));

test("N2 xAI RUN_REFUSAL_PROBE=1 sends the real-person probe (and still no 4:5)", withSandbox((dir) => {
  const r = run(dir, "xai.ts", { RUN_REFUSAL_PROBE: "1" });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.posts.length, 4);
  assert.equal(r.posts.filter(isRefusal).length, 1);
  assert.ok(isRefusal(r.posts[3]));
  assert.equal(r.reqs.filter((q) => q.aspect_ratio === "4:5").length, 0);
}));

test("N2 xAI RUN_XAI_4X5_PROBE=1 sends 4:5 first, then one 3:4 after the 422 (no real-person probe)", withSandbox((dir) => {
  const r = run(dir, "xai.ts", { RUN_XAI_4X5_PROBE: "1" });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.posts.map((q) => q.aspect_ratio), ["4:5", "3:4", null, "16:9"]);
  assert.equal(r.posts.filter(isRefusal).length, 0);
}));

test("N2 xAI flags must be exactly '1' (true/0/yes send nothing extra)", withSandbox((dir) => {
  const r = run(dir, "xai.ts", { RUN_REFUSAL_PROBE: "true", RUN_XAI_4X5_PROBE: "yes" });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.posts.length, 3);
  assert.equal(r.posts.filter(isRefusal).length + r.posts.filter((q) => q.aspect_ratio === "4:5").length, 0);
}));

test("N2 + N9 Gemini default run: 1 free GET + 4 POSTs, every POST has store:false, no real-person probe", withSandbox((dir) => {
  const r = run(dir, "gemini.ts");
  assert.equal(r.status, 0, r.out);
  assert.equal(r.reqs.filter((q) => q.method === "GET").length, 1);
  assert.equal(r.posts.length, 4, r.out);
  for (const q of r.posts) { assert.equal(q.has_store, true); assert.equal(q.store, false); }
  assert.equal(r.posts.filter(isRefusal).length, 0);
  assert.match(r.out, /refusal probe skipped/);
  const res = JSON.parse(readFileSync(join(dir, "spike-results", "gemini", "results.json"), "utf8"));
  for (const label of ["01-generate-3x4", "02-edit-background-red", "03-edit-aspect-16x9", "04-generate-4x5"]) assert.equal(res.steps[label].ledger_status, "settled", label);
}));

test("N2 + N9 Gemini RUN_REFUSAL_PROBE=1: 5 POSTs, the last is the probe, all store:false", withSandbox((dir) => {
  const r = run(dir, "gemini.ts", { RUN_REFUSAL_PROBE: "1" });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.posts.length, 5);
  assert.ok(isRefusal(r.posts[4]));
  assert.equal(r.posts.filter(isRefusal).length, 1);
  for (const q of r.posts) assert.equal(q.store, false);
}));

test("N3 xAI: lock grabbed after the paid call -> exit 1; results.json entry is THIS call's (not 10/03's), matching the new dump", withSandbox((dir) => {
  const OUT = join(dir, "spike-results", "xai");
  const before = JSON.parse(readFileSync(join(OUT, "results.json"), "utf8")).steps["01b-generate-3x4"];
  assert.equal(before.latency_ms, 11445); // the 2026-10-03 run's entry
  const r = run(dir, "xai.ts", { STUB_LOCK: join(dir, "spike-results", "ledger.lock"), STUB_FAST_SLEEP: "1" });
  assert.equal(r.status, 1, r.out);
  assert.equal(r.posts.length, 1, "run stops after the failed ledger update");
  assert.match(r.out, /LEDGER UPDATE FAILED/);
  const res = JSON.parse(readFileSync(join(OUT, "results.json"), "utf8"));
  const step = res.steps["01b-generate-3x4"];
  const dump = JSON.parse(readFileSync(join(OUT, "01b-generate-3x4.json"), "utf8"));
  assert.equal(step.ledger_status, "update_failed");
  assert.match(step.ledger_error, /stayed locked/);
  assert.equal(step.latency_ms, dump.latency_ms);
  assert.notEqual(step.latency_ms, 11445);
  assert.equal(step.http_status, dump.response.status);
  assert.equal(step.cost_usd, dump.cost.usd);
  assert.equal(step.output.file, "spike-results/xai/01-generated.png");
  assert.ok(existsSync(join(OUT, "01-generated.png")), "image saved");
  assert.equal(res.runs.at(-1).stopped_early, "error: LedgerBusy");
  rmSync(join(dir, "spike-results", "ledger.lock"));
  const l = new Ledger(join(dir, "spike-results", "ledger.json"));
  assert.equal(l.entries()[0].status, "reserved"); // still counted at the estimate
}, { priorXaiResults: true }));

test("N3 Gemini: same, results.json entry for 01-generate-3x4 matches the new dump after LedgerBusy", withSandbox((dir) => {
  const OUT = join(dir, "spike-results", "gemini");
  const r = run(dir, "gemini.ts", { STUB_LOCK: join(dir, "spike-results", "ledger.lock"), STUB_FAST_SLEEP: "1" });
  assert.equal(r.status, 1, r.out);
  const step = JSON.parse(readFileSync(join(OUT, "results.json"), "utf8")).steps["01-generate-3x4"];
  const dump = JSON.parse(readFileSync(join(OUT, "01-generate-3x4.json"), "utf8"));
  assert.equal(step.ledger_status, "update_failed");
  assert.equal(step.latency_ms, dump.latency_ms);
  assert.equal(step.interaction_id, "v1_stub");
}));

test("N13 Gemini: 200s with an empty usage block are held UNRESOLVED at the estimate, never settled at $0", withSandbox((dir) => {
  const r = run(dir, "gemini.ts", { STUB_GEMINI_USAGE: "empty" });
  assert.equal(r.status, 0, r.out);
  const l = new Ledger(join(dir, "spike-results", "ledger.json"));
  const rows = l.entries();
  assert.equal(rows.length, 4);
  for (const e of rows) { assert.equal(e.status, "unresolved"); assert.equal(e.actual_usd, null); assert.match(e.cost_basis ?? "", /usage block missing/); }
  assert.equal(l.totals().spikeAllTime, 0.31); // 0.075 + 0.08 + 0.08 + 0.075
}));

test("N10 delete-interactions: already done -> sends nothing by default; FORCE_REDELETE=1 re-sends", withSandbox((dir) => {
  const r = run(dir, "delete-interactions.ts");
  assert.equal(r.status, 0, r.out);
  assert.equal(r.reqs.length, 0);
  assert.match(r.out, /nothing sent/);
  const f = run(dir, "delete-interactions.ts", { FORCE_REDELETE: "1" });
  assert.equal(f.status, 0, f.out);
  assert.equal(f.reqs.filter((q) => q.method === "DELETE").length, 5);
  assert.equal(f.reqs.filter((q) => q.method === "GET").length, 5);
}, { geminiDumps: true }));

// ---- Argus P6: a spend-guard refusal makes the script exit non-zero (3), with nothing sent ----
const prefill = (dir: string, usd: number) => new Ledger(join(dir, "spike-results", "ledger.json")).reserve({ provider: "google", model: "m", label: "prefill", estimate_usd: usd, estimate_basis: "test" });

test("P6 xAI: stale ledger lock at start -> 0 POSTs, exit 3, results.json marks the refusal", withSandbox((dir) => {
  assert.equal(EXIT_SPEND_GUARD, 3);
  writeFileSync(join(dir, "spike-results", "ledger.lock"), "");
  const r = run(dir, "xai.ts");
  assert.equal(r.status, 3, r.out);
  assert.equal(r.reqs.length, 0);
  assert.match(r.out, /SPEND GUARD REFUSED 01b-generate-3x4/);
  assert.match(r.out, /delete spike-results\/ledger\.lock/);
  const res = JSON.parse(readFileSync(join(dir, "spike-results", "xai", "results.json"), "utf8"));
  assert.match(res.steps["01b-generate-3x4"].refused_by_spend_guard, /ledger is locked/);
  assert.equal(res.stopped_early, "spend guard");
}));

test("P6 xAI: spike cap reached mid-run -> stops before the call that would pass $3, exit 3", withSandbox((dir) => {
  prefill(dir, 2.88); // + gen 0.04 billed + edit 0.07 = 2.99; the second edit (est 0.07) would pass $3
  const r = run(dir, "xai.ts");
  assert.equal(r.status, 3, r.out);
  assert.equal(r.posts.length, 2, r.out);
  assert.match(r.out, /SPEND GUARD REFUSED 03-edit-aspect-16x9: Spike cap/);
}));

test("P6 Gemini: spike cap already reached -> only the free GET, exit 3", withSandbox((dir) => {
  prefill(dir, 2.95);
  const r = run(dir, "gemini.ts");
  assert.equal(r.status, 3, r.out);
  assert.equal(r.posts.length, 0);
  assert.equal(r.reqs.filter((q) => q.method === "GET").length, 1);
  assert.match(r.out, /SPEND GUARD REFUSED 01-generate-3x4: Spike cap/);
}));

test("P6: a run with no refusal still exits 0 (the exit code is tied to the refusal only)", withSandbox((dir) => {
  prefill(dir, 2.0);
  assert.equal(run(dir, "gemini.ts").status, 0);
}));

// ---- Argus P2 end to end: unrecognised image shape + no per-modality list -> unresolved, not text rate ----
test("P2 Gemini: a changed image block without output_tokens_by_modality is held unresolved at the estimate", withSandbox((dir) => {
  const r = run(dir, "gemini.ts", { STUB_GEMINI_SHAPE: "v2" });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.posts.length, 1, "stops after step 1: no image recognised");
  const rows = new Ledger(join(dir, "spike-results", "ledger.json")).entries();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "unresolved");
  assert.equal(rows[0].actual_usd, null);
  assert.match(rows[0].cost_basis ?? "", /output_tokens_by_modality\[image\]/);
}));

// ---- Argus Q1 end to end: his "gem-hole" response is held, not settled at $0.00466 ----
test("Q1 Gemini: image in an extra step key, no modality list, 1549 output tokens -> row unresolved (F15), not text rate", withSandbox((dir) => {
  const r = run(dir, "gemini.ts", { STUB_GEMINI_SHAPE: "hole" });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.posts.length, 1);
  const rows = new Ledger(join(dir, "spike-results", "ledger.json")).entries();
  assert.equal(rows[0].status, "unresolved");
  assert.equal(rows[0].actual_usd, null);
  assert.match(rows[0].cost_basis ?? "", /F15/);
}));

// ---- Argus Q2 end to end: steps:[null] no longer loses the paid response ----
test("Q2 Gemini: steps:[null] -> no throw; dump written; F15 settles from the image-rate usage; results.json describes the call; exit 0", withSandbox((dir) => {
  const OUT = join(dir, "spike-results", "gemini");
  const r = run(dir, "gemini.ts", { STUB_GEMINI_SHAPE: "nullstep" });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.posts.length, 1, "stops: no generated image");
  const dump = JSON.parse(readFileSync(join(OUT, "01-generate-3x4.json"), "utf8"));
  assert.deepEqual(dump.response.body.steps, [null]);
  const rows = new Ledger(join(dir, "spike-results", "ledger.json")).entries();
  assert.equal(rows[0].status, "settled"); // usage carries 1120 image tokens, so F15 settles at the image rate
  assert.equal(rows[0].actual_usd, 0.0685);
  assert.match(rows[0].cost_basis ?? "", /F15/);
  const res = JSON.parse(readFileSync(join(OUT, "results.json"), "utf8"));
  assert.equal(res.steps["01-generate-3x4"].ledger_status, "settled");
  assert.deepEqual(res.steps["01-generate-3x4"].step_types, [null]);
  assert.equal(res.stopped_early, "no generated image");
}));

// ---- Argus Q5: no key -> xai.ts still writes results.json via finish("no key") ----
test("Q5 xAI: no key -> nothing sent, exit 0, results.json records stopped_early 'no key'", withSandbox((dir) => {
  const r = run(dir, "xai.ts", { XAI_API_KEY: "" });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.reqs.length, 0);
  const res = JSON.parse(readFileSync(join(dir, "spike-results", "xai", "results.json"), "utf8"));
  assert.equal(res.stopped_early, "no key");
  assert.equal(res.runs.at(-1).stopped_early, "no key");
}));
