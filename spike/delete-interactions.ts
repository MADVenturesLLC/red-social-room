// One-off cleanup (Founder decision 2026-10-03 22:32 ET): delete the 5 Gemini interactions the spike
// created with the default store=true, via the official endpoint:
//   DELETE https://generativelanguage.googleapis.com/v1beta/interactions/{interactionsId}
//   "Deletes the interaction by id ... If successful, the response is empty."  https://ai.google.dev/api/interactions-api
// Then a free GET per id to confirm it is gone. No generation calls; nothing here is billable.
import { join } from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { call, dump, type CallSpec } from "./lib/http.ts";
import { makeLogger } from "./lib/log.ts";
import { writeJson } from "./lib/save.ts";
import { scrub } from "./lib/secrets.ts";

const GEM = join(import.meta.dirname, "..", "spike-results", "gemini");
const OUT = join(GEM, "deletes");
const log = makeLogger(join(OUT, "run.log"));
const BASE = "https://generativelanguage.googleapis.com/v1beta/interactions";
const H = { "Api-Revision": "2026-05-20" };

const targets = readdirSync(GEM)
  .filter((f) => /^0[1-5]-.*\.json$/.test(f) && !f.includes("preflight"))
  .sort()
  .map((f) => ({ file: f, id: (JSON.parse(readFileSync(join(GEM, f), "utf8")) as { response?: { body?: { id?: string } } }).response?.body?.id }))
  .filter((t): t is { file: string; id: string } => typeof t.id === "string" && /^[A-Za-z0-9_\-]+$/.test(t.id));

if (targets.length !== 5) { log(`expected 5 interaction ids, found ${targets.length}; refusing to proceed`); process.exit(1); }

// Already done on 2026-10-03 22:33 ET (deletes/results.json). Don't re-send unless explicitly forced.
const DONE = join(OUT, "results.json");
if (existsSync(DONE) && process.env.FORCE_REDELETE !== "1") {
  const prev = JSON.parse(readFileSync(DONE, "utf8")) as { ran_at?: string; results?: Array<{ verify_get_status?: number }> };
  if ((prev.results ?? []).length === 5 && prev.results!.every((r) => r.verify_get_status === 404)) {
    console.log(`all 5 deletes already verified (404) at ${prev.ran_at}; nothing sent. Set FORCE_REDELETE=1 to re-run.`);
    process.exit(0);
  }
}

/** The Interactions API returns an empty JSON object on a successful delete. */
const isEmptyBody = (text: string) => text.trim() === "" || text.trim() === "{}";

const results: Array<Record<string, unknown>> = [];
for (const [i, t] of targets.entries()) {
  const del: CallSpec = { keyName: "GEMINI_API_KEY", method: "DELETE", url: `${BASE}/${t.id}`, headers: H };
  const d = await call(del);
  dump(join(OUT, `${String(i + 1).padStart(2, "0")}-delete.json`), del, d, { source_dump: t.file, interaction_id: t.id });
  const get: CallSpec = { keyName: "GEMINI_API_KEY", method: "GET", url: `${BASE}/${t.id}`, headers: H };
  const g = await call(get);
  dump(join(OUT, `${String(i + 1).padStart(2, "0")}-verify-get.json`), get, g, { source_dump: t.file, interaction_id: t.id });
  // Interactions errors look like {"error":{"message":"...","code":"not_found"}}: `code` is a string and there is
  // no `status` (unlike the models endpoint's {code:400,status:"INVALID_ARGUMENT"}; PLAN-GAPS 29). Read both.
  const ge = (g.json as { error?: { code?: number | string; status?: string; message?: string } } | null)?.error;
  const geLabel = ge ? String(ge.code ?? ge.status ?? "error") : "";
  const row = { source_dump: t.file, interaction_id: t.id, delete_status: d.status, delete_body: isEmptyBody(d.text) ? (d.json ?? "(empty)") : (d.json ?? scrub(d.text.slice(0, 500))), delete_latency_ms: d.latency_ms, verify_get_status: g.status, verify_get_error: ge ? { code: ge.code, status: ge.status ?? null, message: ge.message } : null };
  results.push(row);
  log(`${t.file}: DELETE ${d.status} (${d.latency_ms} ms, body ${isEmptyBody(d.text) ? `empty${d.text.trim() ? " {}" : ""}` : "non-empty"}); verify GET ${g.status}${geLabel ? ` ${geLabel}` : ""}`);
}
writeJson(join(OUT, "results.json"), JSON.parse(scrub(JSON.stringify({ docs: "https://ai.google.dev/api/interactions-api (deleteInteraction)", ran_at: new Date().toISOString(), results }))));
