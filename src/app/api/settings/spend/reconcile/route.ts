// Settings -> Spend -> Unresolved: settle one held row by hand (F21, item 7/8). Append-only: the row keeps
// its reservation and history; it is marked settled at $0 ("not charged") or at the amount from the console.
import { getApp } from "../../../../../server/app.ts";
import { reconcileRow, RowNotReserved } from "../../../../../server/ledger.ts";
import { guardPost, json, readJson } from "../../../../../server/route-util.ts";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const bad = guardPost(req); if (bad) return bad;
  const body = await readJson(req, 4096);
  if (!body) return json({ error: "Expected a JSON object." }, 400);
  const b = body as { id?: unknown; action?: unknown; usd?: unknown; note?: unknown };
  if (typeof b.id !== "string") return json({ error: "id is required." }, 400);
  const action = b.action === "not_charged" ? { action: "not_charged" as const }
    : b.action === "charged" ? { action: "charged" as const, usd: Number(b.usd) }
    : null;
  if (!action) return json({ error: "action must be not_charged or charged." }, 400);
  const app = getApp();
  try {
    const r = reconcileRow(app.db, b.id, action, typeof b.note === "string" ? b.note.slice(0, 500) : "");
    return json({ ok: true, actualMicros: r.actualMicros });
  } catch (e) {
    if (e instanceof RangeError) return json({ error: e.message }, 400);
    if (e instanceof RowNotReserved) return json({ error: "That row is not unresolved any more. Reload the page." }, 409);
    app.log?.(`reconcile failed: ${(e as Error).name}`);
    return json({ error: "Reconcile failed inside the app. Nothing was changed." }, 500);
  }
}
