// Offline fake transport for the script behaviour tests (preloaded with `node --import`).
// Replaces globalThis.fetch, so NOTHING reaches the network: every request the spike scripts would send
// is appended to $STUB_LOG as one JSON line and answered with a canned provider-shaped response.
// Unknown hosts throw. The child process only ever gets dummy keys (see scripts.test.ts).
//
// Knobs (env): STUB_LOCK=<path>  create this file on the first POST (simulates another run grabbing the
//                                ledger lock right after a paid call returns)
//              STUB_FAST_SLEEP=1 make the ledger's bounded lock wait instant (Atomics.wait -> no-op)
//              STUB_GEMINI_USAGE=empty  answer Gemini POSTs with `usage: {}`
//              STUB_GEMINI_SHAPE=v2     a hypothetical future image shape: the image block is renamed and
//                                       the usage block drops output_tokens_by_modality (Argus P2)
//              STUB_GEMINI_SHAPE=hole   the image sits in an extra step key next to a text block, with no
//                                       modality list and 1549 output tokens (Argus Q1, his "gem-hole")
//              STUB_GEMINI_SHAPE=nullstep  steps: [null] (a 200 that breaks the schema; Argus Q2)
//              STUB_GEMINI_SHAPE=error400  HTTP 400 error body: no steps, no usage (Argus R4)
import { appendFileSync, existsSync, writeFileSync } from "node:fs";

const LOG = process.env.STUB_LOG;
if (!LOG) throw new Error("fetch-stub: STUB_LOG not set");
// 1x1 PNG
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
if (process.env.STUB_FAST_SLEEP === "1") Atomics.wait = () => "timed-out";

const json = (status, j) => new Response(JSON.stringify(j), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const method = init.method ?? "GET";
  let body = null;
  try { body = init.body ? JSON.parse(init.body) : null; } catch { body = "(unparsable)"; }
  const prompt = body?.prompt ?? (typeof body?.input === "string" ? body.input : Array.isArray(body?.input) ? body.input.find((x) => x.type === "text")?.text ?? null : null);
  const aspect_ratio = body?.aspect_ratio ?? body?.response_format?.aspect_ratio ?? null;
  appendFileSync(LOG, JSON.stringify({ method, host: u.host, path: u.pathname, prompt, aspect_ratio, has_store: !!body && typeof body === "object" && "store" in body, store: body?.store ?? null }) + "\n");
  if (process.env.STUB_LOCK && method === "POST" && !existsSync(process.env.STUB_LOCK)) writeFileSync(process.env.STUB_LOCK, "");

  if (u.host === "api.x.ai") {
    if (aspect_ratio === "4:5") {
      return new Response("Failed to deserialize the JSON body into the target type: aspect_ratio: unknown variant `4:5` (stub)", { status: 422, headers: { "content-type": "text/plain" } });
    }
    const ticks = u.pathname.endsWith("/edits") ? 700000000 : 400000000;
    return json(200, { data: [{ b64_json: PNG, mime_type: "image/png" }], usage: { cost_in_usd_ticks: ticks } });
  }
  if (u.host === "generativelanguage.googleapis.com") {
    if (method === "GET" && u.pathname.includes("/models/")) return json(200, { name: "models/stub", version: "stub" });
    if (method === "DELETE") return json(200, {});
    if (method === "GET") return json(404, { error: { message: "Requested entity was not found.", code: "not_found" } });
    const refusal = typeof prompt === "string" && /handcuffs/.test(prompt);
    const usage = process.env.STUB_GEMINI_USAGE === "empty" ? {} : refusal
      ? { total_input_tokens: 40, total_output_tokens: 18, total_thought_tokens: 0 }
      : { total_input_tokens: 26, total_output_tokens: 1549, total_thought_tokens: 0, output_tokens_by_modality: [{ modality: "image", tokens: 1120 }] };
    const shape = process.env.STUB_GEMINI_SHAPE;
    if (shape === "hole" && !refusal) return json(200, { id: "v1_stub", status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: "Here is your image" }], images: [{ data: PNG, mime_type: "image/png" }] }], usage: { total_input_tokens: 26, total_output_tokens: 1549, total_thought_tokens: 0 } });
    if (shape === "error400" && !refusal) return json(400, { error: { code: 400, message: "Invalid value at 'response_format' (stub)", status: "INVALID_ARGUMENT" } });
    if (shape === "nullstep" && !refusal) return json(200, { id: "v1_stub", status: "completed", steps: [null], usage: { total_input_tokens: 26, total_output_tokens: 1549, total_thought_tokens: 0, output_tokens_by_modality: [{ modality: "image", tokens: 1120 }] } });
    const v2 = shape === "v2";
    if (v2 && !refusal) delete usage.output_tokens_by_modality;
    const content = refusal ? [{ type: "text", text: "I can't generate that (stub)." }] : v2 ? [{ type: "generated_image", inline_data: { data: PNG, mime_type: "image/png" } }] : [{ type: "image", data: PNG, mime_type: "image/png" }];
    return json(200, { id: "v1_stub", model: "gemini-3.1-flash-image", status: "completed", steps: [{ type: "model_output", content }], usage });
  }
  throw new Error(`fetch-stub: refusing unknown host ${u.host}`);
};
