// A7 (FD:6): save the R2 backup target. The access key id and secret are write-only, like the provider
// keys: they are stored as mode 600 files and the answer shows only the last 4 of the key id.
import { getApp } from "../../../../server/app.ts";
import { clearR2Config, R2ConfigError, saveR2Config, r2Status } from "../../../../server/r2config.ts";
import { guardPost, json, readJson } from "../../../../server/route-util.ts";
import { notWritableResponse } from "../../../../server/writable.ts";
import { join } from "node:path";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const app = getApp();
  return json({ r2: r2Status(app.db, app.dataDir) });
}

export async function POST(req: Request): Promise<Response> {
  const bad = guardPost(req); if (bad) return bad;
  const body = await readJson(req);
  if (!body) return json({ error: "Expected a JSON object." }, 400);
  const app = getApp();
  const ro = notWritableResponse(app.dataDir, [join(app.dataDir, "secrets")]); if (ro) return ro; // pin 19 (d) gap 2
  const b = body as Record<string, unknown>;
  try {
    if (b.clear === true) { clearR2Config(app.db, app.dataDir); return json({ r2: r2Status(app.db, app.dataDir) }); }
    return json({ r2: saveR2Config(app.db, app.dataDir, b) });
  } catch (e) {
    if (e instanceof R2ConfigError) return json({ error: e.message }, 400);
    return json({ error: "Saving the backup target failed inside the app." }, 500);
  }
}
