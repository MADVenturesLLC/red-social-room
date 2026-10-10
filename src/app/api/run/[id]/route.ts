// Read a run back: run row + one entry per job with its generation view (cost text from the ledger).
import { getApp } from "../../../../server/app.ts";
import { runView } from "../../../../server/runs.ts";
import { json } from "../../../../server/route-util.ts";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const app = getApp();
  const run = runView(app, id);
  if (!run) return json({ error: "Unknown run." }, 404);
  return json(run);
}
