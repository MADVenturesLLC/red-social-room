// A4: the deterministic editor's recipe (TECH-PLAN-v1.md :80 - "the app saves the edit \"recipe\" (JSON)
// alongside the flattened PNG so a change can be redone later"). Pure module: shared by the browser
// editor, the save route and the tests. All positions and sizes are fractions (0..1) of the rendered
// output, so a saved design is valid at any resolution; nothing here touches the DOM or the disk.
export const DESIGN_FONTS: readonly string[] = Object.freeze(["Inter", "Anton"]);
export const RECIPE_VERSION = 1;
export const MAX_TEXT_LAYERS = 20;
export const MAX_LOGO_LAYERS = 20;
export const MAX_RECIPE_BYTES = 64 * 1024;
/** The flatten step never writes a side longer than this (an 8,000 px upload would make huge PNGs). */
export const FLATTEN_MAX_SIDE = 2048;
export const ROTATIONS: readonly number[] = Object.freeze([0, 90, 180, 270]);

export interface CropRect { x: number; y: number; w: number; h: number }
export interface Adjust { brightness: number; contrast: number; saturation: number; warmth: number }
export interface TextLayer {
  id: string; text: string; x: number; y: number; font: string; size: number;
  color: string; strokeWidth: number; strokeColor: string; shadow: boolean;
}
export interface LogoLayer { id: string; assetId: string; x: number; y: number; scale: number }
export interface Recipe {
  version: 1; rotate: number; crop: CropRect | null; adjust: Adjust;
  texts: TextLayer[]; logos: LogoLayer[];
}

export function defaultRecipe(): Recipe {
  return { version: 1, rotate: 0, crop: null, adjust: { brightness: 0, contrast: 0, saturation: 0, warmth: 0 }, texts: [], logos: [] };
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const LAYER_ID = /^[a-zA-Z0-9-]{1,40}$/;
const SHA = /^[a-f0-9]{64}$/;

function num(v: unknown, lo: number, hi: number): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
}

export type ParseResult = { ok: true; recipe: Recipe } | { ok: false; error: string };

/** Strict validation for anything that arrives from the browser. Reasons are shown to the user as-is. */
export function parseRecipe(v: unknown): ParseResult {
  const err = (error: string): ParseResult => ({ ok: false, error });
  if (typeof v !== "object" || v === null || Array.isArray(v)) return err("The design is not an object.");
  const r = v as Record<string, unknown>;
  if (r.version !== RECIPE_VERSION) return err("Unknown design version.");
  if (!ROTATIONS.includes(r.rotate as number)) return err("Rotation must be 0, 90, 180 or 270.");
  let crop: CropRect | null = null;
  if (r.crop !== null && r.crop !== undefined) {
    const c = r.crop as Record<string, unknown>;
    if (!num(c.x, 0, 1) || !num(c.y, 0, 1) || !num(c.w, 0.02, 1) || !num(c.h, 0.02, 1)) return err("The crop is out of range.");
    if (c.x + c.w > 1.0001 || c.y + c.h > 1.0001) return err("The crop does not fit inside the image.");
    crop = { x: c.x, y: c.y, w: c.w, h: c.h };
  }
  const a = (r.adjust ?? {}) as Record<string, unknown>;
  const adj = (k: string): unknown => (a[k] === undefined ? 0 : a[k]);
  if (![adj("brightness"), adj("contrast"), adj("saturation"), adj("warmth")].every((x) => num(x, -100, 100))) return err("A slider value is out of range.");
  const adjust: Adjust = { brightness: adj("brightness") as number, contrast: adj("contrast") as number, saturation: adj("saturation") as number, warmth: adj("warmth") as number };
  const textsRaw = Array.isArray(r.texts) ? r.texts : [];
  if (textsRaw.length > MAX_TEXT_LAYERS) return err(`Too many text layers (${MAX_TEXT_LAYERS} max).`);
  const texts: TextLayer[] = [];
  for (const tRaw of textsRaw) {
    const t = tRaw as Record<string, unknown>;
    if (typeof t.id !== "string" || !LAYER_ID.test(t.id)) return err("A text layer has a bad id.");
    if (typeof t.text !== "string") return err("A text layer has no text.");
    if (t.text.length > 500) return err("A text layer holds more than 500 characters.");
    if (!num(t.x, 0, 1) || !num(t.y, 0, 1)) return err("A text layer is out of range.");
    if (typeof t.font !== "string" || !DESIGN_FONTS.includes(t.font)) return err(`Unknown font "${String(t.font)}".`);
    if (!num(t.size, 0.01, 0.5)) return err("A text size is out of range.");
    if (typeof t.color !== "string" || !HEX.test(t.color)) return err("A text colour is not a #rrggbb value.");
    const strokeWidth = t.strokeWidth === undefined ? 0 : t.strokeWidth;
    const strokeColor = t.strokeColor === undefined ? "#000000" : t.strokeColor;
    if (!num(strokeWidth, 0, 20)) return err("A stroke width is out of range.");
    if (typeof strokeColor !== "string" || !HEX.test(strokeColor)) return err("A stroke colour is not a #rrggbb value.");
    if (typeof t.shadow !== "boolean") return err("A text layer's shadow flag is not true/false.");
    texts.push({ id: t.id, text: t.text, x: t.x, y: t.y, font: t.font, size: t.size, color: t.color, strokeWidth, strokeColor, shadow: t.shadow });
  }
  const logosRaw = Array.isArray(r.logos) ? r.logos : [];
  if (logosRaw.length > MAX_LOGO_LAYERS) return err(`Too many logo layers (${MAX_LOGO_LAYERS} max).`);
  const logos: LogoLayer[] = [];
  for (const lRaw of logosRaw) {
    const l = lRaw as Record<string, unknown>;
    if (typeof l.id !== "string" || !LAYER_ID.test(l.id)) return err("A logo layer has a bad id.");
    if (typeof l.assetId !== "string" || !SHA.test(l.assetId)) return err("A logo layer does not point at a stored image.");
    if (!num(l.x, 0, 1) || !num(l.y, 0, 1)) return err("A logo layer is out of range.");
    if (!num(l.scale, 0.02, 2)) return err("A logo size is out of range.");
    logos.push({ id: l.id, assetId: l.assetId, x: l.x, y: l.y, scale: l.scale });
  }
  return { ok: true, recipe: { version: 1, rotate: r.rotate as number, crop, adjust, texts, logos } };
}

/** The rotated bounding box a recipe's crop is measured against (90/270 swap the sides). */
export function rotatedSize(width: number, height: number, rotate: number): { w: number; h: number } {
  return rotate === 90 || rotate === 270 ? { w: height, h: width } : { w: width, h: height };
}

/** The pixel size the flatten step produces for a source image and recipe (before the FLATTEN_MAX_SIDE cap). */
export function outputSize(width: number, height: number, r: Recipe): { w: number; h: number } {
  const rot = rotatedSize(width, height, r.rotate);
  if (!r.crop) return rot;
  return { w: Math.max(1, Math.round(rot.w * r.crop.w)), h: Math.max(1, Math.round(rot.h * r.crop.h)) };
}

/** 1 when the output fits the cap; smaller when a huge source would otherwise make a huge PNG. */
export function flattenScale(w: number, h: number): number {
  const side = Math.max(w, h);
  return side <= FLATTEN_MAX_SIDE ? 1 : FLATTEN_MAX_SIDE / side;
}

export function recipeLogoIds(r: Recipe): string[] {
  return r.logos.map((l) => l.assetId);
}
