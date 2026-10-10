// A5 unit battery: platform/tone configs, the caption prompt and JSON schema, the strict reply parser,
// the Flash-Lite cost math, the call loop against a scripted fake Google, and the store (captions, tags,
// brand voice, the denormalized FTS text). No network, no real keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { makeApp, fakeProviders, jsonRes } from "./helpers.ts";
import { insertAsset, googleDepsOf } from "../src/server/execute.ts";
import { putImage } from "../src/server/store.ts";
import { toMicros } from "../spike/lib/ledger.ts";
import {
  generateCaptions, CaptionInputError, loadPlatforms, loadTones, buildCaptionPrompt, buildCaptionSchema, parseCaptionReply,
  captionCostFromUsage, saveCaption, listCaptions, acceptTags, listPostTags, getBrandVoice, setBrandVoice, CaptionStoreError,
} from "../src/server/captions.ts";
import { searchPosts } from "../src/server/library.ts";

type T = ReturnType<typeof makeApp>;

const FOUR = ["instagram", "x", "linkedin", "facebook"];

function payload(overX = false): string {
  const long = "A".repeat(350);
  return JSON.stringify({
    platforms: {
      instagram: { captions: ["Sunrise over the buildroom.", "Building at dawn — step by step."], hashtags: ["ventures", "buildroom"], alt_text: "A workspace at sunrise." },
      x: { captions: [overX ? long : "Shipping the red social room today.", "Small rooms, big launches."], hashtags: ["build"], alt_text: "A workspace at sunrise." },
      linkedin: { captions: ["A note on building in public.", "What we shipped this week."], hashtags: ["ventures"], alt_text: "A workspace at sunrise." },
      facebook: { captions: ["One room, one idea.", "From sketch to ship."], hashtags: ["mad"], alt_text: "A workspace at sunrise." },
    },
    tags: ["buildroom", "launch"],
  });
}

const capOk = (text: string, usage: Record<string, unknown> = { total_input_tokens: 4096, total_output_tokens: 800, total_thought_tokens: 0 }) =>
  () => jsonRes(200, { id: "int-cap-1", status: "completed", model: "gemini-3.1-flash-lite", steps: [{ type: "model_output", content: [{ type: "text", text }] }], usage }, { "x-request-id": "cap-req-1" });

async function seedPost(t: T): Promise<{ postId: number; genId: string; assetId: string }> {
  const bytes = await sharp({ create: { width: 96, height: 64, channels: 3, background: "#2255aa" } }).png().toBuffer();
  const img = putImage(t.app.imagesDir, bytes);
  insertAsset(t.app.db, img);
  const genId = randomUUID();
  t.app.db.prepare("INSERT INTO runs (id, created_at, prompt, status) VALUES (?, '2026-10-10T10:00:00-04:00', 'a lighthouse at dusk', 'ok')").run(genId);
  t.app.db.prepare(`INSERT INTO generations (id, run_id, created_at, provider, model, kind, prompt, params, status, output_asset_id, display_asset_id)
    VALUES (?, ?, '2026-10-10T10:00:00-04:00', 'xai', 'grok-imagine-image-2.0', 'generate', 'a lighthouse at dusk', '{}', 'ok', ?, ?)`).run(genId, genId, img.id, img.id);
  const r = t.app.db.prepare("INSERT INTO posts (created_at, generation_id, asset_id, prompt, model, notes) VALUES ('2026-10-10T10:00:00-04:00', ?, ?, 'a lighthouse at dusk', 'grok-imagine-image-2.0', '')").run(genId, img.id);
  return { postId: Number(r.lastInsertRowid), genId, assetId: img.id };
}

const runCaption = (t: T, req: Record<string, unknown>) =>
  generateCaptions(googleDepsOf(t.app), t.app.promptMethod, t.app.imagesDir, { postId: req.postId as number, platforms: (req.platforms ?? FOUR) as string[], tone: (req.tone ?? "casual") as string, notes: (req.notes ?? "") as string });

test("A5 configs: seven platforms with limits, four tones, and schema/prompt built per request", () => {
  const platforms = loadPlatforms();
  assert.equal(platforms.length, 7);
  assert.equal(platforms.find((p) => p.id === "instagram")!.captionLimit, 2200);
  assert.equal(platforms.find((p) => p.id === "x")!.captionLimit, 280);
  assert.equal(platforms.find((p) => p.id === "tiktok")!.verified, false);
  const tones = loadTones();
  assert.ok(tones.length >= 3 && tones.every((t) => t.id && t.direction));
  const schema = buildCaptionSchema(["instagram", "x"]) as { properties: { platforms: { required: string[] } }; required: string[] };
  assert.deepEqual(schema.properties.platforms.required, ["instagram", "x"]);
  assert.deepEqual(schema.required, ["platforms", "tags"]);
  const prompt = buildCaptionPrompt({ prompt: "a cat", platforms: platforms.slice(0, 4), tone: tones[0], notes: "mention the launch", brandVoice: "short and direct" });
  assert.match(prompt, /a cat/);
  assert.match(prompt, /mention the launch/);
  assert.match(prompt, /short and direct/);
  assert.match(prompt, /instagram <= 2200/);
});

test("A5 parse: strict structure, sane bounds, # stripped; over-limit text parses (the flag is a counter, not a cut)", () => {
  const good = parseCaptionReply(payload(true), FOUR);
  assert.ok(good.ok);
  if (good.ok) {
    assert.equal(good.platforms.x.captions[0].length, 350, "over-limit text is kept, never cut");
    assert.deepEqual(good.platforms.instagram.hashtags, ["ventures", "buildroom"]);
    assert.deepEqual(good.tags, ["buildroom", "launch"]);
  }
  const hash = parseCaptionReply(JSON.stringify({ platforms: { instagram: { captions: ["a"], hashtags: ["#one", "two"], alt_text: "" }, x: { captions: ["b"], hashtags: [], alt_text: "" }, linkedin: { captions: ["c"], hashtags: [], alt_text: "" }, facebook: { captions: ["d"], hashtags: [], alt_text: "" } }, tags: [] }), FOUR);
  assert.ok(hash.ok);
  if (hash.ok) assert.deepEqual(hash.platforms.instagram.hashtags, ["one", "two"]);
  for (const [bad, why] of [
    ["not json", /not JSON/],
    [JSON.stringify({ tags: [] }), /no platforms/],
    [JSON.stringify({ platforms: { instagram: { captions: ["a"], hashtags: [], alt_text: "" }, linkedin: { captions: ["c"], hashtags: [], alt_text: "" }, facebook: { captions: ["d"], hashtags: [], alt_text: "" } }, tags: [] }), /missing/],
    [JSON.stringify({ platforms: { instagram: { captions: ["a"], hashtags: ["x".repeat(300)], alt_text: "" }, x: { captions: ["b"], hashtags: [], alt_text: "" }, linkedin: { captions: ["c"], hashtags: [], alt_text: "" }, facebook: { captions: ["d"], hashtags: [], alt_text: "" } }, tags: [] }), /hashtags/],
  ] as Array<[string, RegExp]>) {
    const r = parseCaptionReply(bad, FOUR);
    assert.equal(r.ok, false, `expected refusal: ${bad.slice(0, 60)}`);
    if (!r.ok) assert.match(r.error, why);
  }
});

test("A5 cost: Flash-Lite rates from usage tokens ($0.25 in / $1.50 out per 1M)", () => {
  const a = captionCostFromUsage({ total_input_tokens: 4096, total_output_tokens: 800, total_thought_tokens: 0 });
  assert.ok(!("error" in a));
  if (!("error" in a)) { assert.equal(toMicros(a.usd), 2224); assert.match(a.detail, /4096 input/); }
  const b = captionCostFromUsage({ total_input_tokens: 1000, total_output_tokens: 100, total_thought_tokens: 200 });
  assert.ok(!("error" in b));
  if (!("error" in b)) assert.equal(toMicros(b.usd), 700); // 1000*0.25 + 300*1.5 = 250+450 = 700 micro
  assert.ok("error" in captionCostFromUsage({}));
  assert.ok("error" in captionCostFromUsage({ total_input_tokens: -1 }));
  assert.ok(!("error" in captionCostFromUsage({ total_input_tokens: 1, total_output_tokens: 1 })), "thinking is optional");
});

test("A5 generate (fake Google): four platforms, one over-limit flagged, the request carries image+prompt+tone+voice, cost settles from tokens", async () => {
  const p = fakeProviders({ google: { interactions: [capOk(payload(true))] } });
  const t = makeApp({ fetch: p.fetch });
  try {
    const { postId } = await seedPost(t);
    setBrandVoice(t.app.db, "We build ventures and say what we mean.");
    const out = await runCaption(t, { postId, notes: "mention the Buildroom launch", tone: "casual" });
    assert.equal(out.kind, "ok", JSON.stringify(out));
    const plats = out.platforms!;
    assert.equal(Object.keys(plats).length, 4);
    assert.equal(plats.x.overLimit, true, "the 350-char X caption is flagged, not cut");
    assert.equal(plats.instagram.overLimit, false);
    assert.equal(plats.x.limit, 280);
    assert.deepEqual(out.tags, ["buildroom", "launch"]);
    assert.ok(out.cost && out.cost.micros === 2224 && out.cost.source === "estimated_tokens", JSON.stringify(out.cost));
    const sent = p.google.posts().filter((r) => r.path === "/v1beta/interactions");
    assert.equal(sent.length, 1);
    const body = sent[0].body as { model: string; store: boolean; response_format: { type: string; mime_type: string; schema: { properties: { platforms: { required: string[] } } } }; input: Array<{ type: string; text?: string; data?: string; mime_type?: string }> };
    assert.equal(body.model, "gemini-3.1-flash-lite");
    assert.equal(body.store, false, "D4 on every Google call");
    assert.equal(body.response_format.type, "text");
    assert.equal(body.response_format.mime_type, "application/json");
    assert.deepEqual(body.response_format.schema.properties.platforms.required, FOUR);
    assert.equal(body.input[0].type, "text");
    assert.match(body.input[0].text ?? "", /mention the Buildroom launch/);
    assert.match(body.input[0].text ?? "", /We build ventures and say what we mean\./);
    assert.match(body.input[0].text ?? "", /Casual/);
    assert.equal(body.input[1].type, "image");
    assert.equal(body.input[1].mime_type, "image/png");
    assert.ok((body.input[1].data ?? "").length > 100);
    const [row] = t.app.db.prepare("SELECT * FROM spend_ledger WHERE imported_from IS NULL").all() as Array<Record<string, unknown>>;
    assert.equal(row.kind, "caption");
    assert.equal(row.provider, "google");
    assert.equal(row.model, "gemini-3.1-flash-lite");
    assert.equal(row.status, "settled");
    assert.equal(row.cost_source, "estimated_tokens");
    assert.equal(row.actual_micro_usd, 2224);
  } finally { t.cleanup(); }
});

test("A5 generate: the real-person check blocks a name before anything is sent, with no money recorded", async () => {
  const p = fakeProviders({ google: { interactions: [capOk(payload(false))] } });
  const t = makeApp({ fetch: p.fetch });
  try {
    const { postId } = await seedPost(t);
    const out = await runCaption(t, { postId, notes: "make it about Tom Hanks' new film" });
    assert.equal(out.kind, "blocked");
    assert.equal(p.google.posts().length, 0, "nothing was sent");
    const rows = t.app.db.prepare("SELECT COUNT(*) AS n FROM spend_ledger").get() as { n: number };
    assert.equal(rows.n, 0, "no ledger row");
    const checks = t.app.db.prepare("SELECT COUNT(*) AS n FROM prompt_checks").get() as { n: number };
    assert.equal(checks.n, 1, "the check is recorded");
  } finally { t.cleanup(); }
});

test("A5 generate: an unreadable reply is reported plainly, the billed cost is recorded, and there is no automatic retry", async () => {
  const p = fakeProviders({ google: { interactions: [capOk("here are your captions! not json")] } });
  const t = makeApp({ fetch: p.fetch });
  try {
    const { postId } = await seedPost(t);
    const out = await runCaption(t, { postId });
    assert.equal(out.kind, "error");
    assert.equal(out.code, "unreadable");
    assert.match(out.message ?? "", /billed/);
    assert.equal(p.google.posts().filter((r) => r.path === "/v1beta/interactions").length, 1, "exactly one call — no automatic retry");
    const [row] = t.app.db.prepare("SELECT * FROM spend_ledger WHERE imported_from IS NULL").all() as Array<Record<string, unknown>>;
    assert.equal(row.status, "settled");
    assert.equal(row.actual_micro_usd, 2224, "the billed reply is still recorded");
  } finally { t.cleanup(); }
});

test("A5 generate: a cap too small refuses before sending — zero calls, no reservation row", async () => {
  const p = fakeProviders({ google: { interactions: [capOk(payload(false))] } });
  const t = makeApp({ fetch: p.fetch, capUsd: 0.001 });
  try {
    const { postId } = await seedPost(t);
    const out = await runCaption(t, { postId });
    assert.equal(out.kind, "error");
    assert.equal(out.code, "cap");
    assert.match(out.message ?? "", /cap/i);
    assert.equal(p.google.posts().length, 0, "nothing was sent");
    const rows = t.app.db.prepare("SELECT COUNT(*) AS n FROM spend_ledger").get() as { n: number };
    assert.equal(rows.n, 0);
    const events = t.app.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'cap_refused'").get() as { n: number };
    assert.equal(events.n, 1, "the refusal is visible");
  } finally { t.cleanup(); }
});

test("A5 input validation: unknown platform, missing tone, oversize notes — all before any call", async () => {
  const p = fakeProviders({ google: { interactions: [capOk(payload(false))] } });
  const t = makeApp({ fetch: p.fetch });
  try {
    const { postId } = await seedPost(t);
    await assert.rejects(runCaption(t, { postId, platforms: ["myspace"] }), (e: unknown) => e instanceof CaptionInputError && /Unknown platform/.test(e.message));
    await assert.rejects(runCaption(t, { postId, tone: "no-such-tone" }), /Pick a tone/);
    await assert.rejects(runCaption(t, { postId, notes: "x".repeat(501) }), /500/);
    await assert.rejects(runCaption(t, { postId, platforms: [] }), /at least one platform/);
    assert.equal(p.google.posts().length, 0);
  } finally { t.cleanup(); }
});

test("A5 store: a save upserts per platform, feeds search; tags join only when ticked; the brand voice caps at 2000", async () => {
  const t = makeApp({ fetch: fakeProviders().fetch });
  try {
    const { postId } = await seedPost(t);
    saveCaption(t.app.db, postId, "instagram", "First version of the caption", "ventures build", "Alt one");
    saveCaption(t.app.db, postId, "instagram", "Second version of the caption", "ventures", "Alt two");
    saveCaption(t.app.db, postId, "x", "Short one", "", "");
    const saved = listCaptions(t.app.db, postId);
    assert.equal(saved.length, 2);
    assert.equal(saved.find((c) => c.platform === "instagram")!.text, "Second version of the caption");
    assert.equal(saved.find((c) => c.platform === "x")!.text, "Short one");
    // Over-limit saves as-is (flagged in the UI, never cut).
    saveCaption(t.app.db, postId, "x", "X".repeat(300), "", "");
    assert.equal(listCaptions(t.app.db, postId).find((c) => c.platform === "x")!.text.length, 300);
    // Search by a caption word and by a tag.
    assert.equal(searchPosts(t.app.db, "version").length, 1);
    assert.equal(searchPosts(t.app.db, "lighthouse").length, 1);
    assert.equal(searchPosts(t.app.db, "giraffe").length, 0);
    const tags = acceptTags(t.app.db, postId, ["buildroom", "#launch", "buildroom"]);
    assert.deepEqual(tags.map((x) => x.name), ["buildroom", "launch"]);
    assert.equal(searchPosts(t.app.db, "buildroom").length, 1);
    assert.equal(listPostTags(t.app.db, postId).length, 2);
    assert.throws(() => acceptTags(t.app.db, postId, Array.from({ length: 11 }, (_, i) => `t${i}`)), (e: unknown) => e instanceof CaptionStoreError && /10 tags/.test(e.message));
    assert.throws(() => acceptTags(t.app.db, postId, []), /at least one tag/);
    // Brand voice.
    assert.equal(getBrandVoice(t.app.db), "");
    setBrandVoice(t.app.db, "Short sentences. Real numbers. No hype.");
    assert.equal(getBrandVoice(t.app.db), "Short sentences. Real numbers. No hype.");
    assert.throws(() => setBrandVoice(t.app.db, "x".repeat(2001)), /2000/);
  } finally { t.cleanup(); }
});
