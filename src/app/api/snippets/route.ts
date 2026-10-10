// A7 (T:76): saved prompt snippets — list, save the current one, remove an old one.
import { getApp } from "../../../server/app.ts";
import { addSnippet, deleteSnippet, listSnippets, LibraryError } from "../../../server/library.ts";
import { guardPost, json, readJson } from "../../../server/route-util.ts";
import { notWritableResponse } from "../../../server/writable.ts";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return json({ snippets: listSnippets(getApp().db) });
}

export async function POST(req: Request): Promise<Response> {
  const bad = guardPost(req); if (bad) return bad;
  const body = await readJson(req);
  if (!body) return json({ error: "Expected a JSON object." }, 400);
  const app = getApp();
  const ro = notWritableResponse(app.dataDir); if (ro) return ro; // pin 19 (d)
  try {
    return json({ snippet: addSnippet(app.db, (body as Record<string, unknown>).text) });
  } catch (e) {
    if (e instanceof LibraryError) return json({ error: e.message }, 400);
    return json({ error: "Saving the snippet failed inside the app." }, 500);
  }
}

export async function DELETE(req: Request): Promise<Response> {
  const bad = guardPost(req); if (bad) return bad;
  const app = getApp();
  const ro = notWritableResponse(app.dataDir); if (ro) return ro; // pin 19 (d)
  const fromQuery = new URL(req.url).searchParams.get("id");
  const body = fromQuery === null ? await readJson(req) : null;
  const id = fromQuery ?? (body as Record<string, unknown> | null)?.id;
  try {
    const deleted = deleteSnippet(app.db, id);
    return deleted ? json({ ok: true }) : json({ error: "Unknown snippet." }, 404);
  } catch (e) {
    if (e instanceof LibraryError) return json({ error: e.message }, 400);
    return json({ error: "Removing the snippet failed inside the app." }, 500);
  }
}
