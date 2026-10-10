// A7: "Back up now" — run the same job the nightly scheduler runs, on demand, and answer with the result.
import { getApp } from "../../../../server/app.ts";
import { runBackup } from "../../../../server/backup.ts";
import { loadR2Config } from "../../../../server/r2config.ts";
import { r2Store } from "../../../../server/r2.ts";
import { guardPost, json } from "../../../../server/route-util.ts";
import { notWritableResponse } from "../../../../server/writable.ts";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const bad = guardPost(req); if (bad) return bad;
  const app = getApp();
  const ro = notWritableResponse(app.dataDir); if (ro) return ro; // pin 19 (d)
  const cfg = loadR2Config(app.db, app.dataDir);
  const result = await runBackup({
    db: app.db, dataDir: app.dataDir, imagesDir: app.imagesDir,
    store: cfg ? r2Store(cfg) : null,
    log: app.log,
  });
  return json(result, result.ok ? 200 : 400);
}
