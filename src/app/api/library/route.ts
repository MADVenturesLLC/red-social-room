import { getApp } from "../../../server/app.ts";
import { savePost, saveUploadedPost, searchPosts, LibraryError } from "../../../server/library.ts";
import { guardPost, json, readJson } from "../../../server/route-util.ts";
import { notWritableResponse } from "../../../server/writable.ts";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const q = new URL(req.url).searchParams.get("q") ?? "";
  return json({ posts: searchPosts(getApp().db, q) });
}

export async function POST(req: Request): Promise<Response> {
  const bad = guardPost(req); if (bad) return bad;
  const body = await readJson(req);
  if (!body) return json({ error: "Expected a JSON object." }, 400);
  const app = getApp();
  const ro = notWritableResponse(app.dataDir); if (ro) return ro; // pin 19 (d) gap 2
  try {
    const b = body as Record<string, unknown>;
    if (typeof b.assetId === "string" && b.assetId) {
      return json(saveUploadedPost(app.db, { assetId: b.assetId, prompt: b.prompt, notes: b.notes }));
    }
    return json(savePost(app.db, b.generationId, b.notes));
  } catch (e) {
    if (e instanceof LibraryError) return json({ error: e.message }, 400);
    return json({ error: "Save failed inside the app." }, 500);
  }
}
