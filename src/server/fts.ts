// A7 (F17, "Search index out of sync"): a nightly row-count and integrity check over the posts FTS
// index, a rebuild when they differ, all logged to maintenance_log; plus the manual "Rebuild search
// index" action the row asks for. The row-count reads the FTS shadow table (posts_fts_docsize), because
// counting posts_fts itself just delegates to the content table and would always "match".
import { isoNY } from "../../spike/lib/ledger.ts";
import type { DB } from "./db.ts";

export interface FtsReport {
  posts: number;
  indexed: number;
  integrityOk: boolean;
  rebuilt: boolean;
  detail: string;
}

export function ftsCounts(db: DB): { posts: number; indexed: number } {
  const posts = (db.prepare("SELECT count(*) AS n FROM posts").get() as { n: number }).n;
  const indexed = (db.prepare("SELECT count(*) AS n FROM posts_fts_docsize").get() as { n: number }).n;
  return { posts, indexed };
}

/** FTS5's own index-vs-content check; throws (caught here) when the index disagrees with the posts rows. */
export function ftsIntegrity(db: DB): { ok: boolean; detail: string } {
  try {
    db.exec("INSERT INTO posts_fts(posts_fts) VALUES('integrity-check')");
    return { ok: true, detail: "ok" };
  } catch (e) {
    return { ok: false, detail: (e as Error).message.slice(0, 300) };
  }
}

export function rebuildFts(db: DB): void {
  db.exec("INSERT INTO posts_fts(posts_fts) VALUES('rebuild')");
}

/**
 * The check the nightly job runs (and Settings can trigger). A row-count or integrity mismatch rebuilds
 * the index in the same call; the report and a maintenance_log row record what happened either way.
 */
export function checkFts(db: DB, opts: { now?: string } = {}): FtsReport {
  const now = opts.now ?? isoNY();
  const { posts, indexed } = ftsCounts(db);
  const integrity = ftsIntegrity(db);
  let rebuilt = false;
  let detail = integrity.detail;
  if (posts !== indexed || !integrity.ok) {
    try {
      rebuildFts(db);
      rebuilt = true;
      const after = ftsCounts(db);
      detail = `mismatch before rebuild (posts ${posts}, indexed ${indexed}, integrity ${integrity.ok ? "ok" : detail}); after: posts ${after.posts}, indexed ${after.indexed}`;
      db.prepare("INSERT INTO maintenance_log (created_at, kind, detail) VALUES (?, 'fts_rebuild', ?)").run(now, JSON.stringify({ posts, indexed, integrity: integrity.ok, detail }));
    } catch (e) {
      detail = `rebuild failed: ${(e as Error).message.slice(0, 200)}`;
    }
  }
  db.prepare("INSERT INTO maintenance_log (created_at, kind, detail) VALUES (?, 'fts_check', ?)").run(now, JSON.stringify({ posts, indexed, integrity: integrity.ok, rebuilt }));
  const after = ftsCounts(db);
  return { posts: after.posts, indexed: after.indexed, integrityOk: ftsIntegrity(db).ok, rebuilt, detail };
}

/** The newest maintenance_log rows for the Settings page. */
export function maintenanceRows(db: DB, limit = 20): Array<{ id: number; created_at: string; kind: string; detail: string }> {
  return db.prepare("SELECT id, created_at, kind, detail FROM maintenance_log ORDER BY id DESC LIMIT ?").all(limit) as unknown as Array<{ id: number; created_at: string; kind: string; detail: string }>;
}
