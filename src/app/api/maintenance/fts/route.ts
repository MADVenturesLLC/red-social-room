// A7 (F17): the manual search-index actions. "check" runs the nightly check; "rebuild" rebuilds first
// and then reports, which is what the Settings button does when something looks off.
import { getApp } from "../../../../server/app.ts";
import { checkFts, rebuildFts, ftsCounts } from "../../../../server/fts.ts";
import { isoNY } from "../../../../../spike/lib/ledger.ts";
import { guardPost, json, readJson } from "../../../../server/route-util.ts";
import { notWritableResponse } from "../../../../server/writable.ts";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const bad = guardPost(req); if (bad) return bad;
  const body = await readJson(req);
  if (!body) return json({ error: "Expected a JSON object." }, 400);
  const app = getApp();
  const ro = notWritableResponse(app.dataDir); if (ro) return ro; // pin 19 (d)
  const action = (body as Record<string, unknown>).action === "rebuild" ? "rebuild" : "check";
  if (action === "rebuild") {
    try {
      rebuildFts(app.db);
      app.db.prepare("INSERT INTO maintenance_log (created_at, kind, detail) VALUES (?, 'fts_rebuild', ?)").run(isoNY(), JSON.stringify({ manual: true, ...ftsCounts(app.db) }));
    } catch (e) {
      return json({ error: `Rebuild failed: ${(e as Error).message.slice(0, 200)}` }, 500);
    }
  }
  return json({ action, report: checkFts(app.db) });
}
