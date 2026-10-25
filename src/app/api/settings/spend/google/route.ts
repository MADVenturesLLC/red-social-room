// Settings -> Spend: enter the Google console total for the month (item 8). If it is higher than the
// app's Google estimate, ONE adjustment ledger row is added for the difference so the cap counts real spend.
import { getApp } from "../../../../../server/app.ts";
import { setGoogleConsoleTotal } from "../../../../../server/ledger.ts";
import { guardPost, json, readJson } from "../../../../../server/route-util.ts";
import { actorFromRequest, ownerDenied } from "../../../../../server/actor.ts";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const bad = guardPost(req); if (bad) return bad;
  const ownerOnly = ownerDenied(actorFromRequest(req)); if (ownerOnly) return ownerOnly; // B1: owner-only action
  const body = await readJson(req, 4096);
  if (!body) return json({ error: "Expected a JSON object." }, 400);
  const b = body as { usd?: unknown };
  const app = getApp();
  try {
    const out = setGoogleConsoleTotal(app.db, Number(b.usd));
    return json({ ok: true, adjustmentMicros: out.adjustmentMicros, state: out.state });
  } catch (e) {
    if (e instanceof RangeError) return json({ error: e.message }, 400);
    app.log?.(`google console total failed: ${(e as Error).name}`);
    return json({ error: "Saving the console total failed inside the app. Nothing was changed." }, 500);
  }
}
