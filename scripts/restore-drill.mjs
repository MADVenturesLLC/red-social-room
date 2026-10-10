#!/usr/bin/env node
// A7 restore drill (the plan's acceptance: "a restore from backup onto a clean folder brings the library
// back"). Live mode reads the app's own data directory for the R2 target (mode 600 secrets), pulls the
// newest backup into a clean folder, verifies every content-addressed file and the database, and prints
// a report. `--from-dir <dir>` restores from a local copy of the backup tree instead (used by the tests
// and for offline drills). Exit code 0 = the library came back; 1 = something did not.
//
//   node scripts/restore-drill.mjs                          # from R2 (reads data/ for the target)
//   node scripts/restore-drill.mjs --from-dir ~/somewhere   # from a local backup tree
//   node scripts/restore-drill.mjs --target /tmp/drill      # where to put the restored copy
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { restoreFrom, dirObjectStore, countRestoredFiles } from "../src/server/restore.ts";
import { loadR2Config } from "../src/server/r2config.ts";
import { r2Store } from "../src/server/r2.ts";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

const fromDir = arg("--from-dir");
const target = arg("--target") ?? join("/tmp", `rsr-restore-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const dataDir = resolve(process.env.RSR_DATA_DIR ?? "data");

let store, label;
if (fromDir) {
  store = dirObjectStore(resolve(fromDir));
  label = `local tree ${resolve(fromDir)}`;
} else {
  const dbPath = join(dataDir, "db", "rsr.sqlite");
  if (!existsSync(dbPath)) { console.error(`No database at ${dbPath} — run this on the box, or pass --from-dir.`); process.exit(1); }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const cfg = loadR2Config(db, dataDir);
  db.close();
  if (!cfg) { console.error("R2 is not set up in this data directory (Settings → Backup). Nothing to drill."); process.exit(1); }
  store = r2Store(cfg);
  label = `R2 bucket ${cfg.bucket}`;
}

console.log(`Restore drill: ${label}`);
console.log(`Target: ${target}`);
const report = await restoreFrom(store, target);
for (const p of report.problems) console.log(`  PROBLEM: ${p}`);
console.log(`  database sha256 matches manifest: ${report.dbSha256Ok ? "yes" : "NO"}`);
console.log(`  files: ${report.filesDownloaded} downloaded, ${report.filesVerified} verified byte-for-byte, ${report.filesMissingInBackup} missing`);
console.log(`  restored library: ${report.posts ?? "?"} posts, ${report.assets ?? "?"} assets on record, ${countRestoredFiles(target)} image files on disk`);
console.log(`  counts match the manifest: ${report.countsMatch === null ? "no manifest counts" : report.countsMatch ? "yes" : "NO"}`);
console.log(report.ok ? "RESTORE DRILL: PASS — the library came back." : "RESTORE DRILL: FAIL");
process.exit(report.ok ? 0 : 1);
