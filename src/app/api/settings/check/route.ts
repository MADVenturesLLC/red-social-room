import { getApp } from "../../../../server/app.ts";
import { checkKey } from "../../../../server/xai/adapter.ts";
import { checkGoogleKey } from "../../../../server/google/adapter.ts";
import { googleDepsOf } from "../../../../server/execute.ts";
import { guardPost, json } from "../../../../server/route-util.ts";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const bad = guardPost(req); if (bad) return bad;
  const app = getApp();
  const c = await checkKey(app, { force: true });
  const g = app.googleKeys.status().set ? await checkGoogleKey(googleDepsOf(app), { force: true }) : null;
  return json({ key: app.keys.status(), check: { ok: c.ok, message: c.ok ? null : c.message }, googleKey: app.googleKeys.status(), googleCheck: g ? { ok: g.ok, message: g.ok ? null : g.message } : null });
}
