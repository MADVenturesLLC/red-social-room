// A6 item 9: "AI extend (Nano Banana 2)" — one Google edit with the target ratio, then the exact-size
// step. Paid call: the cap guard and the ledger are the A3 edit path's (D3: Grok is never used here).
import { getApp } from "../../../../server/app.ts";
import { widenRendition, RenditionError } from "../../../../server/renditions.ts";
import { guardPost, json, readJson } from "../../../../server/route-util.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request): Promise<Response> {
  const bad = guardPost(req); if (bad) return bad;
  const body = await readJson(req);
  if (!body) return json({ error: "Expected a JSON object." }, 400);
  const app = getApp();
  try {
    const out = await widenRendition(app, body.postId, body.presetId);
    return json({ ok: out.kind === "ok", ...out });
  } catch (e) {
    if (e instanceof RenditionError) return json({ error: e.message }, 400);
    app.log?.(`widen failed: ${(e as Error).name}: ${(e as Error).message}`);
    return json({ error: "Something went wrong inside the app. Check Settings → Spend before retrying." }, 500);
  }
}
