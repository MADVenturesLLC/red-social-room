// A7 (FD:6 nightly backup; F23 "Backup fails"): the backup engine. One run = snapshot the database
// (VACUUM INTO, a compact single file), upload every image file that has not been uploaded before
// (the store is content-addressed, so file names never change), then upload the manifest that lists
// everything a restore needs. Every run writes one `backups` row (success or failure) and one
// maintenance_log row; Settings shows the red banner when the last ok row is older than 48 h.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isoNY } from "../../spike/lib/ledger.ts";
import type { DB } from "./db.ts";
import type { ObjectStore } from "./r2.ts";

export const STALE_BACKUP_MS = 48 * 60 * 60 * 1000;
export const MANIFEST_KEY = "rsr/manifest.json";
export const BACKUP_HOUR_NY = 3;                        // the nightly job runs in the first tick at/after 3 AM New York

export interface BackupDeps {
  db: DB;
  dataDir: string;
  imagesDir: string;
  store: ObjectStore | null;                           // null = R2 not configured yet
  now?: () => Date;
  log?: (m: string) => void;
}

export interface BackupResult {
  ok: boolean;
  error?: string;
  filesUploaded: number;
  filesTotal: number;
  bytesUploaded: number;
  dbBytes: number;
  dbSha256: string | null;
}

export interface BackupFile { rel: string; key: string; bytes: number }

export function sha256Hex(b: Uint8Array): string {
  return createHash("sha256").update(b).digest("hex");
}

/** Every file under images/ (shape: images/<xx>/<sha256>.<ext>). Missing directory = none yet.
 *  Review round: only regular files whose names are exactly the store's shape count — .part files from an
 *  in-flight write, stray files and nested directories stay out (they are not part of the contract and
 *  must never be uploaded or made the restore drill's problem). */
export function walkImages(imagesDir: string): BackupFile[] {
  const out: BackupFile[] = [];
  if (!existsSync(imagesDir)) return out;
  const SHARD_RE = /^[0-9a-f]{2}$/;
  const NAME_RE = /^[0-9a-f]{64}\.(png|jpg|jpeg|webp)$/;
  for (const sub of readdirSync(imagesDir)) {
    if (!SHARD_RE.test(sub)) continue;
    const dir = join(imagesDir, sub);
    let st; try { st = statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const name of readdirSync(dir)) {
      if (!NAME_RE.test(name)) continue;
      const p = join(dir, name);
      try { const f = statSync(p); if (!f.isFile()) continue; out.push({ rel: `images/${sub}/${name}`, key: `rsr/assets/${sub}/${name}`, bytes: f.size }); } catch { /* vanished mid-scan */ }
    }
  }
  return out;
}

/** The post/asset counts as of the snapshot file itself (never the live database, review round). */
function countsIn(file: string): { posts: number; assets: number } {
  const s = new DatabaseSync(file);
  try {
    const posts = (s.prepare("SELECT count(*) AS n FROM posts").get() as { n: number }).n;
    const assets = (s.prepare("SELECT count(*) AS n FROM assets").get() as { n: number }).n;
    return { posts, assets };
  } finally { s.close(); }
}

/** NY wall-clock parts, for the nightly schedule guard (pure enough for tests with a fixed Date). */
export function nyParts(now: Date): { date: string; hour: number } {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false });
  const parts = Object.fromEntries(f.formatToParts(now).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24 };
}

/** Run once a day, in the first tick at/after 3 AM New York; `lastStartedAt` is an isoNY string or null. */
export function shouldRunNightly(now: Date, lastStartedAt: string | null): boolean {
  const { date, hour } = nyParts(now);
  if (hour < BACKUP_HOUR_NY) return false;
  if (!lastStartedAt) return true;
  return lastStartedAt.slice(0, 10) !== date;
}

export interface BackupSummary {
  lastOkAt: string | null;
  lastAttemptAt: string | null;
  staleMs: number | null;
  banner: boolean;                                    // F23: no good backup, or older than 48 h
  never: boolean;
}

export function backupSummary(db: DB, now: Date): BackupSummary {
  const lastOk = db.prepare("SELECT finished_at FROM backups WHERE ok = 1 ORDER BY id DESC LIMIT 1").get() as { finished_at: string } | undefined;
  const lastAny = db.prepare("SELECT started_at FROM backups ORDER BY id DESC LIMIT 1").get() as { started_at: string } | undefined;
  const lastOkAt = lastOk?.finished_at ?? null;
  const staleMs = lastOkAt ? now.getTime() - Date.parse(lastOkAt) : null;
  return {
    lastOkAt,
    lastAttemptAt: lastAny?.started_at ?? null,
    staleMs,
    never: lastOkAt === null,
    banner: lastOkAt === null || (staleMs !== null && staleMs > STALE_BACKUP_MS),
  };
}

export async function runBackup(d: BackupDeps): Promise<BackupResult> {
  const now = d.now ?? (() => new Date());
  const stamp = now();
  const startedAt = isoNY(stamp);
  const log = d.log ?? (() => undefined);
  const zero: BackupResult = { ok: false, filesUploaded: 0, filesTotal: 0, bytesUploaded: 0, dbBytes: 0, dbSha256: null };
  if (!d.store) return { ...zero, error: "R2 is not set up yet — add the endpoint, bucket and keys in Settings." };

  const row = d.db.prepare("INSERT INTO backups (started_at, ok) VALUES (?, NULL)").run(startedAt);
  const id = Number(row.lastInsertRowid);
  const finish = (r: BackupResult) => {
    d.db.prepare("UPDATE backups SET finished_at = ?, ok = ?, error = ?, files_uploaded = ?, files_total = ?, bytes_uploaded = ?, db_bytes = ?, db_sha256 = ?, manifest_key = ? WHERE id = ?")
      .run(isoNY(now()), r.ok ? 1 : 0, r.error ?? null, r.filesUploaded, r.filesTotal, r.bytesUploaded, r.dbBytes, r.dbSha256, r.ok ? MANIFEST_KEY : null, id);
    d.db.prepare("INSERT INTO maintenance_log (created_at, kind, detail) VALUES (?, 'backup', ?)")
      .run(isoNY(now()), JSON.stringify({ ok: r.ok, filesUploaded: r.filesUploaded, bytesUploaded: r.bytesUploaded, dbBytes: r.dbBytes, error: r.error ?? null }));
    return r;
  };

  try {
    // 1. Database snapshot (compact, single file) via VACUUM INTO.
    const stagingDir = join(d.dataDir, "backup-tmp");
    mkdirSync(stagingDir, { recursive: true });
    const snapshot = join(stagingDir, `rsr-${Date.now()}.sqlite`);
    let dbBuf: Buffer, dbSha: string, dbKey: string, counts: { posts: number; assets: number };
    // Review round: the snapshot is removed in a finally even when the upload throws (a failed run must
    // not leave a database-sized file behind to accumulate), and the counts are read from the snapshot.
    try {
      try { rmSync(snapshot, { force: true }); } catch { /* absent */ }
      const escaped = snapshot.replaceAll("'", "''");
      d.db.exec(`VACUUM INTO '${escaped}'`);
      dbBuf = readFileSync(snapshot);
      dbSha = sha256Hex(dbBuf);
      dbKey = `rsr/db/${dbSha}.sqlite`;
      counts = countsIn(snapshot);
      await d.store.put(dbKey, dbBuf, "application/vnd.sqlite3");
    } finally {
      rmSync(snapshot, { force: true });
    }

    // 2. Upload only image files not recorded as uploaded yet.
    const files = walkImages(d.imagesDir);
    const known = new Set((d.db.prepare("SELECT rel FROM backup_files").all() as unknown as Array<{ rel: string }>).map((r) => r.rel));
    let uploaded = 0, bytes = 0;
    for (const f of files) {
      if (known.has(f.rel)) continue;
      const buf = readFileSync(join(d.dataDir, f.rel));
      await d.store.put(f.key, buf);
      d.db.prepare("INSERT OR IGNORE INTO backup_files (rel, bytes, uploaded_at) VALUES (?, ?, ?)").run(f.rel, buf.length, isoNY(now()));
      uploaded++; bytes += buf.length;
    }
    const allFiles = d.db.prepare("SELECT rel, bytes FROM backup_files ORDER BY rel").all() as unknown as Array<{ rel: string; bytes: number }>;

    // 3. The manifest: everything a restore needs, plus the counts the drill verifies — read from the
    //    snapshot itself above, so the manifest can never describe a different set of rows than it names.
    const manifest = {
      v: 1,
      created_at: startedAt,
      db: { key: dbKey, sha256: dbSha, bytes: dbBuf.length },
      counts,
      files: allFiles.map((f) => ({ rel: f.rel, key: `rsr/assets/${f.rel.slice("images/".length)}`, bytes: f.bytes })),
    };
    const manifestBuf = Buffer.from(JSON.stringify(manifest), "utf8");
    await d.store.put(MANIFEST_KEY, manifestBuf, "application/json");
    await d.store.put(`rsr/history/manifest-${startedAt.slice(0, 10)}.json`, manifestBuf, "application/json");

    log(`backup ok: db ${dbBuf.length} bytes, ${uploaded} new file(s), ${allFiles.length} total`);
    return finish({ ok: true, filesUploaded: uploaded, filesTotal: allFiles.length, bytesUploaded: bytes, dbBytes: dbBuf.length, dbSha256: dbSha });
  } catch (e) {
    const message = (e as Error).message.slice(0, 400);
    log(`backup failed: ${message}`);
    return finish({ ...zero, error: message });
  }
}
