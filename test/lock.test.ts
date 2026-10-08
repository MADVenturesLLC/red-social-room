// One server per data directory (Argus L1 on f63676e and on 9b837ac; A1 pin 18 (b), line 369, Amendment 1 at
// 5c773d7: "a startup lock that the operating system releases when the server process exits"). A second server must
// refuse to start and must not run the startup sweep over the first one's in-flight rows.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/server/db.ts";
import { reserve } from "../src/server/ledger.ts";
import { acquireDataDirLock, releaseDataDirLock, DataDirLocked, LOCK_FILE, LOCK_PID_FILE } from "../src/server/lock.ts";
import { getApp, startApp } from "../src/server/app.ts";
import { REPO_ROOT } from "../src/server/config.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "rsr-lock-"));
const LOCK_TS = pathToFileURL(join(REPO_ROOT, "src", "server", "lock.ts")).href;
const APP_TS = pathToFileURL(join(REPO_ROOT, "src", "server", "app.ts")).href;
const childEnv = (dir: string, extra: Record<string, string> = {}) => ({ PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp", RSR_DATA_DIR: dir, ...extra });
const NODE_ARGS = ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e"];

// A starter: waits for START_AT (so all starters race), tries the lock, prints WIN/LOSE; a winner holds until killed.
const STARTER = `import { acquireDataDirLock, DataDirLocked } from ${JSON.stringify(LOCK_TS)};
const at = Number(process.env.START_AT ?? 0); while (Date.now() < at) { /* spin to line the starters up */ }
try { acquireDataDirLock(process.env.RSR_DATA_DIR); console.log("WIN " + process.pid); setInterval(() => {}, 1000); }
catch (e) { if (e instanceof DataDirLocked) { console.log("LOSE " + e.pid); process.exit(2); } console.log("ERR " + e.message); process.exit(3); }`;

// Every child this file starts is killed after each test, pass or fail, so a failed assertion never leaves a
// lock holder running (which would keep the test process alive).
const children = new Set<ChildProcess>();
afterEach(() => { for (const c of children) { if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL"); } children.clear(); });

function starter(dir: string, startAt = 0): { child: ChildProcess; line: Promise<string>; exited: Promise<number | null> } {
  const child = spawn(process.execPath, [...NODE_ARGS, STARTER], { env: childEnv(dir, { START_AT: String(startAt) }), stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let out = "";
  const line = new Promise<string>((res) => {
    child.stdout!.on("data", (c) => { out += c; if (out.includes("\n")) res(out.trim()); });
    child.on("exit", () => res(out.trim()));
  });
  child.stderr!.on("data", (c) => { out += c; });
  const exited = new Promise<number | null>((res) => child.on("exit", (code) => res(code)));
  return { child, line, exited };
}
async function kill(h: { child: ChildProcess; exited: Promise<number | null> }, signal: NodeJS.Signals = "SIGKILL") { h.child.kill(signal); await h.exited; }

test("lock: taking it in this process holds it and writes this pid; taking it again is the same lock; release frees it and removes the pid file", () => {
  const dir = tmp();
  try {
    const p = acquireDataDirLock(dir);
    assert.equal(p, join(dir, LOCK_FILE));
    assert.equal(readFileSync(join(dir, LOCK_PID_FILE), "utf8").trim(), String(process.pid));
    assert.equal(acquireDataDirLock(dir), p);
    // An exclusive lock from the start (BEGIN EXCLUSIVE): another connection cannot even read rsr.lock while it is held.
    const other = new DatabaseSync(p, { timeout: 0 });
    try { assert.throws(() => other.prepare("SELECT COUNT(*) FROM sqlite_master").get(), (e: unknown) => (e as { errcode?: number }).errcode === 5); } finally { other.close(); }
    releaseDataDirLock(p);
    assert.equal(existsSync(join(dir, LOCK_PID_FILE)), false);
    releaseDataDirLock(p); // not held any more: no-op
    acquireDataDirLock(dir);
    releaseDataDirLock(p);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("lock: while another process holds it, taking it fails with DataDirLocked naming that pid; once that process is SIGKILLed (no cleanup at all) it can be taken at once", async () => {
  const dir = tmp();
  try {
    const h = starter(dir);
    const line = await h.line;
    assert.match(line, /^WIN \d+$/);
    assert.throws(() => acquireDataDirLock(dir), (e: unknown) => e instanceof DataDirLocked && e.pid === h.child.pid
      && e.message === `Another Red Social Room server (pid ${h.child.pid}) is already using the data directory ${dir}. Stop it first, or set RSR_DATA_DIR to a different directory.`);
    await kill(h, "SIGKILL");
    assert.equal(readFileSync(join(dir, LOCK_PID_FILE), "utf8").trim(), String(h.child.pid), "a killed holder leaves its pid file behind");
    const p = acquireDataDirLock(dir); // the OS dropped the dead process's lock; the leftover pid file decides nothing
    assert.equal(readFileSync(join(dir, LOCK_PID_FILE), "utf8").trim(), String(process.pid));
    releaseDataDirLock(p);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("lock: releasing a lock this process does not hold changes nothing - the holder keeps the lock and its pid file", async () => {
  const dir = tmp();
  try {
    const h = starter(dir);
    assert.match(await h.line, /^WIN /);
    releaseDataDirLock(join(dir, LOCK_FILE));
    assert.equal(readFileSync(join(dir, LOCK_PID_FILE), "utf8").trim(), String(h.child.pid));
    assert.throws(() => acquireDataDirLock(dir), DataDirLocked);
    await kill(h);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("lock: a holder that exits normally removes its pid file; the next starter wins", async () => {
  const dir = tmp();
  try {
    const r = spawnSync(process.execPath, [...NODE_ARGS, `import { acquireDataDirLock } from ${JSON.stringify(LOCK_TS)}; acquireDataDirLock(process.env.RSR_DATA_DIR); console.log("held");`], { env: childEnv(dir), encoding: "utf8", timeout: 20000, killSignal: "SIGKILL" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /held/);
    assert.equal(existsSync(join(dir, LOCK_PID_FILE)), false);
    const p = acquireDataDirLock(dir);
    releaseDataDirLock(p);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Argus L1 on 9b837ac: 8 starters at once, 6 rounds (fresh directory, then each round after the last winner was SIGKILLed or SIGTERMed) - exactly one winner every round, the others refused, and the lock is never empty or corrupt", async () => {
  const dir = tmp();
  try {
    for (let round = 0; round < 6; round++) {
      const startAt = Date.now() + 700;
      const hs = Array.from({ length: 8 }, () => starter(dir, startAt));
      const lines = await Promise.all(hs.map((h) => h.line));
      const winners = hs.filter((_, i) => lines[i].startsWith("WIN "));
      assert.equal(winners.length, 1, `round ${round}: ${JSON.stringify(lines)}`);
      const losers = hs.filter((_, i) => lines[i].startsWith("LOSE "));
      assert.equal(losers.length, 7, `round ${round}: ${JSON.stringify(lines)}`);
      for (const l of losers) assert.equal(await l.exited, 2);
      const w = winners[0];
      assert.equal(readFileSync(join(dir, LOCK_PID_FILE), "utf8").trim(), String(w.child.pid), `round ${round}: pid file names the winner`);
      assert.throws(() => acquireDataDirLock(dir), DataDirLocked);
      await kill(w, round % 2 === 0 ? "SIGKILL" : "SIGTERM");
      assert.match(readFileSync(join(dir, LOCK_PID_FILE), "utf8"), /^\d+\n$/, `round ${round}: pid file is never empty or partial`);
      const check = new DatabaseSync(join(dir, LOCK_FILE), { readOnly: true });
      try { assert.equal((check.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check, "ok"); } finally { check.close(); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Argus L1: getApp() on a data directory another live server holds refuses (DataDirLocked) and does not sweep its reserved row; startApp() exits 1 with the error", async () => {
  const dir = tmp();
  const g = globalThis as typeof globalThis & { __rsrApp?: unknown };
  const saved = process.env.RSR_DATA_DIR;
  const h = starter(dir);
  try {
    assert.match(await h.line, /^WIN /);
    const db = openDb(join(dir, "db", "rsr.sqlite"));
    const r = reserve(db, { provider: "xai", model: "grok-imagine-image-2.0", kind: "generate", resolution: "1k", quality: "low", generationId: "00000000-0000-4000-8000-000000000000", attempt: 1, estimateMicros: 40000, estimateSource: "test" });
    db.close();
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
    assert.equal(errs.join("\n"), `[rsr] refusing to start: Another Red Social Room server (pid ${h.child.pid}) is already using the data directory ${dir}. Stop it first, or set RSR_DATA_DIR to a different directory.`);
    const check = openDb(join(dir, "db", "rsr.sqlite"));
    try {
      assert.equal((check.prepare("SELECT status FROM spend_ledger WHERE id = ?").get(r.id) as { status: string }).status, "reserved", "not swept");
    } finally { check.close(); }
  } finally {
    await kill(h);
    if (saved === undefined) delete process.env.RSR_DATA_DIR; else process.env.RSR_DATA_DIR = saved;
    delete g.__rsrApp;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Argus L1: two real app processes on one data directory - the second exits 1 with the error; right after the first is SIGKILLed, a new one starts", async () => {
  const dir = tmp();
  try {
    const first = spawn(process.execPath, [...NODE_ARGS, `import { startApp } from ${JSON.stringify(APP_TS)}; startApp(); console.log("up"); setInterval(() => {}, 1000);`], { env: childEnv(dir), stdio: ["ignore", "pipe", "pipe"] });
    children.add(first);
    let out1 = "";
    await new Promise<void>((res, rej) => {
      first.stdout!.on("data", (c) => { out1 += c; if (out1.includes("up")) res(); });
      first.stderr!.on("data", (c) => { out1 += c; });
      first.on("exit", () => rej(new Error(`first exited early:\n${out1}`)));
    });
    const second = spawnSync(process.execPath, [...NODE_ARGS, `import { startApp } from ${JSON.stringify(APP_TS)}; startApp(); console.log("second up");`], { env: childEnv(dir), encoding: "utf8", timeout: 20000, killSignal: "SIGKILL" });
    assert.equal(second.status, 1, second.stdout + second.stderr);
    assert.doesNotMatch(second.stdout, /second up/);
    assert.match(second.stderr, new RegExp(`refusing to start: Another Red Social Room server \\(pid ${first.pid}\\) is already using the data directory`));
    if (first.exitCode === null && first.signalCode === null) { // an exited child never emits "exit" again
      const gone = new Promise((r) => first.on("exit", r));
      first.kill("SIGKILL");
      await gone;
    }
    const third = spawnSync(process.execPath, [...NODE_ARGS, `import { startApp } from ${JSON.stringify(APP_TS)}; startApp(); console.log("third up");`], { env: childEnv(dir), encoding: "utf8", timeout: 20000, killSignal: "SIGKILL" });
    assert.equal(third.status, 0, third.stderr);
    assert.match(third.stdout, /third up/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
