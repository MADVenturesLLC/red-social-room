// F14 (Amendment 1 section 3, kept from T:160): uploads pass a browser check and then a server check
// before any provider call. Allowed: PNG, JPEG, WebP, up to 20 MB, up to 8,000 px a side (Michael's
// limits). Larger images are offered a downscale ("Resize to 4096 px and continue?"); anything else is
// rejected with the reason. This module is pure so the browser and the server share the same numbers,
// and the server re-checks everything on its own (src/app/api/upload/route.ts).
export const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
export const UPLOAD_MAX_SIDE = 8000;
export const UPLOAD_RESIZE_TARGET = 4096;
export const UPLOAD_TYPES: readonly string[] = Object.freeze(["image/png", "image/jpeg", "image/webp"]);
/** The exact offer text from the F14 row. */
export const RESIZE_OFFER = "Resize to 4096 px and continue?";

export type UploadPrecheck = { kind: "ok" } | { kind: "offer_resize"; message: string } | { kind: "reject"; message: string };

/** The browser-side check. The server repeats every limit and never trusts this result. */
export function precheckUpload(f: { type: string; size: number; width?: number | null; height?: number | null }): UploadPrecheck {
  if (!UPLOAD_TYPES.includes(f.type)) return { kind: "reject", message: "That file is not a PNG, JPEG or WebP image." };
  const side = Math.max(f.width ?? 0, f.height ?? 0);
  if (f.size > UPLOAD_MAX_BYTES || side > UPLOAD_MAX_SIDE) return { kind: "offer_resize", message: RESIZE_OFFER };
  return { kind: "ok" };
}

/** Target dimensions for the resize offer: scale so the longest side is UPLOAD_RESIZE_TARGET; never upscale. */
export function resizeDimensions(width: number, height: number): { width: number; height: number } {
  const side = Math.max(width, height);
  if (side <= UPLOAD_RESIZE_TARGET) return { width, height };
  const k = UPLOAD_RESIZE_TARGET / side;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}
