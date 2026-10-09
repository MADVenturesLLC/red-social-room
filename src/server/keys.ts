// Server-side API key handling (TECH-PLAN-v1.md:79; Amendment 1 F7 / G5).
// - Sources: a key saved from the Settings page (data/secrets/xai_api_key, mode 600) wins over XAI_API_KEY
//   from the environment (.env read by Docker).
// - The raw value leaves this module only inside a request header (authHeader) and is never returned,
//   logged, or rendered. Settings shows only the last 4 characters.
// - scrub() removes every known key value (and anything shaped like an xAI key) from text before it is
//   logged or shown.
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

export interface KeyStatus { set: boolean; source: "settings" | "env" | null; last4: string | null }

export class KeyRejectedInput extends Error {
  constructor(message: string) { super(message); this.name = "KeyRejectedInput"; }
}

const KEY_SHAPE = /^[A-Za-z0-9._-]{20,256}$/;
const XAI_KEY_PATTERN = /xai-[A-Za-z0-9]{16,}/g;
/** Any bearer credential (e.g. an echoed Authorization header), whatever its format. */
const BEARER_PATTERN = /\b(Bearer)\s+[A-Za-z0-9._~+\/=-]+/gi;

export class KeyStore {
  readonly #file: string;
  readonly #envXai: string | null;
  readonly #envOthers: string[];

  constructor(opts: { secretsDir: string; env?: NodeJS.ProcessEnv }) {
    const env = opts.env ?? process.env;
    this.#file = join(opts.secretsDir, "xai_api_key");
    const x = env.XAI_API_KEY?.trim();
    this.#envXai = x ? x : null;
    this.#envOthers = [env.GEMINI_API_KEY?.trim()].filter((v): v is string => !!v);
  }

  #saved(): string | null {
    if (!existsSync(this.#file)) return null;
    const v = readFileSync(this.#file, "utf8").trim();
    return v ? v : null;
  }

  #current(): { value: string; source: "settings" | "env" } | null {
    const s = this.#saved();
    if (s) return { value: s, source: "settings" };
    if (this.#envXai) return { value: this.#envXai, source: "env" };
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
    return { Authorization: `Bearer ${c.value}` };
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
    const vals = [this.#saved(), this.#envXai, ...this.#envOthers].filter((v): v is string => !!v && v.length >= 8);
    for (const v of vals) if (out.includes(v)) out = out.split(v).join("[REDACTED]");
    return out.replace(XAI_KEY_PATTERN, "[REDACTED]").replace(BEARER_PATTERN, "$1 [REDACTED]");
  }
}
