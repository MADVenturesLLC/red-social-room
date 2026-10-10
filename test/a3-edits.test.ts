// A3 unit battery: edits (xAI + Google), reference runs, edit-run validation, lineage, upload rules.
// Scripted fake providers only; no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { makeApp, fakeProviders, googleGenOk, jsonRes, ledgerRows, sampleJpeg } from "./helpers.ts";
import { executeEdit, executeGeneration, insertAsset, googleDepsOf } from "../src/server/execute.ts";
import { putImage, readStored } from "../src/server/store.ts";
import { startEditRun, runView, parseEditInput, RunInputError } from "../src/server/runs.ts";
import { lineageFor } from "../src/server/lineage.ts";
import { precheckUpload, resizeDimensions, RESIZE_OFFER } from "../src/lib/upload-rules.ts";

const GEN_A = "33333333-3333-4333-8333-333333333333";
const GEN_B = "44444444-4444-4444-8444-444444444444";
const GEN_C = "55555555-5555-4555-8555-555555555555";

type T = ReturnType<typeof makeApp>;

/** A distinct edit result, so content-addressing keeps parent and child as separate files (the store
 *  dedupes identical bytes; a real edit returns changed pixels). */
const altJpeg = (fill: string) => sharp({ create: { width: 96, height: 96, channels: 3, background: fill } }).jpeg().toBuffer();
const editOk = (bytes: Buffer, ticks = 700000000) => () => jsonRes(200, { data: [{ b64_json: bytes.toString("base64"), mime_type: "image/jpeg" }], usage: { cost_in_usd_ticks: ticks } }, { "x-request-id": "req-edit-1" });

function newRun(t: T, prompt: string): string {
  const runId = randomUUID();
  t.app.db.prepare("INSERT INTO runs (id, created_at, prompt, status) VALUES (?, '2026-10-10T10:00:00-04:00', ?, 'running')").run(runId, prompt);
  return runId;
}

async function seedSource(t: T): Promise<{ sourceId: string; bytes: Buffer; mime: string }> {
  const bytes = await sampleJpeg();
  const img = putImage(t.app.imagesDir, bytes);
  insertAsset(t.app.db, img);
  return { sourceId: img.id, bytes, mime: "image/jpeg" };
}

async function until(fn: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting for the run");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("A3 xai edit: posts /v1/images/edits with the image inline and no quality field; reserves $0.07, settles from ticks", async () => {
  const alt = await altJpeg("#aa3300");
  const p = fakeProviders({ xai: { edits: [editOk(alt)] } });
  const t = makeApp({ fetch: p.fetch });
  try {
    const { sourceId, bytes } = await seedSource(t);
    const runId = newRun(t, "make the background red");
    const view = await executeEdit(t.app, { runId, provider: "xai", model: "grok-imagine-image-2.0", instruction: "make the background red", sourceAssetId: sourceId, generationId: GEN_A });
    assert.equal(view.status, "ok", JSON.stringify(view));
    assert.ok(view.image && view.image.assetId !== sourceId, "the edit is a new child file");
    assert.equal(readStored(t.app.imagesDir, view.image!.assetId, "image/jpeg").toString("base64"), alt.toString("base64"));
    const req = p.xai.posts().find((r) => r.path === "/v1/images/edits")!;
    assert.equal(req.body!.model, "grok-imagine-image-2.0");
    assert.equal(req.body!.prompt, "make the background red");
    assert.deepEqual(req.body!.image, { type: "image_url", url: `data:image/jpeg;base64,${bytes.toString("base64")}` });
    assert.equal("quality" in req.body!, false);
    assert.equal("aspect_ratio" in req.body!, false);
    const [row] = ledgerRows(t.app);
    assert.equal(row.kind, "edit");
    assert.equal(row.quality, "medium");
    assert.equal(row.estimate_micro_usd, 70000);
    assert.equal(row.actual_micro_usd, 70000);
    assert.equal(row.cost_source, "billed_provider");
    const g = t.app.db.prepare("SELECT * FROM generations WHERE id = ?").get(GEN_A) as Record<string, unknown>;
    assert.equal(g.kind, "edit");
    assert.equal(g.parent_asset_id, sourceId);
    assert.equal(g.output_asset_id, view.image!.assetId);
    assert.equal(g.prompt, "make the background red");
    assert.equal(g.status, "ok");
    // The source file is untouched, byte for byte.
    assert.equal(readStored(t.app.imagesDir, sourceId, "image/jpeg").toString("base64"), bytes.toString("base64"));
  } finally { t.cleanup(); }
});

test("A3 xai edit failure (F13): 503 holds the reservation, writes an error row with the parent, stores no child", async () => {
  const p = fakeProviders({ xai: { edits: [() => new Response("oops", { status: 503 })] } });
  const t = makeApp({ fetch: p.fetch });
  try {
    const { sourceId, bytes } = await seedSource(t);
    const runId = newRun(t, "fail me");
    const view = await executeEdit(t.app, { runId, provider: "xai", model: "grok-imagine-image-2.0", instruction: "fail me", sourceAssetId: sourceId, generationId: GEN_A });
    assert.equal(view.status, "error");
    assert.match(view.message ?? "", /^xAI error 503 \(service unavailable\)\. Retry\./);
    const [row] = ledgerRows(t.app);
    assert.equal(row.status, "unresolved");
    assert.equal(row.kind, "edit");
    const g = t.app.db.prepare("SELECT status, parent_asset_id, output_asset_id FROM generations WHERE id = ?").get(GEN_A) as Record<string, unknown>;
    assert.equal(g.status, "error");
    assert.equal(g.parent_asset_id, sourceId);
    assert.equal(g.output_asset_id, null);
    assert.equal(readStored(t.app.imagesDir, sourceId, "image/jpeg").toString("base64"), bytes.toString("base64"));
  } finally { t.cleanup(); }
});

test("A3: the cap blocks an edit before it is sent (reservation $0.07 against a $0.05 cap)", async () => {
  const p = fakeProviders();
  const t = makeApp({ fetch: p.fetch, capUsd: 0.05 });
  try {
    const { sourceId } = await seedSource(t);
    const runId = newRun(t, "blocked by cap");
    const view = await executeEdit(t.app, { runId, provider: "xai", model: "grok-imagine-image-2.0", instruction: "blocked by cap", sourceAssetId: sourceId, generationId: GEN_A });
    assert.equal(view.status, "error");
    assert.equal(view.code, "cap");
    assert.equal(p.xai.posts().length, 0, "nothing was sent");
    assert.equal(ledgerRows(t.app).length, 0);
  } finally { t.cleanup(); }
});

test("A3 google edit: [text, image] input, store:false, no aspect_ratio; settles from tokens at $0.0685", async () => {
  const p = fakeProviders({ google: { interactions: [() => googleGenOk()] } });
  const t = makeApp({ fetch: p.fetch });
  try {
    const { sourceId, bytes } = await seedSource(t);
    const runId = newRun(t, "make it winter");
    const view = await executeEdit(t.app, { runId, provider: "google", model: "gemini-3.1-flash-image", instruction: "make it winter", sourceAssetId: sourceId, generationId: GEN_B });
    assert.equal(view.status, "ok", JSON.stringify(view));
    const req = p.google.posts()[0];
    const body = req.body as { input: unknown[]; response_format: unknown; store: boolean };
    assert.equal(body.store, false);
    assert.deepEqual(body.input, [{ type: "text", text: "make it winter" }, { type: "image", mime_type: "image/jpeg", data: bytes.toString("base64") }]);
    assert.deepEqual(body.response_format, { type: "image", image_size: "1K" });
    const [row] = ledgerRows(t.app);
    assert.equal(row.kind, "edit");
    assert.equal(row.quality, null);
    assert.equal(row.estimate_micro_usd, 75000);
    assert.equal(row.actual_micro_usd, 68500);
    assert.equal(row.cost_source, "estimated_tokens");
  } finally { t.cleanup(); }
});

test("A3 google edit refusal (F9): a text-only reply is refused with the text and priced from tokens", async () => {
  const p = fakeProviders({ google: { interactions: [() => jsonRes(200, { id: "int-1", status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: "I can't help with that." }] }], usage: { total_input_tokens: 12, total_output_tokens: 7, total_thought_tokens: 0 } })] } });
  const t = makeApp({ fetch: p.fetch });
  try {
    const { sourceId } = await seedSource(t);
    const runId = newRun(t, "refuse me");
    const view = await executeEdit(t.app, { runId, provider: "google", model: "gemini-3.1-flash-image", instruction: "refuse me", sourceAssetId: sourceId, generationId: GEN_B });
    assert.equal(view.status, "refused");
    assert.equal(view.message, "Google returned no image: I can't help with that.");
    const [row] = ledgerRows(t.app);
    assert.equal(row.kind, "edit");
    assert.equal(row.status, "settled");
    const g = t.app.db.prepare("SELECT status, parent_asset_id FROM generations WHERE id = ?").get(GEN_B) as Record<string, unknown>;
    assert.equal(g.status, "refused");
    assert.equal(g.parent_asset_id, sourceId);
  } finally { t.cleanup(); }
});

test("A3 reference: a Google generation with a reference image carries [text, image] and records the parent; Grok refuses before any send", async () => {
  const p = fakeProviders({ google: { interactions: [() => googleGenOk()] } });
  const t = makeApp({ fetch: p.fetch });
  try {
    const { sourceId, bytes } = await seedSource(t);
    const runId = newRun(t, "a poster of this photo");
    const view = await executeGeneration(t.app, { runId, provider: "google", model: "gemini-3.1-flash-image", prompt: "a poster of this photo", ratio: "16:9", generationId: GEN_C, referenceAssetId: sourceId });
    assert.equal(view.status, "ok", JSON.stringify(view));
    const req = p.google.posts()[0];
    const body = req.body as { input: unknown[]; response_format: unknown };
    assert.deepEqual(body.input, [{ type: "text", text: "a poster of this photo" }, { type: "image", mime_type: "image/jpeg", data: bytes.toString("base64") }]);
    assert.deepEqual(body.response_format, { type: "image", aspect_ratio: "16:9", image_size: "1K" });
    const g = t.app.db.prepare("SELECT kind, parent_asset_id FROM generations WHERE id = ?").get(GEN_C) as Record<string, unknown>;
    assert.equal(g.kind, "generate");
    assert.equal(g.parent_asset_id, sourceId);
    // xAI: refused up front, no request, an error row with the parent.
    const before = p.xai.requests.length;
    const run2 = newRun(t, "nope");
    const xview = await executeGeneration(t.app, { runId: run2, provider: "xai", model: "grok-imagine-image-2.0", prompt: "nope", ratio: "1:1", generationId: GEN_A, referenceAssetId: sourceId });
    assert.equal(xview.status, "error");
    assert.match(xview.message ?? "", /Not supported by Grok: reference images/);
    assert.equal(p.xai.requests.length, before, "nothing was sent for the xAI reference");
    const g2 = t.app.db.prepare("SELECT status, kind, parent_asset_id FROM generations WHERE id = ?").get(GEN_A) as Record<string, unknown>;
    assert.equal(g2.status, "error");
    assert.equal(g2.parent_asset_id, sourceId);
  } finally { t.cleanup(); }
});

test("A3 edit runs: validation, mode, compare with the identical instruction, blocked instruction", async () => {
  const p = fakeProviders();
  const t = makeApp({ fetch: p.fetch });
  try {
    const { sourceId } = await seedSource(t);
    assert.throws(() => parseEditInput(t.app, { sourceAssetId: "notahash", instruction: "x", models: ["xai"] }), RunInputError);
    assert.throws(() => parseEditInput(t.app, { sourceAssetId: "a".repeat(64), instruction: "x", models: ["xai"] }), RunInputError);
    assert.throws(() => parseEditInput(t.app, { sourceAssetId: sourceId, instruction: "", models: ["xai"] }), RunInputError);
    assert.throws(() => parseEditInput(t.app, { sourceAssetId: sourceId, instruction: "x", models: [] }), RunInputError);
    assert.throws(() => parseEditInput(t.app, { sourceAssetId: sourceId, instruction: "x", models: ["xai", "xai"] }), RunInputError);
    assert.throws(() => parseEditInput(t.app, { mode: "reference", sourceAssetId: sourceId, instruction: "x", ratio: "1:1", models: ["xai"] }), RunInputError);

    // compare edit: the same instruction string reaches both providers (item 28).
    const { runId } = startEditRun(t.app, { mode: "edit", sourceAssetId: sourceId, instruction: "identical words exactly", models: ["xai", "google"] });
    await until(() => (runView(t.app, runId)?.status ?? "running") !== "running");
    const v = runView(t.app, runId)!;
    assert.equal(v.mode, "edit");
    assert.equal(v.status, "ok");
    assert.ok(v.jobs.every((j) => j.kind === "edit" && j.parentAssetId === sourceId));
    const xb = p.xai.posts().find((r) => r.path === "/v1/images/edits")!;
    const gb = p.google.posts()[0];
    assert.equal(xb.body!.prompt, "identical words exactly");
    assert.equal((gb.body!.input as Array<{ text?: string }>)[0].text, "identical words exactly");

    // a blocked edit instruction (D1): nothing is sent, every job shows the block, rows carry the parent.
    const blockedRun = startEditRun(t.app, { mode: "edit", sourceAssetId: sourceId, instruction: "a photo of Tom Hanks smiling", models: ["xai"] });
    assert.equal(blockedRun.blocked, true);
    const bv = runView(t.app, blockedRun.runId)!;
    assert.equal(bv.status, "blocked");
    assert.ok(bv.jobs.every((j) => j.status === "blocked"));
  } finally { t.cleanup(); }
});

test("A3 lineage: root, chained edits, a failed attempt and a branch all show in order", async () => {
  const [a1, a2, a3] = [await altJpeg("#112233"), await altJpeg("#445566"), await altJpeg("#778899")];
  const p = fakeProviders({ xai: { edits: [editOk(a1), editOk(a2), () => new Response("oops", { status: 503 }), editOk(a3)] } });
  const t = makeApp({ fetch: p.fetch });
  try {
    const { sourceId } = await seedSource(t);
    const runId = newRun(t, "chain");
    const v1 = await executeEdit(t.app, { runId, provider: "xai", model: "grok-imagine-image-2.0", instruction: "one", sourceAssetId: sourceId, generationId: "g1" });
    const v2 = await executeEdit(t.app, { runId, provider: "xai", model: "grok-imagine-image-2.0", instruction: "two", sourceAssetId: v1.image!.assetId, generationId: "g2" });
    const fail = await executeEdit(t.app, { runId, provider: "xai", model: "grok-imagine-image-2.0", instruction: "three (fails)", sourceAssetId: v2.image!.assetId, generationId: "g3" });
    assert.equal(fail.status, "error");
    const v4 = await executeEdit(t.app, { runId, provider: "xai", model: "grok-imagine-image-2.0", instruction: "branch from v1", sourceAssetId: v1.image!.assetId, generationId: "g4" });
    assert.equal(v4.status, "ok");
    const chain = lineageFor(t.app.db, v4.image!.assetId)!;
    assert.equal(chain.rootAssetId, sourceId);
    assert.deepEqual(chain.nodes.map((n) => n.kind), ["source", "edit", "edit", "edit", "edit"]);
    assert.deepEqual(chain.nodes.map((n) => n.instruction), [null, "one", "two", "three (fails)", "branch from v1"]);
    const failed = chain.nodes.find((n) => n.instruction === "three (fails)")!;
    assert.equal(failed.status, "error");
    assert.equal(failed.assetId, null);
    assert.match(failed.error ?? "", /503|Retry/);
    // Walking up from the deepest node finds the same chain.
    assert.equal(lineageFor(t.app.db, v2.image!.assetId)!.rootAssetId, sourceId);
  } finally { t.cleanup(); }
});

test("A3 upload rules (F14): the shared precheck and resize math", () => {
  assert.deepEqual(precheckUpload({ type: "image/png", size: 1024, width: 800, height: 600 }), { kind: "ok" });
  assert.equal(precheckUpload({ type: "image/gif", size: 1024, width: 10, height: 10 }).kind, "reject");
  const offer = precheckUpload({ type: "image/png", size: 30 * 1024 * 1024, width: 4000, height: 4000 });
  assert.deepEqual(offer, { kind: "offer_resize", message: RESIZE_OFFER });
  assert.equal(RESIZE_OFFER, "Resize to 4096 px and continue?");
  assert.equal(precheckUpload({ type: "image/jpeg", size: 1024, width: 9000, height: 10 }).kind, "offer_resize");
  assert.deepEqual(resizeDimensions(9000, 3000), { width: 4096, height: 1365 });
  assert.deepEqual(resizeDimensions(100, 50), { width: 100, height: 50 });
});
