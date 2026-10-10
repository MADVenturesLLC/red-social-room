// A7 (F23): what Settings and the e2e checks read — the last backup outcome, the 48-hour banner state,
// recent attempts, and whether R2 is configured (endpoint and bucket only; never a secret).
import { getApp } from "../../../../server/app.ts";
import { backupSummary } from "../../../../server/backup.ts";
import { r2Status } from "../../../../server/r2config.ts";
import { json } from "../../../../server/route-util.ts";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const app = getApp();
  const summary = backupSummary(app.db, new Date());
  const rows = app.db.prepare("SELECT id, started_at, finished_at, ok, error, files_uploaded, bytes_uploaded, db_bytes FROM backups ORDER BY id DESC LIMIT 10").all();
  return json({ r2: r2Status(app.db, app.dataDir), summary, rows });
}
