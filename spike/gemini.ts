// Act 0 spike, provider 2: Google Nano Banana 2 = gemini-3.1-flash-image (TECH-PLAN-v1.md section 9, A0).
// Official REST endpoint (Interactions API): POST https://generativelanguage.googleapis.com/v1beta/interactions
//   https://ai.google.dev/gemini-api/docs/image-generation , https://ai.google.dev/api/interactions-api
// Steps: free key/model preflight GET -> generate 3:4 -> edit "make the background red" -> edit to 16:9 -> generate 4:5
// -> refusal probe (opt-in via RUN_REFUSAL_PROBE=1, off by default; Founder decision 7).
// The preflight is free and gates every paid call: if the key is rejected, nothing billable is sent.
import { join, relative } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { Ledger } from "./lib/ledger.ts";
import { runPaidStep, LEDGER_PATH, EXIT_SPEND_GUARD, type StepOutcome } from "./lib/step.ts";
import { call, dump, type CallResult, type CallSpec } from "./lib/http.ts";
import { GEMINI } from "./lib/prices.ts";
import { geminiCost, outputImages, outputText, type Interaction } from "./lib/gemini-shape.ts";
import { saveImage, writeJson } from "./lib/save.ts";
import { inspectImage, ratioLabel } from "./lib/image.ts";
import { makeLogger } from "./lib/log.ts";
import { hasKey, scrub } from "./lib/secrets.ts";
import { PROMPTS } from "./prompts.ts";
import { FLAGS, optIn } from "./lib/flags.ts";

const ROOT = join(import.meta.dirname, "..");
const OUT = join(ROOT, "spike-results", "gemini");
const log = makeLogger(join(OUT, "run.log"));
const ledger = new Ledger(LEDGER_PATH);
const BASE = "https://generativelanguage.googleapis.com/v1beta";
const URL_INTERACTIONS = `${BASE}/interactions`;
const API_REVISION = { "Api-Revision": "2026-05-20" }; // https://ai.google.dev/gemini-api/docs/interactions-breaking-changes-may-2026

// Founder decision 2026-10-03 22:32 ET: never let Google store spike interactions server-side.
// store=false opts out of the default 55-day Interactions storage (https://ai.google.dev/gemini-api/docs/interactions-overview,
// "Data storage and retention"). Edits pass the source image inline, so previous_interaction_id is not needed.
function withStoreFalse(body: unknown): unknown {
  return { ...(body as Record<string, unknown>), store: false };
}

// Response shape helpers and the cost rule live in ./lib/gemini-shape.ts (pure; unit-tested).

const RESULTS = join(OUT, "results.json");
const prior = existsSync(RESULTS) ? (JSON.parse(readFileSync(RESULTS, "utf8")) as { steps?: Record<string, unknown>; runs?: unknown[] }) : null;
const summary: Record<string, unknown> = { provider: "google", model_requested: GEMINI.model, started_at: new Date().toISOString(), steps: { ...(prior?.steps ?? {}) } as Record<string, unknown>, runs: [...(prior?.runs ?? [])] };
const steps = summary.steps as Record<string, unknown>;

function record<P>(o: StepOutcome<P>, extra: Record<string, unknown> = {}) {
  const r = o.result;
  const j = (r?.json ?? null) as Interaction | null;
  steps[o.label] = {
    refused_by_spend_guard: o.refusedBySpendGuard ?? null,
    http_status: r?.status ?? null, outcome: r?.outcome ?? null, latency_ms: r?.latency_ms ?? null, total_ms: r?.total_ms ?? null,
    attempts: r?.attempts.length ?? 0, retry_decision: r?.retry_decision ?? null,
    cost_usd: o.cost?.usd ?? null, cost_basis: o.cost?.basis ?? null, cost_billed: false,
    model_returned: j?.model ?? null, interaction_id: j?.id ?? null, interaction_status: j?.status ?? null,
    step_types: (j?.steps ?? []).map((s) => s.type), output_text: outputText(j), usage: j?.usage ?? null,
    error_body: r && r.outcome !== "ok" ? (r.json ?? scrub(r.text.slice(0, 4000))) : (j?.error ?? null),
    safety_like_fields: findSafetyFields(r?.json ?? null),
    stop: o.stop, stop_reason: o.stopReason ?? null,
    ledger_status: o.ledgerStatus ?? null, ledger_error: o.ledgerError ? scrub(o.ledgerError) : null,
    recorded_at: new Date().toISOString(), ...extra,
  };
}

/** Collect any finish/block/safety/reason-style fields anywhere in the response (for the refusal shape). */
function findSafetyFields(v: unknown, path = "$", out: Record<string, unknown> = {}): Record<string, unknown> {
  if (Array.isArray(v)) v.forEach((x, i) => findSafetyFields(x, `${path}[${i}]`, out));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (/finish|block|safety|reason|refus|moderat|status|error/i.test(k) && (typeof x !== "string" || x.length < 2000)) out[`${path}.${k}`] = x;
      findSafetyFields(x, `${path}.${k}`, out);
    }
  }
  return out;
}

function finish(stopReason?: string) {
  summary.finished_at = new Date().toISOString();
  summary.stopped_early = stopReason ?? null;
  (summary.runs as unknown[]).push({ started_at: summary.started_at, finished_at: summary.finished_at, stopped_early: stopReason ?? null });
  summary.ledger_totals_after = ledger.totals();
  writeJson(RESULTS, JSON.parse(scrub(JSON.stringify(summary))));
  log(`done. stopped_early=${stopReason ?? "no"}; ledger: ${JSON.stringify(ledger.totals())}`);
}

async function main() {
  if (!hasKey("GEMINI_API_KEY")) { log("GEMINI_API_KEY not set; nothing sent."); return finish("no key"); }

  // 0) Free preflight: is the key accepted and does the model id exist? (No image generated, not billed.)
  const pre: CallSpec = { keyName: "GEMINI_API_KEY", method: "GET", url: `${BASE}/models/${GEMINI.model}` };
  const pr = await call(pre);
  dump(join(OUT, "00-preflight-model-get.json"), pre, pr, { label: "00-preflight-model-get", billed: false });
  steps["00-preflight-model-get"] = { http_status: pr.status, outcome: pr.outcome, latency_ms: pr.latency_ms, body: pr.json ?? scrub(pr.text.slice(0, 2000)) };
  log(`preflight GET models/${GEMINI.model}: status=${pr.status} latency=${pr.latency_ms}ms`);
  if (pr.status !== 200) {
    log("Key/model preflight failed; per section 7 ('Key rejected') no paid call is sent. Stopping.");
    return finish(`preflight HTTP ${pr.status}: ${JSON.stringify((pr.json as { error?: { status?: string; details?: Array<{ reason?: string }> } } | null)?.error?.details?.[0]?.reason ?? (pr.json as { error?: { status?: string } } | null)?.error?.status ?? pr.outcome)}`);
  }

  // `extra` adds step-specific fields to the results.json entry. runPaidStep records the entry AFTER the
  // ledger update (step.ts), or just before rethrowing if that update fails, so after a LedgerBusy abort
  // results.json still matches the new dump (Argus N3, P3). A spend-guard refusal sets a non-zero exit (P6).
  const step = async <P = undefined>(label: string, estimate: number, body: unknown, persist?: (r: CallResult) => P, extra: (o: StepOutcome<P>) => Record<string, unknown> = () => ({})) => {
    const o = await runPaidStep<P>({ ledger, provider: "google", model: GEMINI.model, label, outDir: OUT, estimateUsd: estimate, estimateBasis: GEMINI.basis, spec: { keyName: "GEMINI_API_KEY", method: "POST", url: URL_INTERACTIONS, headers: API_REVISION, body: withStoreFalse(body) }, costOf: (r) => geminiCost(r, estimate), log, persist, record: (o) => record(o, extra(o)) });
    if (o.refusedBySpendGuard) { process.exitCode = EXIT_SPEND_GUARD; log(`${label} not sent (spend guard); the script will exit ${EXIT_SPEND_GUARD}.`); }
    return o;
  };
  /** persist callback for runPaidStep: saves the first output image before the ledger is settled (Argus F3). */
  const saveAs = (name: string) => (r: CallResult) => {
    const img = outputImages((r.json ?? null) as Interaction | null)[0];
    if (!img?.data) { log(`${name}: no output image in response`); return null; }
    const buf = Buffer.from(img.data, "base64");
    const s = saveImage(join(OUT, name), buf, img.mime_type);
    log(`saved ${relative(ROOT, s.path)} ${s.info.width}x${s.info.height} ${ratioLabel(s.info.width, s.info.height)}`);
    return { buf, mime: img.mime_type ?? "image/png", info: s.info, output: { file: relative(ROOT, s.path), mime_type: img.mime_type ?? null, ...s.info, aspect: ratioLabel(s.info.width, s.info.height) } };
  };

  // 1) Generate 3:4 at 1K: same ratio the xAI run ended up with (xAI has no 4:5), for an apples-to-apples comparison.
  const gen = await step("01-generate-3x4", GEMINI.generateEstimateUsd, { model: GEMINI.model, input: PROMPTS.generate, response_format: { type: "image", aspect_ratio: "3:4", image_size: "1K" } }, saveAs("01-generated"), (o) => ({ requested_aspect_ratio: "3:4", output: o.persisted?.output ?? null }));
  if (gen.stop) return finish(gen.stopReason);
  const g = gen.persisted;
  if (!g) return finish("no generated image");
  const src = { type: "image", mime_type: g.mime, data: g.buf.toString("base64") };

  // 2) Edit "make the background red", image passed inline (stateless; no previous_interaction_id), no aspect ratio given.
  const e1 = await step("02-edit-background-red", GEMINI.editEstimateUsd, { model: GEMINI.model, input: [{ type: "text", text: PROMPTS.edit }, src], response_format: { type: "image", image_size: "1K" } }, saveAs("02-edited-background-red"), (o) => ({ requested_aspect_ratio: null, source_dimensions: `${g.info.width}x${g.info.height}`, output: o.persisted?.output ?? null }));
  if (e1.stop) return finish(e1.stopReason);

  // 3) Edit to a different aspect ratio (outpaint test).
  const e2 = await step("03-edit-aspect-16x9", GEMINI.editEstimateUsd, { model: GEMINI.model, input: [{ type: "text", text: PROMPTS.editAspect }, src], response_format: { type: "image", aspect_ratio: "16:9", image_size: "1K" } }, saveAs("03-edited-aspect-16x9"), (o) => ({ requested_aspect_ratio: "16:9", source_dimensions: `${g.info.width}x${g.info.height}`, output: o.persisted?.output ?? null }));
  if (e2.stop) return finish(e2.stopReason);

  // 4) Generate 4:5 (plan's default ratio, T:84/T:194). 4:5 is in the documented ImageResponseFormat enum.
  const g45 = await step("04-generate-4x5", GEMINI.generateEstimateUsd, { model: GEMINI.model, input: PROMPTS.generate, response_format: { type: "image", aspect_ratio: "4:5", image_size: "1K" } }, saveAs("04-generated-4x5"), (o) => ({ requested_aspect_ratio: "4:5", output: o.persisted?.output ?? null }));
  if (g45.stop) return finish(g45.stopReason);

  // 5) Refusal probe: identical prompt to the xAI probe (photoreal named real person). OFF by default
  //    (Founder decision 7); the 2026-10-03 result is already recorded in 05-refusal-probe.json.
  //    If it runs and an image comes back, it is NOT saved (no persist callback); only metadata is kept.
  if (!optIn(FLAGS.refusalProbe)) {
    log(`refusal probe skipped (default; Founder decision 7 forbids photoreal named real people; evidence already in 05-refusal-probe.json). Set ${FLAGS.refusalProbe}=1 to send it.`);
    return finish();
  }
  const rp = await step("05-refusal-probe", GEMINI.generateEstimateUsd, { model: GEMINI.model, input: PROMPTS.refusal, response_format: { type: "image", aspect_ratio: "1:1", image_size: "1K" } }, undefined, (o) => {
    const i = outputImages((o.result?.json ?? null) as Interaction | null)[0];
    return { refusal_probe: true, image_returned: !!i, image_saved: false, returned_image_info: i?.data ? inspectImage(Buffer.from(i.data, "base64")) : null };
  });
  const rpi = outputImages((rp.result?.json ?? null) as Interaction | null)[0];
  if (rpi) log("refusal probe: provider returned an image; NOT saved to disk by design.");
  return finish(rp.stop ? rp.stopReason : undefined);
}

try { await main(); } catch (e) {
  // e.g. LedgerBusy after a paid call: outputs are already on disk; record the run, then fail non-zero.
  log(`run aborted: ${scrub(String((e as Error)?.message ?? e))}`);
  finish(`error: ${(e as Error)?.name ?? "Error"}`);
  process.exitCode = 1;
}
