// Argus L1 on f63676e: one server per data directory. A second one must refuse to start and must not run the
// startup sweep over the first one's in-flight rows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openDb } from "../src/server/db.ts";
import { reserve } from "../src/server/ledger.ts";
import { acquireDataDirLock, releaseDataDirLock, DataDirLocked, LOCK_FILE } from "../src/server/lock.ts";
import { getApp, startApp } from "../src/server/app.ts";
import { REPO_ROOT } from "../src/server/config.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "rsr-lock-"));
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid as number;
const LOCK_TS = pathToFileURL(join(REPO_ROOT, "src", "server", "lock.ts")).href;
const APP_TS = pathToFileURL(join(REPO_ROOT, "src", "server", "app.ts")).href;
const childEnv = (dir: string) => ({ PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp", RSR_DATA_DIR: dir });

test("lock: taking it writes this pid with O_EXCL; taking it again in the same process is fine; release removes it", () => {
  const dir = tmp();
  try {
    const p = acquireDataDirLock(dir);
    assert.equal(p, join(dir, LOCK_FILE));
    assert.equal(readFileSync(p, "utf8").trim(), String(process.pid));
    assert.equal(acquireDataDirLock(dir), p);
    releaseDataDirLock(p);
    assert.equal(existsSync(p), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("lock: a lock held by another live process is refused with a clear error naming the pid and the directory", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, LOCK_FILE), `${process.ppid}\n`);
    assert.throws(() => acquireDataDirLock(dir), (e: unknown) => e instanceof DataDirLocked && e.pid === process.ppid
      && e.message.includes(`(pid ${process.ppid}) is already using the data directory ${dir}`));
    assert.equal(readFileSync(join(dir, LOCK_FILE), "utf8").trim(), String(process.ppid), "the other process's lock is left alone");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("lock: a stale lock (dead pid, or no pid at all) is replaced by this process", () => {
  const dir = tmp();
  try {
    for (const stale of [`${deadPid()}\n`, "", "not a pid"]) {
      writeFileSync(join(dir, LOCK_FILE), stale);
      acquireDataDirLock(dir);
      assert.equal(readFileSync(join(dir, LOCK_FILE), "utf8").trim(), String(process.pid), JSON.stringify(stale));
      releaseDataDirLock(join(dir, LOCK_FILE));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("lock: released when the process exits", () => {
  const dir = tmp();
  try {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", `import { acquireDataDirLock } from ${JSON.stringify(LOCK_TS)}; acquireDataDirLock(process.env.RSR_DATA_DIR); console.log("locked");`], { env: childEnv(dir), encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /locked/);
    assert.equal(existsSync(join(dir, LOCK_FILE)), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Argus L1: getApp() on a data directory another live server holds refuses (DataDirLocked) and does not sweep its reserved row", () => {
  const dir = tmp();
  const g = globalThis as typeof globalThis & { __rsrApp?: unknown };
  const saved = process.env.RSR_DATA_DIR;
  try {
    const db = openDb(join(dir, "db", "rsr.sqlite"));
    const r = reserve(db, { provider: "xai", model: "grok-imagine-image-2.0", kind: "generate", resolution: "1k", quality: "low", generationId: "00000000-0000-4000-8000-000000000000", attempt: 1, estimateMicros: 40000, estimateSource: "test" });
    db.close();
    writeFileSync(join(dir, LOCK_FILE), `${process.ppid}\n`);
    process.env.RSR_DATA_DIR = dir;
    delete g.__rsrApp;
    assert.throws(() => getApp(), DataDirLocked);
    assert.equal(g.__rsrApp, undefined);
    const exits: number[] = [];
    const errs: string[] = [];
    const orig = console.error;
    console.error = (m: unknown) => { errs.push(String(m)); };
    try { assert.equal(startApp((c) => exits.push(c)), null); } finally { console.error = orig; }
    assert.deepEqual(exits, [1]);
    assert.match(errs.join("\n"), /^\[rsr\] refusing to start: Another Red Social Room server \(pid \d+\) is already using the data directory /);
    const check = openDb(join(dir, "db", "rsr.sqlite"));
    try {
      assert.equal((check.prepare("SELECT status FROM spend_ledger WHERE id = ?").get(r.id) as { status: string }).status, "reserved", "not swept");
    } finally { check.close(); }
  } finally {
    if (saved === undefined) delete process.env.RSR_DATA_DIR; else process.env.RSR_DATA_DIR = saved;
    delete g.__rsrApp;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Argus L1: two real processes on one data directory - the second exits 1 with the error while the first holds the lock; after the first exits, a new one starts", async () => {
  const dir = tmp();
  try {
    const first = spawn(process.execPath, ["--input-type=module", "-e", `import { startApp } from ${JSON.stringify(APP_TS)}; startApp(); console.log("up"); setTimeout(() => {}, 60000);`], { env: childEnv(dir), stdio: ["ignore", "pipe", "pipe"] });
    let out1 = "";
    await new Promise<void>((res, rej) => {
      first.stdout!.on("data", (c) => { out1 += c; if (out1.includes("up")) res(); });
      first.stderr!.on("data", (c) => { out1 += c; });
      first.on("exit", () => rej(new Error(`first exited early:\n${out1}`)));
    });
    const second = spawnSync(process.execPath, ["--input-type=module", "-e", `import { startApp } from ${JSON.stringify(APP_TS)}; startApp(); console.log("second up");`], { env: childEnv(dir), encoding: "utf8" });
    assert.equal(second.status, 1, second.stdout + second.stderr);
    assert.doesNotMatch(second.stdout, /second up/);
    assert.match(second.stderr, new RegExp(`refusing to start: Another Red Social Room server \\(pid ${first.pid}\\) is already using the data directory`));
    const gone = new Promise((r) => first.on("exit", r));
    first.kill("SIGTERM");
    await gone;
    const third = spawnSync(process.execPath, ["--input-type=module", "-e", `import { startApp } from ${JSON.stringify(APP_TS)}; startApp(); console.log("third up");`], { env: childEnv(dir), encoding: "utf8" });
    assert.equal(third.status, 0, third.stderr);
    assert.match(third.stdout, /third up/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
