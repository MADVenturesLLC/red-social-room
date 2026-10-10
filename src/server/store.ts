// Content-addressed image store (TECH-PLAN-v1.md:76; Amendment 1 F16): files are named by their SHA-256,
// written to a temp file, fsynced, renamed, and the directory fsynced. Originals are never overwritten.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statfsSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { inspectImage, sha256, type ImageInfo } from "../../spike/lib/image.ts";

export const MIME: Readonly<Record<string, string>> = Object.freeze({ png: "image/png", jpeg: "image/jpeg", webp: "image/webp", svg: "image/svg+xml" });
export const SHA_RE = /^[a-f0-9]{64}$/;

export class StoreError extends Error {
  constructor(message: string) { super(message); this.name = "StoreError"; }
}

/** Test seam: every write/fsync/rename goes through here so a test can make the disk "fail". */
export const storeIo = {
  writeSync: (fd: number, buf: Buffer): number => writeSync(fd, buf),
  fsyncSync: (fd: number): void => fsyncSync(fd),
  renameSync: (a: string, b: string): void => renameSync(a, b),
};

export function freeBytes(dir: string): number | null {
  try { const s = statfsSync(dir); return Number(s.bavail) * Number(s.bsize); } catch { return null; }
}

export function freeText(dir: string): string {
  const b = freeBytes(dir);
  return b === null ? "free space unknown" : `${(b / 1e9).toFixed(1)} GB free`;
}

export interface StoredImage { id: string; relPath: string; mime: string; width: number | null; height: number | null; bytes: number; info: ImageInfo }

export function relPathFor(id: string, ext: string): string {
  return join(/*turbopackIgnore: true*/ id.slice(0, 2), `${id}.${ext}`);
}

/** The write half of the store: temp file, fsync, rename, directory fsync. Never overwrites. */
function writeBytes(imagesDir: string, id: string, ext: string, buf: Buffer): void {
  const dir = join(imagesDir, id.slice(0, 2));
  const tmp = join(dir, `.${id}.${randomBytes(4).toString("hex")}.part`);
  const final = join(/*turbopackIgnore: true*/ imagesDir, relPathFor(id, ext));
  let fd = -1;
  try {
    mkdirSync(dir, { recursive: true });
    fd = openSync(tmp, "wx", 0o644);
    let off = 0;
    while (off < buf.length) off += storeIo.writeSync(fd, buf.subarray(off));
    storeIo.fsyncSync(fd);
    closeSync(fd); fd = -1;
    storeIo.renameSync(tmp, final);
    const dfd = openSync(dir, "r");
    try { storeIo.fsyncSync(dfd); } finally { closeSync(dfd); }
  } catch (e) {
    if (fd >= 0) { try { closeSync(fd); } catch { /* already failing */ } }
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
    const code = (e as NodeJS.ErrnoException).code;
    const why = code === "ENOSPC" ? "disk full" : code === "EACCES" || code === "EROFS" || code === "EPERM" ? "data folder is not writable" : `I/O error${code ? ` (${code})` : ""}`;
    throw new StoreError(`Save failed: ${why} (${freeText(imagesDir)}).`);
  }
}

/** Write bytes into the store. Returns the asset descriptor; the DB row is the caller's job (after this returns). */
export function putImage(imagesDir: string, buf: Buffer): StoredImage {
  const info = inspectImage(buf);
  if (info.format === "unknown") throw new StoreError("The image is not PNG, JPEG or WebP; not stored.");
  const id = sha256(buf);
  const ext = info.format === "jpeg" ? "jpg" : info.format;
  const rel = relPathFor(id, ext);
  const out: StoredImage = { id, relPath: rel, mime: MIME[info.format], width: info.width, height: info.height, bytes: buf.length, info };
  if (existsSync(/*turbopackIgnore: true*/ join(imagesDir, rel))) return out; // same bytes already stored; never overwrite
  writeBytes(imagesDir, id, ext, buf);
  return out;
}

/** A4: store an SVG logo (Brand kit only; the caller has already run validateSvgLogo). No pixel size exists. */
export function putSvg(imagesDir: string, buf: Buffer): StoredImage {
  const id = sha256(buf);
  const rel = relPathFor(id, "svg");
  const out: StoredImage = { id, relPath: rel, mime: MIME.svg, width: null, height: null, bytes: buf.length, info: { format: "unknown", width: null, height: null, bytes: buf.length, sha256: id } };
  if (existsSync(/*turbopackIgnore: true*/ join(imagesDir, rel))) return out;
  writeBytes(imagesDir, id, "svg", buf);
  return out;
}

/** A3: read a stored image back by its id + mime (the edit/reference source). Throws if the file is gone. */
export function readStored(imagesDir: string, id: string, mime: string): Buffer {
  const ext = mime === "image/jpeg" ? "jpg" : mime === "image/png" ? "png" : "webp";
  return readFileSync(join(/*turbopackIgnore: true*/ imagesDir, relPathFor(id, ext)));
}

/** D2 (Amendment 1 item 1): make the 4:5 tile image from a 3:4 original with sharp's attention crop. */
export async function cropTo(buf: Buffer, ratioW: number, ratioH: number): Promise<Buffer> {
  const info = inspectImage(buf);
  if (!info.width || !info.height) throw new StoreError("Cannot read the image size to crop it.");
  const target = ratioW / ratioH;
  let w = info.width, h = info.height;
  if (w / h > target) w = Math.round(h * target); else h = Math.round(w / target);
  return sharp(buf).resize(w, h, { fit: "cover", position: sharp.strategy.attention }).toBuffer();
}
