// Runs one paid call: spend-guard reservation -> HTTP call -> redacted dump + caller's outputs -> settle ledger.
// Outputs are written BEFORE the ledger is touched again, so a ledger problem after a paid call
// (busy lock, invalid cost) can never lose the paid result (Argus F3). The error is still rethrown.
import { join } from "node:path";
import { call, dump, type CallResult, type CallSpec } from "./http.ts";
import { Ledger, SpendRefused, type Provider } from "./ledger.ts";

export interface StepCost { usd: number | null; basis: string; billed: boolean }

export interface StepOutcome<P = unknown> {
  label: string;
  refusedBySpendGuard?: string;
  result?: CallResult;
  cost?: StepCost;
  persisted?: P; // whatever opts.persist returned (e.g. the saved image)
  /** update_failed = the ledger write threw after the call returned (error rethrown after recording). */
  ledgerStatus?: "settled" | "unresolved" | "update_failed";
  ledgerError?: string;
  stop: boolean; // section 7: stop the run (no retry loops) on 5xx / unresolved 429 / auth / quota / timeout
  stopReason?: string;
}

export const LEDGER_PATH = join(import.meta.dirname, "..", "..", "spike-results", "ledger.json");

export async function runPaidStep<P = undefined>(opts: {
  ledger: Ledger;
  provider: Provider;
  model: string;
  label: string;
  outDir: string;
  estimateUsd: number;
  estimateBasis: string;
  spec: CallSpec;
  costOf: (r: CallResult) => StepCost; // derive actual/estimated cost from the response
  log: (m: string) => void;
  dumpExtra?: Record<string, unknown>;
  /** Save outputs (e.g. the image) from the response. Runs before the ledger is settled. */
  persist?: (r: CallResult) => P;
  /**
   * Called with the step's outcome once the ledger is updated, or BEFORE rethrowing when the update failed,
   * so the script's results.json always describes THIS call, never a previous run's (Argus N3).
   */
  record?: (o: StepOutcome<P>) => void;
  /** Test seam: replaces the network call. Defaults to http.call. */
  doCall?: (spec: CallSpec) => Promise<CallResult>;
}): Promise<StepOutcome<P>> {
  const { ledger, log } = opts;
  let entry;
  try {
    entry = ledger.reserve({ provider: opts.provider, model: opts.model, label: opts.label, estimate_usd: opts.estimateUsd, estimate_basis: opts.estimateBasis });
  } catch (e) {
    if (e instanceof SpendRefused) {
      log(`SPEND GUARD REFUSED ${opts.label}: ${e.message}`);
      const o: StepOutcome<P> = { label: opts.label, refusedBySpendGuard: e.message, stop: true, stopReason: "spend guard" };
      opts.record?.(o);
      return o;
    }
    throw e;
  }
  const t = ledger.totals();
  log(`reserved $${opts.estimateUsd.toFixed(3)} for ${opts.label} (month total incl. reservation $${t.month.toFixed(3)}, spike $${t.spikeAllTime.toFixed(3)})`);

  const r = await (opts.doCall ?? call)(opts.spec);
  const cost = opts.costOf(r);

  // 1) Outputs first: the dump, then the caller's files. A failure here is held until the ledger is settled.
  const dumpPath = join(opts.outDir, `${opts.label}.json`);
  dump(dumpPath, opts.spec, r, { label: opts.label, provider: opts.provider, model_requested: opts.model, cost, ledger_entry_id: entry.id, ...(opts.dumpExtra ?? {}) });
  let persisted: P | undefined, persistErr: unknown = null;
  if (opts.persist) { try { persisted = opts.persist(r); } catch (e) { persistErr = e; } }

  let stop = false, stopReason: string | undefined;
  if (r.outcome === "timeout" || r.outcome === "connection_error") { stop = true; stopReason = r.outcome; }
  else if (r.status === 429) { stop = true; stopReason = "rate limited (429) after section-7 handling"; }
  else if (r.status !== null && r.status >= 500) { stop = true; stopReason = `provider ${r.status}`; }
  else if (r.status === 401 || r.status === 403 || r.status === 402) { stop = true; stopReason = `auth/quota ${r.status}`; }
  const o: StepOutcome<P> = { label: opts.label, result: r, cost, persisted, stop, stopReason };

  // 2) Record the cost (bounded lock wait inside the ledger). On failure, outputs are already on disk.
  try {
    if (cost.usd === null) ledger.markUnresolved(entry.id, cost.basis, r.status);
    else ledger.settle(entry.id, cost.usd, cost.basis, r.status);
    o.ledgerStatus = cost.usd === null ? "unresolved" : "settled";
  } catch (e) {
    o.ledgerStatus = "update_failed"; o.ledgerError = (e as Error).message;
    o.stop = true; o.stopReason = `ledger update failed: ${(e as Error).name}`;
    opts.record?.(o);
    log(`LEDGER UPDATE FAILED for ${opts.label} after the paid call returned: ${(e as Error).message} Outputs already written (${dumpPath}${opts.persist && !persistErr ? " and the step's files" : ""}); the step's results.json entry describes this call. Reservation ${entry.id} stays counted at its estimate.`);
    throw e;
  }
  opts.record?.(o);
  log(`${opts.label}: outcome=${r.outcome} status=${r.status} latency=${r.latency_ms}ms cost=${cost.usd === null ? "UNRESOLVED (reservation kept)" : `$${cost.usd.toFixed(4)}`} [${cost.basis}] retry=${r.retry_decision}`);
  if (persistErr) throw persistErr;
  return o;
}
