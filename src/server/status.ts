// What the Create cards and Settings page show (no secrets: key status is source + last 4 only).
// A2: one creator card per provider (server/runs.ts CREATORS); `creator`/`key` stay the xAI card for
// compatibility, `creators`/`googleKey` carry the full picture.
// A3: each card also carries its edit estimate and its reference-image capacity (0 = the UI does not
// offer "Use as reference" on that card, per capabilities()).
import { monthTotals, fmtUsd, priceDrifts, type MonthTotals, type PriceDrift } from "./ledger.ts";
import { estimate } from "./prices.ts";
import { qualityFor, resolutionFor } from "./config.ts";
import { CREATORS } from "./runs.ts";
import { CAPABILITIES as XAI_CAPS } from "./xai/adapter.ts";
import { CAPABILITIES as GOOGLE_CAPS } from "./google/adapter.ts";
import { CAPABILITIES as OPENAI_CAPS } from "./openai/adapter.ts";
import { openaiDepsOf } from "./execute.ts";
import type { AppDeps } from "./generate.ts";
import type { KeyStatus } from "./keys.ts";
import type { DB } from "./db.ts";
import type { KeyCheckCache } from "./xai/adapter.ts";

export interface CreatorStatus {
  id: string;
  name: string;
  model: string;
  priceText: string;
  estimateMicros: number;
  /** A3: the pre-call edit reservation (null when no row exists yet). */
  editEstimateMicros: number | null;
  editPriceText: string | null;
  /** A3: how many reference images this creator takes for a "Use as reference" run (0 = not offered). */
  maxReferenceImages: number;
  state: "ready" | "no_key" | "key_unchecked" | "cap_reached" | "provider_problems";
  stateText: string;
  keySet: boolean;
  keySource: "settings" | "env" | null;
  keyLast4: string | null;
  checked: boolean;
  checkOk: boolean;
  versionListing: string | null;
  checkMessage: string | null;
}
export interface AppStatus {
  key: KeyStatus & { checked: boolean; checkOk: boolean; versionListing: string | null; checkMessage: string | null };
  googleKey: KeyStatus & { checked: boolean; checkOk: boolean; versionListing: string | null; checkMessage: string | null };
  openaiKey: KeyStatus & { checked: boolean; checkOk: boolean; versionListing: string | null; checkMessage: string | null };
  creator: CreatorStatus;
  creators: CreatorStatus[];
  totals: MonthTotals;
  totalsText: { counted: string; held: string; cap: string };
  priceDrift: PriceDrift[];
}

function cardOf(d: AppDeps, def: (typeof CREATORS)[number], totals: MonthTotals): CreatorStatus {
  const oa = def.provider === "openai" ? openaiDepsOf(d) : null;
  const keyStore = def.provider === "google" ? d.googleKeys : def.provider === "openai" ? oa!.keys : d.keys;
  const keyCheck: KeyCheckCache = def.provider === "google" ? d.googleKeyCheck : def.provider === "openai" ? oa!.keyCheck : d.keyCheck;
  const key = keyStore.status();
  const fp = keyStore.fingerprint();
  const checked = fp !== null && keyCheck.fingerprint === fp;
  const priceQuality = def.provider === "xai" ? qualityFor(d.switches, "generate").priceQuality : null;
  const est = estimate(d.db, d.prices, { provider: def.provider, model: def.model, kind: "generate", resolution: resolutionFor(d.switches), quality: priceQuality });
  let editEstimateMicros: number | null = null;
  try {
    const eq = def.provider === "xai" ? qualityFor(d.switches, "edit").priceQuality : null;
    editEstimateMicros = estimate(d.db, d.prices, { provider: def.provider, model: def.model, kind: "edit", resolution: resolutionFor(d.switches), quality: eq }).micros;
  } catch { editEstimateMicros = null; }
  const caps = def.provider === "xai" ? XAI_CAPS : def.provider === "openai" ? OPENAI_CAPS : GOOGLE_CAPS;
  let state: CreatorStatus["state"] = "ready", stateText = "Ready";
  if (!key.set) { state = "no_key"; stateText = "No key — add it in Settings"; }
  else if (totals.countedMicros + est.micros > totals.capMicros) { state = "cap_reached"; stateText = "Cap reached"; }
  else if (providerProblems(d.db, def.provider)) { state = "provider_problems"; stateText = "Provider having problems"; }
  else if (!checked || !keyCheck.ok) { state = "key_unchecked"; stateText = checked ? (keyCheck.message ?? "Key check failed — see Settings") : "Key not checked yet (checked before the first call)"; }
  return {
    id: def.id, name: def.name, model: def.model,
    priceText: `${fmtUsd(est.micros)} / image`, estimateMicros: est.micros,
    editEstimateMicros, editPriceText: editEstimateMicros === null ? null : `${fmtUsd(editEstimateMicros)} / edit`,
    maxReferenceImages: caps.maxReferenceImages,
    state, stateText,
    keySet: key.set, keySource: key.source, keyLast4: key.last4,
    checked, checkOk: checked && keyCheck.ok,
    versionListing: checked ? keyCheck.versionListing : null,
    checkMessage: checked ? keyCheck.message ?? null : null,
  };
}

const FIVEXX_WINDOW_MS = 10 * 60 * 1000;

/** F5 (item 15): after 3 consecutive 5xx results for one provider within 10 minutes, the card shows
 *  "Provider having problems" until the next success. Read from the ledger: the newest rows walk back
 *  through consecutive 5xx http_status values; a later success breaks the streak. */
export function providerProblems(db: DB, provider: "xai" | "google" | "openai"): boolean {
  const rows = db.prepare("SELECT http_status AS s, created_at AS t FROM spend_ledger WHERE provider = ? ORDER BY created_at DESC, rowid DESC LIMIT 8").all(provider) as unknown as Array<{ s: number | null; t: string }>;
  let n = 0, newest = 0, oldest = 0;
  for (const r of rows) {
    if (r.s === null || r.s < 500 || r.s > 599) break;
    const ts = Date.parse(r.t);
    if (!Number.isFinite(ts)) break;
    if (n === 0) newest = ts;
    oldest = ts;
    n++;
  }
  return n >= 3 && newest - oldest <= FIVEXX_WINDOW_MS;
}

export function appStatus(d: AppDeps): AppStatus {
  const totals = monthTotals(d.db);
  const creators = CREATORS.map((def) => cardOf(d, def, totals));
  const xai = creators.find((c) => c.id === "xai") ?? creators[0];
  const goog = creators.find((c) => c.id === "google") ?? creators[1];
  const oai = creators.find((c) => c.id === "openai") ?? creators[0];
  return {
    key: { set: xai.keySet, source: xai.keySource, last4: xai.keyLast4, checked: xai.checked, checkOk: xai.checkOk, versionListing: xai.versionListing, checkMessage: xai.checkMessage },
    googleKey: { set: goog.keySet, source: goog.keySource, last4: goog.keyLast4, checked: goog.checked, checkOk: goog.checkOk, versionListing: goog.versionListing, checkMessage: goog.checkMessage },
    openaiKey: { set: oai.keySet, source: oai.keySource, last4: oai.keyLast4, checked: oai.checked, checkOk: oai.checkOk, versionListing: oai.versionListing, checkMessage: oai.checkMessage },
    creator: xai,
    creators,
    totals,
    totalsText: { counted: fmtUsd(totals.countedMicros), held: fmtUsd(totals.heldMicros), cap: fmtUsd(totals.capMicros) },
    priceDrift: priceDrifts(d.db),
  };
}
