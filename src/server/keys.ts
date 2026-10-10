// Server-side API key handling (TECH-PLAN-v1.md:79; Amendment 1 F7 / G5; A2 adds the Google store).
// - Every provider has its own store: xai -> data/secrets/xai_api_key + XAI_API_KEY; google ->
//   data/secrets/gemini_api_key + GEMINI_API_KEY. A key saved from the Settings page (mode 600) wins over
//   the provider's environment value (.env read by Docker).
// - The raw value leaves this module only inside a request header (authHeader) and is never returned,
//   logged, or rendered. Settings shows only the last 4 characters.
// - scrub() removes every known key value (both providers' saved/env values) and anything shaped like an
//   xAI or Google key from text before it is logged or shown.
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

export interface KeyStatus { set: boolean; source: "settings" | "env" | null; last4: string | null }

export class KeyRejectedInput extends Error {
  constructor(message: string) { super(message); this.name = "KeyRejectedInput"; }
}

const KEY_SHAPE = /^[A-Za-z0-9._-]{20,256}$/;
const XAI_KEY_PATTERN = /xai-[A-Za-z0-9]{16,}/g;
/** Google key shapes from the scan rules: classic API keys ("AIza" + 35) and newer auth keys ("AQ." + 20+). */
const GOOGLE_KEY_PATTERN = /AIza[0-9A-Za-z_-]{35}|AQ\.[A-Za-z0-9_-]{20,}/g;
/** Any bearer credential (e.g. an echoed Authorization header), whatever its format. */
const BEARER_PATTERN = /\b(Bearer)\s+[A-Za-z0-9._~+\/=-]+/gi;

export type KeyProvider = "xai" | "google";

const FILES: Readonly<Record<KeyProvider, string>> = Object.freeze({ xai: "xai_api_key", google: "gemini_api_key" });
const PRIMARY_ENV: Readonly<Record<KeyProvider, string>> = Object.freeze({ xai: "XAI_API_KEY", google: "GEMINI_API_KEY" });
const OTHER_ENV: Readonly<Record<KeyProvider, string[]>> = Object.freeze({ xai: ["GEMINI_API_KEY"], google: ["XAI_API_KEY"] });

export class KeyStore {
  readonly #file: string;
  readonly #provider: KeyProvider;
  readonly #envPrimary: string | null;
  readonly #envOthers: string[];

  constructor(opts: { secretsDir: string; env?: NodeJS.ProcessEnv; provider?: KeyProvider }) {
    const env = opts.env ?? process.env;
    this.#provider = opts.provider ?? "xai";
    this.#file = join(opts.secretsDir, FILES[this.#provider]);
    const p = env[PRIMARY_ENV[this.#provider]]?.trim();
    this.#envPrimary = p ? p : null;
    this.#envOthers = OTHER_ENV[this.#provider].map((n) => env[n]?.trim()).filter((v): v is string => !!v);
  }

  get provider(): KeyProvider { return this.#provider; }

  #saved(): string | null {
    if (!existsSync(this.#file)) return null;
    const v = readFileSync(this.#file, "utf8").trim();
    return v ? v : null;
  }

  #current(): { value: string; source: "settings" | "env" } | null {
    const s = this.#saved();
    if (s) return { value: s, source: "settings" };
    if (this.#envPrimary) return { value: this.#envPrimary, source: "env" };
    return null;
  }

  status(): KeyStatus {
    const c = this.#current();
    if (!c) return { set: false, source: null, last4: null };
    return { set: true, source: c.source, last4: c.value.length >= 20 ? c.value.slice(-4) : null };
  }

  /** Opaque id of the current key (changes when the key changes). Used to drop a cached key check. */
  fingerprint(): string | null {
    const c = this.#current();
    return c ? createHash("sha256").update(c.value).digest("hex").slice(0, 16) : null;
  }

  /** Only for building the outgoing request. Never log or return the result. */
  authHeader(): Record<string, string> {
    const c = this.#current();
    if (!c) throw new Error("No xAI key is set");
    return this.#provider === "google" ? { "x-goog-api-key": c.value } : { Authorization: `Bearer ${c.value}` };
  }

  /** Save a key from the Settings form: shape check, temp file (mode 600) -> fsync -> rename -> dir fsync. */
  save(raw: unknown): KeyStatus {
    const v = typeof raw === "string" ? raw.trim() : "";
    if (!KEY_SHAPE.test(v)) throw new KeyRejectedInput("That doesn't look like an API key (expected 20-256 letters, digits, dot, dash or underscore). Nothing was saved.");
    const dir = join(this.#file, "..");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const tmp = `${this.#file}.tmp-${process.pid}`;
    const fd = openSync(tmp, "w", 0o600);
    try { writeFileSync(fd, v + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.#file);
    const dfd = openSync(dir, "r");
    try { fsyncSync(dfd); } finally { closeSync(dfd); }
    return this.status();
  }

  scrub(s: string): string {
    let out = s;
    const vals = [this.#saved(), this.#envPrimary, ...this.#envOthers].filter((v): v is string => !!v && v.length >= 8);
    for (const v of vals) if (out.includes(v)) out = out.split(v).join("[REDACTED]");
    return out.replace(XAI_KEY_PATTERN, "[REDACTED]").replace(GOOGLE_KEY_PATTERN, "[REDACTED]").replace(BEARER_PATTERN, "$1 [REDACTED]");
  }
}
