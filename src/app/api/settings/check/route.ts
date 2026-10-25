import { getApp } from "../../../../server/app.ts";
import { checkKey } from "../../../../server/xai/adapter.ts";
import { checkGoogleKey } from "../../../../server/google/adapter.ts";
import { checkOpenAiKey } from "../../../../server/openai/adapter.ts";
import { googleDepsOf, openaiDepsOf } from "../../../../server/execute.ts";
import { guardPost, json } from "../../../../server/route-util.ts";
import { actorFromRequest, ownerDenied } from "../../../../server/actor.ts";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const bad = guardPost(req); if (bad) return bad;
  const ownerOnly = ownerDenied(actorFromRequest(req)); if (ownerOnly) return ownerOnly; // B1: owner-only action
  const app = getApp();
  const c = await checkKey(app, { force: true });
  const g = app.googleKeys.status().set ? await checkGoogleKey(googleDepsOf(app), { force: true }) : null;
  const oa = openaiDepsOf(app);
  const o = oa.keys.status().set ? await checkOpenAiKey(oa, { force: true }) : null;
  return json({
    key: app.keys.status(),
    check: { ok: c.ok, message: c.ok ? null : c.message },
    googleKey: app.googleKeys.status(),
    googleCheck: g ? { ok: g.ok, message: g.ok ? null : g.message } : null,
    openaiKey: oa.keys.status(),
    openaiCheck: o ? { ok: o.ok, message: o.ok ? null : o.message } : null,
  });
}
