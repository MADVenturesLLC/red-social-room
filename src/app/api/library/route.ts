import { getApp } from "../../../server/app.ts";
import { savePost, searchPosts, LibraryError } from "../../../server/library.ts";
import { guardPost, json, readJson } from "../../../server/route-util.ts";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const q = new URL(req.url).searchParams.get("q") ?? "";
  return json({ posts: searchPosts(getApp().db, q) });
}

export async function POST(req: Request): Promise<Response> {
  const bad = guardPost(req); if (bad) return bad;
  const body = await readJson(req);
  if (!body) return json({ error: "Expected a JSON object." }, 400);
  try {
    return json(savePost(getApp().db, body.generationId, body.notes));
  } catch (e) {
    if (e instanceof LibraryError) return json({ error: e.message }, 400);
    return json({ error: "Save failed inside the app." }, 500);
  }
}
