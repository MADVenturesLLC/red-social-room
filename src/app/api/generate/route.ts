import { getApp } from "../../../server/app.ts";
import { runGenerate } from "../../../server/generate.ts";
import { guardPost, json, readJson } from "../../../server/route-util.ts";

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
    app.log?.(`generate failed: ${(e as Error).name}: ${(e as Error).message}`);
    return json({ error: "Something went wrong inside the app. Nothing new was shown; check Settings → Spend before retrying." }, 500);
  }
}
