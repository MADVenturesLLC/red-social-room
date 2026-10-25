// One generation (or edit) through a provider adapter, then store + record. Shared by the A1 single-generate
// flow (generate.ts), the A2 run queue (runs.ts) and the A3 edit runs. Order (Amendment 1 G7): the caller
// runs the real-person check; here: writable check -> adapter (capabilities -> key check -> cap + reservation
// -> send -> cost) -> store files -> DB rows. After a paid call the cost is already recorded in its own
// transaction, so a failed image save never loses it (F16).
// A3: executeEdit loads the source image from the store, calls the provider's edit, and stores the result as
// a new child (generations.parent_asset_id); the source file is never touched.
import { isoNY } from "../../spike/lib/ledger.ts";
import { generate as xaiGenerate, edit as xaiEdit, type XaiDeps, type CostInfo } from "./xai/adapter.ts";
import { generate as googleGenerate, edit as googleEdit, type GoogleDeps, type GoogleOutcome } from "./google/adapter.ts";
import { generate as openaiGenerate, edit as openaiEdit, type OpenAiDeps, type OpenAiOutcome } from "./openai/adapter.ts";
import { putImage, cropTo, readStored, StoreError, type StoredImage } from "./store.ts";
import { checkWritable } from "./writable.ts";
import { fmtUsd } from "./ledger.ts";
import { tx, type DB } from "./db.ts";
import { KeyStore } from "./keys.ts";
import { join } from "node:path";
import type { PromptCheckMethod } from "./prompt-check.ts";
import type { KeyCheckCache, XaiOutcome } from "./xai/adapter.ts";

export type ProviderId = "xai" | "google" | "openai";

export interface AppDeps extends XaiDeps {
  dataDir: string;
  imagesDir: string;
  promptMethod: PromptCheckMethod;
  /** A2: the Google side of the app. */
  googleKeys: KeyStore;
  googleKeyCheck: KeyCheckCache;
  googleBaseUrl?: string;
  /** OpenAI (ChatGPT / GPT Image) side of the app. */
  openaiKeys?: KeyStore;
  openaiKeyCheck?: KeyCheckCache;
  openaiBaseUrl?: string;
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

/** A3: read a source image (edit/reference) back out of the store. */
function loadSourceAsset(d: AppDeps, assetId: string): { image: Buffer; mime: string } {
  const a = d.db.prepare("SELECT id, mime FROM assets WHERE id = ?").get(assetId) as { id: string; mime: string } | undefined;
  if (!a) throw new StoreError("That image is not in the store.");
  return { image: readStored(d.imagesDir, a.id, a.mime), mime: a.mime };
}

export interface GenerationRecord {
  runId: string; provider: ProviderId; model: string; generationId: string; prompt: string; ratio: string;
  /** A3: edit rows carry kind 'edit' and their source; reference rows are 'generate' with a parent too. */
  kind?: "generate" | "edit";
  parent_asset_id?: string | null;
  mask_asset_id?: string | null;
  status: "ok" | "refused" | "error" | "blocked" | "not_sent";
  error_code?: string | null; error_message?: string | null;
  client_request_id?: string | null; provider_request_id?: string | null; provider_trace?: string | null;
  model_version_listing?: string | null; output_asset_id?: string | null; display_asset_id?: string | null;
  display_note?: string | null; latency_ms?: number | null; sent_ratio?: string | null;
}

/** The generations row for one run/job outcome (same shape A1 wrote; provider/model are now parameters). */
export function recordGeneration(d: AppDeps, r: GenerationRecord): void {
  tx(d.db, () => {
    d.db.prepare(`INSERT INTO generations (id, run_id, created_at, provider, model, kind, prompt, params, status, error_code, error_message, client_request_id, provider_request_id, provider_trace, model_returned, model_version_listing, output_asset_id, display_asset_id, display_note, latency_ms, parent_asset_id, mask_asset_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`).run(
      r.generationId, r.runId, isoNY(), r.provider, r.model, r.kind ?? "generate", r.prompt,
      JSON.stringify({ requested_ratio: r.ratio, sent_ratio: r.sent_ratio ?? null, n: 1 }), r.status,
      r.error_code ?? null, r.error_message ?? null, r.client_request_id ?? null, r.provider_request_id ?? null, r.provider_trace ?? null,
      r.model_version_listing ?? null, r.output_asset_id ?? null, r.display_asset_id ?? null, r.display_note ?? null, r.latency_ms ?? null,
      r.parent_asset_id ?? null, r.mask_asset_id ?? null);
  });
}

export interface GenExecInput { runId: string; provider: ProviderId; model: string; prompt: string; ratio: string; generationId: string; referenceAssetId?: string | null }

/** Run one generation and write its rows. The caller pre-creates the run row (the FK needs it). */
export async function executeGeneration(d: AppDeps, input: GenExecInput): Promise<GenerateView> {
  checkWritable(d.dataDir); // A1 pin 19 (d): no paid call unless the data directory is writable
  const view: GenerateView = { generationId: input.generationId, status: "error", code: null, message: null, label: null, model: input.model, image: null, original: null, displayNote: null, latencyMs: null, costText: null, ref: null };
  const common = { runId: input.runId, provider: input.provider, model: input.model, generationId: input.generationId, prompt: input.prompt, ratio: input.ratio, kind: "generate" as const, parent_asset_id: input.referenceAssetId ?? null };

  // A3 "Use as reference": only providers with reference images can take one; Grok refuses before any send.
  let reference: { image: Buffer; mime: string } | null = null;
  if (input.referenceAssetId) {
    if (input.provider === "xai") {
      const message = "Not supported by Grok: reference images. Use the Google cards, or use Edit.";
      recordGeneration(d, { ...common, status: "error", error_code: "bad_input", error_message: message });
      return { ...view, status: "error", code: "bad_input", message };
    }
    reference = loadSourceAsset(d, input.referenceAssetId);
  }

  const out: XaiOutcome | GoogleOutcome | OpenAiOutcome = input.provider === "xai"
    ? await xaiGenerate(d, { prompt: input.prompt, ratio: input.ratio, generationId: input.generationId })
    : input.provider === "openai"
      ? await openaiGenerate(openaiDepsOf(d), { prompt: input.prompt, ratio: input.ratio, generationId: input.generationId, model: input.model, reference })
      : await googleGenerate(googleDepsOf(d), { prompt: input.prompt, ratio: input.ratio, generationId: input.generationId, model: input.model, reference });
  view.costText = costText(out.cost);
  view.ref = out.clientRequestId;

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
    // B3 (Copilot review round 1): OpenAI 4:5 maps to a native 2:3 render, so crop it whether or not a
    // reference image was used (references go through /v1/images/edits at that same 2:3 size). xAI can't
    // reach the reference case: it rejects references before sending.
    if (input.ratio === "4:5" && (input.provider === "openai" || (input.provider === "xai" && !input.referenceAssetId))) {
      display = putImage(d.imagesDir, await cropTo(out.image, 4, 5));
      const crop = input.provider === "xai" ? "Made at 3:4, cropped to 4:5" : "Made at 2:3, cropped to 4:5";
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

export interface EditExecInput { runId: string; provider: ProviderId; model: string; instruction: string; sourceAssetId: string; generationId: string; /** A6 item 9: only the widen path sets this; it rides as response_format.aspect_ratio (Google only, D3). */ aspectRatio?: string | null }

/** Run one edit (A3): source image in, a new child out. The original and every earlier version stay untouched. */
export async function executeEdit(d: AppDeps, input: EditExecInput): Promise<GenerateView> {
  checkWritable(d.dataDir); // A1 pin 19 (d): no paid call unless the data directory is writable
  const view: GenerateView = { generationId: input.generationId, status: "error", code: null, message: null, label: null, model: input.model, image: null, original: null, displayNote: null, latencyMs: null, costText: null, ref: null };
  const common = { runId: input.runId, provider: input.provider, model: input.model, generationId: input.generationId, prompt: input.instruction, ratio: "source", kind: "edit" as const, parent_asset_id: input.sourceAssetId };

  const src = loadSourceAsset(d, input.sourceAssetId);
  const out: XaiOutcome | GoogleOutcome | OpenAiOutcome = input.provider === "xai"
    ? await xaiEdit(d, { instruction: input.instruction, image: src.image, mime: src.mime, generationId: input.generationId })
    : input.provider === "openai"
      ? await openaiEdit(openaiDepsOf(d), { instruction: input.instruction, image: src.image, mime: src.mime, generationId: input.generationId, model: input.model })
      : await googleEdit(googleDepsOf(d), { instruction: input.instruction, image: src.image, mime: src.mime, generationId: input.generationId, model: input.model, aspectRatio: input.aspectRatio ?? null });
  view.costText = costText(out.cost);
  view.ref = out.clientRequestId;

  if (out.kind === "error") {
    recordGeneration(d, { ...common, status: "error", error_code: out.code, error_message: out.message, client_request_id: out.clientRequestId, provider_request_id: out.providerRequestId, sent_ratio: out.sentRatio });
    return { ...view, status: "error", code: out.code, message: out.message };
  }
  if (out.kind === "refused") {
    recordGeneration(d, { ...common, status: "refused", error_code: "refused", error_message: out.message, client_request_id: out.clientRequestId, provider_request_id: out.providerRequestId, sent_ratio: out.sentRatio });
    return { ...view, status: "refused", code: "refused", message: out.message };
  }

  // ok (F16 order): the edited image is a new file in the store; the source asset is never written.
  try {
    const child = putImage(d.imagesDir, out.image);
    tx(d.db, () => { insertAsset(d.db, child); });
    recordGeneration(d, { ...common, status: "ok", client_request_id: out.clientRequestId, provider_request_id: out.providerRequestId, provider_trace: out.providerTrace, model_version_listing: out.modelVersionListing, output_asset_id: child.id, display_asset_id: child.id, display_note: null, latency_ms: out.latencyMs, sent_ratio: out.sentRatio });
    return { ...view, status: "ok", image: { assetId: child.id, width: child.width, height: child.height }, original: { assetId: child.id, width: child.width, height: child.height }, latencyMs: out.latencyMs };
  } catch (e) {
    const msg = e instanceof StoreError ? e.message : `Save failed: ${(e as Error).name}.`;
    recordGeneration(d, { ...common, status: "error", error_code: "storage", error_message: msg, client_request_id: out.clientRequestId, provider_request_id: out.providerRequestId, sent_ratio: out.sentRatio });
    return { ...view, status: "error", code: "storage", message: `${msg} The cost of this call is already recorded.` };
  }
}

/** The Google adapter's deps slice of the app. */
export function googleDepsOf(d: AppDeps): GoogleDeps {
  return {
    kind: "google",
    db: d.db, keys: d.googleKeys, prices: d.prices, switches: d.switches, fetch: d.fetch,
    baseUrl: d.googleBaseUrl, timeoutMs: d.timeoutMs, keyCheckTimeoutMs: d.keyCheckTimeoutMs,
    sleep: d.sleep, random: d.random, log: d.log, keyCheck: d.googleKeyCheck,
  };
}

/** The OpenAI adapter's deps slice of the app. */
export function openaiDepsOf(d: AppDeps): OpenAiDeps {
  if (!d.openaiKeys) d.openaiKeys = new KeyStore({ secretsDir: join(d.dataDir, "secrets"), provider: "openai", env: {} as NodeJS.ProcessEnv });
  if (!d.openaiKeyCheck) d.openaiKeyCheck = { fingerprint: null, ok: false, versionListing: null };
  return {
    kind: "openai",
    db: d.db, keys: d.openaiKeys, prices: d.prices, switches: d.switches, fetch: d.fetch,
    baseUrl: d.openaiBaseUrl, timeoutMs: d.timeoutMs, keyCheckTimeoutMs: d.keyCheckTimeoutMs,
    sleep: d.sleep, random: d.random, log: d.log, keyCheck: d.openaiKeyCheck,
  };
}
