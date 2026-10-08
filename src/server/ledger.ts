// Spend guard over the SQLite spend_ledger (Amendment 1 section 3.4, rows F20/F21; TECH-PLAN-v1.md:57).
// One shared monthly cap across all providers (FOUNDER-DECISIONS.md:5), America/New_York calendar month
// (item 17). The cap check and the reservation happen in ONE transaction (section 3.4 "Views").
// Money is integer micro-USD; conversions reuse the spike's rounding (spike/lib/ledger.ts toMicros: rounds up).
import { randomUUID } from "node:crypto";
import { currentMonthNY, isoNY, toMicros, MONTHLY_CAP_USD, WARN_FRACTION } from "../../spike/lib/ledger.ts";
import { tx, type DB } from "./db.ts";

export type CostSource = "billed_provider" | "estimated_tokens" | "estimated_price_table" | "assumed_zero_rejected" | "assumed_zero_429" | "not_sent" | "manual_reconcile";

export class CapRefused extends Error {
  readonly usedMicros: number; readonly capMicros: number; readonly heldMicros: number;
  constructor(message: string, used: number, cap: number, held: number) { super(message); this.name = "CapRefused"; this.usedMicros = used; this.capMicros = cap; this.heldMicros = held; }
}

export const fmtUsd = (micros: number): string => `$${(micros / 1e6).toFixed(2)}`;
export const fmtUsd4 = (micros: number): string => `$${(micros / 1e6).toFixed(4)}`;

/** "Nov 1, 12:00 AM ET" for the month after `monthNY` (F20 text). */
export function nextMonthStartText(monthNY: string): string {
  const [y, m] = monthNY.split("-").map(Number);
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[m % 12]} 1${m === 12 ? `, ${y + 1}` : ""}, 12:00 AM ET`;
}

export function capMicros(db: DB): number {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'monthly_cap_micro_usd'").get() as { value: string } | undefined;
  if (!row) return toMicros(MONTHLY_CAP_USD);
  const n = Number(row.value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("settings.monthly_cap_micro_usd is not a whole non-negative number; refusing to guess the cap");
  return n;
}

export function setCapUsd(db: DB, usd: number): void {
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0 || usd > 10_000) throw new RangeError("Cap must be a number between $0 and $10,000.");
  db.prepare("INSERT INTO settings (key, value) VALUES ('monthly_cap_micro_usd', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(toMicros(usd)));
}

export interface MonthTotals { monthNY: string; countedMicros: number; heldMicros: number; byProvider: Record<string, number>; capMicros: number; warn: boolean; unresolvedCount: number }

export function monthTotals(db: DB, monthNY = currentMonthNY()): MonthTotals {
  const t = db.prepare("SELECT COALESCE(SUM(counted_micro_usd),0) AS c, COALESCE(SUM(CASE WHEN status <> 'settled' THEN counted_micro_usd ELSE 0 END),0) AS h, COALESCE(SUM(status = 'unresolved'),0) AS u FROM spend_counted WHERE month_ny = ?").get(monthNY) as { c: number; h: number; u: number };
  const byProvider: Record<string, number> = {};
  for (const r of db.prepare("SELECT provider, counted_micro_usd FROM spend_by_month_provider WHERE month_ny = ?").all(monthNY) as Array<{ provider: string; counted_micro_usd: number }>) byProvider[r.provider] = r.counted_micro_usd;
  const cap = capMicros(db);
  return { monthNY, countedMicros: Number(t.c), heldMicros: Number(t.h), byProvider, capMicros: cap, warn: Number(t.c) >= Math.round(WARN_FRACTION * cap), unresolvedCount: Number(t.u) };
}

export interface ReserveInput {
  provider: "xai" | "google"; model: string; kind: "generate" | "edit" | "prompt_check"; resolution: string; quality: string | null;
  generationId: string; attempt: number; estimateMicros: number; estimateSource: string;
  now?: Date; // test seam for the month boundary
}

/**
 * Cap check + reservation in one BEGIN IMMEDIATE transaction (F20). Refuses (CapRefused, no row) when
 * counted month total + this estimate would pass the cap. A refusal is logged as an event, not a ledger row.
 * Returns the new row id, which is the call's client_request_id (item 3).
 */
export function reserve(db: DB, p: ReserveInput): { id: string; warn: boolean } {
  if (!Number.isSafeInteger(p.estimateMicros) || p.estimateMicros <= 0) throw new CapRefused(`No positive cost estimate for this call; refusing to send an unpriced call.`, 0, 0, 0);
  const now = p.now ?? new Date();
  const month = currentMonthNY(now);
  let refused: CapRefused | null = null;
  const out = tx(db, () => {
    const t = db.prepare("SELECT COALESCE(SUM(counted_micro_usd),0) AS c, COALESCE(SUM(CASE WHEN status <> 'settled' THEN counted_micro_usd ELSE 0 END),0) AS h FROM spend_counted WHERE month_ny = ?").get(month) as { c: number; h: number };
    const used = Number(t.c), held = Number(t.h);
    const cap = capMicros(db);
    if (used + p.estimateMicros > cap) {
      const heldText = held > 0 ? `, including ${fmtUsd(held)} held for unchecked calls` : "";
      refused = new CapRefused(`Monthly cap ${fmtUsd(cap)} reached (${fmtUsd(used)} counted across xAI and Google${heldText}). Raise the cap in Settings or wait until ${nextMonthStartText(month)}.`, used, cap, held);
      db.prepare("INSERT INTO events (created_at, kind, detail) VALUES (?, 'cap_refused', ?)").run(isoNY(now), JSON.stringify({ provider: p.provider, model: p.model, kind: p.kind, estimate_micro_usd: p.estimateMicros, used_micro_usd: used, cap_micro_usd: cap, generation_id: p.generationId }));
      return null;
    }
    const id = randomUUID();
    db.prepare(`INSERT INTO spend_ledger (id, created_at, month_ny, provider, model, kind, resolution, quality, generation_id, attempt, estimate_micro_usd, estimate_source, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved')`).run(id, isoNY(now), month, p.provider, p.model, p.kind, p.resolution, p.quality, p.generationId, p.attempt, p.estimateMicros, p.estimateSource);
    return { id, warn: used + p.estimateMicros >= Math.round(WARN_FRACTION * cap) };
  });
  if (refused) throw refused;
  return out!;
}

export interface SettleInput { actualMicros: number; costSource: CostSource; costDetail?: string | null; providerRequestId?: string | null; providerTrace?: string | null; httpStatus: number | null; outcome: string; note?: string | null }

export function settle(db: DB, id: string, s: SettleInput): void {
  if (!Number.isSafeInteger(s.actualMicros) || s.actualMicros < 0) throw new RangeError(`actual cost for ${id} must be whole micro-USD >= 0`);
  const r = db.prepare(`UPDATE spend_ledger SET status = 'settled', actual_micro_usd = ?, cost_source = ?, cost_detail = ?, provider_request_id = ?, provider_trace = ?, http_status = ?, outcome = ?, settled_at = ?, note = ? WHERE id = ? AND status = 'reserved'`)
    .run(s.actualMicros, s.costSource, s.costDetail ?? null, s.providerRequestId ?? null, s.providerTrace ?? null, s.httpStatus, s.outcome, isoNY(), s.note ?? null, id);
  if (Number(r.changes) !== 1) throw new RowNotReserved(db, id, "not settled");
  if (s.costSource === "billed_provider") notePriceDrift(db, id);
}

/** Amendment 1 item 2(e) / F22 (line 205): a bill more than $0.005 over its reservation. */
export const PRICE_DRIFT_MICROS = 5_000;

/**
 * F22: when the billed amount exceeds the reservation by more than $0.005, record a `price_drift` event with
 * both numbers for Settings -> Spend. The ledger keeps the billed amount (settle above); prices.json is never
 * changed automatically. The next reservation already rises to the highest bill via item 2(d) (prices.ts).
 * A1 pin 2, line 353: this is what catches xAI billing medium ($0.06) instead of low ($0.04).
 */
function notePriceDrift(db: DB, id: string): void {
  const row = db.prepare("SELECT provider, model, kind, resolution, quality, estimate_micro_usd AS est, actual_micro_usd AS act, provider_request_id FROM spend_ledger WHERE id = ?").get(id) as
    { provider: string; model: string; kind: string; resolution: string | null; quality: string | null; est: number; act: number; provider_request_id: string | null };
  if (row.act - row.est <= PRICE_DRIFT_MICROS) return;
  db.prepare("INSERT INTO events (created_at, kind, detail) VALUES (?, 'price_drift', ?)").run(isoNY(), JSON.stringify({
    ledger_id: id, provider: row.provider, model: row.model, kind: row.kind, resolution: row.resolution, quality: row.quality,
    reserved_micro_usd: row.est, billed_micro_usd: row.act, provider_request_id: row.provider_request_id,
  }));
}

export interface PriceDrift { at: string; ledgerId: string; text: string }

/** Recent F22 notices, newest first, as Settings -> Spend shows them. */
export function priceDrifts(db: DB, limit = 20): PriceDrift[] {
  const rows = db.prepare("SELECT created_at, detail FROM events WHERE kind = 'price_drift' ORDER BY id DESC LIMIT ?").all(limit) as Array<{ created_at: string; detail: string }>;
  return rows.map((r) => {
    const d = JSON.parse(r.detail) as { ledger_id: string; provider: string; model: string; kind: string; resolution: string | null; quality: string | null; reserved_micro_usd: number; billed_micro_usd: number };
    const who = d.provider === "xai" ? "xAI" : d.provider === "google" ? "Google" : d.provider;
    const key = [d.kind, [d.resolution, d.quality].filter(Boolean).join("/")].filter(Boolean).join(" ");
    return { at: r.created_at, ledgerId: d.ledger_id, text: `Price drift: ${who} ${d.model} ${key} billed ${fmtUsd4(d.billed_micro_usd)} against a ${fmtUsd4(d.reserved_micro_usd)} reservation (Ref ${d.ledger_id.slice(0, 8)}). prices.json was not changed; the next reservation uses the higher bill.` };
  });
}

/** Cost unknown after a possible send (G3): keep the full reservation counted until Michael reconciles it. */
export function markUnresolved(db: DB, id: string, s: { reason: string; providerRequestId?: string | null; providerTrace?: string | null; httpStatus: number | null; outcome: string; note?: string | null }): void {
  const r = db.prepare(`UPDATE spend_ledger SET status = 'unresolved', cost_detail = ?, provider_request_id = ?, provider_trace = ?, http_status = ?, outcome = ?, note = ? WHERE id = ? AND status = 'reserved'`)
    .run(JSON.stringify({ reason: s.reason }), s.providerRequestId ?? null, s.providerTrace ?? null, s.httpStatus, s.outcome, s.note ?? null, id);
  if (Number(r.changes) !== 1) throw new RowNotReserved(db, id, "not marked unresolved");
}

/** settle()/markUnresolved() found the row already out of `reserved` (Argus L1 on f63676e: for example a startup
 *  sweep marked it interrupted). The row is left as it is; the caller records the late result instead. */
export class RowNotReserved extends Error {
  readonly id: string;
  readonly rowStatus: string | null;
  constructor(db: DB, id: string, what: string) {
    const row = db.prepare("SELECT status FROM spend_ledger WHERE id = ?").get(id) as { status: string } | undefined;
    super(`ledger row ${id} is not in state reserved (${row?.status ?? "missing"}); ${what}`);
    this.name = "RowNotReserved";
    this.id = id;
    this.rowStatus = row?.status ?? null;
  }
}

export interface LateResult {
  httpStatus: number | null; outcome: string; providerRequestId: string | null; providerTrace: string | null;
  actualMicros: number | null; costSource: string | null; reason: string; note: string | null;
}

/**
 * Argus L1 on f63676e: a call came back after its row had already left `reserved`. The real outcome (status,
 * provider request id, bill) goes into a `late_result` event so reconciling still has it; the ledger row is not
 * touched, so the cap keeps counting it exactly as it stands (an unresolved row at its full estimate, a settled row
 * at its settled amount). Returns what the row counts now.
 */
export function recordLateResult(db: DB, id: string, r: LateResult): { status: string | null; countedMicros: number; actualMicros: number | null; costSource: string | null } {
  const row = db.prepare("SELECT status, outcome, estimate_micro_usd AS est, actual_micro_usd AS act, cost_source FROM spend_ledger WHERE id = ?").get(id) as
    { status: string; outcome: string | null; est: number; act: number | null; cost_source: string | null } | undefined;
  db.prepare("INSERT INTO events (created_at, kind, detail) VALUES (?, 'late_result', ?)").run(isoNY(), JSON.stringify({
    ledger_id: id, row_status: row?.status ?? null, row_outcome: row?.outcome ?? null,
    http_status: r.httpStatus, outcome: r.outcome, provider_request_id: r.providerRequestId, provider_trace: r.providerTrace,
    actual_micro_usd: r.actualMicros, cost_source: r.costSource, reason: r.reason, note: r.note,
  }));
  if (!row) return { status: null, countedMicros: 0, actualMicros: null, costSource: null };
  const settled = row.status === "settled";
  return { status: row.status, countedMicros: settled ? Number(row.act) : Number(row.est), actualMicros: settled ? Number(row.act) : null, costSource: settled ? row.cost_source : null };
}

/**
 * Argus L2 on fa3d359: a row still `reserved` when the app starts belongs to a call that was in flight when the
 * process stopped. Only one server runs per data directory (the lock in lock.ts, Argus L1 on f63676e), so no live
 * call can be swept. Mark each `unresolved` ("interrupted") so it shows
 * in Settings -> Unresolved for reconciling; its estimate keeps counting against the cap either way.
 */
export function markInterrupted(db: DB): number {
  const r = db.prepare(`UPDATE spend_ledger SET status = 'unresolved', outcome = 'interrupted', cost_detail = ?, note = ? WHERE status = 'reserved'`)
    .run(JSON.stringify({ reason: "unresolved: the app stopped while this call was in flight; reservation kept" }), "interrupted: still reserved at app start");
  return Number(r.changes);
}

/** Highest settled bill for the same price key (Amendment 1 item 2d). 0 if none. */
export function highestBillMicros(db: DB, k: { provider: string; model: string; kind: string; resolution: string; quality: string | null }): number {
  const r = db.prepare(`SELECT COALESCE(MAX(actual_micro_usd),0) AS m FROM spend_ledger WHERE status = 'settled' AND cost_source = 'billed_provider'
    AND provider = ? AND model = ? AND kind = ? AND resolution IS ? AND quality IS ?`).get(k.provider, k.model, k.kind, k.resolution, k.quality) as { m: number };
  return Number(r.m);
}

export function unresolvedRows(db: DB): Array<{ id: string; created_at: string; provider: string; model: string; estimate_micro_usd: number; http_status: number | null; outcome: string | null }> {
  return db.prepare("SELECT id, created_at, provider, model, estimate_micro_usd, http_status, outcome FROM spend_ledger WHERE status = 'unresolved' ORDER BY created_at").all() as never;
}
