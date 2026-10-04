// Free (non-billed) metadata calls: confirm keys are accepted and model ids exist BEFORE any paid call.
// No image is generated here, so nothing goes through the spend ledger.
import { join } from "node:path";
import { call, dump, type CallSpec } from "./lib/http.ts";
import { hasKey } from "./lib/secrets.ts";
import { makeLogger } from "./lib/log.ts";

const OUT = join(import.meta.dirname, "..", "spike-results", "preflight");
const log = makeLogger(join(OUT, "run.log"));

const checks: Array<{ name: string; spec: CallSpec }> = [
  { name: "xai-image-generation-models", spec: { keyName: "XAI_API_KEY", method: "GET", url: "https://api.x.ai/v1/image-generation-models" } },
  { name: "gemini-model-gemini-3.1-flash-image", spec: { keyName: "GEMINI_API_KEY", method: "GET", url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image" } },
];

for (const c of checks) {
  if (!hasKey(c.spec.keyName)) { log(`${c.name}: ${c.spec.keyName} not set, skipping`); continue; }
  const r = await call(c.spec);
  dump(join(OUT, `${c.name}.json`), c.spec, r);
  log(`${c.name}: outcome=${r.outcome} status=${r.status} latency=${r.latency_ms}ms`);
  if (r.json && typeof r.json === "object") {
    const j = r.json as Record<string, unknown>;
    if (Array.isArray(j.models)) log(`  models: ${(j.models as Array<{ id?: string; aliases?: string[] }>).map((m) => `${m.id}${m.aliases?.length ? ` (aliases: ${m.aliases.join(",")})` : ""}`).join("; ")}`);
    else log(`  ${JSON.stringify({ name: j.name, version: j.version, displayName: j.displayName, supportedGenerationMethods: j.supportedGenerationMethods, error: j.error })}`);
  }
}
