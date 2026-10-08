// A1 pin 19 (d), line 370 (Amendment 1 at 9a890fb): if the data directory or the database stops being writable after
// the server has started (and holds the pin 18(b) lock), the server keeps running, a paid POST answers 500 saying in
// plain words that the data directory is not writable, and no provider call is made.
//
// Write access cannot be learned from the open database: a connection opened while the file was writable keeps
// writing through its file descriptor after a chmod, and the image store would only fail after the provider had
// been paid. So before any paid call the app checks the directories and files it is about to write.
import { accessSync, constants, existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DataDirNotWritable, isNotWritable } from "./lock.ts";

export { DataDirNotWritable, isNotWritable };

/** The paid POST's 500 body when the data directory is not writable. */
export const NOT_WRITABLE_MESSAGE = "The data directory is not writable, so nothing was sent to the provider and nothing was charged. Make the data directory writable again, then retry.";

export const DB_RELPATH = join("db", "rsr.sqlite");

/** Throws DataDirNotWritable unless this process can create files in the data directory, db/ and images/, and
 *  write the database file and its WAL/SHM files. */
export function checkWritable(dataDir: string): void {
  for (const d of [dataDir, join(dataDir, "db"), join(dataDir, "images")]) {
    const probe = join(d, `.rsr-write-check.${process.pid}.${randomBytes(4).toString("hex")}`);
    try {
      mkdirSync(d, { recursive: true });
      writeFileSync(probe, "", { flag: "wx", mode: 0o600 });
      unlinkSync(probe);
    } catch (e) {
      throw new DataDirNotWritable(dataDir, `cannot create files in ${d}, ${(e as NodeJS.ErrnoException).code ?? "error"}`, e);
    }
  }
  for (const f of ["", "-wal", "-shm"].map((x) => join(dataDir, DB_RELPATH) + x)) {
    if (!existsSync(f)) continue;
    try { accessSync(f, constants.W_OK); } catch (e) {
      throw new DataDirNotWritable(dataDir, `cannot write ${f}, ${(e as NodeJS.ErrnoException).code ?? "error"}`, e);
    }
  }
}
