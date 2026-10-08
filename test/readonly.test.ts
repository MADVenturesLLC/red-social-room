// A1 pin 19 (d), line 370 (Amendment 1 at 9a890fb): a data directory that is not writable at startup means the lock
// cannot be taken and the server refuses to start, saying the directory is not writable (not that another server
// holds the lock). If the directory or database stops being writable after startup, a paid call makes no provider
// call and the paid POST answers 500 saying the data directory is not writable.
//
// Real read-only directories: chmod 0555 on directories and 0444 on files. These tests need a non-root user (root
// ignores the mode bits); they refuse to run as root rather than pass without really blocking writes.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { acquireDataDirLock, releaseDataDirLock, DataDirLocked, DataDirLockFailed, DataDirNotWritable, isNotWritable, LOCK_FILE, LOCK_PID_FILE } from "../src/server/lock.ts";
import { checkWritable, checkImageShards, NOT_WRITABLE_MESSAGE, NOT_WRITABLE_SAVE_MESSAGE } from "../src/server/writable.ts";
import { createHash } from "node:crypto";
import { monthTotals } from "../src/server/ledger.ts";
import { getApp, startApp } from "../src/server/app.ts";
import { runGenerate } from "../src/server/generate.ts";
import { REPO_ROOT } from "../src/server/config.ts";
import { makeApp, fakeXai, ledgerRows, sampleJpeg, DUMMY_KEY } from "./helpers.ts";

assert.notEqual(process.getuid?.(), 0, "read-only tests must not run as root: root ignores chmod 0555/0444, so nothing would really be blocked");

const tmp = () => mkdtempSync(join(tmpdir(), "rsr-ro-"));
const LOCK_TS = pathToFileURL(join(REPO_ROOT, "src", "server", "lock.ts")).href;
const NOT_WRITABLE_RE = /^The data directory is not writable: /;
// SQLite's own text must never be in the message (Argus L1 on 0e2f1f4); the SQLite error stays on `cause`.
const RAW_SQLITE_RE = /unable to open database file|attempt to write a readonly database|readonly database|SQLITE_|result code/i;
const causeCode = (e: unknown) => ((e as Error).cause as { errcode?: number } | undefined)?.errcode;

/** chmod a tree read-only (dirs 0555, files 0444); returns a function that puts every mode back. */
function makeReadOnly(root: string): () => void {
  const saved: Array<[string, number]> = [];
  const walk = (p: string) => {
    const st = statSync(p);
    saved.push([p, st.mode & 0o7777]);
    if (st.isDirectory()) { for (const n of readdirSync(p)) walk(join(p, n)); chmodSync(p, 0o555); } else chmodSync(p, 0o444);
  };
  walk(root);
  return () => { for (const [p, m] of saved.reverse()) chmodSync(p, m); };
}
function cleanup(dir: string) { try { chmodSync(dir, 0o700); } catch { /* gone */ } spawnRm(dir); }
function spawnRm(dir: string) {
  const fix = (p: string) => { try { const st = statSync(p); if (st.isDirectory()) { chmodSync(p, 0o700); for (const n of readdirSync(p)) fix(join(p, n)); } else chmodSync(p, 0o600); } catch { /* gone */ } };
  fix(dir); rmSync(dir, { recursive: true, force: true });
}
const notWritable = (e: unknown) => e instanceof DataDirNotWritable && NOT_WRITABLE_RE.test(e.message) && !RAW_SQLITE_RE.test(e.message) && !/Another Red Social Room server/.test(e.message) && !(e instanceof DataDirLocked);

const children = new Set<ChildProcess>();
afterEach(() => { for (const c of children) { if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL"); } children.clear(); });

// --- The lock on read-only directories: observed behaviour, now classified ---------------------------------------

test("A1 pin 19 (d): directory 0555 and no rsr.lock - SQLite 'unable to open database file'; the lock fails as DataDirNotWritable", () => {
  const dir = tmp();
  try {
    chmodSync(dir, 0o555);
    assert.throws(() => acquireDataDirLock(dir), (e: unknown) => notWritable(e) && causeCode(e) === 14 && (e as Error).message.includes(join(dir, LOCK_FILE)));
    assert.equal(existsSync(join(dir, LOCK_FILE)), false);
  } finally { cleanup(dir); }
});

for (const [label, fileMode] of [["0644", 0o644], ["0444", 0o444]] as const) {
  test(`A1 pin 19 (d): directory 0555 with an existing rsr.lock ${label} - 'attempt to write a readonly database'; DataDirNotWritable, never DataDirLocked`, () => {
    const dir = tmp();
    try {
      releaseDataDirLock(acquireDataDirLock(dir)); // a previous run left rsr.lock behind
      chmodSync(join(dir, LOCK_FILE), fileMode); chmodSync(dir, 0o555);
      assert.throws(() => acquireDataDirLock(dir), (e: unknown) => notWritable(e) && (causeCode(e)! & 0xff) === 8);
    } finally { cleanup(dir); }
  });
}

test("Argus L3 on 0e2f1f4 / A1 pin 19 (d): a read-only rsr.lock (0444) in a writable directory - raw SQLite gives every process an 'exclusive' lock; the lock now fails as not writable (SQLITE_READONLY) here and in 8 simultaneous starters: never more than one winner (here none)", async () => {
  const dir = tmp();
  try {
    releaseDataDirLock(acquireDataDirLock(dir));
    chmodSync(join(dir, LOCK_FILE), 0o444);
    const raw = [new DatabaseSync(join(dir, LOCK_FILE)), new DatabaseSync(join(dir, LOCK_FILE))];
    try { for (const db of raw) db.exec("BEGIN EXCLUSIVE"); } finally { for (const db of raw) { try { db.exec("ROLLBACK"); } catch { /* none */ } db.close(); } }
    // ^ the raw SQLite behaviour this guards against (seen at 0e2f1f4): both "exclusive" transactions began.
    assert.throws(() => acquireDataDirLock(dir), (e: unknown) => notWritable(e) && (causeCode(e)! & 0xff) === 8);
    const at = Date.now() + 1500;
    const script = `import { acquireDataDirLock } from ${JSON.stringify(LOCK_TS)};
const at = Number(process.env.AT); while (Date.now() < at) { /* line the starters up */ }
try { acquireDataDirLock(process.env.D); console.log("WIN"); setInterval(() => {}, 1000); } catch (e) { console.log(e.name); process.exit(2); }`;
    const runs = Array.from({ length: 8 }, () => {
      const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script],
        { env: { PATH: process.env.PATH ?? "", D: dir, AT: String(at) }, stdio: ["ignore", "pipe", "inherit"] });
      children.add(child);
      let out = "";
      return new Promise<string>((res) => { child.stdout!.on("data", (c) => { out += c; if (out.includes("\n")) res(out.trim()); }); child.on("exit", () => res(out.trim())); });
    });
    const lines = await Promise.all(runs);
    assert.ok(lines.filter((l) => l === "WIN").length <= 1, lines.join(","));
    assert.deepEqual(lines, Array(8).fill("DataDirNotWritable"));
  } finally { cleanup(dir); }
});

test("A1 pin 19 (d): a lock that cannot write its pid file is released, not left half-held, and fails as DataDirLockFailed", async () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, LOCK_PID_FILE)); writeFileSync(join(dir, LOCK_PID_FILE, "x"), ""); // rename onto a non-empty directory fails
    assert.throws(() => acquireDataDirLock(dir), (e: unknown) => e instanceof DataDirLockFailed);
    rmSync(join(dir, LOCK_PID_FILE), { recursive: true });
    // Free again for ANOTHER process: the failed attempt let go of the SQLite lock (asking in this process would
    // only find this process's own leftover lock).
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e",
      `import { acquireDataDirLock } from ${JSON.stringify(LOCK_TS)}; try { acquireDataDirLock(process.env.D); console.log("WIN"); } catch (e) { console.log(e.name); }`],
      { env: { PATH: process.env.PATH ?? "", D: dir }, stdio: ["ignore", "pipe", "inherit"] });
    children.add(child);
    let out = ""; child.stdout!.on("data", (c) => { out += c; });
    await new Promise((r) => child.on("exit", r));
    assert.equal(out.trim(), "WIN");
  } finally { cleanup(dir); }
});

test("A1 pin 19 (d): isNotWritable - SQLITE_CANTOPEN, SQLITE_READONLY and its extended codes, EACCES/EPERM/EROFS; not BUSY or other errors", () => {
  for (const errcode of [14, 8, 264, 520, 776, 1032, 1288, 1544]) assert.equal(isNotWritable({ errcode }), true, String(errcode));
  for (const code of ["EACCES", "EPERM", "EROFS"]) assert.equal(isNotWritable({ code }), true, code);
  for (const e of [{ errcode: 5 }, { errcode: 6 }, { errcode: 11 }, { errcode: 1 }, { code: "ENOSPC" }, { code: "ENOTEMPTY" }, {}]) assert.equal(isNotWritable(e), false, JSON.stringify(e));
});

// --- Startup on a read-only data directory: refuse to start, saying it is not writable ---------------------------

test("A1 pin 19 (d): startApp() on a read-only data directory exits 1 saying the directory is not writable, not that another server holds the lock", () => {
  const g = globalThis as typeof globalThis & { __rsrApp?: unknown };
  const saved = { data: process.env.RSR_DATA_DIR, xai: process.env.XAI_API_KEY, gem: process.env.GEMINI_API_KEY };
  const dir = tmp();
  const errs: string[] = []; const origErr = console.error; console.error = (m: unknown) => { errs.push(String(m)); };
  try {
    delete process.env.XAI_API_KEY; delete process.env.GEMINI_API_KEY; process.env.RSR_DATA_DIR = dir; delete g.__rsrApp;
    chmodSync(dir, 0o555);
    const codes: number[] = [];
    assert.equal(startApp((c) => codes.push(c)), null);
    assert.deepEqual(codes, [1]);
    assert.equal(errs.length, 1);
    assert.match(errs[0], /^\[rsr\] refusing to start: The data directory is not writable: /);
    assert.doesNotMatch(errs[0], RAW_SQLITE_RE);
    assert.doesNotMatch(errs[0], /Another Red Social Room server/);
    assert.equal(g.__rsrApp, undefined);
  } finally {
    console.error = origErr; delete g.__rsrApp;
    for (const [k, v] of [["RSR_DATA_DIR", saved.data], ["XAI_API_KEY", saved.xai], ["GEMINI_API_KEY", saved.gem]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    cleanup(dir);
  }
});

for (const sub of ["db", "images"]) {
  test(`A1 pin 19 (d): the lock is taken but ${sub}/ is read-only at startup - getApp() refuses with DataDirNotWritable (startApp exits 1)`, () => {
    const g = globalThis as typeof globalThis & { __rsrApp?: unknown };
    const saved = { data: process.env.RSR_DATA_DIR, xai: process.env.XAI_API_KEY, gem: process.env.GEMINI_API_KEY };
    const dir = tmp();
    try {
      delete process.env.XAI_API_KEY; delete process.env.GEMINI_API_KEY; process.env.RSR_DATA_DIR = dir; delete g.__rsrApp;
      mkdirSync(join(dir, sub)); chmodSync(join(dir, sub), 0o555);
      assert.throws(() => getApp(), notWritable);
      assert.equal(g.__rsrApp, undefined);
    } finally {
      releaseDataDirLock(join(dir, LOCK_FILE)); delete g.__rsrApp;
      for (const [k, v] of [["RSR_DATA_DIR", saved.data], ["XAI_API_KEY", saved.xai], ["GEMINI_API_KEY", saved.gem]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      cleanup(dir);
    }
  });
}

// --- After startup: the paid call checks write access first and makes no provider call -----------------------------

test("A1 pin 19 (d): checkWritable passes on a writable directory and names what is not writable: the directory, db/, images/, the database file, its WAL", () => {
  const t = makeApp({ fetch: fakeXai().fetch });
  try {
    t.app.db.exec("CREATE TABLE IF NOT EXISTS wal_probe (x); INSERT INTO wal_probe VALUES (1)"); // WAL/SHM files exist now
    checkWritable(t.dir);
    for (const [what, path, mode] of [["the directory", t.dir, 0o555], ["db/", join(t.dir, "db"), 0o555], ["images/", join(t.dir, "images"), 0o555],
      ["the database", join(t.dir, "db", "rsr.sqlite"), 0o444], ["the WAL", join(t.dir, "db", "rsr.sqlite-wal"), 0o444]] as const) {
      const before = statSync(path).mode & 0o7777;
      chmodSync(path, mode);
      try { assert.throws(() => checkWritable(t.dir), (e: unknown) => notWritable(e) && (e as Error).message.includes(path), what); }
      finally { chmodSync(path, before); }
      checkWritable(t.dir);
    }
    // The probe files are removed again (Argus W8 on 5ea231d): none left anywhere in the data directory.
    mkdirSync(join(t.dir, "images", "ab"), { recursive: true });
    checkWritable(t.dir);
    assert.deepEqual((readdirSync(t.dir, { recursive: true }) as string[]).filter((n) => n.includes(".rsr-write-check")), []);
  } finally { t.cleanup(); }
});

test("A1 pin 19 (d): data directory and database made read-only after the app opened them - the open connection could still write, but a paid call throws DataDirNotWritable before anything: zero provider calls, no ledger row, no run", async () => {
  const x = fakeXai();
  const t = makeApp({ fetch: x.fetch });
  const restore = makeReadOnly(t.dir);
  try {
    // Why the check cannot rely on the database: a connection opened while writable keeps writing after the chmod.
    t.app.db.prepare("INSERT INTO settings (key, value) VALUES ('ro_probe', '1')").run();
    t.app.db.prepare("DELETE FROM settings WHERE key = 'ro_probe'").run();
    const runsBefore = Number((t.app.db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n);
    const checksBefore = Number((t.app.db.prepare("SELECT COUNT(*) AS n FROM prompt_checks").get() as { n: number }).n);
    await assert.rejects(runGenerate(t.app, { prompt: "a lighthouse at dusk", ratio: "1:1" }), notWritable);
    assert.equal(Number((t.app.db.prepare("SELECT COUNT(*) AS n FROM prompt_checks").get() as { n: number }).n), checksBefore, "refused before the prompt check writes its row");
    assert.equal(x.requests.length, 0, "the fake provider recorded zero calls");
    assert.equal(ledgerRows(t.app).length, 0);
    assert.equal(Number((t.app.db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n), runsBefore);
  } finally { restore(); t.cleanup(); }
  // Writable again: the same call goes through.
  const x2 = fakeXai(); const t2 = makeApp({ fetch: x2.fetch });
  try { assert.equal((await runGenerate(t2.app, { prompt: "a lighthouse at dusk", ratio: "1:1" })).status, "ok"); assert.ok(x2.posts().length >= 1); } finally { t2.cleanup(); }
});

test("A1 pin 19 (d): the 500 message says in plain words that the data directory is not writable", () => {
  assert.match(NOT_WRITABLE_MESSAGE, /^The data directory is not writable/);
  assert.match(NOT_WRITABLE_MESSAGE, /nothing was sent to the provider and nothing was charged/);
});

test("A1 pin 19 (d): the lock is never skipped - any other failure to take it (here: its pid file cannot be written) also makes startApp() exit 1", () => {
  const g = globalThis as typeof globalThis & { __rsrApp?: unknown };
  const saved = { data: process.env.RSR_DATA_DIR, xai: process.env.XAI_API_KEY, gem: process.env.GEMINI_API_KEY };
  const dir = tmp();
  const errs: string[] = []; const origErr = console.error; console.error = (m: unknown) => { errs.push(String(m)); };
  try {
    delete process.env.XAI_API_KEY; delete process.env.GEMINI_API_KEY; process.env.RSR_DATA_DIR = dir; delete g.__rsrApp;
    mkdirSync(join(dir, LOCK_PID_FILE)); writeFileSync(join(dir, LOCK_PID_FILE, "x"), "");
    const codes: number[] = [];
    assert.equal(startApp((c) => codes.push(c)), null);
    assert.deepEqual(codes, [1]);
    assert.match(errs.join("\n"), /refusing to start: Could not take the one-server lock on the data directory/);
    assert.equal(g.__rsrApp, undefined);
  } finally {
    console.error = origErr; delete g.__rsrApp;
    for (const [k, v] of [["RSR_DATA_DIR", saved.data], ["XAI_API_KEY", saved.xai], ["GEMINI_API_KEY", saved.gem]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    cleanup(dir);
  }
});

test("A1 pin 19 (d): the paid POST route - write access lost between the check and the first database write (SQLITE_READONLY) still answers the not-writable 500, makes no image call, and logs no SQLite text; DataDirNotWritable answers the same", async () => {
  const { POST } = await import("../src/app/api/generate/route.ts");
  const g = globalThis as typeof globalThis & { __rsrApp?: unknown };
  const req = () => new Request("http://127.0.0.1:3000/api/generate", { method: "POST", headers: { host: "127.0.0.1:3000", "x-rsr": "1", "content-type": "application/json" }, body: JSON.stringify({ prompt: "a lighthouse at dusk", ratio: "1:1" }) });
  const x = fakeXai();
  const t = makeApp({ fetch: x.fetch });
  const ro = new DatabaseSync(join(t.dir, "db", "rsr.sqlite"), { readOnly: true }); // stands in for the race
  try {
    g.__rsrApp = { ...t.app, db: ro };
    const res = await POST(req());
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: NOT_WRITABLE_MESSAGE, code: "data_dir_not_writable" });
    assert.equal(x.posts().filter((r) => r.path === "/v1/images/generations").length, 0, "no image call");
    assert.ok(t.logs.some((l) => /generate refused: the database is not writable/.test(l)), t.logs.join("\n"));
    assert.ok(!t.logs.some((l) => RAW_SQLITE_RE.test(l)), t.logs.join("\n"));
    // And the normal path: the directory itself is read-only, so the check refuses before anything.
    g.__rsrApp = t.app;
    const restore = makeReadOnly(t.dir);
    try {
      const res2 = await POST(req());
      assert.equal(res2.status, 500);
      assert.deepEqual(await res2.json(), { error: NOT_WRITABLE_MESSAGE, code: "data_dir_not_writable" });
    } finally { restore(); }
    assert.equal(x.requests.filter((r) => r.path === "/v1/images/generations").length, 0, "the fake provider recorded zero image calls");
  } finally { delete g.__rsrApp; ro.close(); t.cleanup(); }
});

// --- Gap 1 (Surface ruling "Close it in A1", Oct 8 ~3:37 AM ET): the images/<xx>/ shard -------------------------------

test("A1 pin 19 (d) gap 1: the exact images/<xx>/ shard this image would be saved to is read-only (images/ itself writable) - the paid call refuses before the provider: zero calls, no ledger row, no run; writable again, it goes through", async () => {
  const x = fakeXai();
  const t = makeApp({ fetch: x.fetch });
  // The fake returns the same bytes every time, so the shard is known here; the app cannot know it before the call.
  const shard = join(t.app.imagesDir, createHash("sha256").update(await sampleJpeg()).digest("hex").slice(0, 2));
  mkdirSync(shard, { recursive: true });
  chmodSync(shard, 0o555); // only the shard: the data directory, db/ and images/ stay writable
  try {
    const runs = () => Number((t.app.db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n);
    const before = runs();
    await assert.rejects(runGenerate(t.app, { prompt: "a lighthouse at dusk", ratio: "1:1" }), (e: unknown) => notWritable(e) && (e as Error).message.includes(shard));
    assert.equal(x.requests.length, 0, "the fake provider recorded zero calls");
    assert.equal(ledgerRows(t.app).length, 0);
    assert.equal(runs(), before);
    chmodSync(shard, 0o755);
    const ok = await runGenerate(t.app, { prompt: "a lighthouse at dusk", ratio: "1:1" });
    assert.equal(ok.status, "ok", JSON.stringify(ok));
    assert.ok(readdirSync(shard).some((n) => n.endsWith(".jpg")), "saved into that shard");
  } finally { try { chmodSync(shard, 0o755); } catch { /* gone */ } t.cleanup(); }
});

test("A1 pin 19 (d) gap 1: checkImageShards probes every existing two-hex shard (any one could be the target) and nothing else; a missing shard is not created", () => {
  const t = makeApp({ fetch: fakeXai().fetch });
  const images = t.app.imagesDir;
  try {
    mkdirSync(images, { recursive: true });
    for (const n of ["00", "7f", "ff"]) mkdirSync(join(images, n));
    mkdirSync(join(images, "notashard")); chmodSync(join(images, "notashard"), 0o555); // ignored
    checkImageShards(t.dir, images);
    assert.deepEqual(readdirSync(images).sort(), ["00", "7f", "ff", "notashard"], "no shard created, no probe file left");
    for (const n of ["00", "7f", "ff"]) {
      chmodSync(join(images, n), 0o555);
      try { assert.throws(() => checkImageShards(t.dir, images), (e: unknown) => notWritable(e) && (e as Error).message.includes(join(images, n)), n); }
      finally { chmodSync(join(images, n), 0o755); }
    }
    chmodSync(join(images, "notashard"), 0o755);
  } finally { t.cleanup(); }
});

// --- Gap 2 (Surface: optional in A1): key save, cap save and library save give the plain not-writable 500 ----------

async function routeCase(fn: (t: ReturnType<typeof makeApp>, x: ReturnType<typeof fakeXai>, post: (path: string, body: unknown) => Promise<Response>) => Promise<void>) {
  const g = globalThis as typeof globalThis & { __rsrApp?: unknown };
  const x = fakeXai();
  const t = makeApp({ fetch: x.fetch });
  const routes: Record<string, () => Promise<{ POST: (r: Request) => Promise<Response> }>> = {
    "/api/settings/key": () => import("../src/app/api/settings/key/route.ts"),
    "/api/settings/cap": () => import("../src/app/api/settings/cap/route.ts"),
    "/api/library": () => import("../src/app/api/library/route.ts"),
  };
  const post = async (path: string, body: unknown) => (await routes[path]()).POST(new Request(`http://127.0.0.1:3000${path}`, { method: "POST", headers: { host: "127.0.0.1:3000", "x-rsr": "1", "content-type": "application/json" }, body: JSON.stringify(body) }));
  g.__rsrApp = t.app;
  try { await fn(t, x, post); } finally { delete g.__rsrApp; t.cleanup(); }
}
const saveRefused = async (res: Response) => { assert.equal(res.status, 500); assert.deepEqual(await res.json(), { error: NOT_WRITABLE_SAVE_MESSAGE, code: "data_dir_not_writable" }); };

test("A1 pin 19 (d) gap 2: key save on a read-only data directory - 500 'nothing was saved', the key is unchanged and no key check is sent; secrets/ alone read-only refuses too", async () => {
  await routeCase(async (t, x, post) => {
    const before = t.app.keys.status();
    const restore = makeReadOnly(t.dir);
    try { await saveRefused(await post("/api/settings/key", { key: DUMMY_KEY.replace("eSnz", "Zz9q") })); } finally { restore(); }
    assert.deepEqual(t.app.keys.status(), before);
    assert.equal(x.requests.length, 0, "no key check");
    const ok = await post("/api/settings/key", { key: DUMMY_KEY.replace("eSnz", "Zz9q") });
    assert.equal(ok.status, 200);
    const saved = t.app.keys.status();
    chmodSync(join(t.dir, "secrets"), 0o500);
    try { await saveRefused(await post("/api/settings/key", { key: DUMMY_KEY.replace("eSnz", "Yy8r") })); } finally { chmodSync(join(t.dir, "secrets"), 0o700); }
    assert.deepEqual(t.app.keys.status(), saved);
  });
});

test("A1 pin 19 (d) gap 2: cap save on a read-only data directory - 500 'nothing was saved', the cap is unchanged", async () => {
  await routeCase(async (t, _x, post) => {
    const cap = monthTotals(t.app.db).capMicros;
    const restore = makeReadOnly(t.dir);
    try { await saveRefused(await post("/api/settings/cap", { usd: 12 })); } finally { restore(); }
    assert.equal(monthTotals(t.app.db).capMicros, cap);
    assert.equal((await post("/api/settings/cap", { usd: 12 })).status, 200);
    assert.equal(monthTotals(t.app.db).capMicros, 12_000_000);
  });
});

test("A1 pin 19 (d) gap 2: library save on a read-only data directory - 500 'nothing was saved', no post is written", async () => {
  await routeCase(async (t, _x, post) => {
    const g = await runGenerate(t.app, { prompt: "a lighthouse at dusk", ratio: "1:1" });
    assert.equal(g.status, "ok");
    const posts = () => Number((t.app.db.prepare("SELECT COUNT(*) AS n FROM posts").get() as { n: number }).n);
    const restore = makeReadOnly(t.dir);
    try { await saveRefused(await post("/api/library", { generationId: g.generationId, notes: "x" })); } finally { restore(); }
    assert.equal(posts(), 0);
    assert.equal((await post("/api/library", { generationId: g.generationId, notes: "x" })).status, 200);
    assert.equal(posts(), 1);
  });
});

// --- Argus L2 on 5ea231d: the data directory does not exist and cannot be created ------------------------------------

test("Argus L2 on 5ea231d / A1 pin 19 (d): the data directory does not exist and its parent is 0555 - startApp() exits 1 with 'The data directory is not writable', not 'another server', no SQLite text", () => {
  const g = globalThis as typeof globalThis & { __rsrApp?: unknown };
  const saved = { data: process.env.RSR_DATA_DIR, xai: process.env.XAI_API_KEY, gem: process.env.GEMINI_API_KEY };
  const parent = tmp();
  const dir = join(parent, "data");
  const errs: string[] = []; const origErr = console.error; console.error = (m: unknown) => { errs.push(String(m)); };
  try {
    delete process.env.XAI_API_KEY; delete process.env.GEMINI_API_KEY; process.env.RSR_DATA_DIR = dir; delete g.__rsrApp;
    chmodSync(parent, 0o555);
    assert.throws(() => acquireDataDirLock(dir), (e: unknown) => notWritable(e) && (e as Error).message.includes(`(cannot create or write ${dir}, EACCES)`));
    const codes: number[] = [];
    assert.equal(startApp((c) => codes.push(c)), null);
    assert.deepEqual(codes, [1]);
    assert.match(errs.join("\n"), /^\[rsr\] refusing to start: The data directory is not writable: /);
    assert.doesNotMatch(errs.join("\n"), /Another Red Social Room server/);
    assert.doesNotMatch(errs.join("\n"), RAW_SQLITE_RE);
    assert.equal(existsSync(dir), false);
  } finally {
    console.error = origErr; delete g.__rsrApp;
    for (const [k, v] of [["RSR_DATA_DIR", saved.data], ["XAI_API_KEY", saved.xai], ["GEMINI_API_KEY", saved.gem]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    cleanup(parent);
  }
});

test("Argus N13 on 5ea231d: any other lock failure names the SQLite result code, never SQLite's own text (rsr.lock is not a database)", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, LOCK_FILE), "this is not a SQLite database file, just text ".repeat(20));
    assert.throws(() => acquireDataDirLock(dir), (e: unknown) => e instanceof DataDirLockFailed && /\(SQLite result code 26\)/.test((e as Error).message) && !/not a database/.test((e as Error).message));
  } finally { cleanup(dir); }
});

// --- Argus L1 on 3bbbe97: a folder that can be written but not read -------------------------------------------------

test("Argus L1 on 3bbbe97: the exact images/<xx>/ shard is 0333 (writable, not readable; the store opens it for reading to fsync) - the paid call refuses before the provider: zero calls, no ledger row, no run, no orphan file", async () => {
  const x = fakeXai();
  const t = makeApp({ fetch: x.fetch });
  const shard = join(t.app.imagesDir, createHash("sha256").update(await sampleJpeg()).digest("hex").slice(0, 2));
  mkdirSync(shard, { recursive: true });
  chmodSync(shard, 0o333);
  try {
    const runs = () => Number((t.app.db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n);
    const before = runs();
    await assert.rejects(runGenerate(t.app, { prompt: "a lighthouse at dusk", ratio: "1:1" }), (e: unknown) => notWritable(e) && (e as Error).message.includes(`cannot read and write ${shard}`));
    assert.equal(x.requests.length, 0, "the fake provider recorded zero calls");
    assert.equal(ledgerRows(t.app).length, 0);
    assert.equal(runs(), before);
    chmodSync(shard, 0o755);
    assert.deepEqual(readdirSync(shard), [], "no orphan image file, no probe file");
    assert.equal((await runGenerate(t.app, { prompt: "a lighthouse at dusk", ratio: "1:1" })).status, "ok");
  } finally { try { chmodSync(shard, 0o755); } catch { /* gone */ } t.cleanup(); }
});

test("Argus L1 on 3bbbe97: an images/ that cannot be listed (0333) refuses - in checkWritable and in checkImageShards itself - and never skips the subfolder checks", () => {
  const t = makeApp({ fetch: fakeXai().fetch });
  const images = t.app.imagesDir;
  try {
    mkdirSync(join(images, "51"), { recursive: true });
    chmodSync(join(images, "51"), 0o555); // a read-only subfolder hidden behind the unlistable images/
    chmodSync(images, 0o333);
    assert.throws(() => checkWritable(t.dir), (e: unknown) => notWritable(e) && (e as Error).message.includes(images));
    assert.throws(() => checkImageShards(t.dir, images), (e: unknown) => notWritable(e) && (e as Error).message.includes(`cannot list ${images}`));
  } finally { try { chmodSync(images, 0o755); chmodSync(join(images, "51"), 0o755); } catch { /* gone */ } t.cleanup(); }
});

test("Argus L1 on 3bbbe97: the read/write/search check applies to every probed folder - data directory, db/, images/ and secrets/ at 0333 each refuse", () => {
  const t = makeApp({ fetch: fakeXai().fetch });
  try {
    t.app.keys.save(DUMMY_KEY.replace("eSnz", "Xx7p")); // creates secrets/
    checkWritable(t.dir); // creates db/ and images/
    for (const d of [t.dir, join(t.dir, "db"), join(t.dir, "images"), join(t.dir, "secrets")]) {
      const before = statSync(d).mode & 0o7777;
      chmodSync(d, 0o333);
      try { assert.throws(() => checkWritable(t.dir, [join(t.dir, "secrets")]), (e: unknown) => notWritable(e) && (e as Error).message.includes(`cannot read and write ${d}`), d); }
      finally { chmodSync(d, before); }
    }
    checkWritable(t.dir, [join(t.dir, "secrets")]);
  } finally { t.cleanup(); }
});
