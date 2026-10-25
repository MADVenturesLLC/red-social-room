// A3: start an edit (or "use as reference") run - one job per chosen model (two = compare edit), through
// the same queue, concurrency and SSE stream as /api/run. Answers 200 with the run snapshot.
import { getApp } from "../../../server/app.ts";
import { runView, startEditRun, RunInputError } from "../../../server/runs.ts";
import { actorFromRequest, spendDenied } from "../../../server/actor.ts";
import { guardPost, json, readJson } from "../../../server/route-util.ts";
import { notWritableResponse, DataDirNotWritable, NOT_WRITABLE_MESSAGE } from "../../../server/writable.ts";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const bad = guardPost(req); if (bad) return bad;
  const viewOnly = spendDenied(actorFromRequest(req)); if (viewOnly) return viewOnly; // B1: view-only accounts make no paid call
  const body = await readJson(req, 512 * 1024);
  if (!body) return json({ error: "Expected a JSON object." }, 400);
  const app = getApp();
  const ro = notWritableResponse(app.dataDir); if (ro) return ro; // pin 19 (d)
  try {
    const { runId, blocked, message, label, mode } = startEditRun(app, body);
    return json({ runId, blocked, message, label, mode, run: runView(app, runId) });
  } catch (e) {
    if (e instanceof RunInputError) return json({ error: e.message }, 400);
    if (e instanceof DataDirNotWritable) return json({ error: NOT_WRITABLE_MESSAGE }, 500);
    app.log?.(`edit run start failed: ${(e as Error).name}`);
    return json({ error: "The edit could not start inside the app." }, 500);
  }
}
