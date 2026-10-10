// A4: the Brand kit (TECH-PLAN-v1.md :96 - "his PNG/SVG logos are stored in a \"Brand kit\" panel").
// Logos are ordinary stored assets; this table is just the kit's list. SVG is allowed here and only here:
// a logo never goes to a provider, it is drawn on the local canvas. SVGs carrying scripts, event handlers,
// foreignObject or javascript: links are refused with the reason, and the asset route serves svg under a
// sandbox policy (src/app/api/assets/[id]/route.ts).
import { isoNY } from "../../spike/lib/ledger.ts";
import { inspectImage } from "../../spike/lib/image.ts";
import type { DB } from "./db.ts";
import { insertAsset } from "./execute.ts";
import { putImage, putSvg, StoreError, type StoredImage } from "./store.ts";
import { UPLOAD_MAX_BYTES, UPLOAD_MAX_SIDE } from "../lib/upload-rules.ts";

export const LOGO_MAX_BYTES = 1024 * 1024;
export const LOGO_NAME_MAX = 80;
export const BRAND_MAX_ITEMS = 50;

export class BrandError extends Error {
  constructor(message: string) { super(message); this.name = "BrandError"; }
}

/** True when the bytes look like an SVG (a BOM and leading XML declaration are tolerated). */
export function looksLikeSvg(buf: Buffer): boolean {
  const head = buf.subarray(0, 1024).toString("utf8").replace(/^\uFEFF/, "").trimStart();
  return head.startsWith("<svg") || head.startsWith("<?xml");
}

/** The active-content check for an SVG logo. Returns the reason to show, or null when the file is fine. */
export function validateSvgLogo(buf: Buffer): string | null {
  if (buf.length === 0) return "The file is empty.";
  if (buf.length > LOGO_MAX_BYTES) return "SVG logos are limited to 1 MB.";
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { return "That SVG is not readable as UTF-8 text."; }
  const t = text.replace(/^\uFEFF/, "");
  if (!/<svg[\s>]/i.test(t.slice(0, 4096))) return "That file does not look like an SVG.";
  if (/<script[\s>]/i.test(t)) return "SVG logos cannot contain scripts.";
  if (/<foreignObject[\s>]/i.test(t)) return "SVG logos cannot contain foreignObject.";
  if (/\son[a-z]+\s*=/i.test(t)) return "SVG logos cannot contain event handlers (on... attributes).";
  if (/javascript\s*:/i.test(t)) return "SVG logos cannot contain javascript: links.";
  return null;
}

export interface BrandItem { id: number; assetId: string; name: string; createdAt: string; mime: string; width: number | null; height: number | null; bytes: number }

/** Store one logo and add it to the kit. Throws BrandError with the reason to show. */
export function addLogo(db: DB, imagesDir: string, b64: string, nameRaw: unknown): BrandItem {
  const name = typeof nameRaw === "string" ? nameRaw.trim().slice(0, LOGO_NAME_MAX) : "";
  if (!name) throw new BrandError("Give the logo a name.");
  const n = db.prepare("SELECT COUNT(*) AS n FROM brand_kit").get() as { n: number };
  if (n.n >= BRAND_MAX_ITEMS) throw new BrandError(`The brand kit is full (${BRAND_MAX_ITEMS} logos).`);
  const buf = Buffer.from(b64, "base64");
  if (buf.length === 0) throw new BrandError("No logo data was sent.");
  let stored: StoredImage;
  if (looksLikeSvg(buf)) {
    const why = validateSvgLogo(buf);
    if (why) throw new BrandError(why);
    stored = putSvg(imagesDir, buf);
  } else {
    if (buf.length > UPLOAD_MAX_BYTES) throw new BrandError("That logo is over 20 MB. Resize it and try again.");
    const info = inspectImage(buf);
    if (info.format === "unknown") throw new BrandError("Logos must be PNG, JPEG, WebP or SVG.");
    if ((info.width ?? 0) > UPLOAD_MAX_SIDE || (info.height ?? 0) > UPLOAD_MAX_SIDE) throw new BrandError("That logo is larger than 8,000 px on a side. Resize it and try again.");
    stored = putImage(imagesDir, buf);
  }
  const at = isoNY();
  insertAsset(db, stored);
  const r = db.prepare("INSERT INTO brand_kit (asset_id, name, created_at) VALUES (?, ?, ?)").run(stored.id, name, at);
  return { id: Number(r.lastInsertRowid), assetId: stored.id, name, createdAt: at, mime: stored.mime, width: stored.width, height: stored.height, bytes: stored.bytes };
}

export function listBrand(db: DB): BrandItem[] {
  const rows = db.prepare(`SELECT b.id, b.asset_id, b.name, b.created_at, a.mime, a.width, a.height, a.bytes
    FROM brand_kit b JOIN assets a ON a.id = b.asset_id ORDER BY b.id DESC`).all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({ id: Number(r.id), assetId: String(r.asset_id), name: String(r.name), createdAt: String(r.created_at), mime: String(r.mime), width: r.width === null ? null : Number(r.width), height: r.height === null ? null : Number(r.height), bytes: Number(r.bytes) }));
}

/** Remove one logo from the kit. The file stays in the store (content-addressed; other designs may use it). */
export function removeBrand(db: DB, idRaw: unknown): boolean {
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0) return false;
  const r = db.prepare("DELETE FROM brand_kit WHERE id = ?").run(id);
  return r.changes > 0;
}
