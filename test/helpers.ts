// Shared test fixtures: an in-memory app wired to a scripted fake xAI (no network, dummy keys only).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { openDb } from "../src/server/db.ts";
import { KeyStore } from "../src/server/keys.ts";
import { loadPrices } from "../src/server/prices.ts";
import { parseSwitches, type Switches } from "../src/server/config.ts";
import { nameListMethod } from "../src/server/prompt-check.ts";
import type { AppDeps } from "../src/server/generate.ts";
import type { FetchLike } from "../src/server/xai/http.ts";

// Dummy keys: random-looking (so fragment checks have no false hits) but deliberately NOT in the real
// xAI or Google key formats, so no secret scanner mistakes them for real keys. Never real secrets.
export const DUMMY_KEY = "dummy_TESTONLY_eSnzAkRvEBmAqdNAlxMozDnpKNBHvF2RdMB6EiqvXdJL5QU20qMu2PHKgSdR";
export const DUMMY_GOOGLE_KEY = "dummy_TESTONLY_gGLXkQzWvRtYbNmHpCsDfJaEeUuIiOoPpAaSsDdFfGgHhJjKk";
export const DEFAULT_SWITCHES = { promptCheck: { method: "name_list", onFailure: "block", override: "none" }, xaiRejectionCost: "spike_narrow_422", xaiDataRetention: "default_30_days", xaiQuality: "measured_defaults", finalResolution: "1k_upscale" };

let jpegCache: Buffer | null = null;
/** A real 864x1152 JPEG (xAI's 3:4 1K size, Amendment 1 item 1). */
export async function sampleJpeg(): Promise<Buffer> {
  if (!jpegCache) {
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="864" height="1152"><rect width="864" height="1152" fill="#334"/><circle cx="432" cy="400" r="180" fill="#e83"/></svg>`);
    jpegCache = await sharp(svg).jpeg({ quality: 80 }).toBuffer();
  }
  return jpegCache;
}

export interface Req { method: string; url: string; path: string; headers: Record<string, string>; body: Record<string, unknown> | null }
export type Handler = (req: Req, init: RequestInit) => Response | Promise<Response>;

export const jsonRes = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export const KEY_OK = () => jsonRes(200, { redacted_api_key: "xai-...QRST", api_key_blocked: false, api_key_disabled: false, team_blocked: false });
export const MODELS_OK = () => jsonRes(200, { models: [{ id: "grok-imagine-image-2.0", version: "1.0", fingerprint: "fp_test" }] });
export async function genOk(ticks = 400000000, extra: Record<string, unknown> = {}): Promise<Response> {
  return jsonRes(200, { data: [{ b64_json: (await sampleJpeg()).toString("base64"), mime_type: "image/jpeg", ...extra }], usage: { cost_in_usd_ticks: ticks } }, { "x-request-id": "req-test-1", "cf-ray": "ray-1" });
}

/** Scripted fake xAI. `gen` answers POST /v1/images/generations in order (last one repeats). */
export function fakeXai(opts: { keyCheck?: Handler; models?: Handler; gen?: Handler[] } = {}) {
  const requests: Req[] = [];
  let g = 0;
  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    const req: Req = { method: init.method ?? "GET", url, path: u.pathname, headers, body };
    requests.push(req);
    if (u.pathname === "/v1/api-key") return (opts.keyCheck ?? KEY_OK)(req, init);
    if (u.pathname === "/v1/image-generation-models") return (opts.models ?? MODELS_OK)(req, init);
    if (u.pathname === "/v1/images/generations") {
      const list = opts.gen ?? [() => genOk()];
      const h = list[Math.min(g++, list.length - 1)];
      return h(req, init);
    }
    throw new Error(`fake xAI: unexpected ${u.pathname}`);
  };
  return { fetch, requests, posts: () => requests.filter((r) => r.method === "POST") };
}

/** A fetch that never answers until the request's signal aborts (timeout test). */
export const hang: Handler = (_req, init) => new Promise((_res, rej) => {
  // AbortSignal.timeout() timers are unref'd; keep the test's event loop alive until the abort fires.
  const keep = setInterval(() => {}, 1000);
  init.signal?.addEventListener("abort", () => { clearInterval(keep); rej(init.signal?.reason ?? new DOMException("aborted", "TimeoutError")); });
});

/** A fetch error carrying a Node error code, as undici reports it ("fetch failed" with a cause). */
export const netError = (code: string): Handler => () => { throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) }); };

export interface TestApp { app: AppDeps; dir: string; logs: string[]; sleeps: number[]; cleanup: () => void; namesFile: string }

export function makeApp(o: { fetch: FetchLike; switches?: Partial<Switches> & Record<string, unknown>; env?: NodeJS.ProcessEnv; capUsd?: number; names?: string | null; spikeLedger?: string | null; timeoutMs?: number; xaiBaseUrl?: string; googleBaseUrl?: string } ): TestApp {
  const dir = mkdtempSync(join(tmpdir(), "rsr-a1-"));
  const namesFile = join(dir, "names.txt");
  if (o.names !== null) writeFileSync(namesFile, o.names ?? "# test list\nTom Hanks\n");
  const db = openDb(join(dir, "db", "rsr.sqlite"), { spikeLedgerPath: o.spikeLedger ?? null });
  if (o.capUsd !== undefined) db.prepare("INSERT INTO settings (key, value) VALUES ('monthly_cap_micro_usd', ?)").run(String(Math.round(o.capUsd * 1e6)));
  const logs: string[] = [], sleeps: number[] = [];
  const app: AppDeps = {
    db,
    keys: new KeyStore({ secretsDir: join(dir, "secrets"), env: o.env ?? { XAI_API_KEY: DUMMY_KEY } }),
    googleKeys: new KeyStore({ secretsDir: join(dir, "secrets"), env: o.env ?? { GEMINI_API_KEY: DUMMY_GOOGLE_KEY }, provider: "google" }),
    prices: loadPrices(),
    switches: parseSwitches({ ...DEFAULT_SWITCHES, ...(o.switches ?? {}) }),
    fetch: o.fetch,
    baseUrl: o.xaiBaseUrl ?? "https://api.x.ai",
    timeoutMs: o.timeoutMs ?? 2000,
    keyCheckTimeoutMs: 2000,
    sleep: async (ms) => { sleeps.push(ms); },
    random: () => 0.5,
    log: (m) => logs.push(m),
    keyCheck: { fingerprint: null, ok: false, versionListing: null },
    googleKeyCheck: { fingerprint: null, ok: false, versionListing: null },
    googleBaseUrl: o.googleBaseUrl ?? "https://generativelanguage.googleapis.com",
    dataDir: dir,
    imagesDir: join(dir, "images"),
    promptMethod: nameListMethod(namesFile),
  };
  return { app, dir, logs, sleeps, namesFile, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

export function ledgerRows(app: AppDeps) {
  return app.db.prepare("SELECT * FROM spend_ledger WHERE imported_from IS NULL ORDER BY created_at, attempt").all() as Array<Record<string, unknown>>;
}

// ---- A2: the Google side of the scripted API ----

export const GOOGLE_MODEL_OK = () => jsonRes(200, { name: "models/gemini-3.1-flash-image", version: "3.0", displayName: "Nano Banana 2" });
export const GOOGLE_KEY_REJECTED_400 = () => jsonRes(400, { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID", domain: "googleapis.com" }] } });
export const GOOGLE_INTERACTIONS_401 = () => jsonRes(401, { error: { code: "authentication", message: "The API key is not valid." } });

/** The usage block of the spike's recorded generate ($0.0685 via geminiCostFromUsage: 26 in x $0.50/M + 429 text x $3/M + 1120 image x $60/M). */
export function googleUsage(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { total_input_tokens: 26, total_output_tokens: 1549, total_thought_tokens: 0, total_cached_tokens: 0, output_tokens_by_modality: [{ modality: "image", tokens: 1120 }, { modality: "text", tokens: 429 }], ...over };
}

export async function googleGenOk(extra: Record<string, unknown> = {}): Promise<Response> {
  return jsonRes(200, {
    id: "int-test-1", status: "completed", model: "gemini-3.1-flash-image",
    steps: [
      { type: "thought", signature: "sig-should-be-stripped" },
      { type: "model_output", content: [{ type: "text", text: "Here is your image." }, { type: "image", mime_type: "image/jpeg", data: (await sampleJpeg()).toString("base64") }] },
    ],
    usage: googleUsage(), ...extra,
  }, { "x-request-id": "goog-req-1" });
}

/** Scripted fake Google. `interactions` answers POST /v1beta/interactions in order (last one repeats). */
export function fakeGoogle(opts: { model?: Handler; interactions?: Handler[] } = {}) {
  const requests: Req[] = [];
  let g = 0;
  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    const req: Req = { method: init.method ?? "GET", url, path: u.pathname, headers, body };
    requests.push(req);
    if (u.pathname === "/v1beta/models/gemini-3.1-flash-image") return (opts.model ?? GOOGLE_MODEL_OK)(req, init);
    if (u.pathname === "/v1beta/interactions") {
      const list = opts.interactions ?? [() => googleGenOk()];
      const h = list[Math.min(g++, list.length - 1)];
      return h(req, init);
    }
    throw new Error(`fake google: unexpected ${u.pathname}`);
  };
  return { fetch, requests, posts: () => requests.filter((r) => r.method === "POST") };
}

/** One fetch over both scripted providers: /v1/* -> xAI, /v1beta/* -> Google. */
export function fakeProviders(o: { xai?: Parameters<typeof fakeXai>[0]; google?: Parameters<typeof fakeGoogle>[0] } = {}) {
  const xa = fakeXai(o.xai ?? {});
  const go = fakeGoogle(o.google ?? {});
  const fetch: FetchLike = async (url, init) => {
    const p = new URL(url).pathname;
    if (p.startsWith("/v1/")) return xa.fetch(url, init);
    if (p.startsWith("/v1beta/")) return go.fetch(url, init);
    throw new Error(`fake providers: unexpected ${p}`);
  };
  return { fetch, xai: xa, google: go };
}

/** Every form of a secret the leak checks look for: full, base64, and three 12-char fragments. */
export function secretNeedles(v: string): string[] {
  const mid = Math.floor(v.length / 2);
  return [v, Buffer.from(v).toString("base64"), v.slice(0, 12 + 4).slice(4), v.slice(mid - 6, mid + 6), v.slice(-12)];
}
