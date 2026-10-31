// C1: generate the PWA icons from one SVG (sharp is already a dependency). Run: node scripts/make-icons.mjs
// The mark: the app's red on the app's dark background, with "RSR" set in DejaVu Sans (present on the box).
import sharp from "sharp";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const out = resolve("public/icons");
mkdirSync(out, { recursive: true });

const svg = (size, { maskable }) => {
  const pad = maskable ? size * 0.15 : size * 0.08;
  const plate = size - pad * 2;
  const radius = plate * 0.22;
  const fontSize = maskable ? size * 0.24 : size * 0.29;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="#0b0b0f"/>
  <rect x="${pad}" y="${pad}" width="${plate}" height="${plate}" rx="${radius}" fill="#c8102e"/>
  <text x="${size / 2}" y="${size / 2 + fontSize * 0.35}" font-family="DejaVu Sans" font-size="${fontSize}" font-weight="bold" fill="#ffffff" text-anchor="middle" letter-spacing="${size * 0.004}">RSR</text>
</svg>`);
};

const jobs = [
  ["icon-192.png", 192, { maskable: false }],
  ["icon-512.png", 512, { maskable: false }],
  ["icon-maskable-512.png", 512, { maskable: true }],
  ["apple-touch-icon.png", 180, { maskable: false }],
];
for (const [name, size, opts] of jobs) {
  const file = join(out, name);
  await sharp(svg(size, opts)).png().toFile(file);
  console.log(`${file} ${size}x${size}`);
}
