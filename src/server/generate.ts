// prompt -> image (TECH-PLAN-v1.md section 9 A1). Order (Amendment 1 G7): real-person check -> capabilities
// -> key check -> cap check + reservation -> send (the last three inside the xAI adapter). After a paid call
// the cost is already recorded in its own transaction, so a failed image save never loses it (F16).
import { randomUUID } from "node:crypto";
import { isoNY } from "../../spike/lib/ledger.ts";
import { checkPrompt, type PromptCheckMethod } from "./prompt-check.ts";
import { generate as xaiGenerate, MODEL, type XaiDeps, type CostInfo } from "./xai/adapter.ts";
import { putImage, cropTo, StoreError, type StoredImage } from "./store.ts";
import { fmtUsd } from "./ledger.ts";
import { tx, type DB } from "./db.ts";

export interface AppDeps extends XaiDeps { imagesDir: string; promptMethod: PromptCheckMethod }

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

function insertAsset(db: DB, a: StoredImage): void {
  db.prepare("INSERT OR IGNORE INTO assets (id, rel_path, mime, width, height, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(a.id, a.relPath, a.mime, a.width, a.height, a.bytes, isoNY());
}

export async function runGenerate(d: AppDeps, input: { prompt: unknown; ratio: unknown }): Promise<GenerateView> {
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  const ratio = typeof input.ratio === "string" ? input.ratio : "4:5";
  const runId = randomUUID(), generationId = randomUUID();
  const view: GenerateView = { generationId, status: "error", code: null, message: null, label: null, model: MODEL, image: null, original: null, displayNote: null, latencyMs: null, costText: null, ref: null };
  const record = (status: string, extra: { error_code?: string | null; error_message?: string | null; client_request_id?: string | null; provider_request_id?: string | null; provider_trace?: string | null; model_version_listing?: string | null; output_asset_id?: string | null; display_asset_id?: string | null; display_note?: string | null; latency_ms?: number | null; sent_ratio?: string | null }) => {
    tx(d.db, () => {
      d.db.prepare("INSERT INTO runs (id, created_at, prompt, status) VALUES (?, ?, ?, ?)").run(runId, isoNY(), prompt, status === "ok" ? "ok" : status === "blocked" || status === "not_sent" ? "blocked" : "failed");
      d.db.prepare(`INSERT INTO generations (id, run_id, created_at, provider, model, kind, prompt, params, status, error_code, error_message, client_request_id, provider_request_id, provider_trace, model_returned, model_version_listing, output_asset_id, display_asset_id, display_note, latency_ms)
        VALUES (?, ?, ?, 'xai', ?, 'generate', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`).run(
        generationId, runId, isoNY(), MODEL, prompt, JSON.stringify({ requested_ratio: ratio, sent_ratio: extra.sent_ratio ?? null, n: 1 }), status,
        extra.error_code ?? null, extra.error_message ?? null, extra.client_request_id ?? null, extra.provider_request_id ?? null, extra.provider_trace ?? null,
        extra.model_version_listing ?? null, extra.output_asset_id ?? null, extra.display_asset_id ?? null, extra.display_note ?? null, extra.latency_ms ?? null);
    });
  };

  // 1) Real-person check (D1, F10). A block or an unavailable check sends nothing and creates no ledger row.
  const pc = checkPrompt(prompt, d.promptMethod, d.switches.promptCheck, d.db);
  if (!pc.allowed) {
    const status = pc.result === "blocked" ? "blocked" : "not_sent";
    record(status, { error_code: pc.result, error_message: pc.message });
    return { ...view, status, code: pc.result, message: pc.message };
  }
  view.label = pc.label;

  // 2) The adapter: capabilities, key check, cap + reservation, send, cost.
  const out = await xaiGenerate(d, { prompt, ratio, generationId });
  view.costText = costText(out.cost);
  view.ref = out.clientRequestId;
  if (out.kind === "error") {
    record("error", { error_code: out.code, error_message: out.message, client_request_id: out.clientRequestId, provider_request_id: out.providerRequestId, sent_ratio: out.sentRatio });
    return { ...view, status: "error", code: out.code, message: out.message };
  }
  if (out.kind === "refused") {
    record("refused", { error_code: "refused", error_message: out.message, client_request_id: out.clientRequestId, provider_request_id: out.providerRequestId, sent_ratio: out.sentRatio });
    return { ...view, status: "refused", code: "refused", message: out.message };
  }

  // 3) Store the original unchanged, then the 4:5 crop for the tile (D2). Files first, then the DB rows.
  try {
    const original = putImage(d.imagesDir, out.image);
    let display = original, note: string | null = null;
    if (ratio === "4:5") {
      display = putImage(d.imagesDir, await cropTo(out.image, 4, 5));
      note = "Made at 3:4, cropped to 4:5";
    }
    tx(d.db, () => { insertAsset(d.db, original); if (display !== original) insertAsset(d.db, display); });
    record("ok", { client_request_id: out.clientRequestId, provider_request_id: out.providerRequestId, provider_trace: out.providerTrace, model_version_listing: out.modelVersionListing, output_asset_id: original.id, display_asset_id: display.id, display_note: note, latency_ms: out.latencyMs, sent_ratio: out.sentRatio });
    return { ...view, status: "ok", image: { assetId: display.id, width: display.width, height: display.height }, original: { assetId: original.id, width: original.width, height: original.height }, displayNote: note, latencyMs: out.latencyMs };
  } catch (e) {
    const msg = e instanceof StoreError ? e.message : `Save failed: ${(e as Error).name}.`;
    record("error", { error_code: "storage", error_message: msg, client_request_id: out.clientRequestId, provider_request_id: out.providerRequestId, sent_ratio: out.sentRatio });
    return { ...view, status: "error", code: "storage", message: `${msg} The cost of this call is already recorded.` };
  }
}
