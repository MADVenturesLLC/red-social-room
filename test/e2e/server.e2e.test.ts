// End-to-end against the real Next.js production server (next build + next start) and a local fake xAI.
// Proves the A1 path over HTTP (make -> save -> find by a prompt word) and that NO page, API response,
// header, or built browser file contains a key (A1 acceptance: "Keys never appear in browser network
// traffic"; the Settings page shows only the last 4). Dummy keys only; the real env keys are not passed in.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, request as httpRequest, type Server } from "node:http";
import { connect } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../../src/server/config.ts";
import { DUMMY_KEY, sampleJpeg, secretNeedles } from "../helpers.ts";
import { HOST_REFUSED_BODY } from "../../src/server/hosts.ts";

const OTHER = "dummy_TESTONLY2_YN37HqzjWJUVBEzSe0yEx85UHWPO5NEramEpLdk3wQs5ingajTDuNgrguPUC";
const GEMINI_DUMMY = "dummyg_TESTONLY_4zxmPjPWZezkrrbewFcerUGlX2tQCAOIkSoD1AiaLJ2fRTUFTqbz82x8FgwD";
const NEEDLES = [...secretNeedles(DUMMY_KEY), ...secretNeedles(OTHER), ...secretNeedles(GEMINI_DUMMY)];
const NEXT_BIN = join(REPO_ROOT, "node_modules", "next", "dist", "bin", "next");

let mock: Server, server: ChildProcess, base = "", dataDir = "", port = 0, startEnv: NodeJS.ProcessEnv = {};
// A prompt containing "slow-call" makes the mock hold its answer until releaseSlow() (the Argus L1 lock test).
let releaseSlow: () => void = () => undefined, slowSeen: () => void = () => undefined;
const slowArrived = new Promise<void>((r) => { slowSeen = r; });
const slowGate = new Promise<void>((r) => { releaseSlow = r; });
// A prompt containing "late-call" is held the same way and then billed $0.09 (A1 pin 18 late-bill test).
let releaseLate: () => void = () => undefined, lateSeen: () => void = () => undefined;
const lateArrived = new Promise<void>((r) => { lateSeen = r; });
const lateGate = new Promise<void>((r) => { releaseLate = r; });
let keyCheckBeforeFirstRequest = false;
// A1 pin 17, line 368: set only when the server STARTS (not at build), to prove it is read at runtime.
const ALLOWED_HOSTS_ENV = "  Phone.Tailnet-Example.ts.net , other.example ";

/** A raw HTTP request with an exact Host header (fetch always derives Host from the URL). */
function raw(method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method, path, headers, setHost: false }, (res) => {
      let text = ""; res.setEncoding("utf8"); res.on("data", (c) => { text += c; }); res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
/** Bytes on the wire, for a request with no Host line at all. */
function rawSocket(lines: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = connect(port, "127.0.0.1", () => s.write(lines));
    let out = ""; s.setEncoding("utf8"); s.on("data", (c) => { out += c; }); s.on("end", () => resolve(out)); s.on("error", reject);
    setTimeout(() => s.end(), 2000);
  });
}
/** The body of a raw HTTP/1.1 response, chunked transfer decoded. */
function rawBody(resp: string): string {
  const at = resp.indexOf("\r\n\r\n");
  const head = resp.slice(0, at), rest = resp.slice(at + 4);
  if (!/^transfer-encoding:\s*chunked/im.test(head)) return rest;
  let out = "", i = 0;
  for (;;) {
    const nl = rest.indexOf("\r\n", i);
    const n = parseInt(rest.slice(i, nl), 16);
    if (!n) return out;
    out += rest.slice(nl + 2, nl + 2 + n);
    i = nl + 2 + n + 2;
  }
}
const mockSeen: Array<{ path: string; auth: string | undefined }> = [];
const transcript: Array<{ what: string; text: string }> = [];
let serverLog = "";

function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  // Built from scratch: the real XAI_API_KEY / GEMINI_API_KEY from this shell never reach the child.
  return { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp", NEXT_TELEMETRY_DISABLED: "1", ...extra };
}

async function record(what: string, res: Response): Promise<string> {
  const text = await res.text();
  const headers = [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
  transcript.push({ what, text: `${headers}\n\n${text}` });
  return text;
}

const post = (path: string, body: unknown, headers: Record<string, string> = { "x-rsr": "1" }) =>
  fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

before(async () => {
  const jpeg = await sampleJpeg();
  mock = createServer((req, res) => {
    mockSeen.push({ path: req.url ?? "", auth: req.headers.authorization });
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/api-key") return res.end(JSON.stringify({ api_key_blocked: false, api_key_disabled: false, team_blocked: false }));
      if (req.url === "/v1/image-generation-models") return res.end(JSON.stringify({ models: [{ id: "grok-imagine-image-2.0", version: "1.0", fingerprint: "fp_e2e" }] }));
      if (req.url === "/v1/images/generations" && req.method === "POST") {
        if (body.includes("late-call")) { lateSeen(); void lateGate.then(() => { res.setHeader("x-request-id", "req-e2e-late"); res.end(JSON.stringify({ data: [{ b64_json: jpeg.toString("base64"), mime_type: "image/jpeg" }], usage: { cost_in_usd_ticks: 900000000 } })); }); return; }
        if (body.includes("slow-call")) { slowSeen(); void slowGate.then(() => { res.setHeader("x-request-id", "req-e2e-slow"); res.end(JSON.stringify({ data: [{ b64_json: jpeg.toString("base64"), mime_type: "image/jpeg" }], usage: { cost_in_usd_ticks: 400000000 } })); }); return; }
        res.setHeader("x-request-id", "req-e2e");
        return res.end(JSON.stringify({ data: [{ b64_json: jpeg.toString("base64"), mime_type: "image/jpeg" }], usage: { cost_in_usd_ticks: body.includes("medium-bill") ? 600000000 : 400000000 } }));
      }
      res.statusCode = 404; res.end("{}");
    });
  });
  await new Promise<void>((r) => mock.listen(0, "127.0.0.1", () => r()));
  const mockPort = (mock.address() as { port: number }).port;
  dataDir = mkdtempSync(join(tmpdir(), "rsr-e2e-"));
  const env = childEnv({ XAI_API_KEY: DUMMY_KEY, GEMINI_API_KEY: GEMINI_DUMMY, RSR_DATA_DIR: dataDir, RSR_XAI_BASE_URL: `http://127.0.0.1:${mockPort}` });
  // Build with the dummy keys in the environment, so the bundle scan below would catch any inlining.
  // RSR_ALLOWED_HOSTS is deliberately absent at build time and present at start (A1 pin 17: read at runtime).
  assert.equal(env.RSR_ALLOWED_HOSTS, undefined);
  const b = spawnSync(process.execPath, [NEXT_BIN, "build"], { cwd: REPO_ROOT, env, encoding: "utf8", timeout: 300_000 });
  assert.equal(b.status, 0, `next build failed:\n${b.stdout}\n${b.stderr}`);
  port = 4300 + Math.floor(Math.random() * 500);
  base = `http://127.0.0.1:${port}`;
  startEnv = { ...env, RSR_ALLOWED_HOSTS: ALLOWED_HOSTS_ENV };
  server = spawn(process.execPath, [NEXT_BIN, "start", "-p", String(port), "-H", "127.0.0.1"], { cwd: REPO_ROOT, env: startEnv, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout?.on("data", (c) => { serverLog += c; });
  server.stderr?.on("data", (c) => { serverLog += c; });
  // A1 pin 10, line 361: the free key check runs when the server starts. Wait for it at the fake xAI before this
  // test sends the server any HTTP request.
  for (let i = 0; i < 150 && !mockSeen.some((m) => m.path === "/v1/api-key"); i++) await new Promise((r) => setTimeout(r, 200));
  keyCheckBeforeFirstRequest = mockSeen.some((m) => m.path === "/v1/api-key" && m.auth === `Bearer ${DUMMY_KEY}`);
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${base}/api/status`); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`next start did not come up:\n${serverLog}`);
});

after(() => {
  server?.kill("SIGTERM");
  mock?.close();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

test("A1 over HTTP: make an image, save it, find it in the Library by a word from the prompt", async () => {
  const create = await record("GET /", await fetch(`${base}/`));
  assert.match(create, /Grok Imagine 2\.0/);
  const g = JSON.parse(await record("POST /api/generate", await post("/api/generate", { prompt: "A friendly orange tabby cat on a windowsill", ratio: "4:5" })));
  assert.equal(g.status, "ok", JSON.stringify(g));
  assert.equal(g.displayNote, "Made at 3:4, cropped to 4:5");
  const img = await fetch(`${base}/api/assets/${g.image.assetId}`);
  assert.equal(img.headers.get("content-type"), "image/jpeg");
  assert.ok((await img.arrayBuffer()).byteLength > 1000);
  const s = JSON.parse(await record("POST /api/library", await post("/api/library", { generationId: g.generationId, notes: "e2e" })));
  assert.equal(s.already, false);
  const lib = await record("GET /library?q=tabby", await fetch(`${base}/library?q=tabby`));
  assert.match(lib, /A friendly orange tabby cat on a windowsill/);
  assert.match(lib, new RegExp(`/api/assets/${g.image.assetId}`));
  const none = await record("GET /library?q=giraffe", await fetch(`${base}/library?q=giraffe`));
  assert.doesNotMatch(none, /tabby cat/);
  const api = JSON.parse(await record("GET /api/library?q=windowsill", await fetch(`${base}/api/library?q=windowsill`)));
  assert.equal(api.posts.length, 1);
  // The server used the key from its own environment when calling xAI.
  assert.ok(mockSeen.some((m) => m.path === "/v1/images/generations" && m.auth === `Bearer ${DUMMY_KEY}`));
});

test("A1 pin 2, line 353 / F22: a call billed $0.06 against the $0.04 reservation shows the price drift notice in Settings -> Spend", async () => {
  const before = await record("GET /settings (before drift)", await fetch(`${base}/settings`));
  assert.doesNotMatch(before, /Price drift/);
  const g = JSON.parse(await record("POST /api/generate (medium bill)", await post("/api/generate", { prompt: "a lighthouse at dusk medium-bill", ratio: "1:1" })));
  assert.equal(g.status, "ok", JSON.stringify(g));
  assert.equal(g.costText, "$0.06");
  const html = await record("GET /settings (after drift)", await fetch(`${base}/settings`));
  assert.match(html, /Price drift: xAI grok-imagine-image-2\.0 generate 1k\/low billed \$0\.0600 against a \$0\.0400 reservation/);
});

test("Settings shows only the last 4; saving a new key never echoes it; the new key is used server-side", async () => {
  const before = await record("GET /settings", await fetch(`${base}/settings`));
  assert.match(before, new RegExp(`ending (<!-- -->)?<code>${DUMMY_KEY.slice(-4)}</code>`));
  const saved = await record("POST /api/settings/key", await post("/api/settings/key", { key: OTHER }));
  const sj = JSON.parse(saved);
  assert.deepEqual(sj.key, { set: true, source: "settings", last4: OTHER.slice(-4) });
  assert.equal(sj.check.ok, true);
  const afterHtml = await record("GET /settings (after save)", await fetch(`${base}/settings`));
  assert.match(afterHtml, new RegExp(`<code>${OTHER.slice(-4)}</code>`));
  await record("POST /api/settings/check", await post("/api/settings/check", {}));
  await record("GET /api/status", await fetch(`${base}/api/status`));
  const g = JSON.parse(await record("POST /api/generate (new key)", await post("/api/generate", { prompt: "a blue heron at dawn", ratio: "1:1" })));
  assert.equal(g.status, "ok");
  assert.equal(mockSeen.filter((m) => m.path === "/v1/images/generations").at(-1)?.auth, `Bearer ${OTHER}`);
  const bad = await record("POST /api/settings/key (bad)", await post("/api/settings/key", { key: "not a key at all" }));
  assert.equal(JSON.parse(bad).error.includes("not a key"), false);
});

const IMAGES_COUNT = () => { try { return readdirSync(join(dataDir, "images"), { recursive: true }).length; } catch { return 0; } };
const FOREIGN = { host: "attacker.example:3000", "x-rsr": "1", "sec-fetch-site": "same-origin" };

test("A1 pin 17, line 368: a foreign Host gets 403 (fixed body, no page content) on /settings, a static file, a GET API route and the paid POST - zero provider calls, no ledger row, no file", async () => {
  const html = await (await fetch(`${base}/`)).text();
  const asset = html.match(/\/_next\/static\/[^"'\s)]+\.js/)?.[0];
  assert.ok(asset, "found a static JS file");
  assert.equal((await fetch(base + asset)).status, 200, "the same file is served to an allowed Host");
  const statusBefore = await (await fetch(`${base}/api/status`)).json() as { totals: { countedMicros: number; unresolvedCount: number } };
  const mockBefore = mockSeen.length, imagesBefore = IMAGES_COUNT();
  const results = [
    await raw("GET", "/settings", FOREIGN),
    await raw("GET", "/", FOREIGN),
    await raw("GET", "/library?q=tabby", FOREIGN),
    await raw("GET", asset!, FOREIGN),
    await raw("GET", "/api/library?q=tabby", FOREIGN),
    await raw("GET", "/api/status", FOREIGN),
    await raw("POST", "/api/generate", { ...FOREIGN, "content-type": "application/json" }, JSON.stringify({ prompt: "a red fox in snow", ratio: "1:1" })),
    await raw("POST", "/api/settings/cap", { ...FOREIGN, "content-type": "application/json" }, JSON.stringify({ usd: 10000 })),
  ];
  for (const r of results) {
    assert.equal(r.status, 403);
    assert.equal(r.text, HOST_REFUSED_BODY);
  }
  assert.equal(mockSeen.length, mockBefore, "zero mock-provider requests");
  assert.equal(IMAGES_COUNT(), imagesBefore, "no image file written");
  const statusAfter = await (await fetch(`${base}/api/status`)).json() as { totals: { countedMicros: number; unresolvedCount: number; capMicros: number } };
  assert.equal(statusAfter.totals.countedMicros, statusBefore.totals.countedMicros, "no ledger row");
  assert.equal(statusAfter.totals.capMicros, 50_000_000, "cap unchanged");
});

test("A1 pin 17, line 368: X-Forwarded-Host is ignored (cannot unlock a foreign Host, cannot lock out an allowed one)", async () => {
  const a = await raw("GET", "/settings", { host: "attacker.example", "x-forwarded-host": `127.0.0.1:${port}` });
  assert.equal(a.status, 403); assert.equal(a.text, HOST_REFUSED_BODY);
  const b = await raw("GET", "/settings", { host: `127.0.0.1:${port}`, "x-forwarded-host": "attacker.example" });
  assert.equal(b.status, 200); assert.match(b.text, /<h1>Settings<\/h1>/);
});

test("A1 pin 17, line 368: a name from RSR_ALLOWED_HOSTS (set only at start, not at build) is accepted with its port and in mixed case; [::1] and localhost too", async () => {
  for (const host of ["PHONE.tailnet-example.TS.NET:443", "phone.tailnet-example.ts.net", "Other.Example:8443", `[::1]:${port}`, `LocalHost:${port}`]) {
    const r = await raw("GET", "/settings", { host });
    assert.equal(r.status, 200, host);
    assert.match(r.text, /<h1>Settings<\/h1>/, host);
  }
  const s = await raw("GET", "/api/status", { host: "phone.tailnet-example.ts.net:443" });
  assert.equal(s.status, 200);
});

test("A1 pin 17, line 368: an empty Host gets 403 with the fixed body; a request with no Host line at all may instead get Node's own 400 - either way no page, provider call or ledger row", async () => {
  const counted = JSON.parse(await (await fetch(`${base}/api/status`)).text()).totals.countedMicros;
  const mocks = mockSeen.length;
  const empty = await rawSocket("GET /settings HTTP/1.1\r\nHost: \r\nConnection: close\r\n\r\n");
  assert.match(empty, /^HTTP\/1\.1 403 /);
  assert.equal(rawBody(empty), HOST_REFUSED_BODY);
  // HTTP/1.1 with no Host line: Node's HTTP server answers 400 before the app runs (the pin allows this).
  const none = await rawSocket("GET /settings HTTP/1.1\r\nConnection: close\r\n\r\n");
  assert.match(none, /^HTTP\/1\.1 400 /);
  assert.doesNotMatch(none, /<h1>Settings<\/h1>/);
  const body = JSON.stringify({ prompt: "no host line at all", ratio: "1:1" });
  const nonePost = await rawSocket(`POST /api/generate HTTP/1.1\r\nContent-Type: application/json\r\nx-rsr: 1\r\nsec-fetch-site: same-origin\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
  assert.match(nonePost, /^HTTP\/1\.1 400 /);
  // HTTP/1.0 allows a request without Host; Node lets it through, and the app's own check refuses it with the 403.
  const old = await rawSocket("GET /settings HTTP/1.0\r\n\r\n");
  assert.match(old, /^HTTP\/1\.1 403 /);
  assert.equal(rawBody(old), HOST_REFUSED_BODY);
  assert.equal(mockSeen.length, mocks, "no provider request");
  assert.equal(JSON.parse(await (await fetch(`${base}/api/status`)).text()).totals.countedMicros, counted, "no ledger change");
  emptyHostStatus = empty.slice(9, 12); missingHostStatus = none.slice(9, 12);
});

test("Argus L1 on f63676e: a second server on the same data directory refuses to start with a clear error and sweeps nothing; the first server's in-flight call settles normally", async () => {
  const dbPath = join(dataDir, "db", "rsr.sqlite");
  const rowsOf = (id?: string) => {
    const db = new DatabaseSync(dbPath);
    try { return db.prepare("SELECT id, status, outcome, provider_request_id FROM spend_ledger WHERE provider_request_id IS ? OR status = 'reserved'").all(id ?? null) as Array<Record<string, unknown>>; } finally { db.close(); }
  };
  const lock = readFileSync(join(dataDir, "rsr.lock.pid"), "utf8").trim();
  assert.equal(lock, String(server.pid), "the first server holds the data-directory lock");
  const inFlight = post("/api/generate", { prompt: "slow-call: a lighthouse at dusk", ratio: "1:1" });
  await slowArrived;
  const reservedBefore = rowsOf().filter((r) => r.status === "reserved");
  assert.equal(reservedBefore.length, 1, "the slow call's row is reserved while xAI holds the answer");

  const port2 = port + 600;
  const second = spawn(process.execPath, [NEXT_BIN, "start", "-p", String(port2), "-H", "127.0.0.1"], { cwd: REPO_ROOT, env: startEnv, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  second.stdout?.on("data", (c) => { out += c; }); second.stderr?.on("data", (c) => { out += c; });
  const exited = new Promise<number | null>((r) => second.on("exit", (code) => r(code)));
  let code: number | null | undefined;
  for (let i = 0; i < 150 && code === undefined; i++) {
    code = await Promise.race([exited, new Promise<undefined>((r) => setTimeout(() => r(undefined), 200))]);
    if (code === undefined) { try { await fetch(`http://127.0.0.1:${port2}/api/status`); } catch { /* not up, or already gone */ } }
  }
  if (code === undefined) second.kill("SIGKILL");
  assert.equal(code, 1, `the second server must exit 1:\n${out}`);
  assert.match(out, /refusing to start: Another Red Social Room server \(pid \d+\) is already using the data directory /);
  const stillReserved = rowsOf().filter((r) => r.status === "reserved");
  assert.deepEqual(stillReserved.map((r) => r.id), reservedBefore.map((r) => r.id), "no sweep: the live row is still reserved");
  assert.equal(readFileSync(join(dataDir, "rsr.lock.pid"), "utf8").trim(), String(server.pid), "the lock still belongs to the first server");

  releaseSlow();
  const g = JSON.parse(await (await inFlight).text());
  assert.equal(g.status, "ok", JSON.stringify(g));
  const [row] = rowsOf("req-e2e-slow");
  assert.equal(row.status, "settled");
  assert.equal(row.id, reservedBefore[0].id);
});
let emptyHostStatus = "", missingHostStatus = "";
after(() => { console.log(`# host probe: empty Host -> ${emptyHostStatus}, missing Host -> ${missingHostStatus}`); });

test("A1 pin 10, line 361: the server ran the free key check at start, before it got any request", () => {
  assert.equal(keyCheckBeforeFirstRequest, true);
});

test("A1 pin 18, line 369: a $0.09 bill that arrives after its $0.04 row was swept to unresolved counts $0.09; the row stays unresolved and Settings -> Unresolved shows the late bill next to the held amount", async () => {
  const dbPath = join(dataDir, "db", "rsr.sqlite");
  const before = (await (await fetch(`${base}/api/status`)).json()) as { totals: { countedMicros: number; unresolvedCount: number } };
  const inFlight = post("/api/generate", { prompt: "late-call: a red kite over a hill", ratio: "1:1" });
  await lateArrived;
  // Stand-in for a sweep by a process that stopped and restarted (the lock rules out a second live server).
  const db = new DatabaseSync(dbPath);
  try { assert.equal(Number(db.prepare("UPDATE spend_ledger SET status = 'unresolved', outcome = 'interrupted' WHERE status = 'reserved'").run().changes), 1); } finally { db.close(); }
  releaseLate();
  const g = JSON.parse(await (await inFlight).text());
  assert.equal(g.status, "ok", JSON.stringify(g));
  const after = (await (await fetch(`${base}/api/status`)).json()) as { totals: { countedMicros: number; unresolvedCount: number } };
  assert.equal(after.totals.countedMicros - before.totals.countedMicros, 90000);
  assert.equal(after.totals.unresolvedCount, before.totals.unresolvedCount + 1);
  const check = new DatabaseSync(dbPath);
  try {
    const row = check.prepare("SELECT status, actual_micro_usd FROM spend_ledger WHERE outcome = 'interrupted' AND id NOT IN (SELECT id FROM spend_ledger WHERE provider_request_id IS NOT NULL)").all() as Array<Record<string, unknown>>;
    assert.deepEqual(row.map((r) => ({ ...r })), [{ status: "unresolved", actual_micro_usd: null }]);
  } finally { check.close(); }
  const settings = await (await fetch(`${base}/settings`)).text();
  assert.match(settings, /\$0\.09 held \(late bill \$0\.09\)/);
});

test("POSTs without the same-origin header, or marked cross-site, are refused before anything runs", async () => {
  const n = mockSeen.length;
  assert.equal((await post("/api/generate", { prompt: "x", ratio: "1:1" }, {})).status, 403);
  assert.equal((await post("/api/generate", { prompt: "x", ratio: "1:1" }, { "x-rsr": "1", "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await fetch(`${base}/api/generate`, { method: "POST", headers: { "x-rsr": "1", "Content-Type": "text/plain" }, body: "{}" })).status, 415);
  assert.equal(mockSeen.length, n);
});

test("asset route only serves stored hashes (no path traversal)", async () => {
  for (const p of ["..%2F..%2Fdb%2Frsr.sqlite", "0".repeat(64), "abc"]) assert.equal((await fetch(`${base}/api/assets/${p}`)).status, 404, p);
});

test("no response body or header, and no built browser file, contains any key (full, base64, or 12-char fragment)", async () => {
  // Every JS/CSS file the pages reference, plus every file Next built for the browser.
  for (const page of ["/", "/library", "/settings"]) {
    const html = await (await fetch(base + page)).text();
    for (const m of html.matchAll(/\/_next\/static\/[^"'\s)]+/g)) await record(`GET ${m[0]}`, await fetch(base + m[0]));
  }
  const hits: string[] = [];
  for (const t of transcript) for (const n of NEEDLES) if (t.text.includes(n)) hits.push(`${t.what} contains a key needle (#${NEEDLES.indexOf(n)})`);
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
  const staticFiles = walk(join(REPO_ROOT, ".next", "static"));
  for (const f of staticFiles) { const s = readFileSync(f, "latin1"); for (const n of NEEDLES) if (s.includes(n)) hits.push(`${f} contains a key needle`); }
  // Everything Next wrote for the server at build time (Argus L3): JS chunks and source maps, where build-time
  // inlining would land, plus the HTML/RSC/JSON payloads.
  const serverFiles = walk(join(REPO_ROOT, ".next", "server"));
  assert.ok(serverFiles.filter((p) => p.endsWith(".js")).length > 5, "server JS chunks are scanned");
  for (const f of serverFiles) { const s = readFileSync(f, "latin1"); for (const n of NEEDLES) if (s.includes(n)) hits.push(`${f} contains a key needle`); }
  // The server's own log.
  for (const n of NEEDLES) if (serverLog.includes(n)) hits.push("server log contains a key needle");
  assert.ok(transcript.length >= 15, `checked ${transcript.length} responses`);
  assert.ok(staticFiles.length > 5);
  assert.deepEqual(hits, []);
});
