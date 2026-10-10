// A7 battery: nightly backup (FD:6/F23), the restore drill, the search-index check (F17), snippets and
// reuse (T:76), tag filters and post deletion. No network: the object store is a local directory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DB } from "../src/server/db.ts";
import { runBackup, backupSummary, shouldRunNightly, walkImages, STALE_BACKUP_MS } from "../src/server/backup.ts";
import { restoreFrom, dirObjectStore, countRestoredFiles } from "../src/server/restore.ts";
import { checkFts, ftsCounts, maintenanceRows } from "../src/server/fts.ts";
import { addSnippet, deletePost, deleteSnippet, listSnippets, listTags, recentPrompts, reuseData, searchPosts, savePost, LibraryError } from "../src/server/library.ts";
import { loadR2Config, saveR2Config, r2Status, R2ConfigError, clearR2Config } from "../src/server/r2config.ts";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A db with two library posts (each with its own asset, run, job and generation rows). */
function seededDb(dir: string): { db: DB; p1: number; p2: number; a1: string; a2: string } {
  const db = openDb(join(dir, "db", "rsr.sqlite"), { spikeLedgerPath: null });
  const a1 = "a".repeat(64), a2 = "b".repeat(64);
  const insAsset = db.prepare("INSERT INTO assets (id, rel_path, mime, bytes, created_at) VALUES (?, ?, 'image/jpeg', 10, '2026-10-10T01:00:00-04:00')");
  insAsset.run(a1, `images/aa/${a1}.jpg`); insAsset.run(a2, `images/bb/${a2}.jpg`);
  const insRun = db.prepare("INSERT INTO runs (id, created_at, prompt, status) VALUES (?, '2026-10-10T01:00:00-04:00', ?, 'ok')");
  const insGen = db.prepare(`INSERT INTO generations (id, run_id, created_at, provider, model, kind, prompt, params, status, output_asset_id, display_asset_id)
    VALUES (?, ?, '2026-10-10T01:00:00-04:00', ?, ?, 'generate', ?, '{}', 'ok', ?, ?)`);
  const insJob = db.prepare(`INSERT INTO jobs (id, run_id, creator_id, provider, model, generation_id, prompt, ratio, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ok', '2026-10-10T01:00:00-04:00')`);
  for (const [n, asset, creator, prompt, ratio] of [["1", a1, "xai", "orange cat on a windowsill", "4:5"], ["2", a2, "google", "blue whale over the city", "1:1"]] as const) {
    const run = `00000000-0000-4000-8000-00000000000${n}`;
    const gen = `11111111-1111-4111-8111-11111111111${n}`;
    insRun.run(run, prompt);
    insGen.run(gen, run, creator === "xai" ? "xai" : "google", creator === "xai" ? "grok-imagine-image-2.0" : "gemini-3.1-flash-image", prompt, asset, asset);
    insJob.run(`22222222-2222-4222-8222-22222222222${n}`, run, creator, creator, "m", gen, prompt, ratio);
  }
  const p1 = Number(db.prepare("INSERT INTO posts (created_at, generation_id, asset_id, prompt, model) VALUES ('2026-10-10T01:00:00-04:00', ?, ?, ?, 'm')").run("11111111-1111-4111-8111-111111111111", a1, "orange cat on a windowsill").lastInsertRowid);
  const p2 = Number(db.prepare("INSERT INTO posts (created_at, generation_id, asset_id, prompt, model) VALUES ('2026-10-10T01:00:00-04:00', ?, ?, ?, 'm')").run("11111111-1111-4111-8111-111111111112", a2, "blue whale over the city").lastInsertRowid);
  return { db, p1, p2, a1, a2 };
}

/** A content-addressed image file under images/, named by its own sha256 — as the real store writes it. */
function seedImage(dir: string, body: string): string {
  const sha = createHash("sha256").update(body).digest("hex");
  const rel = join("images", sha.slice(0, 2), `${sha}.jpg`);
  mkdirSync(join(dir, rel.split("/")[0], rel.split("/")[1]), { recursive: true });
  writeFileSync(join(dir, rel), body);
  return sha;
}

test("A7 backup: uploads the database, the new files and a manifest; the next run uploads only what is new", async () => {
  const dir = tmp("rsr-a7-b1-"); const storeDir = tmp("rsr-a7-store1-");
  try {
    const { db } = seededDb(dir);
    const sha1 = seedImage(dir, "image-one"); seedImage(dir, "image-two");
    const store = dirObjectStore(storeDir);
    const now = () => new Date("2026-10-10T07:30:00Z");
    const r1 = await runBackup({ db, dataDir: dir, imagesDir: join(dir, "images"), store, now });
    assert.equal(r1.ok, true, r1.error);
    assert.equal(r1.filesUploaded, 2);
    assert.ok(r1.dbBytes > 0);
    const manifest = JSON.parse(Buffer.from((await store.get("rsr/manifest.json"))!).toString("utf8")) as { db: { sha256: string; key: string }; files: Array<{ rel: string }>; counts: { posts: number; assets: number } };
    assert.equal(manifest.counts.posts, 2);
    assert.equal(manifest.files.length, 2);
    assert.equal(manifest.db.key, `rsr/db/${manifest.db.sha256}.sqlite`);
    // The snapshot really is a usable database.
    const snapPath = join(storeDir, manifest.db.key);
    assert.equal(statSync(snapPath).size, r1.dbBytes);
    // Second run: one more file appears -> exactly one upload; the manifest lists three.
    seedImage(dir, "image-three");
    const r2 = await runBackup({ db, dataDir: dir, imagesDir: join(dir, "images"), store, now });
    assert.equal(r2.ok, true);
    assert.equal(r2.filesUploaded, 1);
    assert.equal(r2.filesTotal, 3);
    const m2 = JSON.parse(Buffer.from((await store.get("rsr/manifest.json"))!).toString("utf8")) as { files: Array<{ rel: string }> };
    assert.equal(m2.files.length, 3);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(storeDir, { recursive: true, force: true }); }
});

test("A7 backup (F23): a failing upload records a failed row with the error; the banner is red only after 48 h", async () => {
  const dir = tmp("rsr-a7-b2-"); const storeDir = tmp("rsr-a7-store2-");
  try {
    const { db } = seededDb(dir);
    seedImage(dir, "img");
    const good = dirObjectStore(storeDir);
    const t0 = new Date("2026-10-10T07:30:00Z");
    const ok1 = await runBackup({ db, dataDir: dir, imagesDir: join(dir, "images"), store: good, now: () => t0 });
    assert.equal(ok1.ok, true);
    const s = backupSummary(db, new Date(t0.getTime() + STALE_BACKUP_MS - 3_600_000));
    assert.equal(s.banner, false, "47 h after a good backup there is no banner");
    assert.equal(backupSummary(db, new Date(t0.getTime() + STALE_BACKUP_MS + 3_600_000)).banner, true, "49 h after a good backup the banner shows");
    const failing = { put: async () => { throw new Error("R2 refused the upload of rsr/db/x (HTTP 403): denied"); }, get: async () => null };
    const bad = await runBackup({ db, dataDir: dir, imagesDir: join(dir, "images"), store: failing, now: () => new Date(t0.getTime() + 26 * 3.6e6) });
    assert.equal(bad.ok, false);
    assert.match(bad.error ?? "", /R2 refused/);
    const row = db.prepare("SELECT ok, error FROM backups ORDER BY id DESC LIMIT 1").get() as { ok: number; error: string };
    assert.equal(row.ok, 0);
    assert.match(row.error, /R2 refused/);
    // The last good backup still governs the banner (a failure does not erase it).
    assert.equal(backupSummary(db, new Date(t0.getTime() + 27 * 3.6e6)).banner, false);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(storeDir, { recursive: true, force: true }); }
});

test("A7 backup: without a target nothing runs and no row is written", async () => {
  const dir = tmp("rsr-a7-b3-");
  try {
    const { db } = seededDb(dir);
    const r = await runBackup({ db, dataDir: dir, imagesDir: join(dir, "images"), store: null });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /not set up/);
    assert.equal((db.prepare("SELECT count(*) AS n FROM backups").get() as { n: number }).n, 0);
    assert.equal(backupSummary(db, new Date()).banner, true, "never backed up => the banner shows");
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("A7 nightly guard: once a day, first tick at/after 3 AM New York", () => {
  const before3 = new Date("2026-10-10T06:00:00Z");           // 2:00 AM EDT
  const at3 = new Date("2026-10-10T07:05:00Z");               // 3:05 AM EDT
  assert.equal(shouldRunNightly(before3, null), false);
  assert.equal(shouldRunNightly(at3, null), true);
  assert.equal(shouldRunNightly(at3, "2026-10-10T03:01:00-04:00"), false, "already ran today");
  assert.equal(shouldRunNightly(new Date("2026-10-11T07:05:00Z"), "2026-10-10T03:01:00-04:00"), true, "a new day");
  assert.equal(shouldRunNightly(new Date("2026-10-10T12:00:00Z"), "2026-10-09T03:01:00-04:00"), true, "catch-up later in the day");
});

test("A7 restore drill: a backup restores onto a clean folder and verifies (and a missing manifest fails loudly)", async () => {
  const dir = tmp("rsr-a7-r1-"); const storeDir = tmp("rsr-a7-store3-"); const target = tmp("rsr-a7-target-");
  const sd2 = tmp("rsr-a7-store4-"), sd3 = tmp("rsr-a7-store5-"), t3 = tmp("rsr-a7-target4-");
  try {
    const { db, p1, p2 } = seededDb(dir);
    seedImage(dir, "one"); seedImage(dir, "two");
    const store = dirObjectStore(storeDir);
    await runBackup({ db, dataDir: dir, imagesDir: join(dir, "images"), store });
    db.close();
    const report = await restoreFrom(store, target);
    for (const p of report.problems) assert.fail(p);
    assert.equal(report.ok, true);
    assert.equal(report.dbSha256Ok, true);
    assert.equal(report.filesDownloaded, 2);
    assert.equal(report.filesVerified, 2);
    assert.equal(report.posts, 2);
    assert.equal(report.assets, 2);
    assert.equal(report.countsMatch, true);
    assert.equal(countRestoredFiles(target), 2);
    assert.ok(p1 > 0 && p2 > 0);
    // A drill against an empty store says so instead of "passing".
    const empty = await restoreFrom(dirObjectStore(tmp("rsr-a7-empty-")), tmp("rsr-a7-target2-"));
    assert.equal(empty.ok, false);
    assert.ok(empty.problems.some((p) => /No manifest/.test(p)));
    // Review round: a manifest without counts must not pass (v1 always carries them)...
    const raw = JSON.parse(Buffer.from((await store.get("rsr/manifest.json"))!).toString("utf8")) as { files: unknown[] } & Record<string, unknown>;
    const noCounts = { ...raw } as Record<string, unknown>;
    delete noCounts.counts;
    cpSync(storeDir, sd2, { recursive: true });
    await dirObjectStore(sd2).put("rsr/manifest.json", Buffer.from(JSON.stringify(noCounts)));
    const rep2 = await restoreFrom(dirObjectStore(sd2), tmp("rsr-a7-target3-"));
    assert.equal(rep2.ok, false);
    assert.ok(rep2.problems.some((p) => /counts/.test(p)), rep2.problems.join("; "));
    // ...and a path outside the store's exact shape is refused before anything is written anywhere.
    const evil = { ...raw, files: [{ rel: "../../evil.txt", key: "rsr/assets/xx/yy.txt", bytes: 3 }, ...raw.files] };
    cpSync(storeDir, sd3, { recursive: true });
    await dirObjectStore(sd3).put("rsr/manifest.json", Buffer.from(JSON.stringify(evil)));
    const rep3 = await restoreFrom(dirObjectStore(sd3), t3);
    assert.equal(rep3.ok, false);
    assert.ok(rep3.problems.some((p) => /unexpected path/.test(p)), rep3.problems.join("; "));
    assert.equal(existsSync(join(t3, "..", "evil.txt")), false, "nothing is written outside the clean target");
  } finally { for (const d of [dir, storeDir, target, sd2, sd3, t3]) rmSync(d, { recursive: true, force: true }); }
});

test("A7 FTS (F17): a healthy index passes; a wiped index is detected, rebuilt, and logged", () => {
  const dir = tmp("rsr-a7-f1-");
  try {
    const { db } = seededDb(dir);
    const first = checkFts(db);
    assert.equal(first.posts, 2);
    assert.equal(first.indexed, 2);
    assert.equal(first.integrityOk, true);
    assert.equal(first.rebuilt, false);
    db.exec("INSERT INTO posts_fts(posts_fts) VALUES('delete-all')");
    assert.equal(ftsCounts(db).indexed, 0, "the index really is empty now");
    const second = checkFts(db);
    assert.equal(second.rebuilt, true);
    assert.equal(second.posts, 2);
    assert.equal(second.indexed, 2, "the rebuild brought every post back");
    assert.equal(second.integrityOk, true);
    const mine = maintenanceRows(db, 10).filter((m) => m.kind === "fts_rebuild");
    assert.equal(mine.length, 1);
    assert.match(mine[0]!.detail, /mismatch before rebuild/);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("A7 snippets: save, dedupe, list, remove", () => {
  const dir = tmp("rsr-a7-s1-");
  try {
    const { db } = seededDb(dir);
    const a = addSnippet(db, "  a warm sunset over the harbor  ");
    const again = addSnippet(db, "a warm sunset over the harbor");
    assert.equal(again.id, a.id, "the same text is one snippet");
    addSnippet(db, "neon lights, wet asphalt");
    assert.equal(listSnippets(db).length, 2);
    assert.equal(Object.getPrototypeOf(listSnippets(db)[0]!), Object.prototype, "snippets must be plain objects (React server->client rule)");
    assert.equal(listSnippets(db)[0]!.text, "neon lights, wet asphalt", "newest first");
    assert.equal(deleteSnippet(db, a.id), true);
    assert.equal(deleteSnippet(db, a.id), false);
    assert.throws(() => addSnippet(db, "   "), LibraryError);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("A7 reuse + recent prompts: a post hands back its prompt, ratio and model", () => {
  const dir = tmp("rsr-a7-u1-");
  try {
    const { db, p1 } = seededDb(dir);
    const reuse = reuseData(db, p1);
    if (!reuse) assert.fail("reuseData returned null for an existing post");
    assert.equal(reuse.prompt, "orange cat on a windowsill");
    assert.equal(reuse.ratio, "4:5");
    assert.equal(reuse.creator, "xai");
    assert.equal(reuseData(db, 999), null);
    assert.equal(reuseData(db, "nope"), null);
    const recent = recentPrompts(db);
    assert.deepEqual(recent.slice(0, 2), ["blue whale over the city", "orange cat on a windowsill"]);
    // A1-era posts (no jobs row): the ratio comes from the generation's params, the creator from its provider.
    db.prepare("INSERT INTO assets (id, rel_path, mime, bytes, created_at) VALUES (?, ?, 'image/jpeg', 10, 'now')").run("c".repeat(64), `images/cc/${"c".repeat(64)}.jpg`);
    db.prepare("INSERT INTO runs (id, created_at, prompt, status) VALUES ('33333333-3333-4333-8333-333333333333', 'now', 'old post', 'ok')").run();
    db.prepare(`INSERT INTO generations (id, run_id, created_at, provider, model, kind, prompt, params, status, output_asset_id, display_asset_id)
      VALUES ('44444444-4444-4444-8444-444444444444', '33333333-3333-4333-8333-333333333333', 'now', 'xai', 'grok-imagine-image-2.0', 'generate', 'old post', '{"requested_ratio":"16:9","sent_ratio":"16:9","n":1}', 'ok', ?, ?)`).run("c".repeat(64), "c".repeat(64));
    const oldPost = Number(db.prepare("INSERT INTO posts (created_at, generation_id, asset_id, prompt, model) VALUES ('now', '44444444-4444-4444-8444-444444444444', ?, 'old post', 'grok-imagine-image-2.0')").run("c".repeat(64)).lastInsertRowid);
    const oldReuse = reuseData(db, oldPost);
    if (!oldReuse) assert.fail("reuseData returned null for an A1-era post");
    assert.equal(oldReuse.ratio, "16:9");
    assert.equal(oldReuse.creator, "xai");
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("A7 delete post: the rows go, the file stays, the search no longer finds it", () => {
  const dir = tmp("rsr-a7-d1-");
  try {
    const { db, p1, a1 } = (() => { const s = seededDb(dir); return { ...s, a1: s.a1 }; })();
    db.prepare("INSERT INTO captions (post_id, platform, text, hashtags, alt_text, model, created_at) VALUES (?, 'x', 'cap', '', '', 'm', 'now')").run(p1);
    const tag = Number(db.prepare("INSERT INTO tags (name, created_at) VALUES ('cats', 'now')").run().lastInsertRowid);
    db.prepare("INSERT INTO post_tags (post_id, tag_id) VALUES (?, ?)").run(p1, tag);
    db.prepare("INSERT INTO renditions (post_id, preset_id, asset_id, source_asset_id, method, created_at) VALUES (?, 'ig-feed', ?, ?, 'crop', 'now')").run(p1, a1, a1);
    assert.equal(searchPosts(db, "orange").length, 1);
    assert.equal(deletePost(db, p1), true);
    assert.equal(searchPosts(db, "orange").length, 0, "the FTS triggers removed it from search");
    assert.equal((db.prepare("SELECT count(*) AS n FROM captions").get() as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT count(*) AS n FROM post_tags").get() as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT count(*) AS n FROM renditions").get() as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT count(*) AS n FROM assets WHERE id = ?").get(a1) as { n: number }).n, 1, "the file stays for other references");
    assert.equal(deletePost(db, p1), false, "deleting twice is an honest miss");
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("A7 tag filters: searchPosts by tag, with or without a search word; listTags counts", () => {
  const dir = tmp("rsr-a7-t1-");
  try {
    const { db, p1 } = seededDb(dir);
    const tag = Number(db.prepare("INSERT INTO tags (name, created_at) VALUES ('cats', 'now')").run().lastInsertRowid);
    db.prepare("INSERT INTO post_tags (post_id, tag_id) VALUES (?, ?)").run(p1, tag);
    assert.equal(searchPosts(db, "", "cats").length, 1);
    assert.equal(searchPosts(db, "", "cats")[0]!.id, p1);
    assert.equal(searchPosts(db, "whale", "cats").length, 0, "word and tag must both match");
    assert.equal(searchPosts(db, "orange", "cats").length, 1);
    const tags = listTags(db);
    assert.equal(tags.length, 1);
    assert.equal(tags[0]!.name, "cats");
    assert.equal(tags[0]!.count, 1);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("A7 R2 target: validated on save, secrets only in mode-600 files, status shows the last 4", () => {
  const dir = tmp("rsr-a7-c1-");
  try {
    const { db } = seededDb(dir);
    // No secrets/ on purpose: the first save must create the store itself (review round).
    assert.throws(() => saveR2Config(db, dir, { endpoint: "https://example.com", bucket: "b", accessKeyId: "k".repeat(30), secretAccessKey: "s".repeat(30) }), R2ConfigError);
    assert.throws(() => saveR2Config(db, dir, { endpoint: "https://acct123.r2.cloudflarestorage.com", bucket: "Bad_Bucket", accessKeyId: "k".repeat(30), secretAccessKey: "s".repeat(30) }), R2ConfigError);
    const st = saveR2Config(db, dir, { endpoint: "https://acct123.r2.cloudflarestorage.com", bucket: "rsr-backup", accessKeyId: "AKIDEXAMPLE1234", secretAccessKey: "c2VjcmV0ZXhhbXBsZXNlY3JldGV4YW1wbGU=" });
    assert.equal(st.configured, true);
    assert.equal(st.keyLast4, "1234");
    const mode = (f: string) => (statSync(join(dir, "secrets", f)).mode & 0o777).toString(8);
    assert.equal(mode("r2_access_key_id"), "600");
    assert.equal(mode("r2_secret_access_key"), "600");
    assert.equal((statSync(join(dir, "secrets")).mode & 0o777).toString(8), "700", "the store itself is created mode 700");
    const back = loadR2Config(db, dir);
    assert.equal(back?.bucket, "rsr-backup");
    assert.equal(back?.secretAccessKey, "c2VjcmV0ZXhhbXBsZXNlY3JldGV4YW1wbGU=");
    clearR2Config(db, dir);
    assert.equal(r2Status(db, dir).configured, false);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("A7 backup: walkImages takes only content-addressed image files (strays, .part files and subdirectories stay out)", () => {
  const dir = tmp("rsr-a7-w1-");
  try {
    const sha = seedImage(dir, "x");
    const shard = join(dir, "images", sha.slice(0, 2));
    writeFileSync(join(dir, "images", "stray.txt"), "not an image");           // top level
    writeFileSync(join(shard, `${"0".repeat(64)}.part`), "partial write");       // in-flight write
    writeFileSync(join(shard, "notes.txt"), "junk");                             // stray in a shard
    mkdirSync(join(shard, "nested"), { recursive: true });                       // directory in a shard
    mkdirSync(join(dir, "images", "nothex"), { recursive: true });               // not a shard name
    const files = walkImages(join(dir, "images"));
    assert.equal(files.length, 1, JSON.stringify(files));
    assert.match(files[0]!.rel, /^images\/[0-9a-f]{2}\/[0-9a-f]{64}\.jpg$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
