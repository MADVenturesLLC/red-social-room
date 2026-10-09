// What the Create card and Settings page show (no secrets: key status is source + last 4 only).
import { monthTotals, fmtUsd, priceDrifts, type MonthTotals, type PriceDrift } from "./ledger.ts";
import { estimate } from "./prices.ts";
import { qualityFor, resolutionFor } from "./config.ts";
import { MODEL } from "./xai/adapter.ts";
import type { AppDeps } from "./generate.ts";
import type { KeyStatus } from "./keys.ts";

export interface CreatorStatus { name: string; model: string; priceText: string; estimateMicros: number; state: "ready" | "no_key" | "key_unchecked" | "cap_reached"; stateText: string }
export interface AppStatus { key: KeyStatus & { checked: boolean; checkOk: boolean; versionListing: string | null; checkMessage: string | null }; creator: CreatorStatus; totals: MonthTotals; totalsText: { counted: string; held: string; cap: string }; priceDrift: PriceDrift[] }

export function appStatus(d: AppDeps): AppStatus {
  const key = d.keys.status();
  const fp = d.keys.fingerprint();
  const checked = fp !== null && d.keyCheck.fingerprint === fp;
  const est = estimate(d.db, d.prices, { provider: "xai", model: MODEL, kind: "generate", resolution: resolutionFor(d.switches), quality: qualityFor(d.switches, "generate").priceQuality });
  const totals = monthTotals(d.db);
  let state: CreatorStatus["state"] = "ready", stateText = "Ready";
  if (!key.set) { state = "no_key"; stateText = "No key — add it in Settings"; }
  else if (totals.countedMicros + est.micros > totals.capMicros) { state = "cap_reached"; stateText = "Cap reached"; }
  else if (!checked || !d.keyCheck.ok) { state = "key_unchecked"; stateText = checked ? (d.keyCheck.message ?? "Key check failed — see Settings") : "Key not checked yet (checked before the first call)"; }
  return {
    key: { ...key, checked, checkOk: checked && d.keyCheck.ok, versionListing: checked ? d.keyCheck.versionListing : null, checkMessage: checked ? d.keyCheck.message ?? null : null },
    creator: { name: "Grok Imagine 2.0", model: MODEL, priceText: `${fmtUsd(est.micros)} / image`, estimateMicros: est.micros, state, stateText },
    totals,
    totalsText: { counted: fmtUsd(totals.countedMicros), held: fmtUsd(totals.heldMicros), cap: fmtUsd(totals.capMicros) },
    priceDrift: priceDrifts(d.db),
  };
}
