// Read-only view of the spend ledger: per-entry status and totals across ALL providers.
// Totals are summed in integer micro-USD (Argus N7), like the spend guard itself.
// Usage: node spike/ledger-report.ts [--ledger <path>]
import { Ledger, countedMicros, fromMicros, MONTHLY_CAP_USD, SPIKE_CAP_USD } from "./lib/ledger.ts";
import { LEDGER_PATH } from "./lib/step.ts";

const i = process.argv.indexOf("--ledger");
const l = new Ledger(i >= 0 ? process.argv[i + 1] : LEDGER_PATH);
let billed = 0, estimated = 0, unresolved = 0; // micro-USD
for (const e of l.entries()) {
  const c = countedMicros(e);
  if (e.status !== "settled") unresolved += c; // reserved or unresolved: still held at the estimate
  else if (e.cost_basis?.startsWith("billed")) billed += c;
  else estimated += c;
  console.log(`${e.created_at}  ${e.provider.padEnd(6)} ${e.label.padEnd(24)} est $${e.estimate_usd.toFixed(3)}  ${e.status.padEnd(10)} counted $${fromMicros(c).toFixed(6)}  ${e.cost_basis ?? ""}`);
}
const t = l.totals();
const usd = (m: number) => `${fromMicros(m).toFixed(6)} (${m} micro-USD)`;
console.log(`\nmonth ${JSON.stringify(t)}  cap $${MONTHLY_CAP_USD}; spike cap $${SPIKE_CAP_USD}`);
console.log(`billed (provider-reported) $${usd(billed)} | estimated $${usd(estimated)} | unresolved/reserved $${usd(unresolved)} | total $${usd(billed + estimated + unresolved)}`);
