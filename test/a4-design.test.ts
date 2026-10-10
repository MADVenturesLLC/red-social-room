// A4 unit battery: the editor's recipe, its geometry, the Brand kit (PNG + SVG safety) and the design
// save path (recipe stored, post pointed at the render, the original kept as the source). No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { makeApp, fakeProviders } from "./helpers.ts";
import { insertAsset } from "../src/server/execute.ts";
import { putImage, relPathFor } from "../src/server/store.ts";
import { addLogo, listBrand, removeBrand, BRAND_MAX_ITEMS, LOGO_MAX_BYTES } from "../src/server/brand.ts";
import { getPostDesign, updatePostDesign, DesignError } from "../src/server/design.ts";
import { defaultRecipe, parseRecipe, rotatedSize, outputSize, flattenScale, MAX_TEXT_LAYERS } from "../src/lib/recipe.ts";

type T = ReturnType<typeof makeApp>;

const mkApp = () => makeApp({ fetch: fakeProviders().fetch });
const pngLogo = (fill: string) => sharp({ create: { width: 64, height: 32, channels: 4, background: fill } }).png().toBuffer();
const OK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40"><rect width="100" height="40" fill="#c8102e"/></svg>';

async function seedPost(t: T): Promise<{ postId: number; genId: string; assetId: string }> {
  const bytes = await sharp({ create: { width: 96, height: 64, channels: 3, background: "#2255aa" } }).png().toBuffer();
  const img = putImage(t.app.imagesDir, bytes);
  insertAsset(t.app.db, img);
  const genId = randomUUID();
  t.app.db.prepare("INSERT INTO runs (id, created_at, prompt, status) VALUES (?, '2026-10-10T10:00:00-04:00', 'a tabby on a windowsill', 'ok')").run(genId);
  t.app.db.prepare(`INSERT INTO generations (id, run_id, created_at, provider, model, kind, prompt, params, status, output_asset_id, display_asset_id)
    VALUES (?, ?, '2026-10-10T10:00:00-04:00', 'xai', 'grok-imagine-image-2.0', 'generate', 'a tabby on a windowsill', '{}', 'ok', ?, ?)`).run(genId, genId, img.id, img.id);
  const r = t.app.db.prepare("INSERT INTO posts (created_at, generation_id, asset_id, prompt, model, notes) VALUES ('2026-10-10T10:00:00-04:00', ?, ?, 'a tabby on a windowsill', 'grok-imagine-image-2.0', '')").run(genId, img.id);
  return { postId: Number(r.lastInsertRowid), genId, assetId: img.id };
}

async function anyAsset(t: T, fill = "#aa3300"): Promise<string> {
  const bytes = await sharp({ create: { width: 48, height: 48, channels: 3, background: fill } }).png().toBuffer();
  const img = putImage(t.app.imagesDir, bytes);
  insertAsset(t.app.db, img);
  return img.id;
}

test("A4 recipe: defaults fill in, a full recipe roundtrips, and bad values are refused with reasons", () => {
  const d = parseRecipe(defaultRecipe());
  assert.ok(d.ok);
  const minimal = parseRecipe({ version: 1, rotate: 90, crop: null, texts: [], logos: [] });
  assert.ok(minimal.ok);
  assert.deepEqual(minimal.recipe.adjust, { brightness: 0, contrast: 0, saturation: 0, warmth: 0 });
  const full = {
    version: 1, rotate: 270, crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.5 },
    adjust: { brightness: -100, contrast: 100, saturation: 25, warmth: -40 },
    texts: [{ id: "t1", text: "Hello", x: 0.1, y: 0.1, font: "Anton", size: 0.12, color: "#ffffff", strokeWidth: 2, strokeColor: "#111111", shadow: true }],
    logos: [{ id: "l1", assetId: "a".repeat(64), x: 0.4, y: 0.7, scale: 0.25 }],
  };
  const f = parseRecipe(full);
  assert.ok(f.ok);
  assert.deepEqual(f.recipe, full);
  for (const [bad, why] of [
    [{ ...full, rotate: 45 }, /Rotation/],
    [{ ...full, version: 2 }, /version/],
    [{ ...full, crop: { x: 0.9, y: 0.1, w: 0.5, h: 0.5 } }, /fit/],
    [{ ...full, crop: { x: 0, y: 0, w: 0.001, h: 0.5 } }, /out of range/],
    [{ ...full, adjust: { ...full.adjust, contrast: 200 } }, /slider/],
    [{ ...full, texts: [{ ...full.texts[0], font: "Comic Sans" }] }, /font/],
    [{ ...full, texts: [{ ...full.texts[0], color: "red" }] }, /colour/],
    [{ ...full, texts: [{ ...full.texts[0], size: 0.9 }] }, /text size/],
    [{ ...full, texts: [{ ...full.texts[0], text: "x".repeat(501) }] }, /500/],
    [{ ...full, texts: Array.from({ length: MAX_TEXT_LAYERS + 1 }, (_, i) => ({ ...full.texts[0], id: `t${i}` })) }, /Too many text/],
    [{ ...full, logos: [{ ...full.logos[0], assetId: "nope" }] }, /stored image/],
    [{ ...full, logos: [{ ...full.logos[0], scale: 3 }] }, /logo size/],
  ] as Array<[unknown, RegExp]>) {
    const r = parseRecipe(bad);
    assert.equal(r.ok, false, `expected refusal for ${JSON.stringify(bad).slice(0, 80)}`);
    if (!r.ok) assert.match(r.error, why);
  }
});

test("A4 geometry: rotation swaps sides, crop trims the rotated box, the flatten cap only shrinks big outputs", () => {
  assert.deepEqual(rotatedSize(864, 1152, 0), { w: 864, h: 1152 });
  assert.deepEqual(rotatedSize(864, 1152, 90), { w: 1152, h: 864 });
  assert.deepEqual(rotatedSize(864, 1152, 180), { w: 864, h: 1152 });
  const r = defaultRecipe();
  assert.deepEqual(outputSize(864, 1152, r), { w: 864, h: 1152 });
  assert.deepEqual(outputSize(864, 1152, { ...r, crop: { x: 0.1, y: 0.25, w: 0.5, h: 0.5 } }), { w: 432, h: 576 });
  assert.deepEqual(outputSize(864, 1152, { ...r, rotate: 90, crop: { x: 0, y: 0, w: 0.5, h: 0.5 } }), { w: 576, h: 432 });
  assert.equal(flattenScale(1024, 1024), 1);
  assert.equal(flattenScale(4096, 2048), 0.5);
});

test("A4 brand: a PNG and an SVG logo land in the kit; removing one leaves the file in the store", async () => {
  const t = mkApp();
  try {
    const png = addLogo(t.app.db, t.app.imagesDir, (await pngLogo("#c8102e")).toString("base64"), "Roundel");
    assert.equal(png.mime, "image/png");
    assert.equal(png.width, 64);
    const svg = addLogo(t.app.db, t.app.imagesDir, Buffer.from(OK_SVG).toString("base64"), "Wordmark");
    assert.equal(svg.mime, "image/svg+xml");
    assert.equal(svg.width, null);
    const list = listBrand(t.app.db);
    assert.equal(list.length, 2);
    assert.equal(list[0].name, "Wordmark"); // newest first
    assert.ok(existsSync(join(t.app.imagesDir, relPathFor(svg.assetId, "svg"))));
    assert.equal(removeBrand(t.app.db, list[0].id), true);
    assert.equal(listBrand(t.app.db).length, 1);
    // The bytes stay (content-addressed; other designs may use them), only the kit row is gone.
    assert.ok(existsSync(join(t.app.imagesDir, relPathFor(svg.assetId, "svg"))));
    assert.equal(removeBrand(t.app.db, 99999), false);
  } finally { t.cleanup(); }
});

test("A4 brand: SVGs with active content are refused with the reason; so are empty names and junk bytes", async () => {
  const t = mkApp();
  try {
    const svg = (body: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">${body}</svg>`);
    const cases: Array<[Buffer, RegExp]> = [
      [svg('<script>alert(1)</script>'), /cannot contain scripts/],
      [svg('<rect width="10" height="10" onload="alert(1)"/>'), /event handlers/],
      [svg('<foreignObject width="10" height="10"></foreignObject>'), /foreignObject/],
      [svg('<a href="javascript:alert(1)"><rect width="10" height="10"/></a>'), /javascript:/],
    ];
    for (const [buf, why] of cases) {
      assert.throws(() => addLogo(t.app.db, t.app.imagesDir, buf.toString("base64"), "Bad"), (e: unknown) => e instanceof Error && why.test(e.message), why.source);
    }
    const big = Buffer.concat([Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">'), Buffer.alloc(LOGO_MAX_BYTES + 10, 0x20), Buffer.from("</svg>")]);
    assert.throws(() => addLogo(t.app.db, t.app.imagesDir, big.toString("base64"), "Big"), /1 MB/);
    const small = (await pngLogo("#111111")).toString("base64");
    assert.throws(() => addLogo(t.app.db, t.app.imagesDir, small, "   "), /name/);
    assert.throws(() => addLogo(t.app.db, t.app.imagesDir, Buffer.from("not an image at all").toString("base64"), "Junk"), /PNG, JPEG, WebP or SVG/);
    assert.equal(listBrand(t.app.db).length, 0);
  } finally { t.cleanup(); }
});

test("A4 brand: the kit caps at 50 logos", async () => {
  const t = mkApp();
  try {
    const b64 = (await pngLogo("#224466")).toString("base64");
    for (let i = 0; i < BRAND_MAX_ITEMS; i++) addLogo(t.app.db, t.app.imagesDir, b64, `Logo ${i}`);
    assert.throws(() => addLogo(t.app.db, t.app.imagesDir, b64, "One too many"), /full/);
  } finally { t.cleanup(); }
});

test("A4 design: a save stores the recipe, points the post at the render, and keeps the original as the source", async () => {
  const t = mkApp();
  try {
    const { postId, assetId: original } = await seedPost(t);
    const logoId = await anyAsset(t, "#ff8800");
    const render1 = await anyAsset(t, "#00aa66");
    const recipe1 = {
      ...defaultRecipe(), crop: { x: 0.1, y: 0.05, w: 0.8, h: 0.9 },
      adjust: { brightness: 0, contrast: 0, saturation: 0, warmth: 40 },
      texts: [{ id: "t1", text: "First headline", x: 0.1, y: 0.1, font: "Anton", size: 0.12, color: "#ffffff", strokeWidth: 0, strokeColor: "#000000", shadow: true }],
      logos: [{ id: "l1", assetId: logoId, x: 0.4, y: 0.7, scale: 0.25 }],
    };
    const out1 = updatePostDesign(t.app.db, postId, render1, recipe1);
    assert.equal(out1.assetId, render1);
    assert.equal(out1.sourceAssetId, original);
    let got = getPostDesign(t.app.db, postId)!;
    assert.equal(got.assetId, render1);
    assert.equal(got.sourceAssetId, original);
    assert.deepEqual(got.recipe, recipe1);
    // Reopen, change only the headline: same crop, same logo, source untouched ("without redoing the rest").
    const recipe2 = { ...recipe1, texts: [{ ...recipe1.texts[0], text: "Second headline" }] };
    const render2 = await anyAsset(t, "#6600aa");
    const out2 = updatePostDesign(t.app.db, postId, render2, recipe2);
    assert.equal(out2.sourceAssetId, original);
    got = getPostDesign(t.app.db, postId)!;
    assert.equal(got.assetId, render2);
    assert.equal(got.sourceAssetId, original);
    assert.equal(got.recipe!.texts[0].text, "Second headline");
    assert.deepEqual(got.recipe!.crop, recipe1.crop);
    assert.deepEqual(got.recipe!.logos, recipe1.logos);
  } finally { t.cleanup(); }
});

test("A4 design: bad saves are refused with the reasons", async () => {
  const t = mkApp();
  try {
    const { postId } = await seedPost(t);
    const render = await anyAsset(t);
    const r = defaultRecipe();
    assert.throws(() => updatePostDesign(t.app.db, 99999, render, r), (e: unknown) => e instanceof DesignError && /Unknown post/.test(e.message));
    assert.throws(() => updatePostDesign(t.app.db, postId, "not-a-sha", r), /not valid/);
    assert.throws(() => updatePostDesign(t.app.db, postId, "f".repeat(64), r), /not in the store/);
    assert.throws(() => updatePostDesign(t.app.db, postId, render, { ...r, logos: [{ id: "l1", assetId: "b".repeat(64), x: 0.1, y: 0.1, scale: 0.2 }] }), /logo .* is not in the store/);
    assert.throws(() => updatePostDesign(t.app.db, postId, render, { version: 9 }), /version/);
    assert.equal(getPostDesign(t.app.db, postId)!.recipe, null); // nothing half-saved
  } finally { t.cleanup(); }
});
