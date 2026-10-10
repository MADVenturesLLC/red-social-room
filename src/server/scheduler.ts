// A7: the in-process nightly scheduler (no cron on the box; the app itself runs the backup and the FTS
// check). One hourly tick, unreferenced so it never keeps the process alive; the first tick lands shortly
// after start so a box that was off at 3 AM catches up. Every decision is pure (shouldRunNightly / the
// maintenance_log date guard) so the tests pin the clock and assert outcomes.
import { isoNY } from "../../spike/lib/ledger.ts";
import type { DB } from "./db.ts";
import { runBackup, shouldRunNightly } from "./backup.ts";
import { checkFts } from "./fts.ts";
import { loadR2Config } from "./r2config.ts";
import { r2Store } from "./r2.ts";

export interface SchedulerDeps {
  db: DB;
  dataDir: string;
  imagesDir: string;
  log?: (m: string) => void;
}

export interface SchedulerHandle { stop: () => void; tick: (now?: Date) => Promise<void> }

/** Last FTS check date (NY) from maintenance_log, or null. */
function lastFtsDate(db: DB): string | null {
  const row = db.prepare("SELECT created_at FROM maintenance_log WHERE kind IN ('fts_check','fts_rebuild') ORDER BY id DESC LIMIT 1").get() as { created_at: string } | undefined;
  return row ? row.created_at.slice(0, 10) : null;
}

export async function schedulerTick(d: SchedulerDeps, now = new Date()): Promise<void> {
  const log = d.log ?? (() => undefined);
  // The search-index check runs once a day (cheap: two counts + an integrity walk).
  try {
    const nyDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    if (lastFtsDate(d.db) !== nyDate) {
      const r = checkFts(d.db);
      log(`fts check: posts ${r.posts}, indexed ${r.indexed}, integrity ${r.integrityOk}, rebuilt ${r.rebuilt}`);
    }
  } catch (e) { log(`fts check failed: ${(e as Error).message.slice(0, 160)}`); }

  // The backup runs at most once a day, at/after 3 AM New York.
  try {
    const lastAny = d.db.prepare("SELECT started_at FROM backups ORDER BY id DESC LIMIT 1").get() as { started_at: string } | undefined;
    if (!shouldRunNightly(now, lastAny?.started_at ?? null)) return;
    const cfg = loadR2Config(d.db, d.dataDir);
    if (!cfg) { log("backup due, but R2 is not set up yet — skipped"); return; }
    const r = await runBackup({ db: d.db, dataDir: d.dataDir, imagesDir: d.imagesDir, store: r2Store(cfg), log });
    log(r.ok ? `backup ok (${r.filesUploaded} new file(s))` : `backup failed: ${r.error}`);
  } catch (e) { log(`backup tick failed: ${(e as Error).message.slice(0, 160)}`); }
}

export function startScheduler(d: SchedulerDeps): SchedulerHandle {
  const timer = setInterval(() => { void schedulerTick(d); }, 60 * 60 * 1000);
  timer.unref?.();
  const first = setTimeout(() => { void schedulerTick(d); }, 30_000);
  first.unref?.();
  return { stop: () => { clearInterval(timer); clearTimeout(first); }, tick: (now?: Date) => schedulerTick(d, now) };
}

/** isoNY re-export, so callers need only one import for the log lines. */
export { isoNY };
