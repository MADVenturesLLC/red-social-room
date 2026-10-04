// Manually resolve a reserved/unresolved spend-ledger row after checking the provider console
// (Argus F6; Amendment F21), instead of hand-editing ledger.json.
//
//   node spike/ledger-reconcile.ts <entry-id or unique prefix (>= 8 chars)> <usd | not-charged> "<what you checked>" [--ledger <path>]
//
// Examples (the xAI 4:5 422 row held at $0.06 since 2026-10-03 22:09 ET):
//   node spike/ledger-reconcile.ts beb67d2b not-charged "console.x.ai shows no charge for the 22:09:17 ET 422"
//   node spike/ledger-reconcile.ts beb67d2b 0.04 "console.x.ai shows a $0.04 charge for the 22:09:17 ET 422"
// The row becomes status "settled" with cost_basis "manual_reconcile: <note>"; the previous status and
// basis are kept in prior_status / prior_cost_basis. Already-settled rows are refused.
import { Ledger, countedUsd } from "./lib/ledger.ts";
import { LEDGER_PATH } from "./lib/step.ts";

const args = process.argv.slice(2);
let path = LEDGER_PATH;
const li = args.indexOf("--ledger");
if (li >= 0) { path = args[li + 1]; args.splice(li, 2); }
const [id, amount, ...noteParts] = args;
const note = noteParts.join(" ");
const usage = 'usage: node spike/ledger-reconcile.ts <entry-id|prefix> <usd|not-charged> "<note>" [--ledger <path>]';
if (!id || !amount || !note.trim() || !path) { console.error(usage); process.exit(2); }

const usd = amount === "not-charged" ? 0 : /^\d+(\.\d+)?$/.test(amount) ? Number(amount) : NaN;
if (!Number.isFinite(usd)) { console.error(`amount must be a plain non-negative number or "not-charged"; got ${amount}\n${usage}`); process.exit(2); }

try {
  const l = new Ledger(path);
  const before = l.totals();
  const e = l.reconcile(id, usd, amount === "not-charged" ? `not charged; ${note}` : note);
  const after = l.totals();
  console.log(`reconciled ${e.id} (${e.provider} ${e.label}): ${e.prior_status} -> settled at $${countedUsd(e).toFixed(4)} [${e.cost_basis}]`);
  console.log(`totals before ${JSON.stringify(before)}\ntotals after  ${JSON.stringify(after)}`);
} catch (e) {
  console.error(`reconcile refused: ${(e as Error).message}`);
  process.exit(1);
}
