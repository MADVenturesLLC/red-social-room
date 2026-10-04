// Minimal spend guard for Act 0, modeled on TECH-PLAN-v1.md section 7 "Cost cap reached" (line 165)
// and the Founder decision (one shared $50/month cap across ALL providers, no per-provider cap).
//
// - Ledger is a local JSON file (stand-in for the planned SQLite `spend_ledger` table, plan line 78).
// - Before every call: under an exclusive lock, sum (reserved + spent) across all providers,
//   add this call's estimate, and REFUSE before sending if it would pass the monthly cap.
//   Spike-only extra rule: also refuse if the spike's all-time total would pass $3.
// - The estimate is written as a reservation in the same locked step ("transaction").
// - After the call, the reservation is replaced by the actual cost (or kept if unknown).
// - All cap arithmetic is done in integer micro-USD (1 USD = 1_000_000), so float error cannot
//   shift a cap edge (Argus F9; Amendment section 3.4).
// - The ledger file is never created implicitly: a missing file fails closed (Argus F7).
//   Create one only with `node spike/ledger-init.ts`.
// - A settled row is final (append-only spirit, Amendment section 3.4): settle()/markUnresolved()
//   refuse to overwrite it. Reserved/unresolved rows are resolved by reconcile() (Argus F6).
import { openSync, closeSync, writeFileSync, readFileSync, renameSync, fsyncSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export const MONTHLY_CAP_USD = 50; // Founder decision 2026-10-03 (FOUNDER-DECISIONS.md:5, plan :17, :57, :165)
export const SPIKE_CAP_USD = 3; // Spike-only hard stop from the A0 brief (not yet in a contract doc; see REPORT "Known limits")
export const WARN_FRACTION = 0.8; // plan :165 "A warning shows at 80%"
export const MICROS_PER_USD = 1_000_000;

/** settle()/markUnresolved()/reconcile() wait this long for the lock (bounded; Argus F3). reserve() never waits. */
export const SETTLE_LOCK_RETRIES = 100;
export const SETTLE_LOCK_RETRY_MS = 50; // 100 x 50 ms = ~5 s total (pinned by a test)

/** Recovery for a stale lock (a crashed run leaves the lock file behind; there is no TTL). */
export const STALE_LOCK_HELP = "If no spike script is running, the lock is stale (left by a crashed run): delete spike-results/ledger.lock and retry.";

export type Provider = "xai" | "google";
export type EntryStatus = "reserved" | "settled" | "unresolved";

export interface LedgerEntry {
  id: string;
  created_at: string; // ISO with offset
  month: string; // YYYY-MM in America/New_York (see PLAN-GAPS: cap month timezone)
  provider: Provider;
  model: string;
  label: string;
  estimate_usd: number;
  estimate_basis: string;
  status: EntryStatus;
  actual_usd: number | null;
  cost_basis: string | null; // "billed: ..." or "estimated: ..." or "manual_reconcile: ..." or reason it is unresolved
  http_status: number | null;
  spike: true;
  // Set only by reconcile(): the row's state before the manual resolution, kept for audit.
  reconciled_at?: string;
  prior_status?: EntryStatus;
  prior_cost_basis?: string | null;
}

interface LedgerFile { version: 1; monthly_cap_usd: number; spike_cap_usd: number; entries: LedgerEntry[] }

export class SpendRefused extends Error {
  constructor(message: string) { super(message); this.name = "SpendRefused"; }
}
/** The ledger file does not exist. Never auto-created: that would silently reset cap history. */
export class LedgerMissing extends Error {
  constructor(message: string) { super(message); this.name = "LedgerMissing"; }
}
/** The lock stayed busy for the whole bounded wait while recording a result. */
export class LedgerBusy extends Error {
  constructor(message: string) { super(message); this.name = "LedgerBusy"; }
}

export interface LedgerOptions {
  monthlyCapUsd?: number; // tests only; defaults to MONTHLY_CAP_USD
  spikeCapUsd?: number; // tests only; defaults to SPIKE_CAP_USD
  settleLockRetries?: number;
  settleLockRetryMs?: number;
  /** Test seam for the bounded lock wait (defaults to a real blocking sleep). */
  sleep?: (ms: number) => void;
}

export function currentMonthNY(d = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit" }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  return `${y}-${m}`;
}

/**
 * USD -> integer micro-USD, rounded UP (Argus N6): a reservation or cost can never round down to less
 * than it is, e.g. an estimate of $0.0000001 reserves 1 micro-USD, not 0. The 1e-6 slack only absorbs
 * binary float noise (0.07 * 1e6 = 70000.00000000001 stays 70000).
 */
export function toMicros(usd: number): number { return Math.ceil(usd * MICROS_PER_USD - 1e-6) || 0; } // "|| 0" turns -0 into 0
export function fromMicros(m: number): number { return m / MICROS_PER_USD; }

/** The amount (integer micro-USD) an entry currently counts against the cap. Reserved/unresolved rows keep their estimate. */
export function countedMicros(e: LedgerEntry): number {
  if (e.status === "settled" && e.actual_usd !== null) return toMicros(e.actual_usd);
  return toMicros(e.estimate_usd);
}
export function countedUsd(e: LedgerEntry): number { return fromMicros(countedMicros(e)); }

/** Largest amount whose micro-USD value is still an exact integer in a JS number (~$9.0e9). */
export const MAX_USD = Math.floor(Number.MAX_SAFE_INTEGER / MICROS_PER_USD);

/** A cost must be a finite number >= 0 (Argus F4: -10 or NaN must never reach the ledger). */
export function assertValidUsd(usd: unknown, what: string): asserts usd is number {
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0 || usd > MAX_USD) {
    throw new RangeError(`${what} must be a finite number >= 0 (and <= ${MAX_USD}); got ${String(usd)}. Ledger not changed.`);
  }
}

/** Ledger file failed validation on load. Nothing is sent while the ledger is in this state. */
export class LedgerCorrupt extends Error {
  constructor(message: string) { super(message); this.name = "LedgerCorrupt"; }
}

const STATUSES: readonly EntryStatus[] = ["reserved", "settled", "unresolved"];
const PROVIDERS: readonly Provider[] = ["xai", "google"];
/** True if `v` is a USD amount >= 0 that is an exact whole number of micro-USD (what the ledger always writes). */
function isMicroAmount(v: unknown): v is number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > MAX_USD) return false;
  const x = v * MICROS_PER_USD;
  return Math.abs(x - Math.round(x)) < 1e-6;
}

/**
 * Validate a parsed ledger file row by row (Argus N1). A hand-edited or corrupted row must fail CLOSED:
 * before this, a missing amount gave NaN totals and `NaN > cap` is false, so a send was allowed.
 * Returns a list of problems ("row 3 (id beb67d2b): actual_usd ..."); empty means valid.
 */
export function validateLedgerFile(f: unknown): string[] {
  const errs: string[] = [];
  const o = f as Partial<LedgerFile> | null;
  if (!o || typeof o !== "object" || Array.isArray(o)) return ["top level is not an object"];
  if (o.version !== 1) errs.push(`version must be 1 (got ${JSON.stringify(o.version)})`);
  if (!isMicroAmount(o.monthly_cap_usd)) errs.push("monthly_cap_usd must be a non-negative micro-USD amount");
  if (!isMicroAmount(o.spike_cap_usd)) errs.push("spike_cap_usd must be a non-negative micro-USD amount");
  if (!Array.isArray(o.entries)) { errs.push("entries must be an array"); return errs; }
  const seen = new Set<string>();
  o.entries.forEach((raw, i) => {
    const e = raw as Partial<LedgerEntry> | null;
    const at = `row ${i}${e && typeof e === "object" && typeof e.id === "string" ? ` (id ${e.id.slice(0, 8)})` : ""}`;
    const bad = (m: string) => errs.push(`${at}: ${m}`);
    if (!e || typeof e !== "object" || Array.isArray(e)) { bad("not an object"); return; }
    if (typeof e.id !== "string" || !e.id) bad("id must be a non-empty string");
    else if (seen.has(e.id)) bad("duplicate id"); else seen.add(e.id);
    if (typeof e.created_at !== "string" || !e.created_at) bad("created_at must be a string");
    if (typeof e.month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(e.month)) bad("month must be a YYYY-MM string");
    if (!PROVIDERS.includes(e.provider as Provider)) bad(`provider must be one of ${PROVIDERS.join("/")}`);
    if (typeof e.model !== "string") bad("model must be a string");
    if (typeof e.label !== "string") bad("label must be a string");
    if (typeof e.estimate_basis !== "string") bad("estimate_basis must be a string");
    if (!isMicroAmount(e.estimate_usd) || e.estimate_usd === 0) bad("estimate_usd must be a positive whole number of micro-USD");
    if (!STATUSES.includes(e.status as EntryStatus)) bad(`status must be one of ${STATUSES.join("/")}`);
    if (e.status === "settled") { if (!isMicroAmount(e.actual_usd)) bad("a settled row needs actual_usd >= 0 in whole micro-USD"); }
    else if (e.actual_usd !== null) bad(`a ${String(e.status)} row must have actual_usd null`);
    if (e.cost_basis !== null && typeof e.cost_basis !== "string") bad("cost_basis must be a string or null");
    if (e.http_status !== null && !(Number.isInteger(e.http_status) && (e.http_status as number) >= 100 && (e.http_status as number) <= 599)) bad("http_status must be null or an HTTP status code");
    if (e.spike !== true) bad("spike must be true (only spike rows exist in this ledger)");
    if (e.prior_status !== undefined && !STATUSES.includes(e.prior_status)) bad("prior_status is not a known status");
  });
  return errs;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function fsyncDir(dir: string): void {
  const fd = openSync(dir, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function writeAtomic(path: string, f: LedgerFile, exclusive = false): void {
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, "w");
  try {
    writeFileSync(fd, JSON.stringify(f, null, 2) + "\n");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  if (exclusive && existsSync(path)) { unlinkSync(tmp); throw new Error(`${path} already exists; refusing to overwrite it.`); }
  renameSync(tmp, path); // atomic replace
  fsyncDir(dirname(path)); // make the rename itself durable (Argus F7)
}

export class Ledger {
  readonly path: string;
  readonly lockPath: string;
  private readonly monthlyCapMicros: number;
  private readonly spikeCapMicros: number;
  private readonly settleRetries: number;
  private readonly settleRetryMs: number;
  private readonly sleep: (ms: number) => void;

  /** Opens an EXISTING ledger. Throws LedgerMissing (fail closed) if the file is absent. */
  constructor(path: string, opts: LedgerOptions = {}) {
    this.path = path;
    this.lockPath = path.replace(/\.json$/, "") + ".lock";
    this.monthlyCapMicros = toMicros(opts.monthlyCapUsd ?? MONTHLY_CAP_USD);
    this.spikeCapMicros = toMicros(opts.spikeCapUsd ?? SPIKE_CAP_USD);
    this.settleRetries = opts.settleLockRetries ?? SETTLE_LOCK_RETRIES;
    this.settleRetryMs = opts.settleLockRetryMs ?? SETTLE_LOCK_RETRY_MS;
    this.sleep = opts.sleep ?? sleepSync;
    if (!existsSync(path)) {
      throw new LedgerMissing(`Spend ledger ${path} does not exist. Refusing to start with an empty history (that would reset the cap). If this is genuinely the first run, create it with: node spike/ledger-init.ts`);
    }
    this.read(); // validate shape now, before anything is sent
  }

  /** Explicit init: creates a new empty ledger. Refuses if one already exists. */
  static init(path: string, opts: LedgerOptions = {}): Ledger {
    if (existsSync(path)) throw new Error(`${path} already exists; refusing to overwrite it.`);
    mkdirSync(dirname(path), { recursive: true });
    writeAtomic(path, { version: 1, monthly_cap_usd: opts.monthlyCapUsd ?? MONTHLY_CAP_USD, spike_cap_usd: opts.spikeCapUsd ?? SPIKE_CAP_USD, entries: [] }, true);
    return new Ledger(path, opts);
  }

  /** Every read (totals, reserve, settle, report) validates the whole file and fails closed (Argus N1). */
  private read(): LedgerFile {
    let f: unknown;
    try { f = JSON.parse(readFileSync(this.path, "utf8")); } catch (e) {
      throw new LedgerCorrupt(`${this.path} is not valid JSON (${(e as Error).message}); refusing to use it. Nothing was sent.`);
    }
    const errs = validateLedgerFile(f);
    if (errs.length) {
      throw new LedgerCorrupt(`${this.path} failed validation; refusing to use it and nothing was sent. Fix or restore the file (git show HEAD:spike-results/ledger.json). Problems: ${errs.slice(0, 10).join("; ")}${errs.length > 10 ? `; ... ${errs.length - 10} more` : ""}`);
    }
    return f as LedgerFile;
  }

  /**
   * Exclusive lock (O_EXCL create). With retries=0 it fails at once (reserve(): nothing is sent
   * without the check). With retries>0 it waits a bounded time (recording a result that already
   * happened must not be lost to a momentary lock; Argus F3).
   */
  private withLock<T>(fn: (f: LedgerFile) => T, retries: number, retryMs: number, onBusy: (waitedMs: number) => Error, sleep: (ms: number) => void = sleepSync): T {
    let fd = -1;
    for (let i = 0; fd < 0; i++) {
      try { fd = openSync(this.lockPath, "wx"); } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        if (i >= retries) throw onBusy(i * retryMs);
        sleep(retryMs);
      }
    }
    try {
      const f = this.read();
      const out = fn(f);
      writeAtomic(this.path, f);
      return out;
    } finally {
      closeSync(fd);
      unlinkSync(this.lockPath);
    }
  }

  private withSettleLock<T>(what: string, id: string, fn: (f: LedgerFile) => T): T {
    return this.withLock(fn, this.settleRetries, this.settleRetryMs, (waited) => new LedgerBusy(
      `Spend ledger stayed locked (${this.lockPath}) for ~${waited} ms while trying to ${what} entry ${id}. The entry is still counted at its estimate, so the cap is safe. ${STALE_LOCK_HELP} Then record the real cost with: node spike/ledger-reconcile.ts ${id} <usd>|not-charged "<note>" (reconcile needs the same lock, so it fails too until the lock is gone).`), this.sleep);
  }

  totals(month = currentMonthNY()): { month: number; spikeAllTime: number; byProvider: Record<string, number> } {
    const f = this.read();
    const byProvider: Record<string, number> = {};
    let m = 0, s = 0;
    for (const e of f.entries) {
      const c = countedMicros(e);
      if (e.month === month) { m += c; byProvider[e.provider] = (byProvider[e.provider] ?? 0) + c; }
      if (e.spike) s += c;
    }
    return { month: fromMicros(m), spikeAllTime: fromMicros(s), byProvider: Object.fromEntries(Object.entries(byProvider).map(([k, v]) => [k, fromMicros(v)])) };
  }

  /** Check + reserve atomically. Throws SpendRefused (nothing is sent) if any cap would be passed. */
  reserve(p: { provider: Provider; model: string; label: string; estimate_usd: number; estimate_basis: string }): LedgerEntry {
    if (!(typeof p.estimate_usd === "number" && Number.isFinite(p.estimate_usd) && p.estimate_usd > 0)) {
      throw new SpendRefused(`No positive cost estimate for ${p.label}; refusing to send an unpriced call.`);
    }
    const est = toMicros(p.estimate_usd); // rounded UP (N6)
    if (!(est > 0) || p.estimate_usd > MAX_USD) throw new SpendRefused(`Estimate for ${p.label} is not a usable positive amount; refusing to send.`);
    return this.withLock((f) => {
      const month = currentMonthNY();
      let monthUsed = 0, spikeUsed = 0;
      for (const e of f.entries) {
        if (e.month === month) monthUsed += countedMicros(e);
        if (e.spike) spikeUsed += countedMicros(e);
      }
      const usd = (m: number) => fromMicros(m).toFixed(4);
      if (monthUsed + est > this.monthlyCapMicros) {
        throw new SpendRefused(`Monthly cap $${usd(this.monthlyCapMicros)} reached ($${usd(monthUsed)} used across all providers; this call est. $${usd(est)}). Refused before sending.`);
      }
      if (spikeUsed + est > this.spikeCapMicros) {
        throw new SpendRefused(`Spike cap $${usd(this.spikeCapMicros)} reached ($${usd(spikeUsed)} used; this call est. $${usd(est)}). Refused before sending.`);
      }
      if (monthUsed + est >= Math.round(WARN_FRACTION * this.monthlyCapMicros)) {
        console.warn(`WARNING: monthly spend would reach ${(100 * (monthUsed + est) / this.monthlyCapMicros).toFixed(0)}% of the $${usd(this.monthlyCapMicros)} cap.`);
      }
      const entry: LedgerEntry = {
        id: randomUUID(), created_at: isoNY(), month, provider: p.provider, model: p.model, label: p.label,
        estimate_usd: fromMicros(est), estimate_basis: p.estimate_basis, status: "reserved", actual_usd: null,
        cost_basis: null, http_status: null, spike: true,
      };
      f.entries.push(entry);
      return entry;
    }, 0, 0, () => new SpendRefused(`Spend ledger is locked (${this.lockPath}). Another call is in flight or a previous run crashed; refusing to send. ${STALE_LOCK_HELP}`));
  }

  /** Replace a reservation with the actual cost. Refuses invalid amounts and already-settled rows. */
  settle(id: string, actual_usd: number, cost_basis: string, http_status: number | null): void {
    assertValidUsd(actual_usd, `actual cost for ledger entry ${id}`);
    this.withSettleLock("settle", id, (f) => {
      const e = findEntry(f, id);
      if (e.status === "settled") throw new Error(`ledger entry ${id} is already settled ($${e.actual_usd}); refusing to overwrite it.`);
      e.status = "settled"; e.actual_usd = fromMicros(toMicros(actual_usd)); e.cost_basis = cost_basis; e.http_status = http_status;
    });
  }

  /** Cost is unknown (e.g. timeout after the request was sent): keep the reservation counted against the cap. */
  markUnresolved(id: string, reason: string, http_status: number | null): void {
    this.withSettleLock("mark unresolved", id, (f) => {
      const e = findEntry(f, id);
      if (e.status === "settled") throw new Error(`ledger entry ${id} is already settled; refusing to mark it unresolved.`);
      e.status = "unresolved"; e.cost_basis = reason; e.http_status = http_status;
    });
  }

  /**
   * Manual resolution of a reserved/unresolved row after a console check (Amendment F21).
   * `idOrPrefix` may be a unique prefix of at least 8 characters. Settled rows are refused.
   */
  reconcile(idOrPrefix: string, actual_usd: number, note: string): LedgerEntry {
    assertValidUsd(actual_usd, "reconciled amount");
    if (!note.trim()) throw new Error("reconcile needs a note saying what was checked (e.g. 'console.x.ai shows no charge')");
    return this.withSettleLock("reconcile", idOrPrefix, (f) => {
      const e = findEntry(f, idOrPrefix, true);
      if (e.status === "settled") throw new Error(`ledger entry ${e.id} is already settled ($${e.actual_usd}); refusing to overwrite it.`);
      e.prior_status = e.status; e.prior_cost_basis = e.cost_basis;
      e.status = "settled"; e.actual_usd = fromMicros(toMicros(actual_usd));
      e.cost_basis = `manual_reconcile: ${note.trim()}`; e.reconciled_at = isoNY();
      return { ...e };
    });
  }

  entries(): LedgerEntry[] { return this.read().entries; }
}

function findEntry(f: LedgerFile, idOrPrefix: string, allowPrefix = false): LedgerEntry {
  const exact = f.entries.find((x) => x.id === idOrPrefix);
  if (exact) return exact;
  if (allowPrefix && idOrPrefix.length >= 8) {
    const m = f.entries.filter((x) => x.id.startsWith(idOrPrefix));
    if (m.length === 1) return m[0];
    if (m.length > 1) throw new Error(`ledger id prefix ${idOrPrefix} is ambiguous (${m.length} entries)`);
  }
  throw new Error(`ledger entry ${idOrPrefix} not found`);
}

export function round(n: number): number { return fromMicros(toMicros(n)); }

export function isoNY(d = new Date()): string {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZoneName: "shortOffset" }).formatToParts(d);
  const g = (t: string) => f.find((p) => p.type === t)?.value ?? "";
  const off = g("timeZoneName").replace("GMT", "") || "+0";
  const m = off.match(/^([+-])(\d{1,2})(?::(\d{2}))?$/);
  const offset = m ? `${m[1]}${m[2].padStart(2, "0")}:${m[3] ?? "00"}` : "+00:00";
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}:${g("second")}${offset}`;
}
