// A4: save a design (recipe + flattened render) onto a post. The render is an uploaded asset; every
// validation lives in src/server/design.ts.
import { getApp } from "../../../../server/app.ts";
import { updatePostDesign, DesignError } from "../../../../server/design.ts";
import { guardPost, json, readJson } from "../../../../server/route-util.ts";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const bad = guardPost(req); if (bad) return bad;
  const body = await readJson(req, 256 * 1024); // the recipe cap is 64 KB; the render travels as its own upload
  if (!body) return json({ error: "Expected a JSON object." }, 400);
  const b = body as Record<string, unknown>;
  try {
    const out = updatePostDesign(getApp().db, b.postId, b.assetId, b.recipe);
    return json({ ok: true, ...out });
  } catch (e) {
    if (e instanceof DesignError) return json({ error: e.message }, 400);
    return json({ error: "The design did not save inside the app." }, 500);
  }
}
