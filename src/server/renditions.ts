// A6: platform sizing + export (TECH-PLAN-v1.md :218-220, sections 5 and 6; amendment items 9, 10, 24).
// Every rendition and export goes through ONE exact-size step: sharp resize(w, h, {fit:"cover",
// position: attention}) to the preset's exact pixels (item 24) — a user-dragged crop replaces the
// attention choice, never the exactness. "AI extend" (D3, item 9) sends a Google edit with
// response_format.aspect_ratio and the image inline, stores the result with method `ai_extend` and runs
// it through the same exact-size step. Grok is never used for widening. If Google refuses or fails the
// caller shows the real error and offers the fallback that exists (P3: outpaintFallback switch).
// The original file is never altered; renditions are new files.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { isoNY } from "../../spike/lib/ledger.ts";
import { inspectImage } from "../../spike/lib/image.ts";
import { REPO_ROOT } from "./config.ts";
import { insertAsset } from "./execute.ts";
import { executeEdit } from "./execute.ts";
import { putImage, readStored, StoreError, SHA_RE } from "./store.ts";
import { MODEL as GOOGLE_IMAGE_MODEL } from "./google/adapter.ts";
import type { AppDeps } from "./generate.ts";
import type { DB } from "./db.ts";
import { zipStore } from "./zip.ts";

export const ZIP_NAME = (postId: number) => `red-social-room-post-${postId}-export.zip`;

export class RenditionError extends Error {
  constructor(message: string) { super(message); this.name = "RenditionError"; }
}

export interface SizePreset {
  id: string; platform: string; label: string; width: number; height: number; ratio: string;
  quality: number; maxBytes: number | null; safeZone: { x: number; y: number; w: number; h: number } | null;
}

export function loadSizes(path = join(REPO_ROOT, "config", "sizes.json")): readonly SizePreset[] {
  const f = JSON.parse(readFileSync(/*turbopackIgnore: true*/ path, "utf8")) as { version?: unknown; presets?: unknown };
  if (f.version !== 1 || !Array.isArray(f.presets)) throw new Error(`${path}: expected { version: 1, presets: [...] }`);
  const out = f.presets.map((p: SizePreset, i: number) => {
    if (typeof p.id !== "string" || !/^[a-z0-9-]+$/.test(p.id)) throw new Error(`${path}: preset ${i} id`);
    for (const k of ["platform", "label", "ratio"] as const) if (typeof p[k] !== "string" || !p[k]) throw new Error(`${path}: preset ${i} ${k}`);
    for (const k of ["width", "height"] as const) if (!Number.isSafeInteger(p[k]) || p[k] <= 0) throw new Error(`${path}: preset ${i} ${k}`);
    if (!Number.isSafeInteger(p.quality) || p.quality < 1 || p.quality > 100) throw new Error(`${path}: preset ${i} quality`);
    if (p.maxBytes !== null && (!Number.isSafeInteger(p.maxBytes) || p.maxBytes <= 0)) throw new Error(`${path}: preset ${i} maxBytes`);
    const sz = p.safeZone;
    if (sz !== null && (!Number.isSafeInteger(sz?.x) || !Number.isSafeInteger(sz?.y) || !Number.isSafeInteger(sz?.w) || !Number.isSafeInteger(sz?.h) || sz.x < 0 || sz.y < 0 || sz.w <= 0 || sz.h <= 0 || sz.x + sz.w > p.width || sz.y + sz.h > p.height)) throw new Error(`${path}: preset ${i} safeZone`);
    return Object.freeze({ id: p.id, platform: p.platform, label: p.label, width: p.width, height: p.height, ratio: p.ratio, quality: p.quality, maxBytes: p.maxBytes ?? null, safeZone: sz ? { ...sz } : null });
  });
  return Object.freeze(out);
}

/** Item 24's info note: requested vs actual, grey when off by more than 1%. */
export function ratioNoteFor(srcW: number | null, srcH: number | null, preset: SizePreset): string | null {
  if (!srcW || !srcH) return null;
  const r = srcW / srcH, target = preset.width / preset.height;
  if (Math.abs(r - target) / target <= 0.01) return null;
  return `asked ${preset.ratio}, got ${srcW}×${srcH} = ${r.toFixed(3)}`;
}

/** Item 10 (P5 default A): the source is smaller than the preset, so sharp upscales; said plainly, never native. */
export function upscaleNote(srcW: number | null, preset: SizePreset): string | null {
  if (!srcW || srcW >= preset.width) return null;
  return `Upscaled from ${srcW} px wide`;
}

async function encodeExact(buf: Buffer, preset: SizePreset): Promise<Buffer> {
  let q = preset.quality;
  let out = await sharp(buf).resize(preset.width, preset.height, { fit: "cover", position: sharp.strategy.attention }).jpeg({ quality: q }).toBuffer();
  while (preset.maxBytes !== null && out.length > preset.maxBytes && q > 10) {
    q -= 5;
    out = await sharp(buf).resize(preset.width, preset.height, { fit: "cover", position: sharp.strategy.attention }).jpeg({ quality: q }).toBuffer();
  }
  if (preset.maxBytes !== null && out.length > preset.maxBytes) throw new RenditionError(`Could not fit ${preset.label} under ${Math.round(preset.maxBytes / 1024)} KB.`);
  return out;
}

async function encodeCropped(buf: Buffer, preset: SizePreset, crop: { x: number; y: number; w: number; h: number }): Promise<Buffer> {
  const info = inspectImage(buf);
  if (!info.width || !info.height) throw new RenditionError("Cannot read the image size to crop it.");
  const left = Math.min(Math.max(0, Math.round(crop.x * info.width)), info.width - 16);
  const top = Math.min(Math.max(0, Math.round(crop.y * info.height)), info.height - 16);
  const width = Math.min(Math.max(16, Math.round(crop.w * info.width)), info.width - left);
  const height = Math.min(Math.max(16, Math.round(crop.h * info.height)), info.height - top);
  const got = (width / height), want = preset.width / preset.height;
  if (Math.abs(got - want) / want > 0.02) throw new RenditionError(`The crop frame does not match ${preset.label} (${preset.ratio}).`);
  let q = preset.quality;
  let out = await sharp(buf).extract({ left, top, width, height }).resize(preset.width, preset.height, { fit: "fill" }).jpeg({ quality: q }).toBuffer();
  while (preset.maxBytes !== null && out.length > preset.maxBytes && q > 10) {
    q -= 5;
    out = await sharp(buf).extract({ left, top, width, height }).resize(preset.width, preset.height, { fit: "fill" }).jpeg({ quality: q }).toBuffer();
  }
  if (preset.maxBytes !== null && out.length > preset.maxBytes) throw new RenditionError(`Could not fit ${preset.label} under ${Math.round(preset.maxBytes / 1024)} KB.`);
  return out;
}

function normalizeCrop(raw: unknown): { x: number; y: number; w: number; h: number } | null {
  if (raw === undefined || raw === null || raw === false) return null;
  const c = raw as Record<string, unknown>;
  const num = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
  if (!num(c.x, 0, 1) || !num(c.y, 0, 1) || !num(c.w, 0.02, 1) || !num(c.h, 0.02, 1)) throw new RenditionError("The crop frame is out of range.");
  if ((c.x as number) + (c.w as number) > 1.0001 || (c.y as number) + (c.h as number) > 1.0001) throw new RenditionError("The crop frame does not fit inside the image.");
  return { x: c.x as number, y: c.y as number, w: c.w as number, h: c.h as number };
}

export interface RenditionResult {
  presetId: string; assetId: string; width: number; height: number; bytes: number; method: "crop" | "ai_extend";
  upscaledFrom: number | null; note: string | null; ratioNote: string | null;
}

function upsertRendition(db: DB, postId: number, presetId: string, assetId: string, sourceAssetId: string, method: "crop" | "ai_extend"): void {
  db.prepare(`INSERT INTO renditions (post_id, preset_id, asset_id, source_asset_id, method, created_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(post_id, preset_id) DO UPDATE SET asset_id = excluded.asset_id, source_asset_id = excluded.source_asset_id, method = excluded.method, created_at = excluded.created_at`).run(postId, presetId, assetId, sourceAssetId, method, isoNY());
}

function postAsset(db: DB, postIdRaw: unknown): { id: number; assetId: string; mime: string } {
  const id = Number(postIdRaw);
  if (!Number.isInteger(id) || id <= 0) throw new RenditionError("Unknown post.");
  const post = db.prepare("SELECT p.id, p.asset_id, a.mime FROM posts p JOIN assets a ON a.id = p.asset_id WHERE p.id = ?").get(id) as { id: number; asset_id: string; mime: string } | undefined;
  if (!post) throw new RenditionError("Unknown post.");
  return { id: post.id, assetId: post.asset_id, mime: post.mime };
}

/** One rendition for one platform: exact preset pixels (item 24). A crop frame replaces the attention choice. */
export async function makeRendition(db: DB, imagesDir: string, postIdRaw: unknown, presetIdRaw: unknown, cropRaw: unknown): Promise<{ rendition: RenditionResult; preset: SizePreset }> {
  const presets = loadSizes();
  const preset = presets.find((p) => p.id === presetIdRaw);
  if (!preset) throw new RenditionError("Unknown size preset.");
  const post = postAsset(db, postIdRaw);
  const crop = normalizeCrop(cropRaw);
  const src = readStored(imagesDir, post.assetId, post.mime);
  const srcInfo = inspectImage(src);
  const buf = crop ? await encodeCropped(src, preset, crop) : await encodeExact(src, preset);
  const got = inspectImage(buf);
  if (got.format !== "jpeg" || got.width !== preset.width || got.height !== preset.height) {
    throw new RenditionError(`The exact-size step produced ${got.width}×${got.height}, expected ${preset.width}×${preset.height}.`);
  }
  const stored = putImage(imagesDir, buf);
  insertAsset(db, stored);
  upsertRendition(db, post.id, preset.id, stored.id, post.assetId, "crop");
  return {
    preset,
    rendition: { presetId: preset.id, assetId: stored.id, width: stored.width!, height: stored.height!, bytes: stored.bytes, method: "crop", upscaledFrom: srcInfo.width, note: crop ? "Dragged crop" : "Smart crop (attention)", ratioNote: ratioNoteFor(srcInfo.width, srcInfo.height, preset) },
  };
}

export interface WidenOutcome {
  kind: "ok" | "refused" | "error";
  message: string | null; code: string | null;
  costText: string | null;
  fallback: "none" | "recraft";
  rendition: RenditionResult | null;
  preset: SizePreset | null;
}

/** "AI extend (Nano Banana 2)" (D3, item 9): one Google edit with the target ratio; then the exact-size step. */
export async function widenRendition(d: AppDeps, postIdRaw: unknown, presetIdRaw: unknown): Promise<WidenOutcome> {
  const presets = loadSizes();
  const preset = presets.find((p) => p.id === presetIdRaw);
  if (!preset) throw new RenditionError("Unknown size preset.");
  const post = postAsset(d.db, postIdRaw);
  const instruction = `Extend the scene to fill a ${preset.ratio} frame, keep the subject unchanged.`;
  const runId = randomUUID(), generationId = randomUUID();
  d.db.prepare("INSERT INTO runs (id, created_at, prompt, status) VALUES (?, ?, ?, 'running')").run(runId, isoNY(), instruction);
  const view = await executeEdit(d, { runId, provider: "google", model: GOOGLE_IMAGE_MODEL, instruction, sourceAssetId: post.assetId, generationId, aspectRatio: preset.ratio });
  d.db.prepare("UPDATE runs SET status = ? WHERE id = ?").run(view.status === "ok" ? "ok" : view.status === "blocked" || view.status === "not_sent" ? "blocked" : "failed", runId);
  const fallback = d.switches.outpaintFallback;
  if (view.status !== "ok" || !view.image) {
    return { kind: view.status === "refused" ? "refused" : "error", message: view.message, code: view.code, costText: view.costText, fallback, rendition: null, preset };
  }
  try {
    const child = d.db.prepare("SELECT mime FROM assets WHERE id = ?").get(view.image.assetId) as { mime: string } | undefined;
    const childBuf = readStored(d.imagesDir, view.image.assetId, child?.mime ?? "image/jpeg");
    const childInfo = inspectImage(childBuf);
    const buf = await encodeExact(childBuf, preset);
    const got = inspectImage(buf);
    if (got.width !== preset.width || got.height !== preset.height) throw new StoreError(`exact-size produced ${got.width}×${got.height}`);
    const stored = putImage(d.imagesDir, buf);
    insertAsset(d.db, stored);
    upsertRendition(d.db, post.id, preset.id, stored.id, post.assetId, "ai_extend");
    return {
      kind: "ok", message: null, code: null, costText: view.costText, fallback,
      preset,
      rendition: { presetId: preset.id, assetId: stored.id, width: stored.width!, height: stored.height!, bytes: stored.bytes, method: "ai_extend", upscaledFrom: childInfo.width, note: "AI extend (Nano Banana 2)", ratioNote: ratioNoteFor(childInfo.width, childInfo.height, preset) },
    };
  } catch (e) {
    const msg = e instanceof StoreError || e instanceof RenditionError ? e.message : `Save failed: ${(e as Error).name}.`;
    return { kind: "error", message: msg, code: "storage", costText: view.costText, fallback, rendition: null, preset };
  }
}

export interface RenditionRow { presetId: string; platform: string; label: string; width: number; height: number; assetId: string; bytes: number; method: string; createdAt: string; upscaledFrom: number | null; note: string | null; ratioNote: string | null; safeZone: SizePreset["safeZone"]; /** review 3: true when the post's image changed after this rendition was made. */ stale: boolean }

export function listRenditions(db: DB, postIdRaw: unknown): RenditionRow[] {
  const id = Number(postIdRaw);
  if (!Number.isInteger(id) || id <= 0) return [];
  const presets = loadSizes();
  const rows = db.prepare(`SELECT r.preset_id, r.asset_id, r.source_asset_id, r.method, r.created_at, a.bytes FROM renditions r JOIN assets a ON a.id = r.asset_id WHERE r.post_id = ? ORDER BY r.preset_id`).all(id) as Array<Record<string, unknown>>;
  const post = db.prepare("SELECT p.asset_id, a.width FROM posts p JOIN assets a ON a.id = p.asset_id WHERE p.id = ?").get(id) as { asset_id: string; width: number | null } | undefined;
  const srcW = post?.width ?? null;
  const srcH = (() => { const r = db.prepare("SELECT a.height FROM posts p JOIN assets a ON a.id = p.asset_id WHERE p.id = ?").get(id) as { height: number | null } | undefined; return r?.height ?? null; })();
  const out: RenditionRow[] = [];
  for (const row of rows) {
    const preset = presets.find((p) => p.id === row.preset_id);
    if (!preset) continue;
    const stale = String(row.source_asset_id) !== (post?.asset_id ?? "");
    out.push({ presetId: preset.id, platform: preset.platform, label: preset.label, width: preset.width, height: preset.height, assetId: String(row.asset_id), bytes: Number(row.bytes), method: String(row.method), createdAt: String(row.created_at), upscaledFrom: stale ? null : srcW, note: null, ratioNote: stale ? null : ratioNoteFor(srcW, srcH, preset), safeZone: preset.safeZone, stale });
  }
  return out;
}

export function removeRendition(db: DB, postIdRaw: unknown, presetIdRaw: unknown): boolean {
  const id = Number(postIdRaw);
  if (!Number.isInteger(id) || id <= 0) return false;
  const r = db.prepare("DELETE FROM renditions WHERE post_id = ? AND preset_id = ?").run(id, String(presetIdRaw));
  return r.changes > 0;
}

export function captionsTextFor(db: DB, postId: number, presets: readonly SizePreset[]): string {
  const lines: string[] = [];
  for (const p of presets) {
    lines.push(`== ${p.platform} — ${p.label} (${p.width}×${p.height}) ==`);
    const c = db.prepare("SELECT text, hashtags, alt_text FROM captions WHERE post_id = ? AND platform = ?").get(postId, p.platform.toLowerCase()) as { text: string; hashtags: string; alt_text: string } | undefined;
    if (c) {
      lines.push(c.text);
      lines.push(`Hashtags: ${c.hashtags || "—"}`);
      lines.push(`Alt: ${c.alt_text || "—"}`);
    } else lines.push("(no caption saved yet)");
    lines.push("");
  }
  return lines.join("\n");
}

/** The ZIP: one exact-size image per requested platform plus captions.txt. Missing renditions stop the export. */
export async function exportZip(db: DB, imagesDir: string, postIdRaw: unknown, presetIdsRaw: unknown): Promise<{ buf: Buffer; filename: string; presets: readonly SizePreset[] }> {
  const post = postAsset(db, postIdRaw);
  const ids = Array.isArray(presetIdsRaw) ? [...new Set((presetIdsRaw as unknown[]).map(String))] : [];
  if (!ids.length) throw new RenditionError("Tick at least one platform.");
  if (ids.length > 20) throw new RenditionError("Too many platforms at once.");
  const all = loadSizes();
  const presets: SizePreset[] = [];
  for (const id of ids) {
    const p = all.find((x) => x.id === id);
    if (!p) throw new RenditionError(`Unknown size preset "${id}".`);
    presets.push(p);
  }
  const entries: Array<{ name: string; data: Buffer }> = [];
  for (const p of presets) {
    const row = db.prepare("SELECT r.asset_id, r.source_asset_id, a.mime FROM renditions r JOIN assets a ON a.id = r.asset_id WHERE r.post_id = ? AND r.preset_id = ?").get(post.id, p.id) as { asset_id: string; source_asset_id: string; mime: string } | undefined;
    if (!row || !SHA_RE.test(row.asset_id)) throw new RenditionError(`No rendition yet for ${p.label} — make it first.`);
    if (row.source_asset_id !== post.assetId) throw new RenditionError(`${p.label} was made from an earlier version of this image — make it again.`);
    entries.push({ name: `${p.id}.jpg`, data: readStored(imagesDir, row.asset_id, row.mime) });
  }
  entries.push({ name: "captions.txt", data: Buffer.from(captionsTextFor(db, post.id, presets), "utf8") });
  return { buf: zipStore(entries), filename: ZIP_NAME(post.id), presets };
}
