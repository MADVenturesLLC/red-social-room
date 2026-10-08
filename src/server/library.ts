// Save to library + search by prompt text (TECH-PLAN-v1.md section 9 A1, :77, :103).
import { isoNY } from "../../spike/lib/ledger.ts";
import type { DB } from "./db.ts";

export class LibraryError extends Error {
  constructor(message: string) { super(message); this.name = "LibraryError"; }
}

export interface PostRow { id: number; created_at: string; generation_id: string; asset_id: string; prompt: string; model: string; notes: string; width: number | null; height: number | null }

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

/** User text -> FTS5 query: each word quoted (no FTS syntax from the user), prefix match, all words required. */
export function ftsQuery(q: string): string | null {
  const words = q.normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!words.length) return null;
  return words.slice(0, 12).map((w) => `"${w}"*`).join(" AND ");
}

export function searchPosts(db: DB, q: unknown, limit = 60): PostRow[] {
  const text = typeof q === "string" ? q.slice(0, 200) : "";
  const fq = ftsQuery(text);
  const cols = "p.id, p.created_at, p.generation_id, p.asset_id, p.prompt, p.model, p.notes, a.width, a.height";
  if (!fq) return db.prepare(`SELECT ${cols} FROM posts p JOIN assets a ON a.id = p.asset_id ORDER BY p.id DESC LIMIT ?`).all(limit) as unknown as PostRow[];
  return db.prepare(`SELECT ${cols} FROM posts_fts f JOIN posts p ON p.id = f.rowid JOIN assets a ON a.id = p.asset_id WHERE posts_fts MATCH ? ORDER BY bm25(posts_fts), p.id DESC LIMIT ?`).all(fq, limit) as unknown as PostRow[];
}
