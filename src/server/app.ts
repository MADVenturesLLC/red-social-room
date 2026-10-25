// Process-wide app instance for the Next.js server (route handlers and server pages).
// Holds the DB, both key stores, the switches, the price table and both key-check caches.
// A2: the Google store (secrets/gemini_api_key, GEMINI_API_KEY) and the run-queue startup sweep.
import { join } from "node:path";
import { dataDir, loadSwitches, REPO_ROOT } from "./config.ts";
import { loadUsers, UsersConfigError } from "./actor.ts";
import { openDb } from "./db.ts";
import { markInterrupted } from "./ledger.ts";
import { acquireDataDirLock, DataDirLocked, DataDirLockFailed, DataDirNotWritable, isNotWritable } from "./lock.ts";
import { checkWritable, DB_RELPATH } from "./writable.ts";
import { KeyStore } from "./keys.ts";
import { loadPrices } from "./prices.ts";
import { nameListMethod } from "./prompt-check.ts";
import { checkKey, type KeyCheckCache } from "./xai/adapter.ts";
import { checkGoogleKey } from "./google/adapter.ts";
import { checkOpenAiKey } from "./openai/adapter.ts";
import { googleDepsOf, openaiDepsOf } from "./execute.ts";
import { resetStrandedJobs } from "./runs.ts";
import { startScheduler } from "./scheduler.ts";
import type { AppDeps } from "./generate.ts";

/** Test-only override of an API base URL. Accepted only for a loopback http URL, so a stray env value
 *  can never send a key to another host. */
export function baseUrlFromEnv(v: string | undefined, name: string): string | undefined {
  if (!v) return undefined;
  if (/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(v)) return v;
  throw new Error(`${name} may only point at http://127.0.0.1:<port> (tests). Unset it for real use.`);
}

export function xaiBaseUrlFromEnv(v: string | undefined): string | undefined {
  return baseUrlFromEnv(v, "RSR_XAI_BASE_URL");
}

type G = typeof globalThis & { __rsrApp?: AppDeps };

export function getApp(): AppDeps {
  const g = globalThis as G;
  if (g.__rsrApp) return g.__rsrApp;
  // B1 (review round): the allowlist is validated before the lock is taken or anything is served, so a
  // missing or malformed config/users.json stops the server here instead of failing at request time.
  loadUsers();
  const dir = dataDir();
  // Argus L1 on f63676e: one server per data directory, taken before the database is opened or swept.
  // A1 pin 19 (d), line 370: if it cannot be taken (busy, or the directory is not writable) the server refuses to start.
  acquireDataDirLock(dir);
  // A1 pin 19 (d): db/ and images/ must be writable at startup too; otherwise refuse to start with the same message.
  checkWritable(dir);
  let db: ReturnType<typeof openDb>;
  try { db = openDb(join(dir, DB_RELPATH)); } catch (e) {
    if (isNotWritable(e)) throw new DataDirNotWritable(dir, `cannot open ${join(dir, DB_RELPATH)} for writing`, e);
    throw e;
  }
  const keys = new KeyStore({ secretsDir: join(dir, "secrets") });
  const googleKeys = new KeyStore({ secretsDir: join(dir, "secrets"), provider: "google" }); // A2
  const openaiKeys = new KeyStore({ secretsDir: join(dir, "secrets"), provider: "openai" });
  const keyCheck: KeyCheckCache = { fingerprint: null, ok: false, versionListing: null };
  const googleKeyCheck: KeyCheckCache = { fingerprint: null, ok: false, versionListing: null };
  const openaiKeyCheck: KeyCheckCache = { fingerprint: null, ok: false, versionListing: null };
  const testBase = process.env.RSR_XAI_BASE_URL || process.env.RSR_GOOGLE_BASE_URL || process.env.RSR_OPENAI_BASE_URL;
  const app: AppDeps = {
    db,
    keys,
    googleKeys,
    openaiKeys,
    prices: loadPrices(),
    switches: loadSwitches(),
    fetch: (url, init) => fetch(url, init),
    baseUrl: xaiBaseUrlFromEnv(process.env.RSR_XAI_BASE_URL),
    googleBaseUrl: baseUrlFromEnv(process.env.RSR_GOOGLE_BASE_URL, "RSR_GOOGLE_BASE_URL"),
    openaiBaseUrl: baseUrlFromEnv(process.env.RSR_OPENAI_BASE_URL, "RSR_OPENAI_BASE_URL"),
    timeoutMs: testBase && process.env.RSR_TEST_TIMEOUT_MS ? Number(process.env.RSR_TEST_TIMEOUT_MS) : undefined,
    keyCheck,
    googleKeyCheck,
    openaiKeyCheck,
    dataDir: dir,
    imagesDir: join(dir, "images"),
    promptMethod: nameListMethod(join(REPO_ROOT, "config", "real-person-names.txt")),
    log: (m) => console.log(`[rsr] ${new Date().toISOString()} ${keys.scrub(googleKeys.scrub(openaiKeys.scrub(m)))}`),
  };
  g.__rsrApp = app;
  // A7: the in-process nightly job (backup at 3 AM New York; a daily search-index check). Tests build their
  // AppDeps directly, so this only ever runs in a real server. RSR_DISABLE_SCHEDULER=1 turns it off.
  if (process.env.RSR_DISABLE_SCHEDULER !== "1") startScheduler({ db: app.db, dataDir: dir, imagesDir: join(dir, "images"), log: app.log });
  // Rows left `reserved` by a previous process were in flight when it stopped (Argus L2): list them as unresolved.
  const interrupted = markInterrupted(app.db);
  if (interrupted > 0) app.log?.(`marked ${interrupted} interrupted reservation(s) unresolved at start`);
  // A2: jobs left queued/running by a stopped process can never finish (there is no other runner for this data directory).
  const stranded = resetStrandedJobs(app.db);
  if (stranded > 0) app.log?.(`marked ${stranded} stranded run job(s) at start`);
  // Free key checks at app start (Amendment 1 item 19). Not awaited; failures show on the cards and in Settings.
  if (keys.status().set) void checkKey(app).catch(() => undefined);
  if (googleKeys.status().set) void checkGoogleKey(googleDepsOf(app)).catch(() => undefined);
  if (openaiKeys.status().set) void checkOpenAiKey(openaiDepsOf(app)).catch(() => undefined);
  return app;
}

/**
 * Server start (src/instrumentation.ts): open the app right away so the data-directory lock is taken, and the
 * startup sweep runs, before any request. A second server on the same data directory exits with a clear error.
 * A1 pin 19 (d), line 370 (Amendment 1 at 9a890fb): so does a server whose data directory is not writable, with a
 * message saying so (DataDirNotWritable), never that another server holds the lock (DataDirLocked).
 */
export function startApp(exit: (code: number) => void = (c) => process.exit(c)): AppDeps | null {
  try {
    return getApp();
  } catch (e) {
    if (e instanceof UsersConfigError) {
      console.error(`[rsr] refusing to start: ${e.message}`);
      exit(1);
      return null;
    }
    if (!(e instanceof DataDirLocked || e instanceof DataDirNotWritable || e instanceof DataDirLockFailed)) throw e;
    console.error(`[rsr] refusing to start: ${e.message}`);
    exit(1);
    return null;
  }
}
