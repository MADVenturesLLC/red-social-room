// A6 unit battery: presets, the item 24 exact-size step (both mandated cases), the drag-crop path, the
// item 9 widen (happy + refusal, zero xAI), the ZIP writer and the full export (captions.txt included).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { makeApp, fakeProviders, jsonRes } from "./helpers.ts";
import { insertAsset } from "../src/server/execute.ts";
import { putImage, readStored } from "../src/server/store.ts";
import { inspectImage, sha256 } from "../spike/lib/image.ts";
import { loadSizes, makeRendition, widenRendition, listRenditions, exportZip, ratioNoteFor, upscaleNote, RenditionError, captionsTextFor } from "../src/server/renditions.ts";
import { zipStore, zipRead, crc32 } from "../src/server/zip.ts";
import { frameFor } from "../src/lib/crop-frame.ts";
import { saveCaption } from "../src/server/captions.ts";

type T = ReturnType<typeof makeApp>;

const srcJpeg = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 90, g: 120, b: 160 } } }).jpeg({ quality: 85 }).toBuffer();
const altJpeg = (w: number, h: number, fill: string) => sharp({ create: { width: w, height: h, channels: 3, background: fill } }).jpeg().toBuffer();

async function seedPost(t: T, w = 928, h = 1152): Promise<{ postId: number; assetId: string; bytes: Buffer }> {
  const bytes = await srcJpeg(w, h);
  const img = putImage(t.app.imagesDir, bytes);
  insertAsset(t.app.db, img);
  const genId = randomUUID();
  t.app.db.prepare("INSERT INTO runs (id, created_at, prompt, status) VALUES (?, '2026-10-10T10:00:00-04:00', 'a kite over a winter field', 'ok')").run(genId);
  t.app.db.prepare(`INSERT INTO generations (id, run_id, created_at, provider, model, kind, prompt, params, status, output_asset_id, display_asset_id)
    VALUES (?, ?, '2026-10-10T10:00:00-04:00', 'xai', 'grok-imagine-image-2.0', 'generate', 'a kite over a winter field', '{}', 'ok', ?, ?)`).run(genId, genId, img.id, img.id);
  const r = t.app.db.prepare("INSERT INTO posts (created_at, generation_id, asset_id, prompt, model, notes) VALUES ('2026-10-10T10:00:00-04:00', ?, ?, 'a kite over a winter field', 'grok-imagine-image-2.0', '')").run(genId, img.id);
  return { postId: Number(r.lastInsertRowid), assetId: img.id, bytes };
}

test("A6 presets: thirteen placements with exact pixels; YouTube carries the 2 MB limit; the story safe zone", () => {
  const presets = loadSizes();
  assert.equal(presets.length, 13);
  const yt = presets.find((p) => p.id === "youtube")!;
  assert.equal(yt.width, 1280); assert.equal(yt.height, 720); assert.equal(yt.maxBytes, 2097152);
  const story = presets.find((p) => p.id === "instagram-story")!;
  assert.deepEqual(story.safeZone, { x: 0, y: 155, w: 1080, h: 1610 });
  assert.equal(new Set(presets.map((p) => p.id)).size, 13);
});

test("A6 item 24: 928×1152 → Instagram portrait is exactly 1080×1350 and 1376×768 → YouTube exactly 1280×720 under 2 MB; the original never changes", async () => {
  const t = makeApp({ fetch: fakeProviders().fetch });
  try {
    const { postId, assetId, bytes } = await seedPost(t, 928, 1152);
    const { rendition } = await makeRendition(t.app.db, t.app.imagesDir, postId, "instagram-portrait", null);
    assert.equal(rendition.width, 1080); assert.equal(rendition.height, 1350);
    assert.equal(rendition.upscaledFrom, 928);
    const buf = readStored(t.app.imagesDir, rendition.assetId, "image/jpeg");
    const info = inspectImage(buf);
    assert.equal(info.format, "jpeg"); assert.equal(info.width, 1080); assert.equal(info.height, 1350);
    // The original file is byte-identical after the export step.
    assert.equal(sha256(readStored(t.app.imagesDir, assetId, "image/jpeg")), sha256(bytes));
    const t2 = makeApp({ fetch: fakeProviders().fetch });
    try {
      const p2 = await seedPost(t2, 1376, 768);
      const { rendition: yt } = await makeRendition(t2.app.db, t2.app.imagesDir, p2.postId, "youtube", null);
      assert.equal(yt.width, 1280); assert.equal(yt.height, 720);
      assert.ok(yt.bytes < 2097152, `YouTube file is ${yt.bytes} bytes`);
      const ytInfo = inspectImage(readStored(t2.app.imagesDir, yt.assetId, "image/jpeg"));
      assert.equal(ytInfo.width, 1280); assert.equal(ytInfo.height, 720);
    } finally { t2.cleanup(); }
  } finally { t.cleanup(); }
});

test("A6 drag-crop: the frame re-renders exact pixels, deterministically; a wrong-shape frame is refused", async () => {
  const t = makeApp({ fetch: fakeProviders().fetch });
  try {
    const { postId } = await seedPost(t, 928, 1152);
    const frame = frameFor(1080, 1350, 928, 1152, 0.4, 0.6, 1.6);
    const a = await makeRendition(t.app.db, t.app.imagesDir, postId, "instagram-portrait", frame);
    assert.equal(a.rendition.width, 1080); assert.equal(a.rendition.height, 1350);
    const b = await makeRendition(t.app.db, t.app.imagesDir, postId, "instagram-portrait", frame);
    assert.equal(a.rendition.assetId, b.rendition.assetId, "same frame → same bytes → same file");
    await assert.rejects(makeRendition(t.app.db, t.app.imagesDir, postId, "instagram-portrait", { x: 0.1, y: 0.1, w: 0.5, h: 0.1 }), (e: unknown) => e instanceof RenditionError && /does not match/.test(e.message));
    await assert.rejects(makeRendition(t.app.db, t.app.imagesDir, postId, "nope", null), /Unknown size preset/);
    await assert.rejects(makeRendition(t.app.db, t.app.imagesDir, postId, "x", { x: 0.9, y: 0, w: 0.5, h: 0.5 }), /does not fit/);
  } finally { t.cleanup(); }
});

test("A6 item 24 note + item 10 upscale label: within 1% is silent; otherwise the asked/got line shows", () => {
  const presets = loadSizes();
  const portrait = presets.find((p) => p.id === "instagram-portrait")!;
  const story = presets.find((p) => p.id === "instagram-story")!;
  assert.equal(ratioNoteFor(928, 1152, portrait), null, "0.806 vs 0.8 is within 1%");
  assert.equal(ratioNoteFor(928, 1152, story), "asked 9:16, got 928×1152 = 0.806");
  assert.equal(upscaleNote(928, portrait), "Upscaled from 928 px wide");
  assert.equal(upscaleNote(1280, presets.find((p) => p.id === "youtube")!), null);
});

test("A6 item 9: widen sends ONE Google edit with aspect_ratio and the image inline, stores ai_extend at exact pixels, and makes zero xAI calls", async () => {
  const p = fakeProviders({ google: { interactions: [() => jsonRes(200, { id: "int-widen-1", status: "completed", model: "gemini-3.1-flash-image", steps: [{ type: "model_output", content: [{ type: "image", mime_type: "image/jpeg", data: "" }] }], usage: {} })] } });
  // Build the widened jpeg lazily and swap it in.
  const wide = await altJpeg(640, 360, "#cc7733");
  p.google.requests.length = 0;
  const t = makeApp({ fetch: fakeProviders({ google: { interactions: [() => jsonRes(200, { id: "int-widen-1", status: "completed", model: "gemini-3.1-flash-image", steps: [{ type: "model_output", content: [{ type: "image", mime_type: "image/jpeg", data: wide.toString("base64") }] }], usage: { total_input_tokens: 26, total_output_tokens: 1549, total_thought_tokens: 0, output_tokens_by_modality: [{ modality: "image", tokens: 1120 }, { modality: "text", tokens: 429 }] } }) ] } }).fetch });
  const fp = fakeProviders({ google: { interactions: [() => jsonRes(200, { id: "int-widen-1", status: "completed", model: "gemini-3.1-flash-image", steps: [{ type: "model_output", content: [{ type: "image", mime_type: "image/jpeg", data: wide.toString("base64") }] }], usage: { total_input_tokens: 26, total_output_tokens: 1549, total_thought_tokens: 0, output_tokens_by_modality: [{ modality: "image", tokens: 1120 }, { modality: "text", tokens: 429 }] } }) ] } });
  try {
    t.app.fetch = fp.fetch;
    const { postId } = await seedPost(t);
    const out = await widenRendition(t.app, postId, "x");
    assert.equal(out.kind, "ok", JSON.stringify(out));
    assert.equal(out.fallback, "none");
    assert.equal(out.rendition!.width, 1280); assert.equal(out.rendition!.height, 720);
    assert.equal(out.rendition!.method, "ai_extend");
    assert.equal(out.rendition!.note, "AI extend (Nano Banana 2)");
    const sent = fp.google.posts().filter((r) => r.path === "/v1beta/interactions");
    assert.equal(sent.length, 1);
    const body = sent[0].body as { model: string; response_format: { aspect_ratio?: string; type: string }; input: Array<{ type: string }> };
    assert.equal(body.model, "gemini-3.1-flash-image");
    assert.equal(body.response_format.aspect_ratio, "16:9");
    assert.equal(body.input[0].type, "text");
    assert.equal(body.input[1].type, "image");
    assert.equal(fp.xai.posts().length, 0, "Grok is never used for widening");
    const [row] = t.app.db.prepare("SELECT * FROM spend_ledger WHERE imported_from IS NULL").all() as Array<Record<string, unknown>>;
    assert.equal(row.kind, "edit"); assert.equal(row.provider, "google"); assert.equal(row.status, "settled");
    assert.equal((t.app.db.prepare("SELECT method FROM renditions WHERE post_id = ? AND preset_id = 'x'").get(postId) as { method: string }).method, "ai_extend");
    assert.equal((t.app.db.prepare("SELECT status FROM runs ORDER BY created_at DESC LIMIT 1").get() as { status: string }).status, "ok");
  } finally { t.cleanup(); }
});

test("A6 item 9: a Google refusal on widen shows the real refusal and the fallback that exists (none by default, recraft when switched)", async () => {
  const refusal = () => jsonRes(200, { id: "int-widen-refuse", status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: "I can't extend that safely." }] }], usage: { total_input_tokens: 26, total_output_tokens: 7, total_thought_tokens: 0 } });
  const t = makeApp({ fetch: fakeProviders({ google: { interactions: [refusal] } }).fetch });
  try {
    const { postId } = await seedPost(t);
    const out = await widenRendition(t.app, postId, "x");
    assert.equal(out.kind, "refused");
    assert.match(out.message ?? "", /Refused by Google|no image/i);
    assert.equal(out.fallback, "none");
    assert.equal(out.rendition, null);
    assert.ok((out.costText ?? "").length > 0, "the charged call is shown");
  } finally { t.cleanup(); }
  const t2 = makeApp({ fetch: fakeProviders({ google: { interactions: [refusal] } }).fetch, switches: { outpaintFallback: "recraft" } });
  try {
    const { postId } = await seedPost(t2);
    const out = await widenRendition(t2.app, postId, "x");
    assert.equal(out.fallback, "recraft");
  } finally { t2.cleanup(); }
});

test("A6 zip: the writer round-trips, is deterministic, and the export carries one image per platform plus captions.txt", async () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926, "the standard CRC-32 check value");
  const z1 = zipStore([{ name: "a.txt", data: Buffer.from("hello") }, { name: "b.bin", data: Buffer.from([0, 1, 2, 255]) }]);
  const z2 = zipStore([{ name: "a.txt", data: Buffer.from("hello") }, { name: "b.bin", data: Buffer.from([0, 1, 2, 255]) }]);
  assert.deepEqual(z1, z2, "deterministic bytes");
  const entries = zipRead(z1);
  assert.deepEqual(entries.map((e) => e.name), ["a.txt", "b.bin"]);
  assert.equal(entries[0].data.toString("utf8"), "hello");
  assert.deepEqual([...entries[1].data], [0, 1, 2, 255]);

  const t = makeApp({ fetch: fakeProviders().fetch });
  try {
    const { postId } = await seedPost(t, 928, 1152);
    await makeRendition(t.app.db, t.app.imagesDir, postId, "instagram-portrait", null);
    await makeRendition(t.app.db, t.app.imagesDir, postId, "youtube", null);
    saveCaption(t.app.db, postId, "instagram", "A kite over a winter field — prints soon.", "ventures winter", "A kite in a pale sky.");
    const { buf, filename } = await exportZip(t.app.db, t.app.imagesDir, postId, ["instagram-portrait", "youtube"]);
    assert.equal(filename, `red-social-room-post-${postId}-export.zip`);
    const out = zipRead(buf);
    assert.deepEqual(out.map((e) => e.name), ["instagram-portrait.jpg", "youtube.jpg", "captions.txt"]);
    const ytJpg = out.find((e) => e.name === "youtube.jpg")!;
    assert.equal(ytJpg.data.length, listRenditions(t.app.db, postId).find((r) => r.presetId === "youtube")!.bytes);
    const txt = out.find((e) => e.name === "captions.txt")!.data.toString("utf8");
    assert.match(txt, /== Instagram — Instagram feed, portrait \(1080×1350\) ==/);
    assert.match(txt, /A kite over a winter field — prints soon\./);
    assert.match(txt, /Hashtags: ventures winter/);
    assert.match(txt, /== YouTube — YouTube thumbnail \(1280×720\) ==/);
    assert.match(txt, /no caption saved yet/);
    await assert.rejects(exportZip(t.app.db, t.app.imagesDir, postId, ["x"]), /No rendition yet for X, landscape/);
    await assert.rejects(exportZip(t.app.db, t.app.imagesDir, postId, []), /at least one platform/);
  } finally { t.cleanup(); }
});
