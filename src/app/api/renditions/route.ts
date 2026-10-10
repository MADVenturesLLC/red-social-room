// A6: make one rendition for one platform preset — exact preset pixels (item 24); the crop frame (drag)
// replaces the attention choice. Writes files: the not-writable guard runs first (A1 pin 19d).
import { getApp } from "../../../server/app.ts";
import { makeRendition, RenditionError } from "../../../server/renditions.ts";
import { StoreError } from "../../../server/store.ts";
import { guardPost, json, readJson } from "../../../server/route-util.ts";
import { notWritableResponse } from "../../../server/writable.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request): Promise<Response> {
  const bad = guardPost(req); if (bad) return bad;
  const body = await readJson(req);
  if (!body) return json({ error: "Expected a JSON object." }, 400);
  const app = getApp();
  const ro = notWritableResponse(app.dataDir); if (ro) return ro;
  try {
    const { rendition } = await makeRendition(app.db, app.imagesDir, body.postId, body.presetId, body.crop);
    return json({ ok: true, rendition });
  } catch (e) {
    if (e instanceof RenditionError) return json({ error: e.message }, 400);
    if (e instanceof StoreError) return json({ error: e.message }, 500);
    app.log?.(`rendition failed: ${(e as Error).name}: ${(e as Error).message}`);
    return json({ error: "The rendition did not save inside the app." }, 500);
  }
}
