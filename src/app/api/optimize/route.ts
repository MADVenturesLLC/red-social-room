// B2: Prompt optimization endpoint (TECH-PLAN-v1-AMENDMENT-1.md B2).
// Rewrites the typed prompt into an expanded image prompt using Gemini 3.1 Flash-Lite.
// Protected by host guard, writable check, real-person check, and monthly cap reservation.
import { getApp } from "../../../server/app.ts";
import { googleDepsOf } from "../../../server/execute.ts";
import { optimizePrompt, OptimizeInputError } from "../../../server/optimize.ts";
import { guardPost, json, readJson } from "../../../server/route-util.ts";
import { notWritableResponse } from "../../../server/writable.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request): Promise<Response> {
  const bad = guardPost(req); if (bad) return bad;
  const body = await readJson(req);
  if (!body) return json({ error: "Expected a JSON object." }, 400);
  const app = getApp();
  const ro = notWritableResponse(app.dataDir); if (ro) return ro; // A1 pin 19 (d)
  try {
    const rawPrompt = typeof body.prompt === "string" ? body.prompt : "";
    const out = await optimizePrompt(googleDepsOf(app), app.promptMethod, rawPrompt);
    return json(out);
  } catch (e) {
    if (e instanceof OptimizeInputError) return json({ error: e.message }, 400);
    app.log?.(`optimize failed: ${(e as Error).name}: ${(e as Error).message}`);
    return json({ error: "The optimization could not run inside the app." }, 500);
  }
}
