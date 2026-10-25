// A5: write captions for a post's final image (T:99, T:214-216). Free key check, real-person check on the
// free text, cap check per attempt — all inside src/server/captions.ts. The response is always HTTP 200
// with a kind ("ok" | "blocked" | "error"); a malformed request body is a 400.
import { getApp } from "../../../server/app.ts";
import { googleDepsOf } from "../../../server/execute.ts";
import { generateCaptions, CaptionInputError } from "../../../server/captions.ts";
import { actorFromRequest, spendDenied } from "../../../server/actor.ts";
import { guardPost, json, readJson } from "../../../server/route-util.ts";
import { notWritableResponse } from "../../../server/writable.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request): Promise<Response> {
  const bad = guardPost(req); if (bad) return bad;
  const viewOnly = spendDenied(actorFromRequest(req)); if (viewOnly) return viewOnly; // B1: view-only accounts make no paid call
  const body = await readJson(req);
  if (!body) return json({ error: "Expected a JSON object." }, 400);
  const app = getApp();
  const ro = notWritableResponse(app.dataDir); if (ro) return ro; // A1 pin 19 (d)
  try {
    const out = await generateCaptions(googleDepsOf(app), app.promptMethod, app.imagesDir, {
      postId: Number(body.postId),
      platforms: Array.isArray(body.platforms) ? (body.platforms as unknown[]).map(String) : [],
      tone: typeof body.tone === "string" ? body.tone : "",
      notes: typeof body.notes === "string" ? body.notes : "",
    });
    return json(out);
  } catch (e) {
    if (e instanceof CaptionInputError) return json({ error: e.message }, 400);
    app.log?.(`captions failed: ${(e as Error).name}: ${(e as Error).message}`);
    return json({ error: "Something went wrong inside the app. Check Settings → Spend before retrying." }, 500);
  }
}
