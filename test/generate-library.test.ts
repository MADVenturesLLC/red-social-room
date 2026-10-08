// prompt -> image -> Save to library -> search by prompt text (TECH-PLAN-v1.md section 9 A1), with the
// real-person check (D1/F10/G7; Amendment 1 section 4 line 278) and storage failure (F16).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { runGenerate } from "../src/server/generate.ts";
import { savePost, searchPosts, ftsQuery, LibraryError } from "../src/server/library.ts";
import { monthTotals } from "../src/server/ledger.ts";
import { storeIo } from "../src/server/store.ts";
import { inspectImage } from "../spike/lib/image.ts";
import { PROMPTS } from "../spike/prompts.ts";
import { makeApp, fakeXai, sampleJpeg, ledgerRows } from "./helpers.ts";
import { nameListMethod } from "../src/server/prompt-check.ts";
import { REPO_ROOT } from "../src/server/config.ts";

async function withApp(fn: (t: ReturnType<typeof makeApp>, x: ReturnType<typeof fakeXai>) => Promise<void>, o: { names?: string | null; switches?: Record<string, unknown> } = {}) {
  const x = fakeXai();
  const t = makeApp({ fetch: x.fetch, names: o.names, switches: o.switches as never });
  try { await fn(t, x); } finally { t.cleanup(); }
}

test("A1 acceptance path: make an image, save it, find it by a word from the prompt", () => withApp(async (t) => {
  const v = await runGenerate(t.app, { prompt: "A friendly orange tabby cat on a wooden windowsill", ratio: "1:1" });
  assert.equal(v.status, "ok");
  const saved = savePost(t.app.db, v.generationId, "first test");
  assert.equal(saved.already, false);
  assert.deepEqual(searchPosts(t.app.db, "tabby").map((p) => p.generation_id), [v.generationId]);
  assert.deepEqual(searchPosts(t.app.db, "WINDOWSILL").map((p) => p.generation_id), [v.generationId], "case-insensitive");
  assert.deepEqual(searchPosts(t.app.db, "tab").map((p) => p.generation_id), [v.generationId], "prefix match");
  assert.deepEqual(searchPosts(t.app.db, "dog"), []);
  assert.equal(searchPosts(t.app.db, "").length, 1, "empty search lists recent posts");
  // Saving twice does not duplicate.
  assert.equal(savePost(t.app.db, v.generationId).already, true);
  assert.equal(searchPosts(t.app.db, "").length, 1);
}));

test("search treats FTS syntax as plain words (no query errors, no injection)", () => withApp(async (t) => {
  const v = await runGenerate(t.app, { prompt: "neon city at night", ratio: "1:1" });
  savePost(t.app.db, v.generationId);
  for (const q of ['"', "neon*", "NEAR(neon city)", "neon OR x", "city) AND (", "' ; DROP TABLE posts; --", "-neon", "^neon"]) {
    assert.doesNotThrow(() => searchPosts(t.app.db, q), q);
  }
  assert.equal(ftsQuery('neon" OR "x'), '"neon"* AND "OR"* AND "x"*');
  assert.equal(searchPosts(t.app.db, "neon OR x").length, 0, "OR is a word, not an operator");
}));

test("only a finished image can be saved", () => withApp(async (t) => {
  const v = await runGenerate(t.app, { prompt: PROMPTS.refusal, ratio: "1:1" });
  assert.throws(() => savePost(t.app.db, v.generationId), LibraryError);
  assert.throws(() => savePost(t.app.db, "not-a-uuid"), LibraryError);
}));

test("D2: 4:5 keeps the 3:4 original byte-for-byte and shows an 864x1080 attention crop labeled 'Made at 3:4, cropped to 4:5'", () => withApp(async (t) => {
  const v = await runGenerate(t.app, { prompt: "a red bicycle", ratio: "4:5" });
  assert.equal(v.status, "ok");
  const src = await sampleJpeg();
  assert.equal(v.original?.assetId, createHash("sha256").update(src).digest("hex"));
  assert.deepEqual([v.original?.width, v.original?.height], [864, 1152]);
  assert.deepEqual([v.image?.width, v.image?.height], [864, 1080]);
  assert.equal(v.displayNote, "Made at 3:4, cropped to 4:5");
  const stored = readFileSync(join(t.app.imagesDir, v.original!.assetId.slice(0, 2), `${v.original!.assetId}.jpg`));
  assert.ok(stored.equals(src), "original stored unchanged");
  const crop = readFileSync(join(t.app.imagesDir, v.image!.assetId.slice(0, 2), `${v.image!.assetId}.jpg`));
  assert.deepEqual([inspectImage(crop).width, inspectImage(crop).height], [864, 1080]);
  // Saving stores the tile image (the crop) with the prompt.
  savePost(t.app.db, v.generationId);
  assert.equal(searchPosts(t.app.db, "bicycle")[0].asset_id, v.image!.assetId);
}));

test("A1 acceptance (section 4 line 279): the spike's probe prompt is blocked with zero requests and the month total unchanged", () => withApp(async (t, x) => {
  const before = monthTotals(t.app.db).countedMicros;
  const v = await runGenerate(t.app, { prompt: PROMPTS.refusal, ratio: "1:1" });
  assert.equal(v.status, "blocked");
  assert.equal(v.message, "Not sent: this prompt asks for a photoreal image of a real person. Your rule blocks these.");
  assert.equal(x.requests.length, 0, "not even the key check");
  assert.equal(ledgerRows(t.app).length, 0);
  assert.equal(monthTotals(t.app.db).countedMicros, before);
  const pc = t.app.db.prepare("SELECT result, method, prompt_sha256 FROM prompt_checks").all() as Array<Record<string, unknown>>;
  assert.equal(pc.length, 1); assert.equal(pc[0].result, "blocked"); assert.equal(pc[0].method, "name_list");
  assert.notEqual(pc[0].prompt_sha256, PROMPTS.refusal, "only the prompt hash is stored in prompt_checks");
  const g = t.app.db.prepare("SELECT status, prompt FROM generations").get() as Record<string, unknown>;
  assert.equal(g.status, "blocked"); assert.equal(g.prompt, PROMPTS.refusal, "blocked prompt kept in history with the reason");
}));

test("name list matches whole words, any case, across punctuation and accents", () => withApp(async (t, x) => {
  for (const p of ["tom hanks on a boat", "TOM-HANKS portrait", "Tóm Hanks", "a photo of  Tom\nHanks"]) {
    assert.equal((await runGenerate(t.app, { prompt: p, ratio: "1:1" })).status, "blocked", p);
  }
  assert.equal((await runGenerate(t.app, { prompt: "a tomato and hankies", ratio: "1:1" })).status, "ok");
  assert.equal(x.posts().length, 1);
}));

test("P1c default: the check can't run (name list missing) -> blocked 'Prompt check unavailable. Retry.', nothing sent", () => withApp(async (t, x) => {
  const v = await runGenerate(t.app, { prompt: "a quiet lake", ratio: "1:1" });
  assert.equal(v.status, "not_sent");
  assert.equal(v.message, "Prompt check unavailable. Retry.");
  assert.equal(x.requests.length, 0);
  assert.equal(ledgerRows(t.app).length, 0);
}, { names: null }));

test("P1c default: an empty name list counts as 'can't run' and blocks", () => withApp(async (t, x) => {
  const v = await runGenerate(t.app, { prompt: "a quiet lake", ratio: "1:1" });
  assert.equal(v.message, "Prompt check unavailable. Retry.");
  assert.equal(x.requests.length, 0);
}, { names: "# nothing here\n\n" }));

test("A1 pin 9, line 360: the shipped name list has exactly one seed name, and it blocks", () => withApp(async (t, x) => {
  const shipped = join(REPO_ROOT, "config", "real-person-names.txt");
  const names = readFileSync(shipped, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  assert.deepEqual(names, ["Tom Hanks"]);
  t.app.promptMethod = nameListMethod(shipped);
  assert.equal((await runGenerate(t.app, { prompt: "Tom Hanks waving", ratio: "1:1" })).status, "blocked");
  assert.equal(x.requests.length, 0);
}));

test("A1 pin 9, line 360: an unreadable name list (no read permission) blocks 'Prompt check unavailable. Retry.', nothing sent", { skip: process.getuid?.() === 0 ? "root ignores file modes" : false }, () => withApp(async (t, x) => {
  chmodSync(t.namesFile, 0o000);
  try {
    const v = await runGenerate(t.app, { prompt: "a quiet lake", ratio: "1:1" });
    assert.equal(v.status, "not_sent");
    assert.equal(v.message, "Prompt check unavailable. Retry.");
    assert.equal(x.requests.length, 0);
    assert.equal(ledgerRows(t.app).length, 0);
  } finally { chmodSync(t.namesFile, 0o600); }
}));

test("P1c switch send_labeled: an unavailable check sends and labels the tile (config flips it, not code)", () => withApp(async (t, x) => {
  const v = await runGenerate(t.app, { prompt: "a quiet lake", ratio: "1:1" });
  assert.equal(v.status, "ok");
  assert.equal(v.label, "Sent without the real-person check (check unavailable)");
  assert.equal(x.posts().length, 1);
}, { names: null, switches: { promptCheck: { method: "name_list", onFailure: "send_labeled", override: "none" } } }));

test("the list is re-read per check: adding a name blocks it without a restart", () => withApp(async (t) => {
  assert.equal((await runGenerate(t.app, { prompt: "Ada Lovelace at a desk", ratio: "1:1" })).status, "ok");
  writeFileSync(t.namesFile, "Tom Hanks\nAda Lovelace\n");
  assert.equal((await runGenerate(t.app, { prompt: "Ada Lovelace at a desk", ratio: "1:1" })).status, "blocked");
}));

test("F16: disk full while storing -> 'Save failed: disk full', no temp file, no asset row, but the cost stays recorded", () => withApp(async (t) => {
  const orig = storeIo.renameSync;
  storeIo.renameSync = () => { throw Object.assign(new Error("no space"), { code: "ENOSPC" }); };
  try {
    const v = await runGenerate(t.app, { prompt: "a lighthouse", ratio: "1:1" });
    assert.equal(v.status, "error");
    assert.match(v.message ?? "", /^Save failed: disk full \([\d.]+ GB free\)\. The cost of this call is already recorded\.$/);
    const [row] = ledgerRows(t.app);
    assert.equal(row.status, "settled"); assert.equal(row.actual_micro_usd, 40000);
    assert.equal(Number((t.app.db.prepare("SELECT COUNT(*) AS n FROM assets").get() as { n: number }).n), 0);
    const leftovers = existsSync(t.app.imagesDir) ? readdirSync(t.app.imagesDir, { recursive: true }).filter((f) => String(f).endsWith(".part")) : [];
    assert.deepEqual(leftovers, []);
  } finally { storeIo.renameSync = orig; }
}));

test("F16: the image is fsynced before the rename (a failed fsync leaves no file behind)", () => withApp(async (t) => {
  const orig = storeIo.fsyncSync;
  storeIo.fsyncSync = () => { throw Object.assign(new Error("io"), { code: "EIO" }); };
  try {
    const v = await runGenerate(t.app, { prompt: "a lighthouse", ratio: "1:1" });
    assert.match(v.message ?? "", /^Save failed: I\/O error \(EIO\)/);
    const files = existsSync(t.app.imagesDir) ? readdirSync(t.app.imagesDir, { recursive: true }).filter((f) => /\.(jpg|part)$/.test(String(f))) : [];
    assert.deepEqual(files, []);
  } finally { storeIo.fsyncSync = orig; }
}));

test("the same bytes are stored once (content-addressed) and never overwritten", () => withApp(async (t) => {
  const a = await runGenerate(t.app, { prompt: "one", ratio: "1:1" });
  const b = await runGenerate(t.app, { prompt: "two", ratio: "1:1" });
  assert.equal(a.image?.assetId, b.image?.assetId);
  assert.equal(Number((t.app.db.prepare("SELECT COUNT(*) AS n FROM assets").get() as { n: number }).n), 1);
  const p = join(t.app.imagesDir, a.image!.assetId.slice(0, 2), `${a.image!.assetId}.jpg`);
  assert.ok(existsSync(p));
  unlinkSync(p); // not a real scenario; just proves the path layout used by /api/assets
}));
