// prompt -> image (TECH-PLAN-v1.md section 9 A1). Now a thin single-call wrapper over executeGeneration
// (shared with the A2 run queue). Order (Amendment 1 G7): writable check -> real-person check (D1, F10) ->
// capabilities -> key check -> cap check + reservation -> send (the last four inside the provider adapter).
import { randomUUID } from "node:crypto";
import { isoNY } from "../../spike/lib/ledger.ts";
import { checkPrompt } from "./prompt-check.ts";
import { MODEL } from "./xai/adapter.ts";
import { checkWritable } from "./writable.ts";
import { tx } from "./db.ts";
import { executeGeneration, recordGeneration, type AppDeps, type GenerateView } from "./execute.ts";
import type { PromptCheckMethod } from "./prompt-check.ts";

export { costText } from "./execute.ts";
export type { AppDeps, GenerateView } from "./execute.ts";
export type { PromptCheckMethod };

export async function runGenerate(d: AppDeps, input: { prompt: unknown; ratio: unknown }): Promise<GenerateView> {
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  const ratio = typeof input.ratio === "string" ? input.ratio : "4:5";
  const runId = randomUUID(), generationId = randomUUID();
  const view: GenerateView = { generationId, status: "error", code: null, message: null, label: null, model: MODEL, image: null, original: null, displayNote: null, latencyMs: null, costText: null, ref: null };

  // 0) A1 pin 19 (d), line 370: no paid call unless the data directory and database are writable (throws
  //    DataDirNotWritable; the route answers 500 with NOT_WRITABLE_MESSAGE). Nothing is recorded or sent.
  checkWritable(d.dataDir);

  // 1) Real-person check (D1, F10). A block or an unavailable check sends nothing and creates no ledger row.
  const pc = checkPrompt(prompt, d.promptMethod, d.switches.promptCheck, d.db);
  if (!pc.allowed) {
    const status = pc.result === "blocked" ? "blocked" : "not_sent";
    tx(d.db, () => {
      d.db.prepare("INSERT INTO runs (id, created_at, prompt, status) VALUES (?, ?, ?, 'blocked')").run(runId, isoNY(), prompt);
    });
    recordGeneration(d, { runId, provider: "xai", model: MODEL, generationId, prompt, ratio, status, error_code: pc.result, error_message: pc.message });
    return { ...view, status, code: pc.result, message: pc.message };
  }
  view.label = pc.label;

  // 2) Run row first (the generations FK needs it), then the adapter through the shared executor.
  tx(d.db, () => {
    d.db.prepare("INSERT INTO runs (id, created_at, prompt, status) VALUES (?, ?, ?, 'running')").run(runId, isoNY(), prompt);
  });
  const out = await executeGeneration(d, { runId, provider: "xai", model: MODEL, prompt, ratio, generationId });
  out.label = pc.label;
  d.db.prepare("UPDATE runs SET status = ? WHERE id = ?").run(out.status === "ok" ? "ok" : out.status === "blocked" || out.status === "not_sent" ? "blocked" : "failed", runId);
  return out;
}
