// A5: the brand voice text — written once, kept in settings, sent with every caption call (T:132).
import { getApp } from "../../../../server/app.ts";
import { getBrandVoice, setBrandVoice, CaptionStoreError } from "../../../../server/captions.ts";
import { guardPost, json, readJson } from "../../../../server/route-util.ts";
import { actorFromRequest, ownerDenied } from "../../../../server/actor.ts";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return json({ text: getBrandVoice(getApp().db) });
}

export async function POST(req: Request): Promise<Response> {
  const bad = guardPost(req); if (bad) return bad;
  const ownerOnly = ownerDenied(actorFromRequest(req)); if (ownerOnly) return ownerOnly; // B1: owner-only action
  const body = await readJson(req, 64 * 1024);
  if (!body) return json({ error: "Expected a JSON object." }, 400);
  try {
    return json({ ok: true, text: setBrandVoice(getApp().db, body.text) });
  } catch (e) {
    if (e instanceof CaptionStoreError) return json({ error: e.message }, 400);
    return json({ error: "The brand voice did not save inside the app." }, 500);
  }
}
