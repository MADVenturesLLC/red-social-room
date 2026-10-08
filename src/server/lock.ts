// Argus L1 on f63676e and L1 on 9b837ac; A1 pin 18 (b), line 369 (Amendment 1 at 5c773d7): one server per data
// directory on one host. A second server on the same directory would run the startup sweep (markInterrupted) over
// the first one's in-flight rows, so it must refuse to start instead.
//
// The lock is an exclusive SQLite transaction on <data>/rsr.lock, held open for the life of the process. The
// kernel drops it when the process exits for any reason (normal exit, crash, SIGKILL), so there is no stale-lock
// or PID logic and no take-over race: of any number of simultaneous starters exactly one gets it. <data>/rsr.lock.pid
// holds the holder's pid for the error message only; nothing decides on it.
//
// Never open or read rsr.lock in this process except through SQLite: closing any other file descriptor on it would
// drop this process's POSIX lock.
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const LOCK_FILE = "rsr.lock";
export const LOCK_PID_FILE = "rsr.lock.pid";
export const LOCK_WAIT_MS = 1000;

export class DataDirLocked extends Error {
  readonly pid: number | null;
  constructor(dir: string, pid: number | null) {
    super(`Another Red Social Room server (pid ${pid ?? "unknown"}) is already using the data directory ${dir}. Stop it first, or set RSR_DATA_DIR to a different directory.`);
    this.name = "DataDirLocked";
    this.pid = pid;
  }
}

/** Open lock connections of this process, by lock path. Kept referenced so they are never garbage-collected. */
const held = new Map<string, { db: DatabaseSync; pidPath: string }>();

function holderPid(pidPath: string): number | null {
  try {
    const n = Number(readFileSync(pidPath, "utf8").trim());
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  } catch { return null; }
}

function isBusy(e: unknown): boolean {
  const code = (e as { errcode?: number }).errcode;
  return code === 5 || code === 6; // SQLITE_BUSY, SQLITE_LOCKED
}

/**
 * Take the data-directory lock, or throw DataDirLocked if another process holds it. Taking it again in the same
 * process returns the same lock. Released by releaseDataDirLock() or, at the latest, when the process ends.
 */
export function acquireDataDirLock(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, LOCK_FILE);
  if (held.has(path)) return path;
  const pidPath = join(dir, LOCK_PID_FILE);
  // The busy wait rides out the brief shared locks of other starters racing for the same file; a real holder keeps
  // the lock for good, so after LOCK_WAIT_MS the attempt fails as busy. No PRAGMA locking_mode = EXCLUSIVE: in that
  // mode a starter that lost keeps its shared lock until it exits and no one wins (seen in the 8-starter test).
  const db = new DatabaseSync(path, { timeout: LOCK_WAIT_MS });
  try {
    db.exec("BEGIN EXCLUSIVE"); // rollback-journal file (never WAL), so this blocks every other connection
  } catch (e) {
    db.close();
    if (isBusy(e)) throw new DataDirLocked(dir, holderPid(pidPath));
    throw e;
  }
  held.set(path, { db, pidPath });
  // Informational pid file, replaced atomically (temp file + rename), so a reader never sees it empty.
  const tmp = `${pidPath}.${process.pid}.tmp`;
  writeFileSync(tmp, `${process.pid}\n`, { mode: 0o600 });
  renameSync(tmp, pidPath);
  if (held.size === 1) process.once("exit", releaseAllDataDirLocks);
  return path;
}

/** Release a lock this process holds (removing its pid file first, while still holding it). Not held: no-op. */
export function releaseDataDirLock(path: string): void {
  const h = held.get(path);
  if (!h) return;
  held.delete(path);
  if (holderPid(h.pidPath) === process.pid) { try { unlinkSync(h.pidPath); } catch { /* already gone */ } }
  try { h.db.exec("ROLLBACK"); } catch { /* nothing open */ }
  h.db.close();
}

function releaseAllDataDirLocks(): void {
  for (const path of [...held.keys()]) releaseDataDirLock(path);
}
