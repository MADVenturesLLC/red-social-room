import { writeFileSync, mkdirSync, renameSync, openSync, fsyncSync, closeSync } from "node:fs";
import { dirname } from "node:path";
import { inspectImage, extFor, type ImageInfo } from "./image.ts";

/** temp file -> fsync -> rename (plan :76). Returns the final path and actual pixel info. */
export function saveImage(pathNoExt: string, buf: Buffer, mime?: string): { path: string; info: ImageInfo } {
  const info = inspectImage(buf);
  const path = `${pathNoExt}.${extFor(mime, info)}`;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w");
  writeFileSync(fd, buf);
  fsyncSync(fd);
  closeSync(fd);
  renameSync(tmp, path);
  return { path, info };
}

export function writeJson(path: string, v: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(v, null, 2) + "\n");
}
