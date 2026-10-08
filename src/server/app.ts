// Process-wide app instance for the Next.js server (route handlers and server pages).
// Holds the DB, the key store, the switches, the price table and the key-check cache.
import { join } from "node:path";
import { dataDir, loadSwitches, REPO_ROOT } from "./config.ts";
import { openDb } from "./db.ts";
import { KeyStore } from "./keys.ts";
import { loadPrices } from "./prices.ts";
import { nameListMethod } from "./prompt-check.ts";
import { checkKey, type KeyCheckCache } from "./xai/adapter.ts";
import type { AppDeps } from "./generate.ts";

/** Test-only override of the xAI base URL. Accepted only for a loopback http URL, so a stray env value
 *  can never send the key to another host. */
export function xaiBaseUrlFromEnv(v: string | undefined): string | undefined {
  if (!v) return undefined;
  if (/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(v)) return v;
  throw new Error("RSR_XAI_BASE_URL may only point at http://127.0.0.1:<port> (tests). Unset it for real use.");
}

type G = typeof globalThis & { __rsrApp?: AppDeps };

export function getApp(): AppDeps {
  const g = globalThis as G;
  if (g.__rsrApp) return g.__rsrApp;
  const dir = dataDir();
  const keys = new KeyStore({ secretsDir: join(dir, "secrets") });
  const keyCheck: KeyCheckCache = { fingerprint: null, ok: false, versionListing: null };
  const app: AppDeps = {
    db: openDb(join(dir, "db", "rsr.sqlite")),
    keys,
    prices: loadPrices(),
    switches: loadSwitches(),
    fetch: (url, init) => fetch(url, init),
    baseUrl: xaiBaseUrlFromEnv(process.env.RSR_XAI_BASE_URL),
    timeoutMs: process.env.RSR_XAI_BASE_URL && process.env.RSR_TEST_TIMEOUT_MS ? Number(process.env.RSR_TEST_TIMEOUT_MS) : undefined,
    keyCheck,
    imagesDir: join(dir, "images"),
    promptMethod: nameListMethod(join(REPO_ROOT, "config", "real-person-names.txt")),
    log: (m) => console.log(`[rsr] ${new Date().toISOString()} ${keys.scrub(m)}`),
  };
  g.__rsrApp = app;
  // Free key check at app start (Amendment 1 item 19). Not awaited; failures show on the card and in Settings.
  if (keys.status().set) void checkKey(app).catch(() => undefined);
  return app;
}
