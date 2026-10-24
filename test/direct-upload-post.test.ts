// Tests for direct post creation from uploaded images and reference run queueing.
import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { makeApp, fakeProviders, jsonRes } from "./helpers.ts";
import { insertAsset, openaiDepsOf } from "../src/server/execute.ts";
import { putImage } from "../src/server/store.ts";
import { saveUploadedPost, searchPosts, LibraryError } from "../src/server/library.ts";
import { startRun, runView, RunInputError } from "../src/server/runs.ts";

async function waitRun(t: ReturnType<typeof makeApp>, runId: string, ms = 2000) {
  const t0 = Date.now();
  while (runView(t.app, runId)?.status === "running") {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting for the run");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("saveUploadedPost: creates post directly from uploaded asset with zero generation spend", async () => {
  const p = fakeProviders();
  const t = makeApp({ fetch: p.fetch });
  const bytes = await sharp({ create: { width: 100, height: 100, channels: 3, background: "#ff4400" } }).png().toBuffer();
  const stored = putImage(t.app.imagesDir, bytes);
  insertAsset(t.app.db, stored);

  const res1 = saveUploadedPost(t.app.db, { assetId: stored.id, prompt: "Vintage camera on wooden desk", notes: "Product photo" });
  assert.equal(typeof res1.id, "number");
  assert.equal(res1.already, false);

  // Check database rows
  const post = t.app.db.prepare("SELECT * FROM posts WHERE id = ?").get(res1.id) as Record<string, unknown>;
  assert.ok(post);
  assert.equal(post.asset_id, stored.id);
  assert.equal(post.prompt, "Vintage camera on wooden desk");
  assert.equal(post.model, "upload");
  assert.equal(post.notes, "Product photo");

  // Check FTS search
  const found = searchPosts(t.app.db, "vintage camera");
  assert.equal(found.length, 1);
  assert.equal(found[0].id, res1.id);

  // Calling again returns already: true
  const res2 = saveUploadedPost(t.app.db, { assetId: stored.id });
  assert.equal(res2.id, res1.id);
  assert.equal(res2.already, true);

  // Reject invalid asset ID
  assert.throws(() => saveUploadedPost(t.app.db, { assetId: "not-a-hash" }), LibraryError);
  assert.throws(() => saveUploadedPost(t.app.db, { assetId: "0".repeat(64) }), /not in the store/);

  t.cleanup();
});

test("POST /api/library: handles direct assetId saving", async () => {
  const p = fakeProviders();
  const t = makeApp({ fetch: p.fetch });
  const bytes = await sharp({ create: { width: 80, height: 80, channels: 3, background: "#00ff44" } }).png().toBuffer();
  const stored = putImage(t.app.imagesDir, bytes);
  insertAsset(t.app.db, stored);

  const g = globalThis as typeof globalThis & { __rsrApp?: unknown };
  g.__rsrApp = t.app;
  try {
    const { POST: libraryRoute } = await import("../src/app/api/library/route.ts");
    const req = new Request("http://localhost:3000/api/library", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-rsr": "1", host: "localhost:3000" },
      body: JSON.stringify({ assetId: stored.id, prompt: "Green leaf macro", notes: "Field work" }),
    });
    const res = await libraryRoute(req);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { id: number; already: boolean };
    assert.equal(typeof body.id, "number");
    assert.equal(body.already, false);
  } finally {
    delete g.__rsrApp;
    t.cleanup();
  }
});

test("startRun with referenceAssetId: attaches reference image to Google jobs and rejects Grok", async () => {
  const p = fakeProviders();
  const t = makeApp({ fetch: p.fetch });
  const bytes = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#0044ff" } }).png().toBuffer();
  const stored = putImage(t.app.imagesDir, bytes);
  insertAsset(t.app.db, stored);

  // Valid run with Google creator
  const r1 = startRun(t.app, {
    prompt: "A modern glass vase inspired by the shape",
    ratio: "1:1",
    creators: [{ id: "google", n: 1 }],
    referenceAssetId: stored.id,
  });
  assert.equal(r1.blocked, false);
  const job = t.app.db.prepare("SELECT * FROM jobs WHERE run_id = ?").get(r1.runId) as Record<string, unknown>;
  assert.ok(job);
  assert.equal(job.parent_asset_id, stored.id);
  await waitRun(t, r1.runId);

  // Rejects xAI when referenceAssetId is passed (Grok takes no references)
  assert.throws(
    () => startRun(t.app, {
      prompt: "A vase",
      ratio: "1:1",
      creators: [{ id: "xai", n: 1 }],
      referenceAssetId: stored.id,
    }),
    (err: unknown) => err instanceof RunInputError && err.message.includes("can't take reference images")
  );

  // Rejects non-existent asset ID
  assert.throws(
    () => startRun(t.app, {
      prompt: "A vase",
      ratio: "1:1",
      creators: [{ id: "google", n: 1 }],
      referenceAssetId: "f".repeat(64),
    }),
    (err: unknown) => err instanceof RunInputError && err.message.includes("not in the store")
  );

  t.cleanup();
});

test("startRun with sourceAssetId: runs kind='edit' on both Grok Imagine (xai) and Google using the attached picture", async () => {
  const p = fakeProviders();
  const t = makeApp({ fetch: p.fetch });
  try {
    const bytes = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#00aa44" } }).jpeg().toBuffer();
    const stored = putImage(t.app.imagesDir, bytes);
    insertAsset(t.app.db, stored);

    const r = startRun(t.app, {
      prompt: "Enhance the attached photo into an Avengers baseball poster",
      ratio: "4:5",
      creators: [{ id: "xai", n: 1 }, { id: "google", n: 1 }],
      sourceAssetId: stored.id,
    });
    assert.equal(r.blocked, false);
    await waitRun(t, r.runId);

    const v = runView(t.app, r.runId)!;
    assert.equal(v.status, "ok");
    assert.equal(v.mode, "edit");
    assert.equal(v.jobs.length, 2);
    for (const j of v.jobs) {
      assert.equal(j.kind, "edit");
      assert.equal(j.parentAssetId, stored.id);
      assert.equal(j.status, "ok");
    }
    // Verify xAI called /v1/images/edits (not /v1/images/generations) with the attached image
    const xaiEditReqs = p.xai.posts().filter((req) => req.path === "/v1/images/edits");
    assert.equal(xaiEditReqs.length, 1);
  } finally {
    t.cleanup();
  }
});

test("OpenAI (ChatGPT / GPT Image) creator card: generates and edits with attached picture", async () => {
  const outPng = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#cc4400" } }).png().toBuffer();
  const base = fakeProviders();
  const t = makeApp({
    fetch: async (url, init) => {
      const u = new URL(url);
      if (u.hostname === "api.openai.com") {
        if (u.pathname === "/v1/models") return jsonRes(200, { data: [{ id: "gpt-image-1" }] });
        if (u.pathname === "/v1/images/generations" || u.pathname === "/v1/images/edits") {
          return jsonRes(200, {
            data: [{ b64_json: outPng.toString("base64") }],
            usage: { input_tokens: 100, output_tokens: 1000, input_tokens_details: { text_tokens: 50, image_tokens: 50 } },
          });
        }
      }
      return base.fetch(url, init);
    },
  });
  try {
    openaiDepsOf(t.app).keys.save("dummy_TESTONLY_oAiXkQzWvRtYbNmHpCsDfJaEeUuIiOoPpAaSsDdFfGgHhJjKk");

    // 1. Standard generate on openai creator
    const rGen = startRun(t.app, {
      prompt: "A futuristic stadium at night",
      ratio: "1:1",
      creators: [{ id: "openai", n: 1 }],
    });
    await waitRun(t, rGen.runId);
    const vGen = runView(t.app, rGen.runId)!;
    assert.equal(vGen.status, "ok");
    assert.equal(vGen.jobs[0].creator, "openai");
    assert.equal(vGen.jobs[0].status, "ok");

    // 2. Edit with attached photo (sourceAssetId) on openai creator
    const srcBytes = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#224488" } }).jpeg().toBuffer();
    const stored = putImage(t.app.imagesDir, srcBytes);
    insertAsset(t.app.db, stored);
    const rEdit = startRun(t.app, {
      prompt: "Add dramatic stadium floodlights",
      ratio: "1:1",
      creators: [{ id: "openai", n: 1 }],
      sourceAssetId: stored.id,
    });
    await waitRun(t, rEdit.runId);
    const vEdit = runView(t.app, rEdit.runId)!;
    assert.equal(vEdit.status, "ok");
    assert.equal(vEdit.mode, "edit");
    assert.equal(vEdit.jobs[0].kind, "edit");
    assert.equal(vEdit.jobs[0].parentAssetId, stored.id);
  } finally {
    t.cleanup();
  }
});
