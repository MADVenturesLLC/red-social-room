import { getApp } from "../../../../server/app.ts";
import { setCapUsd, monthTotals, fmtUsd } from "../../../../server/ledger.ts";
import { guardPost, json, readJson } from "../../../../server/route-util.ts";
import { notWritableResponse } from "../../../../server/writable.ts";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const bad = guardPost(req); if (bad) return bad;
  const body = await readJson(req);
  if (!body) return json({ error: "Expected a JSON object." }, 400);
  const app = getApp();
  const ro = notWritableResponse(app.dataDir); if (ro) return ro; // pin 19 (d) gap 2
  try { setCapUsd(app.db, body.usd as number); } catch (e) { return json({ error: (e as Error).message }, 400); }
  const t = monthTotals(app.db);
  return json({ capText: fmtUsd(t.capMicros), countedText: fmtUsd(t.countedMicros) });
}
