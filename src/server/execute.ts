// One generation through a provider adapter, then store + record. Shared by the A1 single-generate flow
// (generate.ts) and the A2 multi-creator run queue (runs.ts). Order (Amendment 1 G7): the caller runs the
// real-person check; here: writable check -> adapter (capabilities -> key check -> cap + reservation ->
// send -> cost) -> store files -> DB rows. After a paid call the cost is already recorded in its own
// transaction, so a failed image save never loses it (F16).
import { isoNY } from "../../spike/lib/ledger.ts";
import { generate as xaiGenerate, MODEL as XAI_MODEL, type XaiDeps, type CostInfo } from "./xai/adapter.ts";
import { generate as googleGenerate, MODEL as GOOGLE_MODEL, type GoogleDeps, type GoogleOutcome } from "./google/adapter.ts";
import { putImage, cropTo, StoreError, type StoredImage } from "./store.ts";
import { checkWritable } from "./writable.ts";
import { fmtUsd } from "./ledger.ts";
import { tx, type DB } from "./db.ts";
import type { PromptCheckMethod } from "./prompt-check.ts";
import type { KeyCheckCache, XaiOutcome } from "./xai/adapter.ts";
import type { KeyStore } from "./keys.ts";

export type ProviderId = "xai" | "google";

export interface AppDeps extends XaiDeps {
  dataDir: string;
  imagesDir: string;
  promptMethod: PromptCheckMethod;
  /** A2: the Google side of the app. */
  googleKeys: KeyStore;
  googleKeyCheck: KeyCheckCache;
  googleBaseUrl?: string;
}

export function modelFor(provider: ProviderId): string {
  return provider === "xai" ? XAI_MODEL : GOOGLE_MODEL;
}

export interface GenerateView {
  generationId: string;
  status: "ok" | "refused" | "error" | "blocked" | "not_sent";
  code: string | null;
  message: string | null;
  label: string | null;
  model: string;
  image: { assetId: string; width: number | null; height: number | null } | null;
  original: { assetId: string; width: number | null; height: number | null } | null;
  displayNote: string | null;
  latencyMs: number | null;
  costText: string | null;
  ref: string | null;
}

export function costText(c: CostInfo | null): string | null {
  if (!c) return null;
  if (c.micros === null) return `${fmtUsd(c.heldMicros)} held (cost unknown)`;
  if (c.source === "billed_provider") return fmtUsd(c.micros);
  if (c.source === "estimated_price_table") return `${fmtUsd(c.micros)} est.`;
  return `${fmtUsd(c.micros)} (${c.source === "not_sent" ? "not sent" : "confirm against console"})`;
}

export function insertAsset(db: DB, a: StoredImage): void {
  db.prepare("INSERT OR IGNORE INTO assets (id, rel_path, mime, width, height, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(a.id, a.relPath, a.mime, a.width, a.height, a.bytes, isoNY());
}

export interface GenerationRecord {
  runId: string; provider: ProviderId; model: string; generationId: string; prompt: string; ratio: string;
  status: "ok" | "refused" | "error" | "blocked" | "not_sent";
  error_code?: string | null; error_message?: string | null;
  client_request_id?: string | null; provider_request_id?: string | null; provider_trace?: string | null;
  model_version_listing?: string | null; output_asset_id?: string | null; display_asset_id?: string | null;
  display_note?: string | null; latency_ms?: number | null; sent_ratio?: string | null;
}

/** The generations row for one run/job outcome (same shape A1 wrote; provider/model are now parameters). */
export function recordGeneration(d: AppDeps, r: GenerationRecord): void {
  tx(d.db, () => {
    d.db.prepare(`INSERT INTO generations (id, run_id, created_at, provider, model, kind, prompt, params, status, error_code, error_message, client_request_id, provider_request_id, provider_trace, model_returned, model_version_listing, output_asset_id, display_asset_id, display_note, latency_ms)
      VALUES (?, ?, ?, ?, ?, 'generate', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`).run(
      r.generationId, r.runId, isoNY(), r.provider, r.model, r.prompt,
      JSON.stringify({ requested_ratio: r.ratio, sent_ratio: r.sent_ratio ?? null, n: 1 }), r.status,
      r.error_code ?? null, r.error_message ?? null, r.client_request_id ?? null, r.provider_request_id ?? null, r.provider_trace ?? null,
      r.model_version_listing ?? null, r.output_asset_id ?? null, r.display_asset_id ?? null, r.display_note ?? null, r.latency_ms ?? null);
  });
}

export interface GenExecInput { runId: string; provider: ProviderId; model: string; prompt: string; ratio: string; generationId: string }

/** Run one generation and write its rows. The caller pre-creates the run row (the FK needs it). */
export async function executeGeneration(d: AppDeps, input: GenExecInput): Promise<GenerateView> {
  checkWritable(d.dataDir); // A1 pin 19 (d): no paid call unless the data directory is writable
  const view: GenerateView = { generationId: input.generationId, status: "error", code: null, message: null, label: null, model: input.model, image: null, original: null, displayNote: null, latencyMs: null, costText: null, ref: null };

  const out: XaiOutcome | GoogleOutcome = input.provider === "xai"
    ? await xaiGenerate(d, { prompt: input.prompt, ratio: input.ratio, generationId: input.generationId })
    : await googleGenerate(googleDepsOf(d), { prompt: input.prompt, ratio: input.ratio, generationId: input.generationId, model: input.model });
  view.costText = costText(out.cost);
  view.ref = out.clientRequestId;
  const common = { runId: input.runId, provider: input.provider, model: input.model, generationId: input.generationId, prompt: input.prompt, ratio: input.ratio };

  if (out.kind === "error") {
    recordGeneration(d, { ...common, status: "error", error_code: out.code, error_message: out.message, client_request_id: out.clientRequestId, provider_request_id: out.providerRequestId, sent_ratio: out.sentRatio });
    return { ...view, status: "error", code: out.code, message: out.message };
  }
  if (out.kind === "refused") {
    recordGeneration(d, { ...common, status: "refused", error_code: "refused", error_message: out.message, client_request_id: out.clientRequestId, provider_request_id: out.providerRequestId, sent_ratio: out.sentRatio });
    return { ...view, status: "refused", code: "refused", message: out.message };
  }

  // ok: store files first, then the DB rows (F16).
  try {
    const providerNoteRaw = (out as { note?: unknown }).note;
    const providerNote = typeof providerNoteRaw === "string" ? providerNoteRaw : null;
    const original = putImage(d.imagesDir, out.image);
    let display = original;
    let note: string | null = providerNote;
    if (input.provider === "xai" && input.ratio === "4:5") { // D2: xAI only; Google supports 4:5 directly
      display = putImage(d.imagesDir, await cropTo(out.image, 4, 5));
      const crop = "Made at 3:4, cropped to 4:5";
      note = note ? `${note} · ${crop}` : crop;
    }
    tx(d.db, () => { insertAsset(d.db, original); if (display !== original) insertAsset(d.db, display); });
    recordGeneration(d, { ...common, status: "ok", client_request_id: out.clientRequestId, provider_request_id: out.providerRequestId, provider_trace: out.providerTrace, model_version_listing: out.modelVersionListing, output_asset_id: original.id, display_asset_id: display.id, display_note: note, latency_ms: out.latencyMs, sent_ratio: out.sentRatio });
    return { ...view, status: "ok", image: { assetId: display.id, width: display.width, height: display.height }, original: { assetId: original.id, width: original.width, height: original.height }, displayNote: note, latencyMs: out.latencyMs };
  } catch (e) {
    const msg = e instanceof StoreError ? e.message : `Save failed: ${(e as Error).name}.`;
    recordGeneration(d, { ...common, status: "error", error_code: "storage", error_message: msg, client_request_id: out.clientRequestId, provider_request_id: out.providerRequestId, sent_ratio: out.sentRatio });
    return { ...view, status: "error", code: "storage", message: `${msg} The cost of this call is already recorded.` };
  }
}

/** The Google adapter's deps slice of the app. */
export function googleDepsOf(d: AppDeps): GoogleDeps {
  return {
    db: d.db, keys: d.googleKeys, prices: d.prices, switches: d.switches, fetch: d.fetch,
    baseUrl: d.googleBaseUrl, timeoutMs: d.timeoutMs, keyCheckTimeoutMs: d.keyCheckTimeoutMs,
    sleep: d.sleep, random: d.random, log: d.log, keyCheck: d.googleKeyCheck,
  };
}
