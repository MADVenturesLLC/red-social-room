// A2 run queue (Amendment 1 section 4 item 11; TECH-PLAN-v1-AMENDMENT-1.md:75): one prompt, one or more
// creator cards, one job row per image. Jobs run in-process with static per-provider concurrency
// (config.ts PROVIDER_CONCURRENCY: xAI 2, Google 2); every job is one paid call that goes through the
// provider adapter unchanged (capabilities -> key check -> cap + reservation -> send -> cost). The UI
// follows a run over server-sent events (GET /api/run/<id>/events) and reads it back at GET /api/run/<id>.
// A3: the same queue carries edit runs (kind 'edit', source image in jobs.parent_asset_id) and reference
// runs (kind 'generate' with a parent); mode on the run view says which.
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { isoNY } from "../../spike/lib/ledger.ts";
import { tx, type DB } from "./db.ts";
import { PROVIDER_CONCURRENCY } from "./config.ts";
import { checkPrompt } from "./prompt-check.ts";
import { checkWritable, DataDirNotWritable, NOT_WRITABLE_MESSAGE } from "./writable.ts";
import { executeEdit, executeGeneration, recordGeneration, type AppDeps, type GenerateView, type ProviderId } from "./execute.ts";
import { generationCostText } from "./ledger.ts";
import { CAPABILITIES as XAI_CAPS, MODEL as XAI_MODEL } from "./xai/adapter.ts";
import { CAPABILITIES as GOOGLE_CAPS, MODEL as GOOGLE_MODEL, PRO_MODEL as GOOGLE_PRO_MODEL } from "./google/adapter.ts";

/** The creator cards: one per provider (Amendment 1 section 4 item 27). */
export interface CreatorDef { id: string; provider: ProviderId; name: string; model: string; blurb: string }
export const CREATORS: readonly CreatorDef[] = Object.freeze([
  { id: "xai", provider: "xai", name: "Grok Imagine 2.0", model: XAI_MODEL, blurb: "xAI" },
  { id: "google", provider: "google", name: "Nano Banana 2", model: GOOGLE_MODEL, blurb: "Google" },
  // FD:11: Nano Banana Pro is its own card, off by default ("Nano Banana 2 is the default"), same Google key and pool.
  { id: "google-pro", provider: "google", name: "Nano Banana Pro", model: GOOGLE_PRO_MODEL, blurb: "Google" },
]);

function capsOf(def: CreatorDef): { edit: boolean; maxReferenceImages: number } {
  return def.provider === "xai" ? XAI_CAPS : GOOGLE_CAPS;
}

export const MAX_IMAGES_PER_CREATOR = 4;

export interface RunJobRow { id: string; run_id: string; creator_id: string; provider: ProviderId; model: string; generation_id: string; prompt: string; ratio: string; status: string; label: string | null; kind: string; parent_asset_id: string | null; created_at: string; started_at: string | null; finished_at: string | null; error: string | null }
export type JobStatus = "queued" | "running" | "ok" | "refused" | "error" | "blocked" | "not_sent";

export interface JobView { jobId: string; creator: string; name: string; model: string; status: JobStatus; generationId: string; kind: string; parentAssetId: string | null; view: GenerateView | null }
export interface RunView { id: string; prompt: string; status: string; created_at: string; mode: "generate" | "edit" | "reference"; jobs: JobView[] }

export class RunInputError extends Error {
  constructor(message: string) { super(message); this.name = "RunInputError"; }
}

interface Runner { queues: Map<ProviderId, string[]>; inflight: Map<ProviderId, number>; emitters: Map<string, EventEmitter> }
const runners = new WeakMap<AppDeps, Runner>();

function runnerOf(d: AppDeps): Runner {
  let r = runners.get(d);
  if (!r) {
    r = { queues: new Map([["xai", []], ["google", []]]), inflight: new Map([["xai", 0], ["google", 0]]), emitters: new Map() };
    runners.set(d, r);
  }
  return r;
}

/** Parse and validate the /api/run body. */
export function parseRunInput(body: unknown): { prompt: string; ratio: string; creators: Array<{ id: string; n: number }> } {
  const o = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const prompt = typeof o.prompt === "string" ? o.prompt.trim() : "";
  if (!prompt) throw new RunInputError("Type a prompt first.");
  if (prompt.length > 64000) throw new RunInputError("Prompts are limited to 64,000 characters.");
  const ratio = typeof o.ratio === "string" ? o.ratio : "";
  if (!ratio) throw new RunInputError("Pick an aspect ratio.");
  const raw = Array.isArray(o.creators) ? o.creators : [];
  const seen = new Set<string>();
  const creators: Array<{ id: string; n: number }> = [];
  for (const c of raw) {
    const cc = (c && typeof c === "object" ? c : {}) as { id?: unknown; n?: unknown };
    const def = typeof cc.id === "string" ? CREATORS.find((x) => x.id === cc.id) : undefined;
    if (!def) throw new RunInputError(`Unknown creator: ${String(cc.id)}`);
    if (seen.has(def.id)) throw new RunInputError(`Creator ${def.id} is listed twice.`);
    seen.add(def.id);
    if (typeof cc.n !== "number" || !Number.isInteger(cc.n) || cc.n < 1 || cc.n > MAX_IMAGES_PER_CREATOR) throw new RunInputError(`Each creator makes 1-${MAX_IMAGES_PER_CREATOR} images.`);
    creators.push({ id: def.id, n: cc.n });
  }
  if (!creators.length) throw new RunInputError("Pick at least one creator.");
  return { prompt, ratio, creators };
}

/**
 * Start a run: the run row and one job per image, then queue the jobs. With the real-person check blocked
 * (or unavailable under P1c=block), the run is `blocked` up front: every job shows the reason, nothing is
 * sent, and no ledger row exists (F10).
 */
export function startRun(d: AppDeps, input: { prompt: unknown; ratio: unknown; creators: unknown }): { runId: string; blocked: boolean; message: string | null; label: string | null } {
  const { prompt, ratio, creators } = parseRunInput(input);
  checkWritable(d.dataDir);
  const pc = checkPrompt(prompt, d.promptMethod, d.switches.promptCheck, d.db);
  const runId = randomUUID();
  const queued: Array<{ jobId: string; provider: ProviderId }> = [];
  tx(d.db, () => {
    d.db.prepare("INSERT INTO runs (id, created_at, prompt, status) VALUES (?, ?, ?, ?)").run(runId, isoNY(), prompt, pc.allowed ? "running" : "blocked");
    const ins = d.db.prepare("INSERT INTO jobs (id, run_id, creator_id, provider, model, generation_id, prompt, ratio, status, label, kind, parent_asset_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'generate', NULL, ?)");
    for (const c of creators) {
      const def = CREATORS.find((x) => x.id === c.id)!;
      for (let i = 0; i < c.n; i++) {
        const jobId = randomUUID();
        ins.run(jobId, runId, def.id, def.provider, def.model, randomUUID(), prompt, ratio, pc.allowed ? "queued" : "blocked", pc.allowed ? pc.label : null, isoNY());
        queued.push({ jobId, provider: def.provider });
      }
    }
  });
  if (!pc.allowed) {
    const rows = d.db.prepare("SELECT * FROM jobs WHERE run_id = ? ORDER BY created_at, id").all(runId) as unknown as RunJobRow[];
    for (const j of rows) {
      recordGeneration(d, { runId, provider: j.provider, model: j.model, generationId: j.generation_id, prompt, ratio, status: pc.result === "blocked" ? "blocked" : "not_sent", error_code: pc.result, error_message: pc.message });
    }
    return { runId, blocked: true, message: pc.message, label: pc.label };
  }
  const r = runnerOf(d);
  for (const q of queued) r.queues.get(q.provider)!.push(q.jobId);
  pump(d, r);
  return { runId, blocked: false, message: null, label: pc.label };
}

// ---- A3: edit and reference runs (same queue, same SSE) ----

export interface EditRunInput { mode: "edit" | "reference"; sourceAssetId: string; instruction: string; ratio: string | null; models: string[] }

/** Parse and validate the /api/edit body: edit (up to two models = compare) or reference (image + prompt). */
export function parseEditInput(d: AppDeps, body: unknown): EditRunInput {
  const o = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const mode: "edit" | "reference" = o.mode === "reference" ? "reference" : "edit";
  const sourceAssetId = typeof o.sourceAssetId === "string" ? o.sourceAssetId : "";
  if (!/^[a-f0-9]{64}$/.test(sourceAssetId)) throw new RunInputError("That image is not stored. Upload or generate it first.");
  if (!d.db.prepare("SELECT 1 FROM assets WHERE id = ?").get(sourceAssetId)) throw new RunInputError("That image is not in the store. Upload or generate it first.");
  const instruction = typeof o.instruction === "string" ? o.instruction.trim() : "";
  if (!instruction) throw new RunInputError(mode === "edit" ? "Type an instruction first." : "Type a prompt first.");
  if (instruction.length > 64000) throw new RunInputError("Instructions are limited to 64,000 characters.");
  const raw = Array.isArray(o.models) ? o.models : [];
  const models: string[] = [];
  for (const m of raw) {
    const id = typeof m === "string" ? m : (m && typeof m === "object" ? (m as { id?: unknown }).id : undefined);
    const def = typeof id === "string" ? CREATORS.find((x) => x.id === id) : undefined;
    if (!def) throw new RunInputError(`Unknown creator: ${String(id)}`);
    if (models.includes(def.id)) throw new RunInputError(`Creator ${def.id} is listed twice.`);
    if (mode === "edit" && !capsOf(def).edit) throw new RunInputError(`${def.name} can't edit images.`);
    if (mode === "reference" && capsOf(def).maxReferenceImages < 1) throw new RunInputError(`${def.name} can't take reference images. Use a Google card, or use Edit.`);
    models.push(def.id);
  }
  if (models.length < 1 || models.length > 2) throw new RunInputError("Pick 1-2 models (two runs a compare).");
  let ratio: string | null = null;
  if (mode === "reference") {
    ratio = typeof o.ratio === "string" ? o.ratio : "";
    if (!ratio) throw new RunInputError("Pick an aspect ratio.");
  }
  return { mode, sourceAssetId, instruction, ratio, models };
}

/** Start an edit or reference run: one job per model, same runner queue, same events. */
export function startEditRun(d: AppDeps, body: unknown): { runId: string; blocked: boolean; message: string | null; label: string | null; mode: "edit" | "reference" } {
  const input = parseEditInput(d, body);
  checkWritable(d.dataDir);
  const pc = checkPrompt(input.instruction, d.promptMethod, d.switches.promptCheck, d.db);
  const runId = randomUUID();
  const queued: Array<{ jobId: string; provider: ProviderId }> = [];
  tx(d.db, () => {
    d.db.prepare("INSERT INTO runs (id, created_at, prompt, status) VALUES (?, ?, ?, ?)").run(runId, isoNY(), input.instruction, pc.allowed ? "running" : "blocked");
    const ins = d.db.prepare("INSERT INTO jobs (id, run_id, creator_id, provider, model, generation_id, prompt, ratio, status, label, kind, parent_asset_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const id of input.models) {
      const def = CREATORS.find((x) => x.id === id)!;
      const jobId = randomUUID();
      ins.run(jobId, runId, def.id, def.provider, def.model, randomUUID(), input.instruction,
        input.mode === "reference" ? input.ratio! : "source",
        pc.allowed ? "queued" : "blocked", pc.allowed ? pc.label : null,
        input.mode === "reference" ? "generate" : "edit", input.sourceAssetId, isoNY());
      queued.push({ jobId, provider: def.provider });
    }
  });
  if (!pc.allowed) {
    const rows = d.db.prepare("SELECT * FROM jobs WHERE run_id = ? ORDER BY created_at, id").all(runId) as unknown as RunJobRow[];
    for (const j of rows) {
      recordGeneration(d, { runId, provider: j.provider, model: j.model, generationId: j.generation_id, prompt: input.instruction, ratio: j.ratio, kind: j.kind === "edit" ? "edit" : "generate", parent_asset_id: j.parent_asset_id, status: pc.result === "blocked" ? "blocked" : "not_sent", error_code: pc.result, error_message: pc.message });
    }
    return { runId, blocked: true, message: pc.message, label: pc.label, mode: input.mode };
  }
  const r = runnerOf(d);
  for (const q of queued) r.queues.get(q.provider)!.push(q.jobId);
  pump(d, r);
  return { runId, blocked: false, message: null, label: pc.label, mode: input.mode };
}

/** Startup sweep: jobs left queued/running belong to a process that is gone (one server per data directory). */
export function resetStrandedJobs(db: DB): number {
  const r = db.prepare("UPDATE jobs SET status = 'error', error = ?, finished_at = ? WHERE status IN ('queued','running')").run("interrupted: the app stopped while this job was running", isoNY());
  let runs = 0;
  for (const s of db.prepare("SELECT id FROM runs WHERE status = 'running'").all() as unknown as Array<{ id: string }>) {
    const done = db.prepare("SELECT COUNT(*) AS c FROM jobs WHERE run_id = ? AND status = 'ok'").get(s.id) as { c: number };
    db.prepare("UPDATE runs SET status = ? WHERE id = ?").run(Number(done.c) > 0 ? "partial" : "failed", s.id);
    runs++;
  }
  return Number(r.changes) + runs;
}

function finalizeRunStatus(d: AppDeps, runId: string): string {
  const rows = d.db.prepare("SELECT status FROM jobs WHERE run_id = ?").all(runId) as unknown as Array<{ status: string }>;
  const total = rows.length;
  const ok = rows.filter((r) => r.status === "ok").length;
  const idle = rows.filter((r) => r.status === "blocked" || r.status === "not_sent").length;
  let status: string;
  if (ok === total) status = "ok";
  else if (ok === 0 && idle === total) status = "blocked";
  else if (ok === 0 && rows.every((r) => r.status !== "queued" && r.status !== "running")) status = "failed";
  else if (ok === 0) status = "running";
  else status = "partial";
  d.db.prepare("UPDATE runs SET status = ? WHERE id = ?").run(status, runId);
  return status;
}

function emit(r: Runner, runId: string, ev: unknown): void {
  r.emitters.get(runId)?.emit("event", ev);
}

/** Follow a run's job updates (server-sent events route). Returns the unsubscribe function. */
export function subscribeRun(d: AppDeps, runId: string, fn: (ev: unknown) => void): () => void {
  const r = runnerOf(d);
  let e = r.emitters.get(runId);
  if (!e) { e = new EventEmitter(); e.setMaxListeners(64); r.emitters.set(runId, e); }
  e.on("event", fn);
  const em = e;
  return () => {
    em.off("event", fn);
    // Prune so finished runs do not leak emitters; only if this is still the registered one.
    if (em.listenerCount("event") === 0 && r.emitters.get(runId) === em) r.emitters.delete(runId);
  };
}

async function executeJob(d: AppDeps, r: Runner, jobId: string): Promise<void> {
  const job = d.db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as unknown as RunJobRow | undefined;
  if (!job || job.status !== "queued") return;
  d.db.prepare("UPDATE jobs SET status = 'running', started_at = ? WHERE id = ?").run(isoNY(), jobId);
  emit(r, job.run_id, { type: "job", jobId, status: "running" });
  let status: JobStatus;
  let error: string | null = null;
  try {
    const view = job.kind === "edit"
      ? await executeEdit(d, { runId: job.run_id, provider: job.provider, model: job.model, instruction: job.prompt, sourceAssetId: job.parent_asset_id!, generationId: job.generation_id })
      : await executeGeneration(d, { runId: job.run_id, provider: job.provider, model: job.model, prompt: job.prompt, ratio: job.ratio, generationId: job.generation_id, referenceAssetId: job.parent_asset_id ?? null });
    status = view.status;
    error = view.status === "error" || view.status === "refused" ? view.message : null;
  } catch (e) {
    status = "error";
    error = e instanceof DataDirNotWritable ? NOT_WRITABLE_MESSAGE : "The app failed inside this job; nothing else was sent.";
    d.log?.(`run ${job.run_id} job ${jobId} failed: ${(e as Error).name}`);
  }
  d.db.prepare("UPDATE jobs SET status = ?, finished_at = ?, error = ? WHERE id = ?").run(status, isoNY(), error, jobId);
  emit(r, job.run_id, { type: "job", jobId, status });
  const remaining = d.db.prepare("SELECT COUNT(*) AS c FROM jobs WHERE run_id = ? AND status IN ('queued','running')").get(job.run_id) as { c: number };
  if (Number(remaining.c) === 0) {
    const runStatus = finalizeRunStatus(d, job.run_id);
    emit(r, job.run_id, { type: "run", status: runStatus });
  }
}

/** Per-provider worker pump: at most PROVIDER_CONCURRENCY[provider] jobs in flight at once. */
function pump(d: AppDeps, r: Runner): void {
  for (const [provider, queue] of r.queues) {
    const limit = PROVIDER_CONCURRENCY[provider] ?? 1;
    while (queue.length && (r.inflight.get(provider) ?? 0) < limit) {
      const jobId = queue.shift()!;
      r.inflight.set(provider, (r.inflight.get(provider) ?? 0) + 1);
      void executeJob(d, r, jobId).finally(() => {
        r.inflight.set(provider, (r.inflight.get(provider) ?? 1) - 1);
        pump(d, r);
      });
    }
  }
}

const VIEW_SELECT = `SELECT j.*, g.id AS g_id, g.status AS g_status, g.error_code, g.error_message, g.client_request_id, g.provider_request_id, g.display_asset_id, g.output_asset_id, g.display_note, g.latency_ms,
  da.width AS d_w, da.height AS d_h, oa.width AS o_w, oa.height AS o_h
  FROM jobs j LEFT JOIN generations g ON g.id = j.generation_id
  LEFT JOIN assets da ON da.id = g.display_asset_id LEFT JOIN assets oa ON oa.id = g.output_asset_id
  WHERE j.run_id = ? ORDER BY j.created_at, j.id`;

function jobViewOf(d: AppDeps, row: Record<string, unknown>): JobView {
  const creator = CREATORS.find((c) => c.id === row.creator_id);
  const view: GenerateView | null = row.g_id ? {
    generationId: String(row.g_id),
    status: String(row.g_status) as GenerateView["status"],
    code: (row.error_code as string | null) ?? null,
    message: (row.error_message as string | null) ?? null,
    label: (row.label as string | null) ?? null, // the run's real-person check label (P1c send_labeled)
    model: String(row.model),
    image: row.display_asset_id ? { assetId: String(row.display_asset_id), width: (row.d_w as number | null) ?? null, height: (row.d_h as number | null) ?? null } : null,
    original: row.output_asset_id ? { assetId: String(row.output_asset_id), width: (row.o_w as number | null) ?? null, height: (row.o_h as number | null) ?? null } : null,
    displayNote: (row.display_note as string | null) ?? null,
    latencyMs: (row.latency_ms as number | null) ?? null,
    costText: generationCostText(d.db, String(row.generation_id)),
    ref: (row.client_request_id as string | null) ?? null,
  } : null;
  return { jobId: String(row.id), creator: String(row.creator_id), name: creator?.name ?? String(row.creator_id), model: String(row.model), status: row.status as JobStatus, generationId: String(row.generation_id), kind: String(row.kind ?? "generate"), parentAssetId: (row.parent_asset_id as string | null) ?? null, view };
}

/** The whole run as the UI and tests read it. */
export function runView(d: AppDeps, runId: string): RunView | null {
  const run = d.db.prepare("SELECT id, prompt, status, created_at FROM runs WHERE id = ?").get(runId) as { id: string; prompt: string; status: string; created_at: string } | undefined;
  if (!run) return null;
  const rows = d.db.prepare(VIEW_SELECT).all(runId) as unknown as Array<Record<string, unknown>>;
  const jobs = rows.map((row) => jobViewOf(d, row));
  const mode: RunView["mode"] = jobs.some((j) => j.kind === "edit") ? "edit" : jobs.some((j) => j.parentAssetId) ? "reference" : "generate";
  return { ...run, mode, jobs };
}
