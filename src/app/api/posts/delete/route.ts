// A7 housekeeping: delete one post from the Library. Post rows and their captions, tags and renditions
// go; the content-addressed image files stay on disk (other posts or versions may share them).
import { getApp } from "../../../../server/app.ts";
import { deletePost, LibraryError } from "../../../../server/library.ts";
import { guardPost, json, readJson } from "../../../../server/route-util.ts";
import { actorFromRequest, ownerDenied } from "../../../../server/actor.ts";
import { notWritableResponse } from "../../../../server/writable.ts";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const bad = guardPost(req); if (bad) return bad;
  const ownerOnly = ownerDenied(actorFromRequest(req)); if (ownerOnly) return ownerOnly; // B1: owner-only action
  const body = await readJson(req);
  if (!body) return json({ error: "Expected a JSON object." }, 400);
  const app = getApp();
  const ro = notWritableResponse(app.dataDir); if (ro) return ro; // pin 19 (d)
  try {
    const deleted = deletePost(app.db, (body as Record<string, unknown>).id);
    return deleted ? json({ ok: true }) : json({ error: "That post is already gone." }, 404);
  } catch (e) {
    if (e instanceof LibraryError) return json({ error: e.message }, 400);
    return json({ error: "Deleting the post failed inside the app." }, 500);
  }
}
