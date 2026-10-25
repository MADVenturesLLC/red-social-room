// End-to-end against the real Next.js production server (next build + next start) and local fakes for xAI
// and Google (A2).
// Proves the A1 path over HTTP (make -> save -> find by a prompt word) and that NO page, API response,
// header, or built browser file contains a key (A1 acceptance: "Keys never appear in browser network
// traffic"; the Settings page shows only the last 4). Dummy keys only; the real env keys are not passed in.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, request as httpRequest, type Server } from "node:http";
import { connect } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../../src/server/config.ts";
import sharp from "sharp";
import { DUMMY_KEY, sampleJpeg, secretNeedles } from "../helpers.ts";
import { HOST_REFUSED_BODY } from "../../src/server/hosts.ts";
import { NOT_WRITABLE_MESSAGE } from "../../src/server/writable.ts";

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
// A prompt containing "sse-hold" is held until releaseSse(), so the A2 SSE test can subscribe while a job runs.
let releaseSse: () => void = () => undefined, sseSeen: () => void = () => undefined;
const sseArrived = new Promise<void>((r) => { sseSeen = r; });
const sseGate = new Promise<void>((r) => { releaseSse = r; });
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
const mockSeen: Array<{ path: string; auth: string | undefined; googleAuth: string | undefined; body: string }> = [];
const transcript: Array<{ what: string; text: string }> = [];
let serverLog = "";

function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  // Built from scratch: the real XAI_API_KEY / GEMINI_API_KEY from this shell never reach the child.
  return { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp", NEXT_TELEMETRY_DISABLED: "1", ...extra };
}

/** A3: distinct fixture pixels per call, so chains and uploads do not collapse through content-addressing. */
let editJpegPool: Buffer[] = [];
let editIdx = 0;
let uploadN = 0;
let widenJpeg: Buffer = Buffer.alloc(0);

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
  editJpegPool = await Promise.all([0, 1, 2, 3, 4, 5, 6, 7].map((i) => sharp({ create: { width: 48, height: 48, channels: 3, background: { r: (40 + i * 25) % 256, g: 70, b: 140 } } }).jpeg().toBuffer()));
  widenJpeg = await sharp({ create: { width: 640, height: 360, channels: 3, background: { r: 200, g: 120, b: 60 } } }).jpeg().toBuffer();
  mock = createServer((req, res) => {
    const entry = { path: req.url ?? "", auth: req.headers.authorization, googleAuth: typeof req.headers["x-goog-api-key"] === "string" ? req.headers["x-goog-api-key"] : undefined, body: "" };
    mockSeen.push(entry);
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      entry.body = body;
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/api-key") return res.end(JSON.stringify({ api_key_blocked: false, api_key_disabled: false, team_blocked: false }));
      if (req.url === "/v1/image-generation-models") return res.end(JSON.stringify({ models: [{ id: "grok-imagine-image-2.0", version: "1.0", fingerprint: "fp_e2e" }] }));
      if (req.url === "/v1/images/generations" && req.method === "POST") {
        if (body.includes("late-call")) { lateSeen(); void lateGate.then(() => { res.setHeader("x-request-id", "req-e2e-late"); res.end(JSON.stringify({ data: [{ b64_json: jpeg.toString("base64"), mime_type: "image/jpeg" }], usage: { cost_in_usd_ticks: 900000000 } })); }); return; }
        if (body.includes("slow-call")) { slowSeen(); void slowGate.then(() => { res.setHeader("x-request-id", "req-e2e-slow"); res.end(JSON.stringify({ data: [{ b64_json: jpeg.toString("base64"), mime_type: "image/jpeg" }], usage: { cost_in_usd_ticks: 400000000 } })); }); return; }
        if (body.includes("sse-hold")) { sseSeen(); void sseGate.then(() => { res.setHeader("x-request-id", "req-e2e-sse"); res.end(JSON.stringify({ data: [{ b64_json: jpeg.toString("base64"), mime_type: "image/jpeg" }], usage: { cost_in_usd_ticks: 400000000 } })); }); return; }
        res.setHeader("x-request-id", "req-e2e");
        return res.end(JSON.stringify({ data: [{ b64_json: jpeg.toString("base64"), mime_type: "image/jpeg" }], usage: { cost_in_usd_ticks: body.includes("medium-bill") ? 600000000 : 400000000 } }));
      }
      if (req.url === "/v1/images/edits" && req.method === "POST") {
        if (body.includes("edit-503")) { res.statusCode = 503; return res.end("oops"); }
        const out = editJpegPool[editIdx++ % editJpegPool.length]!;
        res.setHeader("x-request-id", "req-e2e-edit");
        return res.end(JSON.stringify({ data: [{ b64_json: out.toString("base64"), mime_type: "image/jpeg" }], usage: { cost_in_usd_ticks: 700000000 } }));
      }
      if (req.url === "/v1beta/models/gemini-3.1-flash-image" && req.method === "GET") {
        return res.end(JSON.stringify({ name: "models/gemini-3.1-flash-image", version: "3.0", displayName: "Nano Banana 2" }));
      }
      if (req.url === "/v1beta/interactions" && req.method === "POST") {
        if (body.includes("gemini-3.1-flash-lite")) {
          // A5: the caption call. "captions-badjson" rides in the notes and makes the reply unreadable.
          if (body.includes("captions-badjson")) {
            return res.end(JSON.stringify({ id: "int-cap-bad", status: "completed", model: "gemini-3.1-flash-lite", steps: [{ type: "model_output", content: [{ type: "text", text: "Sorry, here are your captions (not JSON)." }] }], usage: { total_input_tokens: 100, total_output_tokens: 50, total_thought_tokens: 0 } }));
          }
          const capPayload = {
            platforms: {
              instagram: { captions: ["Snow on the harbor — the winter drop is here.", "One red cabin, one big drop day."], hashtags: ["ventures", "winterdrop"], alt_text: "A red cabin in the snow at dusk." },
              x: { captions: ["X".repeat(350), "Short and sharp."], hashtags: ["drop"], alt_text: "A red cabin in the snow." },
              linkedin: { captions: ["A note on shipping through winter.", "What we built this week, in one post."], hashtags: ["ventures"], alt_text: "A red cabin in the snow." },
              facebook: { captions: ["Winter drop, live now.", "From the cabin to your feed."], hashtags: ["winter"], alt_text: "A red cabin in the snow." },
            },
            tags: ["winterdrop", "cabin"],
          };
          return res.end(JSON.stringify({ id: "int-cap-e2e", status: "completed", model: "gemini-3.1-flash-lite", steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify(capPayload) }] }], usage: { total_input_tokens: 4096, total_output_tokens: 800, total_thought_tokens: 0 } }));
        }
        // A6 item 9: the widen path. "fill a 1:1 frame" mock-refuses; "fill a 16:9 frame" returns a 16:9 image.
        if (body.includes("fill a 1:1 frame")) {
          return res.end(JSON.stringify({ id: "int-widen-refuse", status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: "I can't extend that safely." }] }], usage: { total_input_tokens: 26, total_output_tokens: 7, total_thought_tokens: 0 } }));
        }
        if (body.includes("fill a 16:9 frame")) {
          res.setHeader("x-request-id", "req-e2e-widen");
          return res.end(JSON.stringify({ id: "int-widen-e2e", status: "completed", model: "gemini-3.1-flash-image", steps: [{ type: "model_output", content: [{ type: "image", mime_type: "image/jpeg", data: widenJpeg.toString("base64") }] }], usage: { total_input_tokens: 26, total_output_tokens: 1549, total_thought_tokens: 0, output_tokens_by_modality: [{ modality: "image", tokens: 1120 }, { modality: "text", tokens: 429 }] } }));
        }
        if (body.includes("google-503")) { res.statusCode = 503; return res.end("oops"); }
        if (body.includes("google-refuse")) {
          return res.end(JSON.stringify({ id: "int-e2e-refuse", status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: "I can't draw that." }] }], usage: { total_input_tokens: 12, total_output_tokens: 7, total_thought_tokens: 0 } }));
        }
        return res.end(JSON.stringify({ id: "int-e2e", status: "completed", model: "gemini-3.1-flash-image", steps: [{ type: "thought", signature: "sig-e2e" }, { type: "model_output", content: [{ type: "text", text: "Here it is." }, { type: "image", mime_type: "image/jpeg", data: jpeg.toString("base64") }] }], usage: { total_input_tokens: 26, total_output_tokens: 1549, total_thought_tokens: 0, output_tokens_by_modality: [{ modality: "image", tokens: 1120 }, { modality: "text", tokens: 429 }] } }));
      }
      res.statusCode = 404; res.end("{}");
    });
  });
  await new Promise<void>((r) => mock.listen(0, "127.0.0.1", () => r()));
  const mockPort = (mock.address() as { port: number }).port;
  dataDir = mkdtempSync(join(tmpdir(), "rsr-e2e-"));
  const env = childEnv({ XAI_API_KEY: DUMMY_KEY, GEMINI_API_KEY: GEMINI_DUMMY, RSR_DATA_DIR: dataDir, RSR_XAI_BASE_URL: `http://127.0.0.1:${mockPort}`, RSR_GOOGLE_BASE_URL: `http://127.0.0.1:${mockPort}` });
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

  const port2 = await freePort();
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

// A1 pin 19 (d), line 370 (Amendment 1 at 9a890fb). Real read-only modes (dirs 0555, files 0444); the suite runs as a
// non-root user (asserted), since root ignores the mode bits.
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

test("A1 pin 19 (d), line 370: data directory and database made read-only after the server started - a paid POST returns 500 saying the data directory is not writable, the fake provider records zero calls, and the server keeps running", async () => {
  assert.notEqual(process.getuid?.(), 0, "must not run as root: root ignores chmod, so nothing would be read-only");
  const before = (await (await fetch(`${base}/api/status`)).json()) as { totals: { countedMicros: number } };
  const providerCalls = mockSeen.length, images = IMAGES_COUNT();
  const rowsBefore = (() => { const db = new DatabaseSync(join(dataDir, "db", "rsr.sqlite")); try { return ["spend_ledger", "runs", "generations"].map((t) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n)); } finally { db.close(); } })();
  const restore = makeReadOnly(dataDir);
  try {
    const res = await post("/api/generate", { prompt: "a lighthouse at dusk, read-only", ratio: "1:1" });
    const text = await record("POST /api/generate (read-only data directory)", res);
    assert.equal(res.status, 500, text);
    assert.deepEqual(JSON.parse(text), { error: NOT_WRITABLE_MESSAGE, code: "data_dir_not_writable" });
    assert.match(text, /The data directory is not writable/);
    assert.equal(mockSeen.length, providerCalls, "the fake provider recorded zero calls");
    const status = await fetch(`${base}/api/status`);
    assert.equal(status.status, 200, "the server is still running");
    assert.equal(((await status.json()) as { totals: { countedMicros: number } }).totals.countedMicros, before.totals.countedMicros, "no ledger change");
    assert.equal(IMAGES_COUNT(), images, "no file");
    assert.equal(server.exitCode, null);
  } finally { restore(); }
  const counts = () => { const db = new DatabaseSync(join(dataDir, "db", "rsr.sqlite")); try { return ["spend_ledger", "runs", "generations"].map((t) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n)); } finally { db.close(); } };
  assert.deepEqual(counts(), rowsBefore, "no ledger row, run or generation was written");
  // Writable again: the next paid POST goes through on the same server.
  const g = JSON.parse(await (await post("/api/generate", { prompt: "a lighthouse at dusk, writable again", ratio: "1:1" })).text());
  assert.equal(g.status, "ok", JSON.stringify(g));
});

test("A1 pin 19 (d) gap 1 (Surface ruling, Oct 8 ~3:37 AM ET): only the images/<xx>/ shard the next image would be saved to is read-only - a paid POST returns 500 with the not-writable message, zero provider calls, no ledger/run/generation row; writable again, it goes through", async () => {
  assert.notEqual(process.getuid?.(), 0, "must not run as root: root ignores chmod, so nothing would be read-only");
  // The mock returns the same JPEG every time, so the test knows the shard; the server cannot until xAI answers.
  const shard = join(dataDir, "images", createHash("sha256").update(await sampleJpeg()).digest("hex").slice(0, 2));
  assert.ok(statSync(shard).isDirectory(), "earlier 1:1 calls saved into this shard");
  const counts = () => { const db = new DatabaseSync(join(dataDir, "db", "rsr.sqlite")); try { return ["spend_ledger", "runs", "generations"].map((t) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n)); } finally { db.close(); } };
  const rowsBefore = counts(), providerCalls = mockSeen.length, mode = statSync(shard).mode & 0o7777;
  chmodSync(shard, 0o555);
  try {
    const res = await post("/api/generate", { prompt: "a lighthouse at dusk, read-only shard", ratio: "1:1" });
    const text = await record("POST /api/generate (read-only image shard)", res);
    assert.equal(res.status, 500, text);
    assert.deepEqual(JSON.parse(text), { error: NOT_WRITABLE_MESSAGE, code: "data_dir_not_writable" });
    assert.equal(mockSeen.length, providerCalls, "the fake provider recorded zero calls");
    assert.deepEqual(counts(), rowsBefore, "no ledger row, run or generation was written");
  } finally { chmodSync(shard, mode); }
  const g = JSON.parse(await (await post("/api/generate", { prompt: "a lighthouse at dusk, shard writable again", ratio: "1:1" })).text());
  assert.equal(g.status, "ok", JSON.stringify(g));
});

test("Argus L1 on 3bbbe97: the images/<xx>/ shard the next image would be saved to is 0333 (writable, not readable) - a paid POST returns 500 with the not-writable message, zero provider calls, no ledger/run/generation row, no orphan file", async () => {
  assert.notEqual(process.getuid?.(), 0, "must not run as root: root ignores chmod, so nothing would be blocked");
  const shard = join(dataDir, "images", createHash("sha256").update(await sampleJpeg()).digest("hex").slice(0, 2));
  const counts = () => { const db = new DatabaseSync(join(dataDir, "db", "rsr.sqlite")); try { return ["spend_ledger", "runs", "generations"].map((t) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n)); } finally { db.close(); } };
  const rowsBefore = counts(), providerCalls = mockSeen.length, mode = statSync(shard).mode & 0o7777, files = readdirSync(shard).sort();
  chmodSync(shard, 0o333);
  try {
    const res = await post("/api/generate", { prompt: "a lighthouse at dusk, unreadable shard", ratio: "1:1" });
    const text = await record("POST /api/generate (0333 image shard)", res);
    assert.equal(res.status, 500, text);
    assert.deepEqual(JSON.parse(text), { error: NOT_WRITABLE_MESSAGE, code: "data_dir_not_writable" });
    assert.equal(mockSeen.length, providerCalls, "the fake provider recorded zero calls");
    assert.deepEqual(counts(), rowsBefore, "no ledger row, run or generation was written");
  } finally { chmodSync(shard, mode); }
  assert.deepEqual(readdirSync(shard).sort(), files, "no orphan file");
});

test("Argus L1 on 3bbbe97: images/ cannot be listed (0333) - a paid POST returns 500 with the not-writable message, zero provider calls, no ledger/run/generation row; the folder checks are never skipped", async () => {
  assert.notEqual(process.getuid?.(), 0, "must not run as root: root ignores chmod, so nothing would be blocked");
  const images = join(dataDir, "images");
  const counts = () => { const db = new DatabaseSync(join(dataDir, "db", "rsr.sqlite")); try { return ["spend_ledger", "runs", "generations"].map((t) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n)); } finally { db.close(); } };
  const rowsBefore = counts(), providerCalls = mockSeen.length, mode = statSync(images).mode & 0o7777, files = readdirSync(images, { recursive: true }).map(String).sort();
  chmodSync(images, 0o333);
  try {
    const res = await post("/api/generate", { prompt: "a lighthouse at dusk, unlistable images folder", ratio: "1:1" });
    const text = await record("POST /api/generate (images/ 0333)", res);
    assert.equal(res.status, 500, text);
    assert.deepEqual(JSON.parse(text), { error: NOT_WRITABLE_MESSAGE, code: "data_dir_not_writable" });
    assert.equal(mockSeen.length, providerCalls, "the fake provider recorded zero calls");
    assert.deepEqual(counts(), rowsBefore, "no ledger row, run or generation was written");
  } finally { chmodSync(images, mode); }
  assert.deepEqual(readdirSync(images, { recursive: true }).map(String).sort(), files, "no new image or probe file");
});

/** An unused localhost port, asked from the OS at run time (a fixed offset once collided with a local
 *  service on this box; nothing here depends on the number). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      if (typeof a !== "object" || !a) { s.close(); reject(new Error("no port")); return; }
      const port = a.port;
      s.close(() => resolve(port));
    });
  });
}

/** Start `next start` and wait for it to exit (at most ~30 s); returns the exit code (undefined if it kept running) and its output. */
async function startAndAwaitExit(env: NodeJS.ProcessEnv, p: number): Promise<{ code: number | null | undefined; out: string }> {
  const child = spawn(process.execPath, [NEXT_BIN, "start", "-p", String(p), "-H", "127.0.0.1"], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout?.on("data", (c) => { out += c; }); child.stderr?.on("data", (c) => { out += c; });
  const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  let code: number | null | undefined;
  for (let i = 0; i < 150 && code === undefined; i++) {
    code = await Promise.race([exited, new Promise<undefined>((r) => setTimeout(() => r(undefined), 200))]);
    if (code === undefined) { try { await fetch(`http://127.0.0.1:${p}/api/status`); } catch { /* not up, or already gone */ } }
  }
  if (code === undefined) { child.kill("SIGKILL"); await exited; }
  return { code, out };
}

test("A1 pin 19 (d), line 370 (Argus L1 and L3 on 0e2f1f4): starting the server on a read-only data directory (new and empty, or left by a previous run), or with a read-only rsr.lock in a writable one, or missing under a 0555 parent, exits 1 with 'The data directory is not writable', never 'another server holds the lock' and never SQLite's own text", async () => {
  assert.notEqual(process.getuid?.(), 0, "must not run as root: root ignores chmod, so nothing would be read-only");
  const fresh = mkdtempSync(join(tmpdir(), "rsr-e2e-ro-new-"));
  const used = mkdtempSync(join(tmpdir(), "rsr-e2e-ro-used-"));
  const lockRo = mkdtempSync(join(tmpdir(), "rsr-e2e-ro-lock-"));
  const roParent = mkdtempSync(join(tmpdir(), "rsr-e2e-ro-parent-")); // Argus L2 on 5ea231d: <parent 0555>/data does not exist
  const missing = join(roParent, "data");
  const appTs = pathToFileURL(join(REPO_ROOT, "src", "server", "app.ts")).href;
  // A previous run: the real app start leaves rsr.lock, db/ (with the database) and images/ behind.
  for (const d of [used, lockRo]) {
    const prev = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", `import { startApp } from ${JSON.stringify(appTs)}; startApp(); process.exit(0);`],
      { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp", RSR_DATA_DIR: d }, encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL" });
    assert.equal(prev.status, 0, prev.stderr);
    assert.ok(readdirSync(d).includes("rsr.lock") && readdirSync(d).includes("db"), readdirSync(d).join(","));
  }
  const lockMode = statSync(join(lockRo, "rsr.lock")).mode & 0o7777;
  const restores = [makeReadOnly(fresh), makeReadOnly(used), makeReadOnly(roParent)];
  chmodSync(join(lockRo, "rsr.lock"), 0o444); // only the lock file; the directory, db/ and images/ stay writable
  restores.push(() => chmodSync(join(lockRo, "rsr.lock"), lockMode));
  try {
    for (const [label, dir, names] of [["new, empty, 0555", fresh, join(fresh, "rsr.lock")], ["left by a previous run, 0555/0444", used, join(used, "rsr.lock")],
      ["writable, but rsr.lock 0444", lockRo, join(lockRo, "rsr.lock")], ["missing, under a 0555 parent", missing, `cannot create or write ${missing}, EACCES`]] as const) {
      const providerCalls = mockSeen.length;
      const { code, out } = await startAndAwaitExit({ ...startEnv, RSR_DATA_DIR: dir }, await freePort());
      assert.equal(code, 1, `${label}: the server must exit 1:\n${out}`);
      assert.match(out, /refusing to start: The data directory is not writable: /, label);
      assert.ok(out.includes(names), `${label}: names ${names}:\n${out}`);
      assert.doesNotMatch(out, /Another Red Social Room server|already using the data directory/, label);
      assert.doesNotMatch(out, /unable to open database file|attempt to write a readonly database|Failed to prepare server/, label);
      assert.equal(mockSeen.length, providerCalls, `${label}: no provider call (not even the free key check)`);
    }
  } finally {
    for (const r of restores) r();
    for (const d of [fresh, used, lockRo, roParent]) rmSync(d, { recursive: true, force: true });
  }
});

interface RunJobE2E { creator: string; status: string; generationId: string; view: { status: string; message: string | null; code: string | null; displayNote: string | null; costText: string | null; image: { assetId: string } | null } | null }
/** Poll GET /api/run/<id> until the run is terminal (jobs finish in a worker, not in the POST). */
async function runToCompletion(runId: string, ms = 60_000): Promise<{ status: string; mode: string; jobs: RunJobE2E[] }> {
  const t0 = Date.now();
  for (;;) {
    const r = await fetch(`${base}/api/run/${runId}`);
    assert.equal(r.status, 200);
    const v = (await r.json()) as { status: string; mode: string; jobs: RunJobE2E[] };
    if (v.status !== "running") return v;
    if (Date.now() - t0 > ms) throw new Error(`run did not finish: ${JSON.stringify(v)}`);
    await new Promise((res) => setTimeout(res, 250));
  }
}

test("A2 over HTTP: one prompt to both creators shows both results; the Google call carries store:false and its own key; the tile saves to the library", async () => {
  const create = await record("GET / (A2 creator cards)", await fetch(`${base}/`));
  assert.match(create, /Grok Imagine 2\.0/);
  assert.match(create, /Nano Banana 2/);
  assert.match(create, /Nano Banana Pro/);
  const started = JSON.parse(await record("POST /api/run (both creators)", await post("/api/run", { prompt: "a hot air balloon over vineyards at sunrise", ratio: "4:5", creators: [{ id: "xai", n: 1 }, { id: "google", n: 1 }] }))) as { runId: string; blocked: boolean };
  assert.equal(started.blocked, false);
  const v = await runToCompletion(started.runId);
  assert.equal(v.status, "ok", JSON.stringify(v));
  const xai = v.jobs.find((j) => j.creator === "xai")!;
  const goog = v.jobs.find((j) => j.creator === "google")!;
  assert.equal(xai.status, "ok");
  assert.equal(goog.status, "ok");
  assert.equal(xai.view!.displayNote, "Made at 3:4, cropped to 4:5");
  assert.equal(goog.view!.displayNote, null);
  const gi = await fetch(`${base}/api/assets/${goog.view!.image!.assetId}`);
  assert.equal(gi.headers.get("content-type"), "image/jpeg");
  const lastPost = mockSeen.filter((m) => m.path === "/v1beta/interactions").at(-1)!;
  const gbody = JSON.parse(lastPost.body) as Record<string, unknown>;
  assert.equal(gbody.store, false);
  assert.equal("previous_interaction_id" in gbody, false);
  assert.equal(lastPost.googleAuth, GEMINI_DUMMY);
  const saved = JSON.parse(await record("POST /api/library (Google tile)", await post("/api/library", { generationId: goog.generationId }))) as { already: boolean };
  assert.equal(saved.already, false);
  const lib = JSON.parse(await record("GET /api/library?q=balloon", await fetch(`${base}/api/library?q=balloon`))) as { posts: unknown[] };
  assert.equal(lib.posts.length, 1);
});

/** Read an SSE stream to its end (or the timeout); returns the raw frames and whether the stream closed. */
async function readSseAll(path: string, ms = 20_000): Promise<{ text: string; ended: boolean }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  const res = await fetch(base + path, { signal: ctrl.signal });
  assert.ok((res.headers.get("content-type") ?? "").startsWith("text/event-stream"), res.headers.get("content-type") ?? "");
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = "", ended = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { ended = true; break; }
      text += dec.decode(value, { stream: true });
    }
  } catch { /* aborted at the timeout */ } finally { clearTimeout(t); }
  return { text, ended };
}

test("A2: the Settings check and save routes run the Google check on the Google store (mis-wire regression)", async () => {
  // The Google model GET must carry the Google key (x-goog-api-key) and no xAI bearer, and Google's result
  // must land in the Google cache - not overwrite the xAI check message (the live defect this guards).
  const before = mockSeen.filter((m) => m.path === "/v1beta/models/gemini-3.1-flash-image").length;
  const res = JSON.parse(await record("POST /api/settings/check (A2 google store)", await post("/api/settings/check", {}))) as { check: { ok: boolean; message: string | null }; googleCheck: { ok: boolean; message: string | null } | null };
  assert.equal(res.check.ok, true);
  assert.deepEqual(res.googleCheck, { ok: true, message: null });
  const modelGets = mockSeen.filter((m) => m.path === "/v1beta/models/gemini-3.1-flash-image");
  assert.ok(modelGets.length > before, "the Google check called the models endpoint");
  const last = modelGets.at(-1)!;
  assert.equal(last.googleAuth, GEMINI_DUMMY, "the Google check used the Google key store");
  assert.equal(last.auth, undefined, "no xAI bearer on a Google call");
  const sj = JSON.parse(await record("GET /api/status (A2 store wires)", await fetch(`${base}/api/status`))) as { googleKey: { checked: boolean; checkOk: boolean }; key: { checkMessage: string | null } };
  assert.equal(sj.googleKey.checked, true);
  assert.equal(sj.googleKey.checkOk, true);
  assert.equal(sj.key.checkMessage, null, "the Google result did not leak into the xAI cache");
  // The save route for Google: same wiring, and the saved key becomes the active source.
  const sv = JSON.parse(await record("POST /api/settings/key (A2 google)", await post("/api/settings/key", { provider: "google", key: GEMINI_DUMMY }))) as { key: { set: boolean; source: string }; check: { ok: boolean } };
  assert.equal(sv.key.set, true);
  assert.equal(sv.key.source, "settings");
  assert.equal(sv.check.ok, true);
  const lg = mockSeen.filter((m) => m.path === "/v1beta/models/gemini-3.1-flash-image").at(-1)!;
  assert.equal(lg.googleAuth, GEMINI_DUMMY, "the save-route check used the Google key store");
});

test("A2 SSE: the events stream delivers job updates and the final run frame, and closes for a finished run", async () => {
  const started = JSON.parse(await record("POST /api/run (sse)", await post("/api/run", { prompt: "sse-hold: a streamed kite", ratio: "1:1", creators: [{ id: "xai", n: 1 }] }))) as { runId: string };
  await sseArrived; // the job is in flight at the fake provider
  const reading = readSseAll(`/api/run/${started.runId}/events`);
  await new Promise((r) => setTimeout(r, 150)); // let the stream subscribe, then let the job finish
  releaseSse();
  const frames = await reading;
  assert.match(frames.text, /"type":"snapshot"/);
  assert.match(frames.text, /"type":"job"/);
  assert.match(frames.text, /"type":"run"/);
  assert.match(frames.text, /"status":"ok"/);
  assert.equal(frames.ended, true, "the stream closes after the final run frame");
  // A late subscriber to a finished run gets the snapshot and an immediate close (no hang).
  const late = await readSseAll(`/api/run/${started.runId}/events`);
  assert.match(late.text, /"type":"snapshot"/);
  assert.equal(late.ended, true, "a finished run closes the stream at once");
});

test("A2 F12 partial over HTTP: the failing creator shows the right message while the other returns", async () => {
  const started = JSON.parse(await record("POST /api/run (google 503)", await post("/api/run", { prompt: "google-503: a kite over cliffs", ratio: "1:1", creators: [{ id: "xai", n: 1 }, { id: "google", n: 1 }] }))) as { runId: string };
  const v = await runToCompletion(started.runId);
  assert.equal(v.status, "partial");
  const goog = v.jobs.find((j) => j.creator === "google")!;
  assert.equal(goog.status, "error");
  assert.equal(goog.view!.message, "Google error 503. Retry.");
  assert.match(goog.view!.costText ?? "", /held \(cost unknown\)/);
  assert.equal(v.jobs.find((j) => j.creator === "xai")!.status, "ok");
  // F21: the Settings link carries a badge with the unresolved count.
  const status = (await (await fetch(`${base}/api/status`)).json()) as { totals: { unresolvedCount: number } };
  assert.ok(status.totals.unresolvedCount >= 1);
  const home = await record("GET / (spend badge)", await fetch(`${base}/`));
  const m = home.match(/data-testid="spend-badge">(\d+)</);
  assert.ok(m, "the badge is rendered");
  assert.equal(Number(m![1]), status.totals.unresolvedCount, "the badge counts unresolved rows (F21)");
});

test("A2 F9 over HTTP: a text-only Google reply shows as refused with the provider text", async () => {
  const started = JSON.parse(await record("POST /api/run (google refusal)", await post("/api/run", { prompt: "google-refuse: something the model won't make", ratio: "1:1", creators: [{ id: "google", n: 1 }] }))) as { runId: string };
  const v = await runToCompletion(started.runId);
  const goog = v.jobs[0];
  assert.equal(goog.status, "refused");
  assert.equal(goog.view!.message, "Google returned no image: I can't draw that.");
});

test("A2 cap: a $0.10 cap blocks the next call before it is sent", async () => {
  await record("POST /api/settings/cap (0.10)", await post("/api/settings/cap", { usd: 0.1 }));
  try {
    const posts = mockSeen.filter((m) => m.path === "/v1/images/generations" || m.path === "/v1beta/interactions").length;
    const before = ((await (await fetch(`${base}/api/status`)).json()) as { totals: { countedMicros: number } }).totals.countedMicros;
    const started = JSON.parse(await record("POST /api/run (capped)", await post("/api/run", { prompt: "a capped run", ratio: "1:1", creators: [{ id: "xai", n: 1 }, { id: "google", n: 1 }] }))) as { runId: string };
    const v = await runToCompletion(started.runId);
    assert.equal(v.status, "failed");
    for (const j of v.jobs) {
      assert.equal(j.status, "error");
      assert.match(j.view!.message ?? "", /Monthly cap \$0\.10 reached/);
      assert.equal(j.view!.code, "cap");
    }
    assert.equal(mockSeen.filter((m) => m.path === "/v1/images/generations" || m.path === "/v1beta/interactions").length, posts, "nothing was sent");
    const after = ((await (await fetch(`${base}/api/status`)).json()) as { totals: { countedMicros: number } }).totals.countedMicros;
    assert.equal(after, before, "no ledger row");
  } finally {
    await record("POST /api/settings/cap (back to 50)", await post("/api/settings/cap", { usd: 50 }));
  }
});

// ---- A3: uploads, edits, lineage (F13/F14, item 28) ----

async function uploadPng(width = 64, height = 64): Promise<{ assetId: string; bytes: Buffer }> {
  const n = uploadN++;
  const bytes = await sharp({ create: { width, height, channels: 3, background: { r: (31 + n * 29) % 256, g: 90, b: (211 - n * 13 + 256) % 256 } } }).png().toBuffer();
  const up = JSON.parse(await record("POST /api/upload (A3)", await post("/api/upload", { data: bytes.toString("base64") }))) as { assetId?: string; mime?: string; error?: string };
  assert.ok(up.assetId && /^[a-f0-9]{64}$/.test(up.assetId), JSON.stringify(up));
  assert.equal(up.mime, "image/png");
  return { assetId: up.assetId, bytes };
}

test("A3 F14 over HTTP: the upload route accepts a small PNG (served back byte-identical) and rejects a non-image and an over-8,000 px image with the reason; zero provider calls", async () => {
  const calls = mockSeen.length;
  const { assetId, bytes } = await uploadPng();
  const served = await fetch(`${base}/api/assets/${assetId}`);
  assert.equal(served.headers.get("content-type"), "image/png");
  assert.equal(Buffer.from(await served.arrayBuffer()).toString("base64"), bytes.toString("base64"));
  const bad = JSON.parse(await record("POST /api/upload (not an image)", await post("/api/upload", { data: Buffer.from("hello, not an image").toString("base64") }))) as { error?: string };
  assert.match(bad.error ?? "", /not a PNG, JPEG or WebP/);
  const wide = await sharp({ create: { width: 9000, height: 8, channels: 3, background: "#000" } }).png().toBuffer();
  const big = JSON.parse(await record("POST /api/upload (9,000 px side)", await post("/api/upload", { data: wide.toString("base64") }))) as { error?: string };
  assert.match(big.error ?? "", /larger than 8,000 px on a side/);
  assert.equal(mockSeen.length, calls, "uploads never call a provider");
});

test("A3 acceptance over HTTP: upload, three chained edits, revert to version 1 - the original bytes never change", async () => {
  const { assetId: v0, bytes } = await uploadPng();
  const ids = [v0];
  for (const ins of ["make the sky gold", "add a small blimp", "turn it into night"]) {
    const started = JSON.parse(await record("POST /api/edit (chain)", await post("/api/edit", { mode: "edit", sourceAssetId: ids[ids.length - 1], instruction: ins, models: ["xai"] }))) as { runId: string; blocked: boolean };
    assert.equal(started.blocked, false);
    const v = await runToCompletion(started.runId);
    assert.equal(v.status, "ok", JSON.stringify(v));
    assert.equal(v.mode, "edit");
    ids.push(v.jobs[0].view!.image!.assetId);
  }
  assert.equal(new Set(ids).size, 4, "every version is its own file");
  const first = JSON.parse(mockSeen.filter((m) => m.path === "/v1/images/edits")[0].body) as { image: { url: string } };
  assert.ok(first.image.url.startsWith("data:image/png;base64,"), "the edit carries the uploaded image inline, same mime");
  const chain = JSON.parse(await record("GET /api/lineage (chain)", await fetch(`${base}/api/lineage?id=${ids[3]}`))) as { rootAssetId: string; nodes: Array<{ kind: string; assetId: string | null; instruction: string | null; costText: string | null; parentAssetId: string | null }> };
  assert.equal(chain.rootAssetId, v0);
  assert.equal(chain.nodes.length, 4);
  assert.deepEqual(chain.nodes.map((n) => n.kind), ["source", "edit", "edit", "edit"]);
  assert.deepEqual(chain.nodes.slice(1).map((n) => n.instruction), ["make the sky gold", "add a small blimp", "turn it into night"]);
  assert.ok(chain.nodes.slice(1).every((n) => n.costText === "$0.07"), JSON.stringify(chain.nodes));
  // Revert to version 1 (the original): it still serves byte-identical, and editing resumes from it.
  const orig = await fetch(`${base}/api/assets/${v0}`);
  assert.equal(Buffer.from(await orig.arrayBuffer()).toString("base64"), bytes.toString("base64"));
  const back = JSON.parse(await record("POST /api/edit (from v1)", await post("/api/edit", { mode: "edit", sourceAssetId: v0, instruction: "a fresh start", models: ["xai"] }))) as { runId: string };
  const bv = await runToCompletion(back.runId);
  assert.equal(bv.status, "ok");
  const chain2 = JSON.parse(await record("GET /api/lineage (after revert)", await fetch(`${base}/api/lineage?id=${bv.jobs[0].view!.image!.assetId}`))) as { nodes: Array<{ parentAssetId: string | null }> };
  assert.equal(chain2.nodes.length, 5);
  assert.equal(chain2.nodes.filter((n) => n.parentAssetId === v0).length, 2, "version 1 now has two children");
  for (const id of ids) assert.equal((await fetch(`${base}/api/assets/${id}`)).status, 200, "no version was overwritten");
});

test("A3 item 28 over HTTP: a compare edit sends the identical instruction string to both models", async () => {
  const { assetId } = await uploadPng();
  const started = JSON.parse(await record("POST /api/edit (compare)", await post("/api/edit", { mode: "edit", sourceAssetId: assetId, instruction: "identical instruction check 28", models: ["xai", "google"] }))) as { runId: string };
  const v = await runToCompletion(started.runId);
  assert.equal(v.status, "ok", JSON.stringify(v));
  assert.equal(v.jobs.length, 2);
  const xb = JSON.parse(mockSeen.filter((m) => m.path === "/v1/images/edits").at(-1)!.body) as { prompt: string };
  const gb = JSON.parse(mockSeen.filter((m) => m.path === "/v1beta/interactions").at(-1)!.body) as { input: Array<{ type: string; text?: string }> };
  assert.equal(xb.prompt, "identical instruction check 28");
  assert.equal(gb.input[0].text, "identical instruction check 28");
  assert.equal(xb.prompt, gb.input[0].text);
});

test("A3 F13 over HTTP: a failed edit leaves the source untouched and shows a failed entry in the strip", async () => {
  const { assetId: v0, bytes } = await uploadPng();
  const started = JSON.parse(await record("POST /api/edit (503)", await post("/api/edit", { mode: "edit", sourceAssetId: v0, instruction: "edit-503 please", models: ["xai"] }))) as { runId: string };
  const v = await runToCompletion(started.runId);
  assert.equal(v.status, "failed");
  assert.match(v.jobs[0].view!.message ?? "", /xAI error 503 \(service unavailable\)\. Retry\./);
  const after = await fetch(`${base}/api/assets/${v0}`);
  assert.equal(Buffer.from(await after.arrayBuffer()).toString("base64"), bytes.toString("base64"), "the source and every earlier version are untouched");
  const chain = JSON.parse(await record("GET /api/lineage (failed edit)", await fetch(`${base}/api/lineage?id=${v0}`))) as { nodes: Array<{ status: string; assetId: string | null; error: string | null }> };
  assert.equal(chain.nodes.length, 2);
  assert.equal(chain.nodes[1].status, "error");
  assert.equal(chain.nodes[1].assetId, null);
  assert.match(chain.nodes[1].error ?? "", /503|Retry/);
});

test("A3 reference over HTTP: 'Use as reference' sends the image with the prompt to Google; Grok refuses before any call", async () => {
  const { assetId } = await uploadPng();
  const started = JSON.parse(await record("POST /api/edit (reference)", await post("/api/edit", { mode: "reference", sourceAssetId: assetId, instruction: "make a tall poster version", ratio: "16:9", models: ["google"] }))) as { runId: string };
  const v = await runToCompletion(started.runId);
  assert.equal(v.status, "ok", JSON.stringify(v));
  assert.equal(v.mode, "reference");
  const gb = JSON.parse(mockSeen.filter((m) => m.path === "/v1beta/interactions").at(-1)!.body) as { input: Array<{ type: string; text?: string; data?: string }>; response_format: Record<string, unknown> };
  assert.ok(Array.isArray(gb.input) && gb.input.length === 2);
  assert.equal(gb.input[0].text, "make a tall poster version");
  assert.equal(gb.input[1].type, "image");
  assert.equal(typeof gb.input[1].data, "string");
  assert.deepEqual(gb.response_format, { type: "image", aspect_ratio: "16:9", image_size: "1K" });
  const chain = JSON.parse(await record("GET /api/lineage (reference)", await fetch(`${base}/api/lineage?id=${v.jobs[0].view!.image!.assetId}`))) as { nodes: Array<{ kind: string; parentAssetId: string | null }> };
  const last = chain.nodes.at(-1)!;
  assert.equal(last.kind, "reference");
  assert.equal(last.parentAssetId, assetId);
  const xr = await post("/api/edit", { mode: "reference", sourceAssetId: assetId, instruction: "nope", ratio: "1:1", models: ["xai"] });
  assert.equal(xr.status, 400);
  const xj = JSON.parse(await record("POST /api/edit (xai reference)", xr)) as { error: string };
  assert.match(xj.error, /can't take reference images/);
});

test("A4 over HTTP: the Brand kit stores a PNG and an SVG (served under a sandbox), refuses a script SVG, and deletes from the kit", async () => {
  const png = (await sharp({ create: { width: 64, height: 32, channels: 4, background: "#c8102e" } }).png().toBuffer()).toString("base64");
  const created = await post("/api/brand", { data: png, name: "Roundel" });
  assert.equal(created.status, 201);
  const item = JSON.parse(await record("POST /api/brand (png)", created)) as { id: number; assetId: string; mime: string };
  assert.equal(item.mime, "image/png");
  assert.match(item.assetId, /^[a-f0-9]{64}$/);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" fill="#111"/></svg>';
  const svgRes = await post("/api/brand", { data: Buffer.from(svg).toString("base64"), name: "Wordmark" });
  assert.equal(svgRes.status, 201);
  const svgItem = JSON.parse(await record("POST /api/brand (svg)", svgRes)) as { assetId: string; mime: string };
  assert.equal(svgItem.mime, "image/svg+xml");
  const served = await fetch(`${base}/api/assets/${svgItem.assetId}`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "image/svg+xml");
  assert.match(served.headers.get("content-security-policy") ?? "", /sandbox/);
  assert.match(await record("GET /api/assets (svg logo)", served), /<svg/);
  const list = JSON.parse(await record("GET /api/brand", await fetch(`${base}/api/brand`))) as { items: Array<{ id: number }> };
  assert.equal(list.items.length, 2);
  const bad = await post("/api/brand", { data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString("base64"), name: "Evil" });
  assert.equal(bad.status, 400);
  assert.match((JSON.parse(await record("POST /api/brand (script svg)", bad)) as { error: string }).error, /cannot contain scripts/);
  const del = await fetch(`${base}/api/brand?id=${item.id}`, { method: "DELETE", headers: { "Content-Type": "application/json", "x-rsr": "1" } });
  assert.equal(del.status, 200);
  assert.equal((JSON.parse(await record("DELETE /api/brand", del)) as { ok: boolean }).ok, true);
  const list2 = JSON.parse(await record("GET /api/brand (after delete)", await fetch(`${base}/api/brand`))) as { items: unknown[] };
  assert.equal(list2.items.length, 1);
});

test("A4 acceptance over HTTP: design a post, save it, reopen it, change only the headline - crop, slider and logo stay", async () => {
  const g = JSON.parse(await record("POST /api/generate (A4)", await post("/api/generate", { prompt: "a lighthouse at dusk", ratio: "4:5" }))) as { status: string; generationId: string; image: { assetId: string } };
  assert.equal(g.status, "ok", JSON.stringify(g));
  const saved = JSON.parse(await record("POST /api/library (A4)", await post("/api/library", { generationId: g.generationId, notes: "design me" }))) as { id: number };
  const postId = saved.id;
  const fresh = JSON.parse(await record("GET /api/posts (fresh)", await fetch(`${base}/api/posts/${postId}`))) as { recipe: unknown; sourceAssetId: string; assetId: string };
  assert.equal(fresh.recipe, null);
  const original = fresh.sourceAssetId;
  assert.equal(fresh.assetId, original, "an untouched post is its own source");

  const logo = JSON.parse(await record("POST /api/brand (A4 logo)", await post("/api/brand", { data: (await sharp({ create: { width: 48, height: 48, channels: 4, background: "#224466" } }).png().toBuffer()).toString("base64"), name: "Mark" }))) as { assetId: string };
  const render1 = (await uploadPng(80, 80)).assetId; // stand-in for the browser's flattened PNG
  const recipe1 = {
    version: 1, rotate: 0, crop: { x: 0.1, y: 0.05, w: 0.8, h: 0.9 },
    adjust: { brightness: 5, contrast: 0, saturation: 0, warmth: 40 },
    texts: [{ id: "t1", text: "First headline", x: 0.1, y: 0.1, font: "Anton", size: 0.12, color: "#ffffff", strokeWidth: 0, strokeColor: "#000000", shadow: true }],
    logos: [{ id: "l1", assetId: logo.assetId, x: 0.4, y: 0.7, scale: 0.25 }],
  };
  const up1 = await post("/api/posts/update", { postId, assetId: render1, recipe: recipe1 });
  assert.equal(up1.status, 200);
  await record("POST /api/posts/update (v1)", up1);
  const got1 = JSON.parse(await record("GET /api/posts (v1)", await fetch(`${base}/api/posts/${postId}`))) as { recipe: typeof recipe1; sourceAssetId: string; assetId: string };
  assert.deepEqual(got1.recipe, recipe1);
  assert.equal(got1.assetId, render1);
  assert.equal(got1.sourceAssetId, original, "the untouched original stays the source");
  const designHtml = await record(`GET /design/${postId}`, await fetch(`${base}/design/${postId}`));
  assert.match(designHtml, /canvas work/);
  const libHtml = await record("GET /library (designed)", await fetch(`${base}/library`));
  assert.match(libHtml, /Edit design/);

  // Reopen and change only the headline: crop, slider and logo stay, the source never moves.
  const render2 = (await uploadPng(81, 81)).assetId;
  const recipe2 = { ...recipe1, texts: [{ ...recipe1.texts[0], text: "Second headline" }] };
  const up2 = await post("/api/posts/update", { postId, assetId: render2, recipe: recipe2 });
  assert.equal(up2.status, 200);
  await record("POST /api/posts/update (v2)", up2);
  const got2 = JSON.parse(await record("GET /api/posts (v2)", await fetch(`${base}/api/posts/${postId}`))) as { recipe: typeof recipe2; sourceAssetId: string; assetId: string };
  assert.equal(got2.recipe.texts[0].text, "Second headline");
  assert.deepEqual(got2.recipe.crop, recipe1.crop);
  assert.deepEqual(got2.recipe.logos, recipe1.logos);
  assert.equal(got2.recipe.adjust.warmth, 40);
  assert.equal(got2.sourceAssetId, original);
  assert.equal(got2.assetId, render2, "the library now shows the second render");
  const libHtml2 = await record("GET /library (after change)", await fetch(`${base}/library`));
  assert.match(libHtml2, new RegExp(`/api/assets/${render2}`));

  const badGet = await fetch(`${base}/api/posts/99999`);
  assert.equal(badGet.status, 404);
  const badUpd = await post("/api/posts/update", { postId, assetId: "f".repeat(64), recipe: recipe1 });
  assert.equal(badUpd.status, 400);
  assert.match((JSON.parse(await record("POST /api/posts/update (missing render)", badUpd)) as { error: string }).error, /not in the store/);
});

test("A5 acceptance over HTTP: one click gives captions for 4 platforms - within limits or flagged red - then save, tags and search", async () => {
  const g = JSON.parse(await record("POST /api/generate (A5)", await post("/api/generate", { prompt: "a red cabin in the snow", ratio: "4:5" }))) as { status: string; generationId: string };
  assert.equal(g.status, "ok", JSON.stringify(g));
  const saved = JSON.parse(await record("POST /api/library (A5)", await post("/api/library", { generationId: g.generationId }))) as { id: number };
  const postId = saved.id;
  const bv = await post("/api/settings/brandvoice", { text: "We build ventures. Short sentences, real numbers." });
  assert.equal(bv.status, 200);
  await record("POST /api/settings/brandvoice", bv);

  const capCallsBefore = mockSeen.filter((m) => m.path === "/v1beta/interactions" && m.body.includes("gemini-3.1-flash-lite")).length;
  const res = await post("/api/captions", { postId, platforms: ["instagram", "x", "linkedin", "facebook"], tone: "mad-confident", notes: "mention the winter drop" });
  assert.equal(res.status, 200);
  const r = JSON.parse(await record("POST /api/captions (4 platforms)", res)) as {
    kind: string; message: string | null; platforms: Record<string, { captions: string[]; hashtags: string[]; altText: string; limit: number; overLimit: boolean }>;
    tags: string[]; cost: { micros: number | null; source: string } | null;
  };
  assert.equal(r.kind, "ok", JSON.stringify(r));
  assert.equal(Object.keys(r.platforms).length, 4, "captions for 4 platforms");
  assert.equal(r.platforms.x.overLimit, true, "the 350-char X caption is flagged red, not cut");
  assert.equal(r.platforms.x.captions[0].length, 350);
  assert.equal(r.platforms.instagram.overLimit, false);
  assert.equal(r.platforms.instagram.limit, 2200);
  assert.deepEqual(r.tags, ["winterdrop", "cabin"]);
  assert.equal(r.cost?.micros, 2224, "settled from usage tokens (4096 in x $0.25/M + 800 out x $1.50/M)");
  assert.equal(r.cost?.source, "estimated_tokens");
  const calls = mockSeen.filter((m) => m.path === "/v1beta/interactions" && m.body.includes("gemini-3.1-flash-lite"));
  assert.equal(calls.length, capCallsBefore + 1, "exactly one caption call");
  const sent = JSON.parse(calls.at(-1)!.body) as { model: string; store: boolean; response_format: { type: string; mime_type: string; schema: { properties: { platforms: { required: string[] } } } }; input: Array<{ type: string; text?: string }> };
  assert.equal(sent.model, "gemini-3.1-flash-lite");
  assert.equal(sent.store, false);
  assert.equal(sent.response_format.mime_type, "application/json");
  assert.deepEqual(sent.response_format.schema.properties.platforms.required, ["instagram", "x", "linkedin", "facebook"]);
  assert.match(sent.input[0].text ?? "", /mention the winter drop/);
  assert.match(sent.input[0].text ?? "", /We build ventures\. Short sentences, real numbers\./);

  const save = await post("/api/captions/save", { postId, platform: "instagram", text: "Harbor lights and snow — the winter drop is here.", hashtags: "ventures winterdrop", altText: "A red cabin in the snow at dusk." });
  assert.equal(save.status, 200);
  await record("POST /api/captions/save", save);
  const page = await record(`GET /captions/${postId}`, await fetch(`${base}/captions/${postId}`));
  assert.match(page, /Harbor lights and snow/, "the saved caption is on the page");
  assert.match(page, /Instagram/);

  const tagsRes = await post("/api/tags", { postId, tags: ["winterdrop", "#cabin"] });
  assert.equal(tagsRes.status, 200);
  const tags = JSON.parse(await record("POST /api/tags", tagsRes)) as { ok: boolean; tags: Array<{ name: string }> };
  assert.deepEqual(tags.tags.map((t) => t.name), ["cabin", "winterdrop"]);
  const byTag = await record("GET /library?q=winterdrop", await fetch(`${base}/library?q=winterdrop`));
  assert.match(byTag, /red cabin in the snow/, "the tag finds the post");
  const byCaption = await record("GET /library?q=harbor", await fetch(`${base}/library?q=harbor`));
  assert.match(byCaption, /red cabin in the snow/, "a caption word finds the post");
  const none = await record("GET /library?q=zebra", await fetch(`${base}/library?q=zebra`));
  assert.doesNotMatch(none, /red cabin in the snow/);
});

test("A5 over HTTP: an unreadable caption reply is reported, still billed, and never retried automatically", async () => {
  const g = JSON.parse(await record("POST /api/generate (A5 badjson)", await post("/api/generate", { prompt: "a quiet library at night", ratio: "1:1" }))) as { status: string; generationId: string };
  assert.equal(g.status, "ok");
  const saved = JSON.parse(await record("POST /api/library (A5 badjson)", await post("/api/library", { generationId: g.generationId }))) as { id: number };
  const before = mockSeen.filter((m) => m.path === "/v1beta/interactions" && m.body.includes("gemini-3.1-flash-lite")).length;
  const res = await post("/api/captions", { postId: saved.id, platforms: ["instagram"], tone: "casual", notes: "captions-badjson" });
  assert.equal(res.status, 200);
  const r = JSON.parse(await record("POST /api/captions (unreadable)", res)) as { kind: string; code: string; message: string; cost: { micros: number | null; source: string } | null };
  assert.equal(r.kind, "error");
  assert.equal(r.code, "unreadable");
  assert.match(r.message, /billed/);
  assert.equal(r.cost?.micros, 100, "the unreadable reply still settles what it used (100 in x $0.25/M + 50 out x $1.50/M)");
  const after = mockSeen.filter((m) => m.path === "/v1beta/interactions" && m.body.includes("gemini-3.1-flash-lite")).length;
  assert.equal(after, before + 1, "exactly one call - no automatic retry");
});

test("A6 acceptance over HTTP: exact-size renditions, AI extend (aspect_ratio, zero xAI), the refusal + no-fallback, and the ZIP with captions.txt", async () => {
  const g = JSON.parse(await record("POST /api/generate (A6)", await post("/api/generate", { prompt: "a kite over a winter field", ratio: "4:5" }))) as { status: string; generationId: string };
  assert.equal(g.status, "ok", JSON.stringify(g));
  const saved = JSON.parse(await record("POST /api/library (A6)", await post("/api/library", { generationId: g.generationId }))) as { id: number };
  const postId = saved.id;

  // Item 24: exact pixels, both mandated cases.
  const r1 = JSON.parse(await record("POST /api/renditions (instagram-portrait)", await post("/api/renditions", { postId, presetId: "instagram-portrait" }))) as { ok: boolean; rendition: { assetId: string; width: number; height: number; bytes: number; upscaledFrom: number } };
  assert.equal(r1.ok, true);
  assert.equal(r1.rendition.width, 1080);
  assert.equal(r1.rendition.height, 1350);
  const meta1 = await sharp(Buffer.from(await (await fetch(`${base}/api/assets/${r1.rendition.assetId}`)).arrayBuffer())).metadata();
  assert.equal(meta1.width, 1080);
  assert.equal(meta1.height, 1350);
  const r2 = JSON.parse(await record("POST /api/renditions (youtube)", await post("/api/renditions", { postId, presetId: "youtube" }))) as { ok: boolean; rendition: { assetId: string; bytes: number; width: number; height: number } };
  assert.equal(r2.ok, true);
  assert.equal(r2.rendition.width, 1280);
  assert.equal(r2.rendition.height, 720);
  assert.ok(r2.rendition.bytes < 2097152, `YouTube file is ${r2.rendition.bytes} bytes (under 2 MB)`);
  const meta2 = await sharp(Buffer.from(await (await fetch(`${base}/api/assets/${r2.rendition.assetId}`)).arrayBuffer())).metadata();
  assert.equal(meta2.width, 1280);
  assert.equal(meta2.height, 720);

  // Item 9: AI extend with the target ratio, zero xAI calls.
  const xaiEditsBefore = mockSeen.filter((m) => m.path === "/v1/images/edits").length;
  const w = JSON.parse(await record("POST /api/renditions/widen (x)", await post("/api/renditions/widen", { postId, presetId: "x" }))) as { ok: boolean; kind: string; rendition: { assetId: string; width: number; height: number; method: string; note: string } };
  assert.equal(w.ok, true, JSON.stringify(w));
  assert.equal(w.kind, "ok");
  assert.equal(w.rendition.method, "ai_extend");
  assert.equal(w.rendition.note, "AI extend (Nano Banana 2)");
  assert.equal(w.rendition.width, 1280);
  assert.equal(w.rendition.height, 720);
  const widenReq = mockSeen.filter((m) => m.path === "/v1beta/interactions" && m.body.includes("fill a 16:9 frame"));
  assert.equal(widenReq.length, 1, "one Google request for the widen");
  assert.ok(widenReq[0].body.includes('"aspect_ratio":"16:9"'), "the target ratio rides on the request");
  assert.equal(mockSeen.filter((m) => m.path === "/v1/images/edits").length, xaiEditsBefore, "zero xAI requests for widening");

  // Item 9 refusal: the real refusal shows and the fallback that exists is offered (P3: none on this computer).
  const wr = JSON.parse(await record("POST /api/renditions/widen (refusal)", await post("/api/renditions/widen", { postId, presetId: "instagram-square" }))) as { ok: boolean; kind: string; message: string; fallback: string };
  assert.equal(wr.ok, false);
  assert.equal(wr.kind, "refused");
  assert.match(wr.message, /Refused by Google|no image/i);
  assert.equal(wr.fallback, "none", "P3 interim: no fallback on this computer");

  // The ZIP: one exact-size image per platform plus captions.txt.
  const savedCap = await post("/api/captions/save", { postId, platform: "instagram", text: "A kite over a winter field — prints soon.", hashtags: "ventures winter", altText: "A kite in a pale sky." });
  assert.equal(savedCap.status, 200);
  await record("POST /api/captions/save (A6)", savedCap);
  const zipRes = await fetch(`${base}/api/export`, { method: "POST", headers: { "Content-Type": "application/json", "x-rsr": "1" }, body: JSON.stringify({ postId, presets: ["instagram-portrait", "x", "youtube"] }) });
  assert.equal(zipRes.status, 200);
  assert.equal(zipRes.headers.get("content-type"), "application/zip");
  assert.match(zipRes.headers.get("content-disposition") ?? "", new RegExp(`filename="red-social-room-post-${postId}-export.zip"`));
  const zipBuf = Buffer.from(await zipRes.arrayBuffer());
  transcript.push({ what: "POST /api/export", text: `zip ${zipBuf.length} bytes` });
  assert.equal(zipBuf.subarray(0, 4).toString("latin1"), "PK\x03\x04");
  const zipText = zipBuf.toString("latin1");
  for (const name of ["instagram-portrait.jpg", "x.jpg", "youtube.jpg", "captions.txt"]) assert.ok(zipText.includes(name), `zip carries ${name}`);
  assert.ok(zipBuf.includes(Buffer.from("A kite over a winter field — prints soon.", "utf8")), "captions.txt carries the saved caption");
  const lib = await record("GET /library (A6 links)", await fetch(`${base}/library`));
  assert.match(lib, new RegExp(`/export/${postId}`));
});

test("A7 over HTTP: tags filter the Library, snippets save and insert, a post reuses and deletes, and the backup + index tools answer", async () => {
  // Two library posts (the shared mock answers both creates).
  const g1 = JSON.parse(await record("POST /api/generate (A7-1)", await post("/api/generate", { prompt: "A7 tagtarget: red bicycle by the canal", ratio: "4:5" })));
  assert.equal(g1.status, "ok", JSON.stringify(g1));
  const p1 = JSON.parse(await record("POST /api/library (A7-1)", await post("/api/library", { generationId: g1.generationId })));
  const g2 = JSON.parse(await record("POST /api/generate (A7-2)", await post("/api/generate", { prompt: "A7 second image: green kite in the park", ratio: "1:1" })));
  assert.equal(g2.status, "ok", JSON.stringify(g2));
  const p2 = JSON.parse(await record("POST /api/library (A7-2)", await post("/api/library", { generationId: g2.generationId })));
  // Tag the first post directly (the caption flow usually suggests tags; the filter itself is what this proves).
  const db = new DatabaseSync(join(dataDir, "db", "rsr.sqlite"));
  const tag = Number(db.prepare("INSERT INTO tags (name, created_at) VALUES ('a7-cats', '2026-10-10')").run().lastInsertRowid);
  db.prepare("INSERT INTO post_tags (post_id, tag_id) VALUES (?, ?)").run(p1.id, tag);
  db.close();
  const filtered = await record("GET /library?tag=a7-cats", await fetch(`${base}/library?tag=a7-cats`));
  assert.match(filtered, /red bicycle by the canal/);
  assert.doesNotMatch(filtered, /green kite in the park/);
  assert.match(filtered, /data-tag="a7-cats" data-active="1"/); // the chip is there and active; the count itself is covered by the unit tests
  const all = await record("GET /library", await fetch(`${base}/library`));
  assert.match(all, /green kite in the park/);
  // Snippets: save, see it on the create page, list it over HTTP, remove it.
  const sn = JSON.parse(await record("POST /api/snippets", await post("/api/snippets", { text: "warm light, soft grain" }))) as { snippet?: { id: number } };
  assert.ok(sn.snippet && sn.snippet.id > 0, JSON.stringify(sn));
  const snList = JSON.parse(await record("GET /api/snippets", await fetch(`${base}/api/snippets`))) as { snippets: Array<{ text: string }> };
  assert.equal(snList.snippets.length, 1);
  const createPage = await record("GET / (snippets)", await fetch(`${base}/`));
  assert.match(createPage, /warm light, soft grain/);
  assert.match(createPage, /data-snippets/);
  const del = await fetch(`${base}/api/snippets?id=${sn.snippet.id}`, { method: "DELETE", headers: { "Content-Type": "application/json", "x-rsr": "1" } });
  assert.equal(del.status, 200);
  const snGone = JSON.parse(await record("GET /api/snippets (after delete)", await fetch(`${base}/api/snippets`))) as { snippets: unknown[] };
  assert.equal(snGone.snippets.length, 0);
  // Reuse: the create page comes back with the post's prompt and model filled in.
  const reusePage = await record("GET /?reuse", await fetch(`${base}/?reuse=${p1.id}`));
  assert.match(reusePage, /Reusing post #/);
  assert.match(reusePage, /red bicycle by the canal/);
  // Delete the second post; it leaves the Library and the search.
  const del2 = JSON.parse(await record("POST /api/posts/delete", await post("/api/posts/delete", { id: p2.id }))) as { ok?: boolean };
  assert.equal(del2.ok, true);
  const gone = await record("GET /library (after delete)", await fetch(`${base}/library`));
  assert.doesNotMatch(gone, /green kite in the park/);
  assert.ok(!gone.includes(`data-post-id="${p2.id}"`), "the deleted post's card is gone");
  // A phrase only the deleted post had ("kite" alone also matches an older test's post).
  const zero = await record("GET /library?q=green+kite", await fetch(`${base}/library?q=green+kite`));
  // React separates adjacent text nodes with comments; assert the literal bytes instead of "sanitizing" HTML.
  assert.ok(zero.includes("0<!-- --> <!-- -->images"), zero.slice(0, 300));
  // Backup status says "not set up yet" and runs nothing; the create button refuses with the reason.
  const bs = JSON.parse(await record("GET /api/backup/status", await fetch(`${base}/api/backup/status`))) as { r2: { configured: boolean }; summary: { never: boolean; banner: boolean }; rows: unknown[] };
  assert.equal(bs.r2.configured, false);
  assert.equal(bs.summary.never, true);
  assert.equal(bs.summary.banner, true);
  assert.equal(bs.rows.length, 0);
  const runRes = await fetch(`${base}/api/backup/run`, { method: "POST", headers: { "Content-Type": "application/json", "x-rsr": "1" }, body: "{}" });
  assert.equal(runRes.status, 400);
  const runBody = JSON.parse(await record("POST /api/backup/run (unset)", runRes)) as { error?: string };
  assert.match(runBody.error ?? "", /not set up/);
  // The search-index check and rebuild both answer with a report.
  const ftsR = JSON.parse(await record("POST /api/maintenance/fts check", await post("/api/maintenance/fts", { action: "check" }))) as { report: { integrityOk: boolean; indexed: number } };
  assert.equal(ftsR.report.integrityOk, true);
  assert.ok(ftsR.report.indexed >= 1);
  const rebuild = JSON.parse(await record("POST /api/maintenance/fts rebuild", await post("/api/maintenance/fts", { action: "rebuild" }))) as { action: string; report: { integrityOk: boolean } };
  assert.equal(rebuild.action, "rebuild");
  assert.equal(rebuild.report.integrityOk, true);
  // Settings shows the backup section with its red banner (never backed up) and the index section.
  const settings = await record("GET /settings (A7)", await fetch(`${base}/settings`));
  assert.match(settings, /Backup \(nightly to Cloudflare R2\)/);
  assert.match(settings, /data-testid="backup-banner"/);
  assert.match(settings, /Search index/);
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

test("C1: installable and shareable — manifest, icons, service worker, and the Share control on Export", async () => {
  const man = await fetch(`${base}/manifest.webmanifest`);
  assert.equal(man.status, 200);
  const m = (await man.json()) as { name: string; start_url: string; icons: Array<{ src: string; sizes: string; purpose?: string }> };
  assert.equal(m.name, "Red Social Room");
  assert.equal(m.start_url, "/");
  assert.ok(m.icons.some((i) => i.sizes === "512x512" && i.purpose === "maskable"), "a maskable icon is listed");

  const sw = await fetch(`${base}/sw.js`);
  assert.equal(sw.status, 200);
  assert.match(await sw.text(), /addEventListener\("fetch"/);

  for (const icon of ["/icons/icon-192.png", "/icons/icon-512.png", "/icons/apple-touch-icon.png"]) {
    const res = await fetch(base + icon);
    assert.equal(res.status, 200, icon);
    assert.equal(res.headers.get("content-type"), "image/png", icon);
    assert.ok((await res.arrayBuffer()).byteLength > 1000, `${icon} has bytes`);
  }

  const home = await (await fetch(`${base}/`)).text();
  assert.match(home, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(home, /apple-touch-icon/);

  // A post's Export page carries the Share control once a rendition exists.
  const g = JSON.parse(await record("POST /api/generate (C1)", await post("/api/generate", { prompt: "C1 share target: red kite over the bay", ratio: "4:5" }))) as { generationId: string };
  const saved = JSON.parse(await record("POST /api/library (C1)", await post("/api/library", { generationId: g.generationId }))) as { id: number };
  const rend = await record("POST /api/renditions (C1)", await post("/api/renditions", { postId: saved.id, presetId: "instagram-portrait" }));
  assert.ok(!/"error"/.test(rend), rend);
  const exp = await (await fetch(`${base}/export/${saved.id}`)).text();
  assert.match(exp, /data-share="instagram-portrait"/);
  assert.match(exp, />Share…</);
});
