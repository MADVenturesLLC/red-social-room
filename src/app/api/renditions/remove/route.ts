// A6: remove one rendition from the post. The file stays in the content-addressed store (never deleted).
import { getApp } from "../../../../server/app.ts";
import { removeRendition } from "../../../../server/renditions.ts";
import { guardPost, json, readJson } from "../../../../server/route-util.ts";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const bad = guardPost(req); if (bad) return bad;
  const body = await readJson(req);
  if (!body) return json({ error: "Expected a JSON object." }, 400);
  const ok = removeRendition(getApp().db, body.postId, body.presetId);
  return ok ? json({ ok: true }) : json({ error: "That rendition is not there." }, 404);
}
