// Key handling for the spike. Rules (Founder brief + TECH-PLAN-v1.md section 3 "Secrets"):
// - keys come ONLY from the environment (XAI_API_KEY, GEMINI_API_KEY)
// - they are only ever placed into request headers
// - every string that leaves this process (console, log file, JSON dump) goes through scrub()
// The raw values are never exported from this module.

const KEY_ENV_NAMES = ["XAI_API_KEY", "GEMINI_API_KEY"] as const;
export type KeyName = (typeof KEY_ENV_NAMES)[number];

const values = new Map<KeyName, string>();
for (const name of KEY_ENV_NAMES) {
  const v = process.env[name];
  if (v && v.trim().length > 0) values.set(name, v.trim());
}

export function hasKey(name: KeyName): boolean {
  return values.has(name);
}

/** Only for building request headers. Never log the return value. */
export function authHeaders(name: KeyName): Record<string, string> {
  const v = values.get(name);
  if (!v) throw new Error(`${name} is not set in the environment`);
  if (name === "XAI_API_KEY") return { Authorization: `Bearer ${v}` };
  return { "x-goog-api-key": v };
}

/** Header names whose values are always replaced in dumps. */
export const SENSITIVE_HEADERS = new Set(["authorization", "x-goog-api-key", "cookie", "set-cookie", "proxy-authorization"]);

export function redactHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? "[REDACTED]" : scrub(v);
  return out;
}

/** Replace any occurrence of a key value with a placeholder. Compares in-process; never prints. */
export function scrub(s: string): string {
  let out = s;
  for (const [name, v] of values) {
    if (v.length >= 8 && out.includes(v)) out = out.split(v).join(`[REDACTED:${name}]`);
  }
  return out;
}

/** Returns per-key hit counts (full value only) for a text blob, without revealing values. */
export function countKeyHits(text: string): Record<KeyName, number> {
  const res = {} as Record<KeyName, number>;
  for (const name of KEY_ENV_NAMES) {
    const v = values.get(name);
    res[name] = v ? text.split(v).length - 1 : 0;
  }
  return res;
}

/** Needle kinds used by the leak scan: the full value, its base64 form, and three 12-char fragments. */
export const NEEDLE_KINDS = ["full", "base64", "head12", "mid12", "tail12"] as const;
export type NeedleKind = (typeof NEEDLE_KINDS)[number];

function needlesFor(v: string): Array<[NeedleKind, string]> {
  const out: Array<[NeedleKind, string]> = [["full", v], ["base64", Buffer.from(v).toString("base64")]];
  if (v.length >= 24) {
    const mid = Math.floor(v.length / 2);
    out.push(["head12", v.slice(0, 12)], ["mid12", v.slice(mid - 6, mid + 6)], ["tail12", v.slice(-12)]);
  }
  return out;
}

/** Per-key, per-needle-kind hit counts (fragments catch partial pastes). Counts only; values never leave. */
export function countKeyHitsDetailed(text: string): Record<string, Partial<Record<NeedleKind, number>>> {
  const res: Record<string, Partial<Record<NeedleKind, number>>> = {};
  for (const [name, v] of values) {
    for (const [kind, needle] of needlesFor(v)) {
      const n = text.split(needle).length - 1;
      if (n > 0) (res[name] ??= {})[kind] = n;
    }
  }
  return res;
}

export function loadedKeyNames(): KeyName[] {
  return [...values.keys()];
}

/** Positive control for the leak checker: builds blobs containing each key (and each fragment) in memory and confirms detection. */
export function leakCheckerSelfTest(): boolean {
  for (const [name, v] of values) {
    if (countKeyHits(`prefix ${v} suffix`)[name] !== 1) return false;
    if (scrub(`a${v}b`).includes(v)) return false;
    for (const [kind, needle] of needlesFor(v)) {
      if ((countKeyHitsDetailed(`<${needle}>`)[name]?.[kind] ?? 0) < 1) return false;
    }
  }
  return values.size > 0;
}
