// A4: the Brand kit. GET lists it, POST stores one logo (raster or SVG, validated in src/server/brand.ts),
// DELETE removes one from the kit (the file itself stays in the content-addressed store).
import { getApp } from "../../../server/app.ts";
import { addLogo, listBrand, removeBrand, BrandError } from "../../../server/brand.ts";
import { StoreError } from "../../../server/store.ts";
import { guardPost, json, readJson } from "../../../server/route-util.ts";
import { notWritableResponse } from "../../../server/writable.ts";

export const dynamic = "force-dynamic";

const B64_RE = /^[A-Za-z0-9+/=\r\n]+$/;

export async function GET(): Promise<Response> {
  return json({ items: listBrand(getApp().db) });
}

export async function POST(req: Request): Promise<Response> {
  const bad = guardPost(req); if (bad) return bad;
  const body = await readJson(req, 32 * 1024 * 1024);
  if (!body) return json({ error: "Expected a JSON object." }, 400);
  const raw = (body as Record<string, unknown>).data;
  if (typeof raw !== "string" || !raw) return json({ error: "No logo data was sent." }, 400);
  const b64 = raw.startsWith("data:") ? raw.slice(raw.indexOf(",") + 1) : raw;
  if (!B64_RE.test(b64)) return json({ error: "The logo data is not valid base64." }, 400);
  const app = getApp();
  const ro = notWritableResponse(app.dataDir); if (ro) return ro;
  try {
    const item = addLogo(app.db, app.imagesDir, b64, (body as Record<string, unknown>).name);
    return json(item, 201);
  } catch (e) {
    if (e instanceof BrandError) return json({ error: e.message }, 400);
    if (e instanceof StoreError) return json({ error: e.message }, 500);
    return json({ error: "The logo did not save inside the app." }, 500);
  }
}

export async function DELETE(req: Request): Promise<Response> {
  const bad = guardPost(req); if (bad) return bad;
  const id = new URL(req.url).searchParams.get("id");
  const ok = removeBrand(getApp().db, id);
  return ok ? json({ ok: true }) : json({ error: "Unknown logo." }, 404);
}
