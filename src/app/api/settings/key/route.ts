// Write-only: accepts a new key for the chosen provider (body.provider: "xai" default, or "google"),
// saves it server-side, runs the free key check, and answers with the key's status (source + last 4)
// only. The key is never echoed back.
import { getApp } from "../../../../server/app.ts";
import { KeyRejectedInput } from "../../../../server/keys.ts";
import { checkKey } from "../../../../server/xai/adapter.ts";
import { checkGoogleKey } from "../../../../server/google/adapter.ts";
import { checkOpenAiKey } from "../../../../server/openai/adapter.ts";
import { googleDepsOf, openaiDepsOf } from "../../../../server/execute.ts";
import { guardPost, json, readJson } from "../../../../server/route-util.ts";
import { actorFromRequest, ownerDenied } from "../../../../server/actor.ts";
import { notWritableResponse } from "../../../../server/writable.ts";
import { join } from "node:path";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const bad = guardPost(req); if (bad) return bad;
  const ownerOnly = ownerDenied(actorFromRequest(req)); if (ownerOnly) return ownerOnly; // B1: owner-only action
  const body = await readJson(req, 4096);
  if (!body) return json({ error: "Expected a JSON object." }, 400);
  const app = getApp();
  const ro = notWritableResponse(app.dataDir, [join(app.dataDir, "secrets")]); if (ro) return ro; // pin 19 (d) gap 2
  const rawProv = (body as Record<string, unknown>).provider;
  const provider = rawProv === "google" ? "google" as const : rawProv === "openai" ? "openai" as const : "xai" as const;
  try {
    const oa = provider === "openai" ? openaiDepsOf(app) : null;
    const key = provider === "google" ? app.googleKeys.save(body.key) : provider === "openai" ? oa!.keys.save(body.key) : app.keys.save(body.key);
    const c = provider === "google"
      ? await checkGoogleKey(googleDepsOf(app), { force: true })
      : provider === "openai"
        ? await checkOpenAiKey(oa!, { force: true })
        : await checkKey(app, { force: true });
    return json({ key, check: { ok: c.ok, message: c.ok ? null : c.message } });
  } catch (e) {
    if (e instanceof KeyRejectedInput) return json({ error: e.message }, 400);
    app.log?.(`key save failed: ${(e as Error).name}`);
    return json({ error: "Saving the key failed inside the app. Nothing was changed." }, 500);
  }
}
