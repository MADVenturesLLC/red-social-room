// A5: accept suggested tags for a post. Nothing is added silently — this route runs only for the tags
// the user ticked (T:103).
import { getApp } from "../../../server/app.ts";
import { acceptTags, CaptionStoreError } from "../../../server/captions.ts";
import { guardPost, json, readJson } from "../../../server/route-util.ts";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const bad = guardPost(req); if (bad) return bad;
  const body = await readJson(req);
  if (!body) return json({ error: "Expected a JSON object." }, 400);
  try {
    const tags = acceptTags(getApp().db, body.postId, body.tags);
    return json({ ok: true, tags });
  } catch (e) {
    if (e instanceof CaptionStoreError) return json({ error: e.message }, 400);
    return json({ error: "The tags did not save inside the app." }, 500);
  }
}
