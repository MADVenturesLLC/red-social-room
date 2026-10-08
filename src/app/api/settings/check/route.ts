import { getApp } from "../../../../server/app.ts";
import { checkKey } from "../../../../server/xai/adapter.ts";
import { guardPost, json } from "../../../../server/route-util.ts";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const bad = guardPost(req); if (bad) return bad;
  const app = getApp();
  const c = await checkKey(app, { force: true });
  return json({ key: app.keys.status(), check: { ok: c.ok, message: c.ok ? null : c.message } });
}
