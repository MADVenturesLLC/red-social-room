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
//
// A1 pin 19 (d), line 370 (Amendment 1 at 9a890fb): a data directory that is not writable at startup means the lock
// cannot be taken, and the server refuses to start with a message that says so (DataDirNotWritable), never that
// another server holds the lock (DataDirLocked is only for a busy lock). Observed on this box (uid 1000, chmod):
// directory 0555 and no rsr.lock: "unable to open database file" (SQLITE_CANTOPEN); directory 0555 with rsr.lock
// 0644: "attempt to write a readonly database" (SQLITE_READONLY_DIRECTORY, no room for the journal). A read-only
// rsr.lock (0444) opens read-only and BEGIN EXCLUSIVE then "succeeds" in every process at once without locking
// anything (Argus L3 on 0e2f1f4), so the lock also makes a real write inside its transaction (PRAGMA user_version):
// a connection that cannot write fails there with SQLITE_READONLY, which is "not writable" too. The messages name
// the directory and the file, never SQLite's own text (the SQLite error stays on the error's `cause`).
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

export class DataDirNotWritable extends Error {
  constructor(dir: string, what: string, cause?: unknown) {
    super(`The data directory is not writable: ${dir} (${what}). Make it writable for the user running Red Social Room, or set RSR_DATA_DIR to a writable directory.`, { cause });
    this.name = "DataDirNotWritable";
  }
}

/** Any other failure to take the lock. The server refuses to start on this too: the lock is never skipped. */
export class DataDirLockFailed extends Error {
  constructor(dir: string, reason: string, cause?: unknown) {
    super(`Could not take the one-server lock on the data directory ${dir} (${reason}).`, { cause });
    this.name = "DataDirLockFailed";
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

/** No write access: SQLITE_CANTOPEN or SQLITE_READONLY (any extended code), or a file-system permission error. */
export function isNotWritable(e: unknown): boolean {
  const { errcode, code } = e as { errcode?: number; code?: string };
  if (typeof errcode === "number" && ((errcode & 0xff) === 14 || (errcode & 0xff) === 8)) return true;
  return code === "EACCES" || code === "EPERM" || code === "EROFS";
}

/** A short reason without SQLite's own text: the file-system code, or the SQLite result code number. */
function why(e: unknown): string {
  const { code, errcode } = e as { code?: string; errcode?: number };
  if (code && code !== "ERR_SQLITE_ERROR") return code;
  return typeof errcode === "number" ? `SQLite result code ${errcode}` : "unknown error";
}

function lockFailure(dir: string, path: string, e: unknown): Error {
  if (isNotWritable(e)) {
    const code = (e as { code?: string }).code;
    return new DataDirNotWritable(dir, `cannot create or write ${path}${code && code !== "ERR_SQLITE_ERROR" ? `, ${code}` : ""}`, e);
  }
  return new DataDirLockFailed(dir, why(e), e);
}

/**
 * Take the data-directory lock, or throw DataDirLocked if another process holds it. Taking it again in the same
 * process returns the same lock. Released by releaseDataDirLock() or, at the latest, when the process ends.
 */
export function acquireDataDirLock(dir: string): string {
  const path = join(dir, LOCK_FILE);
  if (held.has(path)) return path;
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (e) { throw lockFailure(dir, dir, e); }
  const pidPath = join(dir, LOCK_PID_FILE);
  // The busy wait rides out the brief shared locks of other starters racing for the same file; a real holder keeps
  // the lock for good, so after LOCK_WAIT_MS the attempt fails as busy. No PRAGMA locking_mode = EXCLUSIVE: in that
  // mode a starter that lost keeps its shared lock until it exits and no one wins (seen in the 8-starter test).
  let db: DatabaseSync;
  try { db = new DatabaseSync(path, { timeout: LOCK_WAIT_MS }); } catch (e) { throw lockFailure(dir, path, e); }
  try {
    db.exec("BEGIN EXCLUSIVE"); // rollback-journal file (never WAL), so this blocks every other connection
    // Proves the connection can write (see the header): a read-only rsr.lock fails here instead of "locking".
    db.exec("PRAGMA user_version = 1");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* nothing open */ }
    db.close();
    if (isBusy(e)) throw new DataDirLocked(dir, holderPid(pidPath));
    throw lockFailure(dir, path, e);
  }
  held.set(path, { db, pidPath });
  // Informational pid file, replaced atomically (temp file + rename), so a reader never sees it empty.
  const tmp = `${pidPath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${process.pid}\n`, { mode: 0o600 });
    renameSync(tmp, pidPath);
  } catch (e) {
    releaseDataDirLock(path); // never left half-held when acquiring throws
    throw lockFailure(dir, pidPath, e);
  }
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
