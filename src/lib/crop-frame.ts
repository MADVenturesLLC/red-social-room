// A6: the crop frame for a platform preset, in source fractions. Aspect-locked to the preset; pure so
// the browser drag UI and the tests share one implementation. `scale` zooms in (1 = the largest frame
// of that shape), centered on {cx, cy} (fractions of the source). The frame always fits inside the image.
export interface CropFrame { x: number; y: number; w: number; h: number }

const round4 = (v: number) => Math.round(v * 10000) / 10000;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

export function frameFor(presetW: number, presetH: number, srcW: number, srcH: number, cx: number, cy: number, scale: number): CropFrame {
  const r = presetW / presetH;
  let wFrac = 1;
  let hFrac = (wFrac * srcW) / (r * srcH);
  if (hFrac > 1) { hFrac = 1; wFrac = (hFrac * r * srcH) / srcW; }
  const k = clamp(scale, 1, 4);
  wFrac = wFrac / k; hFrac = hFrac / k;
  const x = clamp(cx - wFrac / 2, 0, 1 - wFrac);
  const y = clamp(cy - hFrac / 2, 0, 1 - hFrac);
  return { x: round4(x), y: round4(y), w: round4(wFrac), h: round4(hFrac) };
}

/** Clamp a frame (as fractions) back inside the source; keeps its size when possible. */
export function clampFrame(f: CropFrame): CropFrame {
  const w = clamp(f.w, 0.02, 1);
  const h = clamp(f.h, 0.02, 1);
  return { x: round4(clamp(f.x, 0, 1 - w)), y: round4(clamp(f.y, 0, 1 - h)), w: round4(w), h: round4(h) };
}
