// Argus L1 on f63676e: one server per data directory. A second server on the same directory would run the startup
// sweep (markInterrupted) over the first one's in-flight rows, so it must refuse to start instead.
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

export const LOCK_FILE = "rsr.lock";

export class DataDirLocked extends Error {
  readonly pid: number;
  constructor(dir: string, pid: number) {
    super(`Another Red Social Room server (pid ${pid}) is already using the data directory ${dir}. Stop it first, or set RSR_DATA_DIR to a different directory. If no such server is running, delete ${join(dir, LOCK_FILE)}.`);
    this.name = "DataDirLocked";
    this.pid = pid;
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

function holderPid(path: string): number | null {
  try {
    const n = Number(readFileSync(path, "utf8").trim());
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  } catch { return null; }
}

const held = new Set<string>();

/**
 * Take `<dir>/rsr.lock` (created with O_EXCL, holding this pid). A lock whose pid is this process is ours already;
 * a lock whose pid is dead, or that holds no pid, is stale and is replaced. A lock held by a live process throws
 * DataDirLocked. The lock is removed when this process exits.
 */
export function acquireDataDirLock(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, LOCK_FILE);
  for (let tries = 0; tries < 2; tries++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try { writeSync(fd, `${process.pid}\n`); } finally { closeSync(fd); }
      if (!held.has(path)) { held.add(path); process.once("exit", () => releaseDataDirLock(path)); }
      return path;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const pid = holderPid(path);
    if (pid === process.pid) { held.add(path); return path; }
    if (pid !== null && alive(pid)) throw new DataDirLocked(dir, pid);
    try { unlinkSync(path); } catch { /* another starter removed it first; retry the exclusive create */ }
  }
  const pid = holderPid(path);
  throw new DataDirLocked(dir, pid ?? 0);
}

/** Remove the lock if this process still holds it. */
export function releaseDataDirLock(path: string): void {
  if (holderPid(path) === process.pid) { try { unlinkSync(path); } catch { /* already gone */ } }
  held.delete(path);
}
