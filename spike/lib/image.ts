// Minimal, dependency-free image header parsing (PNG / JPEG / WebP) so we can
// report ACTUAL output pixel dimensions, not what was requested.
import { createHash } from "node:crypto";

export interface ImageInfo { format: "png" | "jpeg" | "webp" | "unknown"; width: number | null; height: number | null; bytes: number; sha256: string }

export function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function inspectImage(buf: Buffer): ImageInfo {
  const base = { bytes: buf.length, sha256: sha256(buf) };
  // PNG: 8-byte signature, IHDR width/height at 16..24
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { format: "png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), ...base };
  }
  // JPEG: walk segments until a SOFn marker
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSOF) return { format: "jpeg", height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), ...base };
      i += 2 + len;
    }
    return { format: "jpeg", width: null, height: null, ...base };
  }
  // WebP (RIFF....WEBP)
  if (buf.length > 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buf.toString("ascii", 12, 16);
    if (chunk === "VP8X") return { format: "webp", width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3), ...base };
    if (chunk === "VP8 ") return { format: "webp", width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, ...base };
    if (chunk === "VP8L") {
      const b = buf.readUInt32LE(21);
      return { format: "webp", width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1, ...base };
    }
  }
  return { format: "unknown", width: null, height: null, ...base };
}

export function ratioLabel(w: number | null, h: number | null): string {
  if (!w || !h) return "unknown";
  const r = w / h;
  const known: Array<[string, number]> = [["1:1", 1], ["4:5", 0.8], ["5:4", 1.25], ["3:4", 0.75], ["4:3", 4 / 3], ["2:3", 2 / 3], ["3:2", 1.5], ["9:16", 9 / 16], ["16:9", 16 / 9], ["21:9", 21 / 9], ["2:1", 2], ["1:2", 0.5]];
  let best = known[0];
  for (const k of known) if (Math.abs(k[1] - r) < Math.abs(best[1] - r)) best = k;
  return `${r.toFixed(4)} (~${best[0]}${Math.abs(best[1] - r) > 0.02 ? ", not exact" : ""})`;
}

export function extFor(mime: string | undefined, info: ImageInfo): string {
  if (info.format !== "unknown") return info.format === "jpeg" ? "jpg" : info.format;
  if (mime?.includes("png")) return "png";
  if (mime?.includes("webp")) return "webp";
  return "jpg";
}
