// Argus L2 on fa3d359: the real app start (getApp) marks rows left `reserved` by a previous process unresolved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/server/db.ts";
import { reserve, unresolvedRows } from "../src/server/ledger.ts";
import { getApp } from "../src/server/app.ts";

test("Argus L2: app start turns a leftover 'reserved' row into 'unresolved' (interrupted) so Settings lists it", () => {
  const dir = mkdtempSync(join(tmpdir(), "rsr-start-"));
  const g = globalThis as typeof globalThis & { __rsrApp?: { db: { close(): void } } };
  const saved = { data: process.env.RSR_DATA_DIR, xai: process.env.XAI_API_KEY, gem: process.env.GEMINI_API_KEY };
  try {
    // No key in this process env, so app start makes no key-check request.
    delete process.env.XAI_API_KEY; delete process.env.GEMINI_API_KEY;
    process.env.RSR_DATA_DIR = dir;
    const db = openDb(join(dir, "db", "rsr.sqlite"));
    const r = reserve(db, { provider: "xai", model: "grok-imagine-image-2.0", kind: "generate", resolution: "1k", quality: "low", generationId: "00000000-0000-4000-8000-000000000000", attempt: 1, estimateMicros: 40000, estimateSource: "test", now: new Date("2026-10-20T12:00:00-04:00") });
    db.close();
    delete g.__rsrApp;
    const app = getApp();
    const row = app.db.prepare("SELECT status, outcome FROM spend_ledger WHERE id = ?").get(r.id) as Record<string, unknown>;
    assert.deepEqual({ ...row }, { status: "unresolved", outcome: "interrupted" });
    assert.ok(unresolvedRows(app.db).some((u) => u.id === r.id));
  } finally {
    g.__rsrApp?.db.close(); delete g.__rsrApp;
    for (const [k, v] of [["RSR_DATA_DIR", saved.data], ["XAI_API_KEY", saved.xai], ["GEMINI_API_KEY", saved.gem]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A1 pin 10, line 361 (and A1 pin 18 (b), line 369): the free key check runs when the server starts, before any request", async () => {
  const { createServer } = await import("node:http");
  const { spawn } = await import("node:child_process");
  const { pathToFileURL } = await import("node:url");
  const { REPO_ROOT } = await import("../src/server/config.ts");
  const { DUMMY_KEY } = await import("./helpers.ts");
  const seen: Array<{ path: string; auth: string | undefined }> = [];
  let sawCheck: () => void = () => undefined;
  const checked = new Promise<void>((r) => { sawCheck = r; });
  const fake = createServer((req, res) => {
    seen.push({ path: req.url ?? "", auth: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/api-key") { res.end(JSON.stringify({ api_key_blocked: false, api_key_disabled: false, team_blocked: false })); sawCheck(); return; }
    if (req.url === "/v1/image-generation-models") { res.end(JSON.stringify({ models: [{ id: "grok-imagine-image-2.0" }] })); return; }
    res.statusCode = 404; res.end("{}");
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", () => r()));
  const dir = mkdtempSync(join(tmpdir(), "rsr-start-kc-"));
  const app = pathToFileURL(join(REPO_ROOT, "src", "server", "app.ts")).href;
  // Env built from scratch: a dummy key only, and the xAI address is the local fake (no network, nothing paid).
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp", RSR_DATA_DIR: dir, XAI_API_KEY: DUMMY_KEY, RSR_XAI_BASE_URL: `http://127.0.0.1:${(fake.address() as { port: number }).port}` };
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", `import { startApp } from ${JSON.stringify(app)}; startApp(); setTimeout(() => {}, 20000);`], { env, stdio: "ignore" });
  try {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([checked.then(() => false), new Promise<boolean>((r) => { timer = setTimeout(() => r(true), 15000); })]);
    clearTimeout(timer);
    assert.equal(timedOut, false, "no key check reached the fake xAI after start");
    assert.deepEqual(seen[0], { path: "/v1/api-key", auth: `Bearer ${DUMMY_KEY}` });
    assert.equal(seen.some((s) => s.path === "/v1/images/generations"), false, "nothing paid at start");
  } finally {
    // A child that already exited (e.g. startApp refused to start) never emits "exit" again: do not wait for it.
    if (child.exitCode === null && child.signalCode === null) {
      const gone = new Promise((r) => child.on("exit", r));
      child.kill("SIGTERM"); await gone;
    }
    fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
