// A4: saving a design onto a post. The flattened PNG arrives as an ordinary uploaded asset (the editor
// uploads it first, F14 rules); this saves the recipe and points the post at the new render.
// source_asset_id keeps the untouched original the recipe renders from, so reopening and changing one
// thing never re-does the rest (TECH-PLAN-v1.md :80).
import type { DB } from "./db.ts";
import { MAX_RECIPE_BYTES, parseRecipe, recipeLogoIds, type Recipe } from "../lib/recipe.ts";
import { SHA_RE } from "./store.ts";

export class DesignError extends Error {
  constructor(message: string) { super(message); this.name = "DesignError"; }
}

export interface PostDesign {
  id: number; createdAt: string; generationId: string; assetId: string; sourceAssetId: string;
  prompt: string; model: string; notes: string; recipe: Recipe | null; width: number | null; height: number | null;
}

export function getPostDesign(db: DB, idRaw: unknown): PostDesign | null {
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = db.prepare(`SELECT p.id, p.created_at, p.generation_id, p.asset_id, p.source_asset_id, p.prompt, p.model, p.notes, p.recipe, a.width, a.height
    FROM posts p JOIN assets a ON a.id = p.asset_id WHERE p.id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  let recipe: Recipe | null = null;
  if (typeof row.recipe === "string" && row.recipe) {
    try { const p = parseRecipe(JSON.parse(row.recipe)); if (p.ok) recipe = p.recipe; } catch { /* stored badly; treat as no recipe */ }
  }
  return {
    id: Number(row.id), createdAt: String(row.created_at), generationId: String(row.generation_id),
    assetId: String(row.asset_id), sourceAssetId: String(row.source_asset_id ?? row.asset_id),
    prompt: String(row.prompt), model: String(row.model), notes: String(row.notes), recipe,
    width: row.width === null ? null : Number(row.width), height: row.height === null ? null : Number(row.height),
  };
}

/** Save a render + recipe onto a post. Everything is validated here, never trusted from the browser. */
export function updatePostDesign(db: DB, postIdRaw: unknown, assetIdRaw: unknown, recipeRaw: unknown): { assetId: string; sourceAssetId: string } {
  const postId = Number(postIdRaw);
  if (!Number.isInteger(postId) || postId <= 0) throw new DesignError("Unknown post.");
  if (typeof assetIdRaw !== "string" || !SHA_RE.test(assetIdRaw)) throw new DesignError("The rendered image id is not valid.");
  const parsed = parseRecipe(recipeRaw);
  if (!parsed.ok) throw new DesignError(parsed.error);
  const json = JSON.stringify(parsed.recipe);
  if (Buffer.byteLength(json, "utf8") > MAX_RECIPE_BYTES) throw new DesignError("This design is too big to save.");
  const post = db.prepare("SELECT id, asset_id, source_asset_id FROM posts WHERE id = ?").get(postId) as { id: number; asset_id: string; source_asset_id: string | null } | undefined;
  if (!post) throw new DesignError("Unknown post.");
  if (!db.prepare("SELECT 1 FROM assets WHERE id = ?").get(assetIdRaw)) throw new DesignError("The rendered image is not in the store.");
  for (const logoId of recipeLogoIds(parsed.recipe)) {
    if (!db.prepare("SELECT 1 FROM assets WHERE id = ?").get(logoId)) throw new DesignError("A logo in this design is not in the store.");
  }
  const source = post.source_asset_id ?? post.asset_id;
  db.prepare("UPDATE posts SET asset_id = ?, recipe = ?, source_asset_id = ? WHERE id = ?").run(assetIdRaw, json, source, postId);
  return { assetId: assetIdRaw, sourceAssetId: source };
}
