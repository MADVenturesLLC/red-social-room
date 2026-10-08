// A1 pin 19 (d), line 370 (Amendment 1 at 9a890fb): if the data directory or the database stops being writable after
// the server has started (and holds the pin 18(b) lock), the server keeps running, a paid POST answers 500 saying in
// plain words that the data directory is not writable, and no provider call is made.
//
// Write access cannot be learned from the open database: a connection opened while the file was writable keeps
// writing through its file descriptor after a chmod, and the image store would only fail after the provider had
// been paid. So before any paid call the app checks the directories and files it is about to write.
import { accessSync, constants, existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DataDirNotWritable, isNotWritable } from "./lock.ts";
import { json } from "./route-util.ts";

export { DataDirNotWritable, isNotWritable };

/** The paid POST's 500 body when the data directory is not writable. */
export const NOT_WRITABLE_MESSAGE = "The data directory is not writable, so nothing was sent to the provider and nothing was charged. Make the data directory writable again, then retry.";

/** Key save, cap save and library save: their 500 body when the data directory is not writable (Surface ruling on
 *  gap 2, Oct 8 ~3:37 AM ET: optional in A1, done because it is the same check). */
export const NOT_WRITABLE_SAVE_MESSAGE = "The data directory is not writable, so nothing was saved. Make the data directory writable again, then retry.";

export const DB_RELPATH = join("db", "rsr.sqlite");
export const SHARD_RE = /^[0-9a-f]{2}$/;

/**
 * Argus L1 on 3bbbe97: the folder must also be readable. Creating and deleting a file needs only write and search
 * permission, but the stores open their folder for reading to fsync it after a save (store.ts and keys.ts openSync(dir, "r");
 * SQLite syncs its db/ folder the same way), so a 0333 folder passed the probe and the save failed after billing.
 * So read, write and search permission are checked first, then a real file is created and deleted.
 */
function probeDir(dataDir: string, d: string): void {
  try { accessSync(d, constants.R_OK | constants.W_OK | constants.X_OK); } catch (e) {
    throw new DataDirNotWritable(dataDir, `cannot read and write ${d}, ${(e as NodeJS.ErrnoException).code ?? "error"}`, e);
  }
  const probe = join(d, `.rsr-write-check.${process.pid}.${randomBytes(4).toString("hex")}`);
  try {
    writeFileSync(probe, "", { flag: "wx", mode: 0o600 });
    unlinkSync(probe);
  } catch (e) {
    throw new DataDirNotWritable(dataDir, `cannot create files in ${d}, ${(e as NodeJS.ErrnoException).code ?? "error"}`, e);
  }
}

/**
 * Gap 1 (Surface ruling "Close it in A1", Oct 8 ~3:37 AM ET): the image store saves into images/<xx>/, where <xx> is
 * the first two hex digits of the SHA-256 of the bytes the provider returns (store.ts relPathFor). That shard is only
 * known after the provider has answered (and the 4:5 crop has its own hash), so before the call every shard the
 * image could land in is probed: each existing images/<xx>/ folder gets a real create-and-delete probe, and a
 * shard that does not exist yet would be created inside images/, which checkWritable probes the same way. At most
 * 256 folders; nothing is created ahead of time.
 */
export function checkImageShards(dataDir: string, imagesDir: string): void {
  // An images/ that cannot be listed refuses (never skips the folder checks).
  let names: string[];
  try { names = readdirSync(imagesDir); } catch (e) {
    throw new DataDirNotWritable(dataDir, `cannot list ${imagesDir}, ${(e as NodeJS.ErrnoException).code ?? "error"}`, e);
  }
  for (const n of names) if (SHARD_RE.test(n)) probeDir(dataDir, join(imagesDir, n));
}

/** Throws DataDirNotWritable unless this process can create files in the data directory, db/, images/ and every
 *  existing images/<xx>/ shard, plus any existing `extraDirs` (secrets/ for key save), and write the database file
 *  and its WAL/SHM files. */
export function checkWritable(dataDir: string, extraDirs: readonly string[] = []): void {
  for (const d of [dataDir, join(dataDir, "db"), join(dataDir, "images")]) {
    try { mkdirSync(d, { recursive: true }); } catch (e) {
      throw new DataDirNotWritable(dataDir, `cannot create ${d}, ${(e as NodeJS.ErrnoException).code ?? "error"}`, e);
    }
    probeDir(dataDir, d);
  }
  checkImageShards(dataDir, join(dataDir, "images"));
  // Not created here: secrets/ must be made by the key store with mode 700; a missing one is made in the probed dataDir.
  for (const d of extraDirs) if (existsSync(d)) probeDir(dataDir, d);
  for (const f of ["", "-wal", "-shm"].map((x) => join(dataDir, DB_RELPATH) + x)) {
    if (!existsSync(f)) continue;
    try { accessSync(f, constants.W_OK); } catch (e) {
      throw new DataDirNotWritable(dataDir, `cannot write ${f}, ${(e as NodeJS.ErrnoException).code ?? "error"}`, e);
    }
  }
}

/** For the save routes: a 500 with NOT_WRITABLE_SAVE_MESSAGE if the data directory is not writable, else null. */
export function notWritableResponse(dataDir: string, extraDirs: readonly string[] = []): Response | null {
  try { checkWritable(dataDir, extraDirs); return null; } catch (e) {
    if (!(e instanceof DataDirNotWritable)) throw e;
    return json({ error: NOT_WRITABLE_SAVE_MESSAGE, code: "data_dir_not_writable" }, 500);
  }
}
