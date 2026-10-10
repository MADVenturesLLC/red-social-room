// A7: the restore drill (the plan's acceptance: "a restore from backup onto a clean folder brings the
// library back"). This module is the engine; scripts/restore-drill.mjs is the thin command line around
// it. It downloads the manifest, the database and every listed file into a clean target directory,
// verifies each content-addressed file's sha256 against its own name, opens the restored database and
// compares its row counts with the manifest — then prints a report a human can read and exits 0/1.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ObjectStore } from "./r2.ts";

export interface RestoreManifest {
  v: number;
  created_at: string;
  db: { key: string; sha256: string; bytes: number };
  counts?: { posts: number; assets: number };
  files: Array<{ rel: string; key: string; bytes: number }>;
}

export interface RestoreReport {
  ok: boolean;
  targetDir: string;
  dbSha256Ok: boolean;
  filesDownloaded: number;
  filesVerified: number;
  filesMissingInBackup: number;
  posts: number | null;
  assets: number | null;
  countsMatch: boolean | null;
  problems: string[];
}

export async function restoreFrom(store: ObjectStore, targetDir: string, opts: { wipeTarget?: boolean } = {}): Promise<RestoreReport> {
  const report: RestoreReport = { ok: false, targetDir, dbSha256Ok: false, filesDownloaded: 0, filesVerified: 0, filesMissingInBackup: 0, posts: null, assets: null, countsMatch: null, problems: [] };
  if (opts.wipeTarget !== false && existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });

  const mb = await store.get("rsr/manifest.json");
  if (!mb) { report.problems.push("No manifest at rsr/manifest.json — nothing to restore."); return report; }
  let manifest: RestoreManifest;
  try { manifest = JSON.parse(Buffer.from(mb).toString("utf8")) as RestoreManifest; } catch (e) { report.problems.push(`Manifest is not readable JSON: ${(e as Error).message.slice(0, 120)}`); return report; }
  if (manifest.v !== 1 || !manifest.db?.key || !Array.isArray(manifest.files)) { report.problems.push("Manifest has an unexpected shape."); return report; }
  // Review round: a v1 manifest always carries its counts; without them the drill cannot keep its promise
  // (post/asset verification), so restore continues for diagnosis but the run is a failure either way.
  const countsPresent = !!manifest.counts && Number.isInteger(manifest.counts.posts) && Number.isInteger(manifest.counts.assets);
  if (!countsPresent) report.problems.push("Manifest has no post/asset counts — a v1 manifest must carry them to pass the drill.");

  // 1. The database.
  const dbBytes = await store.get(manifest.db.key);
  if (!dbBytes) { report.problems.push(`The database listed in the manifest is missing: ${manifest.db.key}`); return report; }
  const dbSha = createHash("sha256").update(dbBytes).digest("hex");
  report.dbSha256Ok = dbSha === manifest.db.sha256;
  if (!report.dbSha256Ok) report.problems.push("The database file does not match the manifest's sha256.");
  const dbPath = join(targetDir, "db", "rsr.sqlite");
  mkdirSync(dirname(dbPath), { recursive: true });
  writeFileSync(dbPath, dbBytes);

  // 2. Every file (content-addressed: its sha256 is its own name, so each download is checked strictly).
  //    Review round: each path is validated against the store's exact shape BEFORE joining it to the
  //    target, so a malformed or hostile manifest can never make the drill write outside the clean folder.
  const REL_RE = /^images\/[0-9a-f]{2}\/[0-9a-f]{64}\.(png|jpg|jpeg|webp)$/;
  const KEY_RE = /^rsr\/assets\/[0-9a-f]{2}\/[0-9a-f]{64}\.(png|jpg|jpeg|webp)$/;
  for (const f of manifest.files) {
    if (!REL_RE.test(f.rel) || !KEY_RE.test(f.key)) {
      report.problems.push(`Manifest lists an unexpected path: ${String(f.rel).slice(0, 120)}`);
      continue;
    }
    const buf = await store.get(f.key);
    if (!buf) { report.filesMissingInBackup++; report.problems.push(`Missing in backup: ${f.rel}`); continue; }
    report.filesDownloaded++;
    const name = f.rel.split("/").pop() ?? "";
    const sha = name.split(".")[0];
    const ok = createHash("sha256").update(buf).digest("hex") === sha;
    if (ok) report.filesVerified++; else report.problems.push(`File bytes do not match its name: ${f.rel}`);
    const p = join(targetDir, f.rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, buf);
  }

  // 3. Open the restored database and compare counts.
  try {
    // A writable handle on purpose: FTS5's integrity-check writes to the index it checks, and this file is
    // a disposable copy inside the drill's target folder.
    const db = new DatabaseSync(dbPath);
    const posts = (db.prepare("SELECT count(*) AS n FROM posts").get() as { n: number }).n;
    const assets = (db.prepare("SELECT count(*) AS n FROM assets").get() as { n: number }).n;
    report.posts = posts; report.assets = assets;
    if (manifest.counts) report.countsMatch = posts === manifest.counts.posts && assets === manifest.counts.assets;
    try { db.exec("INSERT INTO posts_fts(posts_fts) VALUES('integrity-check')"); } catch (e) { report.problems.push(`Restored search index fails its integrity check: ${(e as Error).message.slice(0, 120)}`); }
    db.close();
  } catch (e) {
    report.problems.push(`The restored database could not be opened: ${(e as Error).message.slice(0, 160)}`);
  }

  report.ok = report.problems.length === 0 && report.dbSha256Ok && report.filesMissingInBackup === 0 && report.countsMatch === true;
  return report;
}

/** A local directory that behaves like the object store — used by the tests and by --from-dir drills. */
export function dirObjectStore(root: string): ObjectStore {
  const pathOf = (key: string) => join(root, key);
  return {
    async put(key, body) { mkdirSync(dirname(pathOf(key)), { recursive: true }); writeFileSync(pathOf(key), body); },
    async get(key) { try { return new Uint8Array(readFileSync(pathOf(key))); } catch { return null; } },
  };
}

/** Count files in a restored tree, for the human line of the drill output. */
export function countRestoredFiles(targetDir: string): number {
  const img = join(targetDir, "images");
  if (!existsSync(img)) return 0;
  let n = 0;
  for (const sub of readdirSync(img)) { try { if (statSync(join(img, sub)).isDirectory()) n += readdirSync(join(img, sub)).length; } catch { /* skip */ } }
  return n;
}
