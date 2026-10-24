// Save to library + search by prompt text (TECH-PLAN-v1.md section 9 A1, :77, :103).
// A7 adds: search by tag (?tag=), the tag list with counts, per-post reuse data, and post deletion
// (housekeeping — post rows and their captions/tags/renditions go; the content-addressed files stay,
// because they are shared by other posts once anything references them).
import { randomUUID } from "node:crypto";
import { isoNY } from "../../spike/lib/ledger.ts";
import { tx, type DB } from "./db.ts";

export class LibraryError extends Error {
  constructor(message: string) { super(message); this.name = "LibraryError"; }
}

export interface PostRow { id: number; created_at: string; generation_id: string; asset_id: string; prompt: string; model: string; notes: string; width: number | null; height: number | null; designed: number }

export function savePost(db: DB, generationId: unknown, notes: unknown = ""): { id: number; already: boolean } {
  if (typeof generationId !== "string" || !/^[0-9a-f-]{36}$/.test(generationId)) throw new LibraryError("Unknown image.");
  const n = typeof notes === "string" ? notes.trim() : "";
  if (n.length > 2000) throw new LibraryError("Notes are limited to 2,000 characters.");
  const g = db.prepare("SELECT id, status, prompt, model, display_asset_id FROM generations WHERE id = ?").get(generationId) as { id: string; status: string; prompt: string; model: string; display_asset_id: string | null } | undefined;
  if (!g) throw new LibraryError("Unknown image.");
  if (g.status !== "ok" || !g.display_asset_id) throw new LibraryError("Only a finished image can be saved.");
  const existing = db.prepare("SELECT id FROM posts WHERE generation_id = ?").get(generationId) as { id: number } | undefined;
  if (existing) return { id: Number(existing.id), already: true };
  const r = db.prepare("INSERT INTO posts (created_at, generation_id, asset_id, prompt, model, notes) VALUES (?, ?, ?, ?, ?, ?)").run(isoNY(), g.id, g.display_asset_id, g.prompt, g.model, n);
  return { id: Number(r.lastInsertRowid), already: false };
}

/** Direct save for an uploaded image: creates post directly without AI model alteration (zero spend). */
export function saveUploadedPost(db: DB, input: { assetId: unknown; prompt?: unknown; notes?: unknown }): { id: number; already: boolean } {
  const assetId = typeof input.assetId === "string" ? input.assetId.trim() : "";
  if (!/^[a-f0-9]{64}$/.test(assetId)) throw new LibraryError("Unknown image.");
  const a = db.prepare("SELECT id, mime FROM assets WHERE id = ?").get(assetId) as { id: string; mime: string } | undefined;
  if (!a) throw new LibraryError("That image is not in the store.");

  const prompt = typeof input.prompt === "string" && input.prompt.trim() ? input.prompt.trim() : "Uploaded image";
  const n = typeof input.notes === "string" ? input.notes.trim() : "";
  if (n.length > 2000) throw new LibraryError("Notes are limited to 2,000 characters.");

  const existing = db.prepare("SELECT id FROM posts WHERE asset_id = ? AND model = 'upload'").get(assetId) as { id: number } | undefined;
  if (existing) return { id: Number(existing.id), already: true };

  const genId = randomUUID();
  const runId = randomUUID();
  const now = isoNY();

  return tx(db, () => {
    db.prepare("INSERT INTO runs (id, created_at, prompt, status) VALUES (?, ?, ?, 'ok')").run(runId, now, prompt);
    db.prepare(`INSERT INTO generations (id, run_id, created_at, provider, model, kind, prompt, params, status, output_asset_id, display_asset_id)
      VALUES (?, ?, ?, 'upload', 'upload', 'generate', ?, '{}', 'ok', ?, ?)`).run(genId, runId, now, prompt, assetId, assetId);
    const r = db.prepare("INSERT INTO posts (created_at, generation_id, asset_id, prompt, model, notes, source_asset_id) VALUES (?, ?, ?, ?, 'upload', ?, ?)").run(now, genId, assetId, prompt, n, assetId);
    return { id: Number(r.lastInsertRowid), already: false };
  });
}

/** User text -> FTS5 query: each word quoted (no FTS syntax from the user), prefix match, all words required. */
export function ftsQuery(q: string): string | null {
  const words = q.normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!words.length) return null;
  return words.slice(0, 12).map((w) => `"${w}"*`).join(" AND ");
}

/** A5/A7: tag suggestions live in `tags`; a post's ticks live in `post_tags`. */
export function listTags(db: DB, limit = 40): Array<{ name: string; count: number }> {
  return db.prepare("SELECT t.name AS name, count(pt.post_id) AS count FROM tags t LEFT JOIN post_tags pt ON pt.tag_id = t.id GROUP BY t.id ORDER BY count DESC, t.name LIMIT ?").all(limit) as unknown as Array<{ name: string; count: number }>;
}

export function searchPosts(db: DB, q: unknown, tag: unknown = null, limit = 60): PostRow[] {
  const text = typeof q === "string" ? q.slice(0, 200) : "";
  const tagName = typeof tag === "string" ? tag.slice(0, 80) : "";
  const fq = ftsQuery(text);
  const cols = "p.id, p.created_at, p.generation_id, p.asset_id, p.prompt, p.model, p.notes, a.width, a.height, (p.recipe IS NOT NULL) AS designed";
  const byTag = "p.id IN (SELECT pt.post_id FROM post_tags pt JOIN tags t ON t.id = pt.tag_id WHERE t.name = ?)";
  if (!fq) {
    if (tagName) return db.prepare(`SELECT ${cols} FROM posts p JOIN assets a ON a.id = p.asset_id WHERE ${byTag} ORDER BY p.id DESC LIMIT ?`).all(tagName, limit) as unknown as PostRow[];
    return db.prepare(`SELECT ${cols} FROM posts p JOIN assets a ON a.id = p.asset_id ORDER BY p.id DESC LIMIT ?`).all(limit) as unknown as PostRow[];
  }
  if (tagName) return db.prepare(`SELECT ${cols} FROM posts_fts f JOIN posts p ON p.id = f.rowid JOIN assets a ON a.id = p.asset_id WHERE posts_fts MATCH ? AND ${byTag} ORDER BY bm25(posts_fts), p.id DESC LIMIT ?`).all(fq, tagName, limit) as unknown as PostRow[];
  return db.prepare(`SELECT ${cols} FROM posts_fts f JOIN posts p ON p.id = f.rowid JOIN assets a ON a.id = p.asset_id WHERE posts_fts MATCH ? ORDER BY bm25(posts_fts), p.id DESC LIMIT ?`).all(fq, limit) as unknown as PostRow[];
}

export interface ReuseData { postId: number; prompt: string; ratio: string; creator: string }
export interface Snippet { id: number; text: string; created_at: string }

/**
 * A7 "reuse-run": everything the create box needs to start again from one library post. Older posts were
 * made before the run queue existed (the A1 route writes a generations row but no jobs row), so both joins
 * are LEFT joins: the ratio falls back to the generation's own params and the creator to its provider.
 */
export function reuseData(db: DB, postId: unknown): ReuseData | null {
  const id = Number(postId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = db.prepare(`SELECT p.id AS post_id, p.prompt AS prompt, p.model AS model,
      j.ratio AS j_ratio, j.creator_id AS j_creator, g.provider AS g_provider, g.params AS g_params
    FROM posts p
    LEFT JOIN jobs j ON j.generation_id = p.generation_id
    LEFT JOIN generations g ON g.id = p.generation_id
    WHERE p.id = ?`).get(id) as { post_id: number; prompt: string; model: string; j_ratio: string | null; j_creator: string | null; g_provider: string | null; g_params: string | null } | undefined;
  if (!row) return null;
  let ratio = row.j_ratio;
  if (!ratio && row.g_params) {
    try {
      const p = JSON.parse(row.g_params) as { requested_ratio?: unknown; sent_ratio?: unknown };
      const r = typeof p.requested_ratio === "string" ? p.requested_ratio : (typeof p.sent_ratio === "string" ? p.sent_ratio : null);
      ratio = r;
    } catch { /* leave null */ }
  }
  const creator = row.j_creator ?? (row.g_provider === "google" ? (/pro/i.test(row.model) ? "google-pro" : "google") : "xai");
  return { postId: Number(row.post_id), prompt: String(row.prompt), ratio: ratio ?? "4:5", creator };
}

/** A7: the last few distinct prompts (newest first) for the chips under the prompt box (T:76). */
export function recentPrompts(db: DB, limit = 5): string[] {
  const rows = db.prepare("SELECT prompt, MAX(rowid) AS last FROM generations WHERE trim(prompt) <> '' GROUP BY prompt ORDER BY last DESC LIMIT ?").all(limit) as unknown as Array<{ prompt: string }>;
  return rows.map((r) => r.prompt);
}

export function listSnippets(db: DB, limit = 50): Snippet[] {
  // Plain objects on purpose: node:sqlite rows have a null prototype, and React refuses to pass those
  // from a server component to a client component (the create page hits this at render time).
  const rows = db.prepare("SELECT id, text, created_at FROM snippets ORDER BY id DESC LIMIT ?").all(limit) as unknown as Snippet[];
  return rows.map((r) => ({ id: Number(r.id), text: String(r.text), created_at: String(r.created_at) }));
}

export function addSnippet(db: DB, text: unknown): Snippet {
  const t = typeof text === "string" ? text.trim() : "";
  if (!t) throw new LibraryError("Type the snippet first.");
  if (t.length > 2000) throw new LibraryError("Snippets are limited to 2,000 characters.");
  db.prepare("INSERT OR IGNORE INTO snippets (created_at, text) VALUES (?, ?)").run(isoNY(), t);
  const row = db.prepare("SELECT id, text, created_at FROM snippets WHERE text = ?").get(t) as unknown as Snippet;
  return { id: Number(row.id), text: String(row.text), created_at: String(row.created_at) };
}

export function deleteSnippet(db: DB, id: unknown): boolean {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw new LibraryError("Unknown snippet.");
  return db.prepare("DELETE FROM snippets WHERE id = ?").run(n).changes > 0;
}

/** A7 housekeeping: remove a post and its captions/tags/renditions. The files themselves stay. */
export function deletePost(db: DB, id: unknown): boolean {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw new LibraryError("Unknown post.");
  const exists = db.prepare("SELECT id FROM posts WHERE id = ?").get(n) as { id: number } | undefined;
  if (!exists) return false;
  db.prepare("DELETE FROM captions WHERE post_id = ?").run(n);
  db.prepare("DELETE FROM post_tags WHERE post_id = ?").run(n);
  db.prepare("DELETE FROM renditions WHERE post_id = ?").run(n);
  db.prepare("DELETE FROM posts WHERE id = ?").run(n);
  return true;
}
