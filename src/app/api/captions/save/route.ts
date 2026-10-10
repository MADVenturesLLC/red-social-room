// A5: save ONE platform's caption (the chosen option, as edited). Over-limit text saves as-is — the UI
// flags it, the app never cuts it (T:133).
import { getApp } from "../../../../server/app.ts";
import { saveCaption, CaptionStoreError } from "../../../../server/captions.ts";
import { guardPost, json, readJson } from "../../../../server/route-util.ts";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const bad = guardPost(req); if (bad) return bad;
  const body = await readJson(req);
  if (!body) return json({ error: "Expected a JSON object." }, 400);
  try {
    const saved = saveCaption(getApp().db, body.postId, body.platform, body.text, body.hashtags, body.altText);
    return json({ ok: true, ...saved });
  } catch (e) {
    if (e instanceof CaptionStoreError) return json({ error: e.message }, 400);
    return json({ error: "The caption did not save inside the app." }, 500);
  }
}
