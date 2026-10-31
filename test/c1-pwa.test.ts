// C1: installable app + share sheet — the static pieces and the share helper's fallbacks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { canShareFiles, shareImage } from "../src/lib/share.ts";

const root = join(import.meta.dirname, "..");

test("C1: the manifest makes the app installable (name, start_url, dark theme, any + maskable icons)", () => {
  const m = JSON.parse(readFileSync(join(root, "public", "manifest.webmanifest"), "utf8")) as {
    name: string; short_name: string; start_url: string; display: string; theme_color: string;
    icons: Array<{ src: string; sizes: string; type: string; purpose?: string }>;
  };
  assert.equal(m.name, "Red Social Room");
  assert.equal(m.short_name, "Social Room");
  assert.equal(m.start_url, "/");
  assert.equal(m.display, "standalone");
  assert.equal(m.theme_color, "#0b0b0f");
  const sizes = m.icons.map((i) => `${i.sizes}:${i.purpose ?? "any"}`);
  assert.ok(sizes.includes("192x192:any"));
  assert.ok(sizes.includes("512x512:any"));
  assert.ok(sizes.includes("512x512:maskable"));
  for (const i of m.icons) assert.equal(i.type, "image/png");
});

test("C1: the icon files exist at the exact sizes the manifest promises", async () => {
  const want: Array<[string, number]> = [
    ["icon-192.png", 192],
    ["icon-512.png", 512],
    ["icon-maskable-512.png", 512],
    ["apple-touch-icon.png", 180],
  ];
  for (const [name, size] of want) {
    const meta = await sharp(join(root, "public", "icons", name)).metadata();
    assert.equal(meta.width, size, `${name} width`);
    assert.equal(meta.height, size, `${name} height`);
    assert.equal(meta.format, "png");
  }
});

test("C1: the service worker never caches app data and only passes GETs through", () => {
  const sw = readFileSync(join(root, "public", "sw.js"), "utf8");
  assert.match(sw, /addEventListener\("fetch"/);
  assert.match(sw, /request\.method !== "GET"/, "POSTs are left alone");
  assert.doesNotMatch(sw, /caches\.open|cache\.put/, "no cache: a stale ledger or library would be worse than offline");
});

test("C1: the share helper falls back instead of throwing (no share sheet, no network)", async () => {
  // Node has a navigator global but no Web Share API: the helper must say so, not crash.
  assert.equal(canShareFiles(), false);
  const out = await shareImage("/api/assets/does-not-exist", "image.jpg", "Red Social Room", "prompt");
  assert.equal(out, "failed", "a relative URL cannot be fetched here → reported as failed");
});
