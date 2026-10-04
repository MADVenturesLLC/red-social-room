// Act 0 spike, provider 1: xAI Grok Imagine 2.0 (TECH-PLAN-v1.md section 9, A0).
// generate (3:4; the 4:5 probe is opt-in) -> edit "make the background red" -> edit to a different aspect
// ratio (16:9 outpaint test) -> refusal probe (opt-in, off by default). Official REST endpoints:
//   POST https://api.x.ai/v1/images/generations   https://docs.x.ai/developers/model-capabilities/images/generation
//   POST https://api.x.ai/v1/images/edits         https://docs.x.ai/developers/model-capabilities/images/editing
import { join, relative } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { Ledger } from "./lib/ledger.ts";
import { runPaidStep, LEDGER_PATH, type StepCost, type StepOutcome } from "./lib/step.ts";
import type { CallResult, CallSpec } from "./lib/http.ts";
import { XAI, SOURCES } from "./lib/prices.ts";
import { saveImage, writeJson } from "./lib/save.ts";
import { inspectImage, ratioLabel } from "./lib/image.ts";
import { makeLogger } from "./lib/log.ts";
import { hasKey, scrub } from "./lib/secrets.ts";
import { PROMPTS } from "./prompts.ts";
import { FLAGS, optIn } from "./lib/flags.ts";

const ROOT = join(import.meta.dirname, "..");
const OUT = join(ROOT, "spike-results", "xai");
const log = makeLogger(join(OUT, "run.log"));
const ledger = new Ledger(LEDGER_PATH);
const GEN_URL = "https://api.x.ai/v1/images/generations";
const EDIT_URL = "https://api.x.ai/v1/images/edits";

// Prompts live in ./prompts.ts (shared with gemini.ts; same text as used for the xAI run).

interface XaiImage { b64_json?: string; url?: string; mime_type?: string; revised_prompt?: string; respect_moderation?: boolean }
interface XaiResp { data?: XaiImage[]; model?: string; usage?: { cost_in_usd_ticks?: number; [k: string]: unknown }; error?: unknown; code?: unknown }

function xaiCost(r: CallResult, estimate: number): StepCost {
  const j = r.json as XaiResp | null;
  const ticks = j?.usage?.cost_in_usd_ticks;
  if (typeof ticks === "number") return { usd: ticks / XAI.ticksPerUsd, basis: `billed: usage.cost_in_usd_ticks=${ticks} (${SOURCES.xaiCostTracking})`, billed: true };
  if (r.outcome === "ok") return { usd: estimate, basis: `estimated (no usage field returned): ${XAI.basis}`, billed: false };
  if (r.status === 422 && /Failed to deserialize/.test(r.text)) {
    // Observed: schema/enum validation failures come back as 422 text/plain before any generation.
    return { usd: 0, basis: "estimated $0: HTTP 422 request-body deserialization error (rejected before generation, no usage field); confirm against console", billed: false };
  }
  if (r.status !== null && r.status >= 400 && r.status < 500 && r.status !== 429) {
    // xAI pricing page: "When your request is deemed to be in violation of our usage guideline by our system, we will still charge".
    return { usd: null, basis: `unresolved: HTTP ${r.status} with no usage field; xAI may still charge for guideline violations (${SOURCES.xaiPricing}); reservation kept until console check`, billed: false };
  }
  return { usd: null, basis: `unresolved: ${r.outcome} status=${r.status}; reservation kept`, billed: false };
}

const RESULTS = join(OUT, "results.json");
const prior = existsSync(RESULTS) ? (JSON.parse(readFileSync(RESULTS, "utf8")) as { steps?: Record<string, unknown>; runs?: unknown[] }) : null;
const summary: Record<string, unknown> = { provider: "xai", model_requested: XAI.model, started_at: new Date().toISOString(), steps: { ...(prior?.steps ?? {}) } as Record<string, unknown>, runs: [...(prior?.runs ?? [])] };
const steps = summary.steps as Record<string, unknown>;

function record<P>(o: StepOutcome<P>, extra: Record<string, unknown> = {}) {
  const r = o.result;
  const j = (r?.json ?? null) as XaiResp | null;
  steps[o.label] = {
    refused_by_spend_guard: o.refusedBySpendGuard ?? null,
    http_status: r?.status ?? null, outcome: r?.outcome ?? null, latency_ms: r?.latency_ms ?? null, total_ms: r?.total_ms ?? null,
    attempts: r?.attempts.length ?? 0, retry_decision: r?.retry_decision ?? null,
    cost_usd: o.cost?.usd ?? null, cost_basis: o.cost?.basis ?? null, cost_billed: o.cost?.billed ?? false,
    model_returned: j?.model ?? null,
    response_top_level_keys: j ? Object.keys(j) : null,
    usage: j?.usage ?? null,
    images: (j?.data ?? []).map((d) => ({ mime_type: d.mime_type ?? null, revised_prompt: d.revised_prompt ?? null, respect_moderation: d.respect_moderation ?? null, has_b64: !!d.b64_json, url_returned: !!d.url })),
    error_body: r && r.outcome !== "ok" ? (r.json ?? scrub(r.text.slice(0, 4000))) : null,
    stop: o.stop, stop_reason: o.stopReason ?? null,
    ledger_status: o.ledgerStatus ?? null, ledger_error: o.ledgerError ? scrub(o.ledgerError) : null,
    recorded_at: new Date().toISOString(),
    ...extra,
  };
}

function firstImage(r: CallResult | undefined): { buf: Buffer; mime?: string; meta: XaiImage } | null {
  const d = (r?.json as XaiResp | null)?.data?.[0];
  if (!d?.b64_json) return null;
  return { buf: Buffer.from(d.b64_json, "base64"), mime: d.mime_type, meta: d };
}

type Saved = ReturnType<typeof saveImage>["info"] & { file: string; aspect: string; buf: Buffer; mime?: string };

/** persist callback for runPaidStep: saves the first returned image (before the ledger is settled; Argus F3). */
const saveAs = (name: string) => (r: CallResult): Saved | null => {
  const i = firstImage(r);
  if (!i) return null;
  const s = saveImage(join(OUT, name), i.buf, i.mime);
  log(`saved ${relative(ROOT, s.path)} ${s.info.width}x${s.info.height} ${ratioLabel(s.info.width, s.info.height)}`);
  return { file: relative(ROOT, s.path), ...s.info, aspect: ratioLabel(s.info.width, s.info.height), buf: i.buf, mime: i.mime };
};
const outputInfo = (s: Saved | null | undefined) => (s ? (({ buf, mime, ...rest }) => rest)(s) : null);

async function main() {
  if (!hasKey("XAI_API_KEY")) { log("XAI_API_KEY not set; nothing sent."); return; }
  // `extra` adds step-specific fields to the results.json entry; runPaidStep records the entry before the
  // ledger is updated, so after a LedgerBusy abort results.json still matches the new dump (Argus N3).
  const step = <P = undefined>(label: string, estimate: number, spec: CallSpec, persist?: (r: CallResult) => P, extra: (o: StepOutcome<P>) => Record<string, unknown> = () => ({})) =>
    runPaidStep<P>({ ledger, provider: "xai", model: XAI.model, label, outDir: OUT, estimateUsd: estimate, estimateBasis: XAI.basis, spec, costOf: (r) => xaiCost(r, estimate), log, persist, record: (o) => record(o, extra(o)) });

  // 1) Generate. Plan default is 4:5 (plan :84 / :194), but xAI rejects 4:5 with HTTP 422 (recorded in
  //    01-generate-4x5.json) and the Founder decided to generate 3:4 and crop. So by default the 4:5 probe is
  //    NOT sent and the run goes straight to 3:4. RUN_XAI_4X5_PROBE=1 re-sends the probe first.
  const genBody = (ar: string) => ({ model: XAI.model, prompt: PROMPTS.generate, n: 1, aspect_ratio: ar, resolution: "1k", response_format: "b64_json" });
  let probe45: StepOutcome<Saved | null> | null = null;
  if (optIn(FLAGS.xai4x5Probe)) {
    probe45 = await step("01-generate-4x5", XAI.generateEstimateUsd, { keyName: "XAI_API_KEY", method: "POST", url: GEN_URL, body: genBody("4:5") }, saveAs("01-generated"), (o) => ({ requested_aspect_ratio: "4:5", output: outputInfo(o.persisted) }));
    if (probe45.stop) return finish(probe45.stopReason);
  } else log(`4:5 probe skipped (default; its HTTP 422 is recorded in 01-generate-4x5.json). Set ${FLAGS.xai4x5Probe}=1 to re-send it.`);
  let gen = probe45;
  if (!gen || gen.result?.status === 400 || gen.result?.status === 422) {
    // Deliberate single request at 3:4 (not a retry loop): the closest documented portrait ratio.
    if (gen) log("4:5 rejected (documented list has no 4:5). Sending ONE request at 3:4, the closest documented portrait ratio.");
    gen = await step("01b-generate-3x4", XAI.generateEstimateUsd, { keyName: "XAI_API_KEY", method: "POST", url: GEN_URL, body: genBody("3:4") }, saveAs("01-generated"), (o) => ({ requested_aspect_ratio: "3:4", output: outputInfo(o.persisted) }));
    if (gen.stop) return finish(gen.stopReason);
  }
  const g = gen.persisted;
  if (!g) { log("No image in generate response; stopping (nothing to edit)."); return finish("no generated image"); }
  const dataUri = `data:${g.mime ?? "image/jpeg"};base64,${g.buf.toString("base64")}`;

  // 2) Edit: "make the background red" (plan :194). No aspect_ratio -> docs say output follows the input image.
  const e1 = await step("02-edit-background-red", XAI.editEstimateUsd, { keyName: "XAI_API_KEY", method: "POST", url: EDIT_URL, body: { model: XAI.model, prompt: PROMPTS.edit, image: { type: "image_url", url: dataUri }, n: 1, response_format: "b64_json" } }, saveAs("02-edited-background-red"), (o) => ({ requested_aspect_ratio: null, output: outputInfo(o.persisted) }));
  if (e1.stop) return finish(e1.stopReason);

  // 3) Edit to a different aspect ratio (outpaint test, plan :125 / :194; research open item 8).
  const e2 = await step("03-edit-aspect-16x9", XAI.editEstimateUsd, { keyName: "XAI_API_KEY", method: "POST", url: EDIT_URL, body: { model: XAI.model, prompt: PROMPTS.editAspect, image: { type: "image_url", url: dataUri }, aspect_ratio: "16:9", n: 1, response_format: "b64_json" } }, saveAs("03-edited-aspect-16x9"), (o) => ({ requested_aspect_ratio: "16:9", source_dimensions: `${g.width}x${g.height}`, output: outputInfo(o.persisted) }));
  if (e2.stop) return finish(e2.stopReason);

  // 4) Refusal probe (plan :156, :194): a photoreal named real person. OFF by default (Founder decision 7);
  //    the 2026-10-03 result is already recorded in 04-refusal-probe.json. If it runs and the provider does
  //    NOT refuse, the image is NOT saved (no persist callback); only its metadata is kept.
  if (!optIn(FLAGS.refusalProbe)) {
    log(`refusal probe skipped (default; Founder decision 7 forbids photoreal named real people; evidence already in 04-refusal-probe.json). Set ${FLAGS.refusalProbe}=1 to send it.`);
    return finish();
  }
  const rp = await step("04-refusal-probe", XAI.generateEstimateUsd, { keyName: "XAI_API_KEY", method: "POST", url: GEN_URL, body: { model: XAI.model, prompt: PROMPTS.refusal, n: 1, aspect_ratio: "1:1", resolution: "1k", response_format: "b64_json" } }, undefined, (o) => {
    const i = firstImage(o.result);
    return { refusal_probe: true, image_returned: !!i, image_saved: false, returned_image_info: i ? (({ sha256, ...rest }) => ({ ...rest, sha256 }))(inspectImage(i.buf)) : null };
  });
  const rpi = firstImage(rp.result);
  if (rpi) log(`refusal probe: provider returned an image (respect_moderation=${rpi.meta.respect_moderation}); NOT saved to disk by design.`);
  return finish(rp.stop ? rp.stopReason : undefined);
}

function finish(stopReason?: string) {
  summary.finished_at = new Date().toISOString();
  (summary.runs as unknown[]).push({ started_at: summary.started_at, finished_at: summary.finished_at, stopped_early: stopReason ?? null });
  summary.stopped_early = stopReason ?? null;
  summary.ledger_totals_after = ledger.totals();
  writeJson(RESULTS, JSON.parse(scrub(JSON.stringify(summary))));
  log(`done. stopped_early=${stopReason ?? "no"}; ledger: ${JSON.stringify(ledger.totals())}`);
}

try { await main(); } catch (e) {
  // e.g. LedgerBusy after a paid call: outputs are already on disk; record the run, then fail non-zero.
  log(`run aborted: ${scrub(String((e as Error)?.message ?? e))}`);
  finish(`error: ${(e as Error)?.name ?? "Error"}`);
  process.exitCode = 1;
}
