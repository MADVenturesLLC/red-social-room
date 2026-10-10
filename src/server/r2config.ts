// A7 (FD:6): where the nightly backup goes. The endpoint and bucket are ordinary settings rows; the two
// secrets live only in data/secrets/ as mode 600 files, exactly like the provider keys. Nothing here ever
// returns a secret: status() shows the endpoint, the bucket and the last 4 of the access key id only.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import type { DB } from "./db.ts";

export interface R2Config {
  endpoint: string;                                     // https://<account>.r2.cloudflarestorage.com
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface R2Status {
  configured: boolean;
  endpoint: string | null;
  bucket: string | null;
  keyLast4: string | null;
}

export class R2ConfigError extends Error {
  constructor(message: string) { super(message); this.name = "R2ConfigError"; }
}

// The keys are only ever sent to an R2 storage endpoint, never anywhere else.
const ENDPOINT_RE = /^https:\/\/[a-z0-9][a-z0-9.-]*\.r2\.cloudflarestorage\.com$/;
const BUCKET_RE = /^[a-z0-9][a-z0-9-]{1,61}$/;
const KEY_ID_RE = /^[A-Za-z0-9]{10,64}$/;
const SECRET_RE = /^[A-Za-z0-9+/=_-]{20,128}$/;

const ENDPOINT_KEY = "r2_endpoint";
const BUCKET_KEY = "r2_bucket";
const KEY_ID_FILE = "r2_access_key_id";
const SECRET_FILE = "r2_secret_access_key";

export function loadR2Config(db: DB, dataDir: string): R2Config | null {
  const get = (k: string) => (db.prepare("SELECT value FROM settings WHERE key = ?").get(k) as { value: string } | undefined)?.value ?? null;
  const endpoint = get(ENDPOINT_KEY);
  const bucket = get(BUCKET_KEY);
  const secrets = join(dataDir, "secrets");
  let accessKeyId: string | null = null, secretAccessKey: string | null = null;
  try {
    if (existsSync(join(secrets, KEY_ID_FILE))) accessKeyId = readFileSync(join(secrets, KEY_ID_FILE), "utf8").trim();
    if (existsSync(join(secrets, SECRET_FILE))) secretAccessKey = readFileSync(join(secrets, SECRET_FILE), "utf8").trim();
  } catch { return null; }
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  if (!ENDPOINT_RE.test(endpoint) || !BUCKET_RE.test(bucket)) return null;
  return { endpoint, bucket, accessKeyId, secretAccessKey };
}

/** Write one secret file atomically (tmp 600, then rename), like the provider key store does. */
function writeSecret(path: string, value: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, value, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function saveR2Config(db: DB, dataDir: string, input: { endpoint?: unknown; bucket?: unknown; accessKeyId?: unknown; secretAccessKey?: unknown }): R2Status {
  const endpoint = typeof input.endpoint === "string" ? input.endpoint.trim().replace(/\/+$/, "") : "";
  const bucket = typeof input.bucket === "string" ? input.bucket.trim() : "";
  const accessKeyId = typeof input.accessKeyId === "string" ? input.accessKeyId.trim() : "";
  const secretAccessKey = typeof input.secretAccessKey === "string" ? input.secretAccessKey.trim() : "";
  if (!ENDPOINT_RE.test(endpoint)) throw new R2ConfigError("The endpoint must look like https://<account>.r2.cloudflarestorage.com — copy it from the R2 page in Cloudflare.");
  if (!BUCKET_RE.test(bucket)) throw new R2ConfigError("The bucket name must be lowercase letters, digits and dashes (2-63 characters).");
  if (accessKeyId && !KEY_ID_RE.test(accessKeyId)) throw new R2ConfigError("The access key id does not look like an R2 key (letters and digits).");
  if (secretAccessKey && !SECRET_RE.test(secretAccessKey)) throw new R2ConfigError("The secret access key does not look like an R2 secret.");
  const secrets = join(dataDir, "secrets");
  if (accessKeyId) writeSecret(join(secrets, KEY_ID_FILE), accessKeyId);
  if (secretAccessKey) writeSecret(join(secrets, SECRET_FILE), secretAccessKey);
  try { mkdirSync(secrets, { recursive: true }); } catch { /* writeSecret already proved it */ }
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(ENDPOINT_KEY, endpoint);
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(BUCKET_KEY, bucket);
  return r2Status(db, dataDir);
}

export function clearR2Config(db: DB, dataDir: string): void {
  for (const f of [KEY_ID_FILE, SECRET_FILE]) { try { rmSync(join(dataDir, "secrets", f)); } catch { /* absent is fine */ } }
  db.prepare("DELETE FROM settings WHERE key IN (?, ?)").run(ENDPOINT_KEY, BUCKET_KEY);
}

export function r2Status(db: DB, dataDir: string): R2Status {
  const cfg = loadR2Config(db, dataDir);
  if (!cfg) {
    const get = (k: string) => (db.prepare("SELECT value FROM settings WHERE key = ?").get(k) as { value: string } | undefined)?.value ?? null;
    return { configured: false, endpoint: get(ENDPOINT_KEY), bucket: get(BUCKET_KEY), keyLast4: null };
  }
  return { configured: true, endpoint: cfg.endpoint, bucket: cfg.bucket, keyLast4: cfg.accessKeyId.slice(-4) };
}
