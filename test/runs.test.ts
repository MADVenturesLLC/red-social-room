// A2 run queue: creator cards, per-provider concurrency, partial results, blocked prompts (Amendment 1
// section 4 item 11; F10/F12/F20). Scripted fake providers only; no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startRun, runView, parseRunInput, resetStrandedJobs, RunInputError } from "../src/server/runs.ts";
import { BLOCKED_TEXT } from "../src/server/prompt-check.ts";
import { monthTotals } from "../src/server/ledger.ts";
import { makeApp, fakeProviders, genOk, jsonRes, ledgerRows } from "./helpers.ts";
import type { Handler } from "./helpers.ts";

async function until(fn: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting for the run");
    await new Promise((r) => setTimeout(r, 10));
  }
}
const start = (t: ReturnType<typeof makeApp>, creators: Array<{ id: string; n: number }>, prompt = "a red kite over a beach", ratio = "4:5") =>
  startRun(t.app, { prompt, ratio, creators });

test("one prompt to both creators: two tiles, both ok; xAI crops 4:5, Google does not", async () => {
  const p = fakeProviders();
  const t = makeApp({ fetch: p.fetch });
  try {
    const { runId, blocked } = start(t, [{ id: "xai", n: 1 }, { id: "google", n: 1 }]);
    assert.equal(blocked, false);
    await until(() => (runView(t.app, runId)?.status ?? "running") !== "running");
    const v = runView(t.app, runId)!;
    assert.equal(v.status, "ok");
    assert.equal(v.jobs.length, 2);
    assert.deepEqual([...v.jobs].map((j) => j.status), ["ok", "ok"]);
    const xai = v.jobs.find((j) => j.creator === "xai")!;
    const goog = v.jobs.find((j) => j.creator === "google")!;
    assert.equal(xai.view?.displayNote, "Made at 3:4, cropped to 4:5");
    assert.equal(goog.view?.displayNote, null);
    assert.equal(xai.view?.costText, "$0.04");
    assert.equal(goog.view?.costText, "$0.07 est.");
    assert.ok(xai.view?.image && xai.view?.original && xai.view.image.assetId !== xai.view.original.assetId); // the 4:5 crop is its own file
    assert.equal(goog.view?.image?.assetId, goog.view?.original?.assetId); // Google makes 4:5 itself
    const rows = ledgerRows(t.app);
    assert.equal(rows.length, 2);
    assert.equal(rows.find((r) => r.provider === "google")!.actual_micro_usd, 68500);
    assert.equal(rows.find((r) => r.provider === "xai")!.actual_micro_usd, 40000);
  } finally { t.cleanup(); }
});

test("A2 acceptance: a bad Google key shows 'Key rejected' on that tile while the other creator still returns", async () => {
  const p = fakeProviders({ google: { model: () => jsonRes(400, { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] } }) } });
  const t = makeApp({ fetch: p.fetch });
  try {
    const { runId } = start(t, [{ id: "xai", n: 1 }, { id: "google", n: 1 }]);
    await until(() => (runView(t.app, runId)?.status ?? "running") !== "running");
    const v = runView(t.app, runId)!;
    assert.equal(v.status, "partial");
    const goog = v.jobs.find((j) => j.creator === "google")!;
    assert.equal(goog.status, "error");
    assert.match(goog.view?.message ?? "", /^Key rejected/);
    assert.equal(v.jobs.find((j) => j.creator === "xai")!.status, "ok");
    assert.equal(p.google.posts().length, 0, "the paid Google call was never sent");
    assert.equal(p.xai.posts().length, 1);
  } finally { t.cleanup(); }
});

test("partial: one creator fails (503, unresolved) while the other returns; the run shows partial", async () => {
  const p = fakeProviders({ xai: { gen: [() => genOk()] }, google: { interactions: [() => new Response("oops", { status: 503 })] } });
  const t = makeApp({ fetch: p.fetch });
  try {
    const { runId } = start(t, [{ id: "xai", n: 1 }, { id: "google", n: 1 }]);
    await until(() => (runView(t.app, runId)?.status ?? "running") !== "running");
    const v = runView(t.app, runId)!;
    assert.equal(v.status, "partial");
    const goog = v.jobs.find((j) => j.creator === "google")!;
    assert.equal(goog.status, "error");
    assert.equal(goog.view?.message, "Google error 503. Retry.");
    assert.equal(goog.view?.costText, "$0.07 held (cost unknown)");
    const rows = ledgerRows(t.app);
    assert.equal(rows.find((r) => r.provider === "google")!.status, "unresolved");
    assert.equal(monthTotals(t.app.db).countedMicros, 40000 + 75000);
  } finally { t.cleanup(); }
});

test("blocked prompt (F10): nothing is sent for any tile; every tile shows the block", async () => {
  const p = fakeProviders();
  const t = makeApp({ fetch: p.fetch });
  try {
    const { runId, blocked, message } = start(t, [{ id: "xai", n: 2 }, { id: "google", n: 1 }], "a photo of Tom Hanks smiling");
    assert.equal(blocked, true);
    assert.equal(message, BLOCKED_TEXT);
    const v = runView(t.app, runId)!;
    assert.equal(v.status, "blocked");
    assert.equal(v.jobs.length, 3);
    assert.ok(v.jobs.every((j) => j.status === "blocked"));
    assert.ok(v.jobs.every((j) => j.view?.message === BLOCKED_TEXT));
    assert.equal(p.xai.requests.length, 0);
    assert.equal(p.google.requests.length, 0);
    assert.equal(ledgerRows(t.app).length, 0);
    assert.equal(monthTotals(t.app.db).countedMicros, 0);
  } finally { t.cleanup(); }
});

test("per-provider concurrency: never more than 2 xAI jobs in flight", async () => {
  let inflight = 0, maxInflight = 0;
  const slow: Handler = async () => {
    inflight++;
    maxInflight = Math.max(maxInflight, inflight);
    await new Promise((r) => setTimeout(r, 40));
    inflight--;
    return genOk();
  };
  const p = fakeProviders({ xai: { gen: [slow] } });
  const t = makeApp({ fetch: p.fetch });
  try {
    const a = start(t, [{ id: "xai", n: 4 }], "batch one").runId;
    const b = start(t, [{ id: "xai", n: 1 }], "batch two").runId;
    await until(() => (runView(t.app, a)?.status ?? "running") !== "running" && (runView(t.app, b)?.status ?? "running") !== "running");
    assert.equal(maxInflight, 2);
    assert.equal(inflight, 0);
    assert.equal(p.xai.posts().length, 5);
  } finally { t.cleanup(); }
});

test("provider pools are independent: xAI and Google each run 2 at a time", async () => {
  const counts = new Map<string, number>([[ "xai", 0 ], [ "google", 0 ]]);
  const maxes = new Map<string, number>([[ "xai", 0 ], [ "google", 0 ]]);
  const slowXai: Handler = async () => {
    counts.set("xai", counts.get("xai")! + 1);
    maxes.set("xai", Math.max(maxes.get("xai")!, counts.get("xai")!));
    await new Promise((r) => setTimeout(r, 40));
    counts.set("xai", counts.get("xai")! - 1);
    return genOk();
  };
  const slowGoogle: Handler = async () => {
    counts.set("google", counts.get("google")! + 1);
    maxes.set("google", Math.max(maxes.get("google")!, counts.get("google")!));
    await new Promise((r) => setTimeout(r, 40));
    counts.set("google", counts.get("google")! - 1);
    const { googleGenOk } = await import("./helpers.ts");
    return googleGenOk();
  };
  const p = fakeProviders({ xai: { gen: [slowXai] }, google: { interactions: [slowGoogle] } });
  const t = makeApp({ fetch: p.fetch });
  try {
    const { runId } = start(t, [{ id: "xai", n: 2 }, { id: "google", n: 2 }]);
    await until(() => (runView(t.app, runId)?.status ?? "running") !== "running");
    assert.equal(runView(t.app, runId)!.status, "ok");
    assert.equal(maxes.get("xai"), 2);
    assert.equal(maxes.get("google"), 2);
  } finally { t.cleanup(); }
});

test("validation: creators, counts and prompt", () => {
  assert.throws(() => parseRunInput({ prompt: "x", ratio: "4:5", creators: [] }), RunInputError);
  assert.throws(() => parseRunInput({ prompt: "x", ratio: "4:5", creators: [{ id: "xai", n: 5 }] }), RunInputError);
  assert.throws(() => parseRunInput({ prompt: "x", ratio: "4:5", creators: [{ id: "xai", n: 1 }, { id: "xai", n: 1 }] }), RunInputError);
  assert.throws(() => parseRunInput({ prompt: "", ratio: "4:5", creators: [{ id: "xai", n: 1 }] }), RunInputError);
  assert.throws(() => parseRunInput({ prompt: "x", ratio: "4:5", creators: [{ id: "nope", n: 1 }] }), RunInputError);
  assert.deepEqual(parseRunInput({ prompt: " hi ", ratio: "4:5", creators: [{ id: "google", n: 2 }] }), { prompt: "hi", ratio: "4:5", creators: [{ id: "google", n: 2 }] });
});

test("resetStrandedJobs marks queued/running jobs from a stopped process", () => {
  const p = fakeProviders();
  const t = makeApp({ fetch: p.fetch });
  try {
    t.app.db.prepare("INSERT INTO runs (id, created_at, prompt, status) VALUES ('r1', '2026-10-09T10:00:00-04:00', 'p', 'running')").run();
    t.app.db.prepare("INSERT INTO jobs (id, run_id, creator_id, provider, model, generation_id, prompt, ratio, status, created_at) VALUES ('j1', 'r1', 'xai', 'xai', 'grok-imagine-image-2.0', 'g1', 'p', '4:5', 'running', '2026-10-09T10:00:01-04:00')").run();
    assert.equal(resetStrandedJobs(t.app.db), 2);
    assert.equal((t.app.db.prepare("SELECT status FROM jobs WHERE id = 'j1'").get() as { status: string }).status, "error");
    assert.equal((t.app.db.prepare("SELECT status FROM runs WHERE id = 'r1'").get() as { status: string }).status, "failed");
  } finally { t.cleanup(); }
});
