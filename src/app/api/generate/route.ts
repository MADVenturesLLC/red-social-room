import { getApp } from "../../../server/app.ts";
import { runGenerate } from "../../../server/generate.ts";
import { guardPost, json, readJson } from "../../../server/route-util.ts";
import { DataDirNotWritable, isNotWritable, NOT_WRITABLE_MESSAGE } from "../../../server/writable.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request): Promise<Response> {
  const bad = guardPost(req); if (bad) return bad;
  const body = await readJson(req);
  if (!body) return json({ error: "Expected a JSON object." }, 400);
  const app = getApp();
  try {
    return json(await runGenerate(app, { prompt: body.prompt, ratio: body.ratio }));
  } catch (e) {
    // A1 pin 19 (d), line 370: the data directory or database is no longer writable; nothing was sent. Logged
    // without SQLite's own text.
    if (e instanceof DataDirNotWritable || isNotWritable(e)) {
      app.log?.(`generate refused: ${e instanceof DataDirNotWritable ? e.message : "the database is not writable"}`);
      return json({ error: NOT_WRITABLE_MESSAGE, code: "data_dir_not_writable" }, 500);
    }
    app.log?.(`generate failed: ${(e as Error).name}: ${(e as Error).message}`);
    return json({ error: "Something went wrong inside the app. Nothing new was shown; check Settings → Spend before retrying." }, 500);
  }
}
