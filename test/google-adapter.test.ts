// Google adapter behavior against a scripted fake Interactions API (Amendment 1 sections 3.2/3.3 Google
// column; section 4 A2: items 6, 8, 12, 23, 26, 29). No network, dummy key only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generate as googleGenerate } from "../src/server/google/adapter.ts";
import { googleDepsOf } from "../src/server/execute.ts";
import { toMicros } from "../spike/lib/ledger.ts";
import { monthTotals, unresolvedRows } from "../src/server/ledger.ts";
import { makeApp, fakeGoogle, googleGenOk, googleUsage, jsonRes, hang, netError, ledgerRows, DUMMY_GOOGLE_KEY } from "./helpers.ts";
import type { Handler } from "./helpers.ts";

const GEN = "22222222-2222-4222-8222-222222222222";
const USD_OK = (26 * 0.5 + 429 * 3 + 1120 * 60) / 1e6; // $0.0685 (the spike's recorded usage)
const OK_MICROS = toMicros(USD_OK);
const text = (status: number, body: string, ct = "text/plain"): Handler => () => new Response(body, { status, headers: { "content-type": ct } });

function withG(fn: (t: ReturnType<typeof makeApp>, g: ReturnType<typeof fakeGoogle>) => Promise<void>, o: { interactions?: Handler[]; model?: Handler; capUsd?: number; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}) {
  return async () => {
    const g = fakeGoogle({ interactions: o.interactions, model: o.model });
    const t = makeApp({ fetch: g.fetch, capUsd: o.capUsd, env: o.env, timeoutMs: o.timeoutMs });
    try { await fn(t, g); } finally { t.cleanup(); }
  };
}
const runG = (t: ReturnType<typeof makeApp>, ratio = "4:5", prompt = "a corgi surfing a wave") =>
  googleGenerate(googleDepsOf(t.app), { prompt, ratio, generationId: GEN });

test("ok: free key check first, then one POST; store:false, no previous_interaction_id, Api-Revision; cost from tokens", withG(async (t, g) => {
  assert.equal(OK_MICROS, 68500); // the pinned $0.0685 in Amendment 1 item 8
  const out = await runG(t);
  assert.equal(out.kind, "ok");
  assert.deepEqual(g.requests.map((r) => `${r.method} ${r.path}`), ["GET /v1beta/models/gemini-3.1-flash-image", "POST /v1beta/interactions"]);
  const req = g.posts()[0];
  assert.equal(req.body!.store, false);
  assert.equal("previous_interaction_id" in req.body!, false);
  assert.equal(req.headers["api-revision"], "2026-05-20");
  assert.equal(req.headers["x-goog-api-key"], DUMMY_GOOGLE_KEY);
  assert.equal(req.headers.authorization, undefined);
  assert.equal(req.body!.model, "gemini-3.1-flash-image");
  assert.equal(req.body!.input, "a corgi surfing a wave");
  assert.deepEqual(req.body!.response_format, { type: "image", aspect_ratio: "4:5", image_size: "1K" });
  const [row] = ledgerRows(t.app);
  assert.equal(row.status, "settled");
  assert.equal(row.actual_micro_usd, OK_MICROS);
  assert.equal(row.cost_source, "estimated_tokens");
  assert.equal(row.provider, "google");
  assert.equal(row.estimate_micro_usd, 75000);
  assert.equal(out.kind === "ok" && out.clientRequestId, row.id);
  assert.equal(out.kind === "ok" && out.mime, "image/jpeg");
  assert.equal(out.kind === "ok" && out.modelVersionListing, "models/gemini-3.1-flash-image / 3.0");
}));

test("key check is cached; a second generate sends no second model GET", withG(async (t, g) => {
  await runG(t);
  await runG(t);
  assert.equal(g.requests.filter((r) => r.path.endsWith("/models/gemini-3.1-flash-image")).length, 1);
  assert.equal(g.posts().length, 2);
}));

test("F1 bad key (classic 400 API_KEY_INVALID): zero POSTs, no ledger row, 'Key rejected'", withG(async (t, g) => {
  const out = await runG(t);
  assert.equal(out.kind, "error");
  assert.equal(out.kind === "error" && out.code, "auth");
  assert.match(out.kind === "error" ? out.message : "", /^Key rejected/);
  assert.equal(g.posts().length, 0);
  assert.equal(ledgerRows(t.app).length, 0);
}, { model: () => jsonRes(400, { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] } }) }));

test("F1: the key check cannot reach Google -> nothing paid is sent (fails closed)", withG(async (t, g) => {
  const out = await runG(t);
  assert.equal(out.kind === "error" && out.code, "unavailable");
  assert.equal(g.posts().length, 0);
  assert.equal(ledgerRows(t.app).length, 0);
}, { model: netError("ECONNREFUSED") }));

test("no key set -> no request at all", withG(async (t, g) => {
  const out = await runG(t);
  assert.equal(out.kind === "error" && out.code, "no_key");
  assert.equal(g.requests.length, 0);
}, { env: {} }));

test("F11: an unsupported ratio is refused before any request or ledger row", withG(async (t, g) => {
  const out = await runG(t, "7:5");
  assert.equal(out.kind === "error" && out.message, "Not supported by Nano Banana 2: aspect ratio 7:5");
  assert.equal(g.requests.length, 0);
  assert.equal(ledgerRows(t.app).length, 0);
}));

test("F3 timeout after send: unresolved (never $0), full reservation counted, no retry", withG(async (t, g) => {
  const before = monthTotals(t.app.db).countedMicros;
  const out = await runG(t);
  assert.equal(out.kind === "error" && out.code, "timeout");
  assert.match(out.kind === "error" ? out.message : "", /Google timed out after 0 s\. It may still have been charged; \$0\.07 is held against your cap until you check\./);
  assert.equal(g.posts().length, 1);
  const [row] = ledgerRows(t.app);
  assert.equal(row.status, "unresolved");
  assert.equal(monthTotals(t.app.db).countedMicros - before, 75000);
}, { interactions: [hang], timeoutMs: 50 }));

test("F2 no connection: released at $0 not_sent, retried once, then a clear error", withG(async (t, g) => {
  const out = await runG(t);
  assert.equal(out.kind === "error" && out.code, "unavailable");
  assert.match(out.kind === "error" ? out.message : "", /Couldn't reach Google \(connection refused\)\./);
  assert.equal(g.posts().length, 2);
  const rows = ledgerRows(t.app);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].cost_source, "not_sent");
  assert.equal(rows[1].cost_source, "not_sent");
  assert.equal(unresolvedRows(t.app.db).length, 0);
  assert.equal(monthTotals(t.app.db).countedMicros, 0);
}, { interactions: [netError("ECONNREFUSED")] }));

test("F2 then success: one released $0 row, then the real call settles", withG(async (t, g) => {
  const out = await runG(t);
  assert.equal(out.kind, "ok");
  assert.equal(g.posts().length, 2);
  const rows = ledgerRows(t.app);
  assert.equal(rows[0].cost_source, "not_sent");
  assert.equal(rows[1].actual_micro_usd, OK_MICROS);
}, { interactions: [netError("ECONNREFUSED"), () => googleGenOk()] }));

test("F4 429 rate_limit_exceeded without retry-after: 2s then 4s, then $0 assumed_zero_429", withG(async (t, g) => {
  const out = await runG(t);
  assert.equal(out.kind === "error" && out.code, "rate_limit");
  assert.match(out.kind === "error" ? out.message : "", /^Rate limited by Google\. Try again\./);
  assert.equal(g.posts().length, 3);
  assert.deepEqual(t.sleeps, [2000, 4000]);
  const [row] = ledgerRows(t.app);
  assert.equal(row.status, "settled");
  assert.equal(row.actual_micro_usd, 0);
  assert.equal(row.cost_source, "assumed_zero_429");
}, { interactions: [() => jsonRes(429, { error: { code: "rate_limit_exceeded", message: "Too many requests." } })] }));

test("F4 429 with retry-after 10: one wait of 10 s, then the retry succeeds", withG(async (t, g) => {
  const out = await runG(t);
  assert.equal(out.kind, "ok");
  assert.equal(g.posts().length, 2);
  assert.deepEqual(t.sleeps, [10000]);
  assert.equal(ledgerRows(t.app)[1].actual_micro_usd, OK_MICROS);
}, { interactions: [() => jsonRes(429, { error: { code: "rate_limit_exceeded" } }, { "retry-after": "10" }), () => googleGenOk()] }));

test("F4 429 with retry-after above 30 s: no retry, one attempt, $0 assumed_zero_429, tile says to wait", withG(async (t, g) => {
  const out = await runG(t);
  assert.equal(out.kind === "error" && out.code, "rate_limit");
  assert.match(out.kind === "error" ? out.message : "", /asked to wait 45 s/);
  assert.equal(g.posts().length, 1);
  assert.deepEqual(t.sleeps, []);
  assert.equal(ledgerRows(t.app)[0].cost_source, "assumed_zero_429");
}, { interactions: [() => jsonRes(429, { error: { code: "too_many_requests" } }, { "retry-after": "45" })] }));

test("F4: a 429 whose body has usage settles from tokens (never $0)", withG(async (t) => {
  const out = await runG(t);
  assert.equal(out.kind === "error" && out.code, "rate_limit");
  assert.equal(t.sleeps.length, 2);
  const [row] = ledgerRows(t.app);
  assert.equal(row.actual_micro_usd, OK_MICROS);
  assert.equal(row.cost_source, "estimated_tokens");
}, { interactions: [() => jsonRes(429, { error: { code: "rate_limit_exceeded" }, usage: googleUsage() })] }));

test("F8 429 quota_exceeded: no retry, $0 assumed_zero_rejected, key check re-runs before the next paid call", withG(async (t, g) => {
  const out = await runG(t);
  assert.equal(out.kind === "error" && out.code, "quota");
  assert.match(out.kind === "error" ? out.message : "", /prepaid credit is used up or billing is disabled/);
  assert.equal(g.posts().length, 1);
  assert.deepEqual(t.sleeps, []);
  assert.equal(ledgerRows(t.app)[0].cost_source, "assumed_zero_rejected");
  await runG(t, "1:1", "a second prompt");
  assert.equal(g.requests.filter((r) => r.path.endsWith("/models/gemini-3.1-flash-image")).length, 2);
}, { interactions: [() => jsonRes(429, { error: { code: "quota_exceeded", message: "You exceeded your current quota." } }), () => googleGenOk()] }));

test("F8 402 payment_required: quota, $0 rejected", withG(async (t) => {
  const out = await runG(t);
  assert.equal(out.kind === "error" && out.code, "quota");
  assert.equal(ledgerRows(t.app)[0].cost_source, "assumed_zero_rejected");
}, { interactions: [() => jsonRes(402, { error: { code: "payment_required", message: "Billing is disabled." } })] }));

test("F6 400 invalid_request: bad_input with the provider text, $0 assumed_zero_rejected", withG(async (t, g) => {
  const out = await runG(t);
  assert.equal(out.kind === "error" && out.code, "bad_input");
  assert.equal(out.kind === "error" ? out.message : "", "Google rejected the request: Request contains an invalid argument.");
  assert.equal(g.posts().length, 1);
  assert.equal(ledgerRows(t.app)[0].cost_source, "assumed_zero_rejected");
}, { interactions: [() => jsonRes(400, { error: { code: "invalid_request", message: "Request contains an invalid argument." } })] }));

test("F6 classic 400 INVALID_ARGUMENT without API_KEY_INVALID: bad_input", withG(async (t) => {
  const out = await runG(t);
  assert.equal(out.kind === "error" && out.code, "bad_input");
}, { interactions: [() => jsonRes(400, { error: { code: 400, message: "Invalid JSON payload received.", status: "INVALID_ARGUMENT", details: [] } })] }));

test("F6 body in neither shape: mapped by HTTP status, the body text shown", withG(async (t) => {
  const out = await runG(t);
  assert.equal(out.kind === "error" && out.code, "bad_input");
  assert.match(out.kind === "error" ? out.message : "", /^Google rejected the request: /);
}, { interactions: [text(400, "upstream hiccup")] }));

test("F7 mid-call 401 authentication: auth + 'Key rejected'; the next generate re-checks the key first", withG(async (t, g) => {
  const out = await runG(t);
  assert.equal(out.kind === "error" && out.code, "auth");
  assert.match(out.kind === "error" ? out.message : "", /^Key rejected \(HTTP 401\)\. Check the Google key in Settings\./);
  assert.equal(ledgerRows(t.app)[0].cost_source, "assumed_zero_rejected");
  await runG(t, "1:1", "again");
  assert.equal(g.requests.filter((r) => r.path.endsWith("/models/gemini-3.1-flash-image")).length, 2);
  assert.equal(g.posts().length, 2);
}, { interactions: [() => jsonRes(401, { error: { code: "authentication", message: "The API key is not valid." } })] }));

test("F5 503 without usage: unresolved, 'Google error 503. Retry.'", withG(async (t) => {
  const out = await runG(t);
  assert.equal(out.kind === "error" && out.code, "unavailable");
  assert.equal(out.kind === "error" ? out.message : "", "Google error 503. Retry.");
  assert.equal(ledgerRows(t.app)[0].status, "unresolved");
}, { interactions: [text(503, "oops")] }));

test("F5 503 that carries usage: settles from the token counts", withG(async (t) => {
  const out = await runG(t);
  assert.equal(out.kind === "error" && out.code, "unavailable");
  const [row] = ledgerRows(t.app);
  assert.equal(row.status, "settled");
  assert.equal(row.actual_micro_usd, OK_MICROS);
  assert.equal(row.cost_source, "estimated_tokens");
}, { interactions: [() => jsonRes(503, { usage: googleUsage() })] }));

test("F9 refusal: 200 text-only reply -> refused with the text, priced from tokens (never $0)", withG(async (t) => {
  const out = await runG(t);
  assert.equal(out.kind, "refused");
  assert.equal(out.kind === "refused" ? out.message : "", "Google returned no image: I can't help with that.");
  const [row] = ledgerRows(t.app);
  assert.equal(row.status, "settled");
  assert.equal(row.actual_micro_usd, toMicros((12 * 0.5 + 7 * 3) / 1e6));
  assert.equal(row.cost_source, "estimated_tokens");
}, { interactions: [() => jsonRes(200, { id: "int-1", status: "completed", steps: [{ type: "thought", summary: [] }, { type: "model_output", content: [{ type: "text", text: "I can't help with that." }] }], usage: { total_input_tokens: 12, total_output_tokens: 7, total_thought_tokens: 0 } })] }));

test("F15: 200 with an image block that has no data -> 'couldn't read', settles from image-rate usage", withG(async (t) => {
  const out = await runG(t);
  assert.equal(out.kind === "error" && out.code, "unavailable");
  assert.equal(out.kind === "error" ? out.message : "", "Google sent a response the app couldn't read (HTTP 200).");
  const [row] = ledgerRows(t.app);
  assert.equal(row.actual_micro_usd, OK_MICROS);
  assert.equal(row.cost_source, "estimated_tokens");
}, { interactions: [() => jsonRes(200, { id: "int-1", status: "completed", steps: [{ type: "model_output", content: [{ type: "image", mime_type: "image/jpeg" }] }], usage: googleUsage() })] }));

test("F15: 200 with no usage at all -> unresolved (never priced at the text rate)", withG(async (t) => {
  const out = await runG(t);
  assert.equal(out.kind === "error" && out.code, "unavailable");
  assert.equal(ledgerRows(t.app)[0].status, "unresolved");
}, { interactions: [() => jsonRes(200, { id: "int-1", status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: "hmm, no image" }] }] })] }));

test("item 6 generation blocked: a blocked code -> refused, the code shown verbatim", withG(async (t) => {
  const out = await runG(t);
  assert.equal(out.kind, "refused");
  assert.match(out.kind === "refused" ? out.message : "", /^Refused by Google \(image_safety\)\./);
  assert.equal(ledgerRows(t.app)[0].status, "unresolved");
}, { interactions: [() => jsonRes(200, { id: "int-1", status: "failed", error: { code: "image_safety", message: "blocked for safety" }, steps: [] })] }));

test("status incomplete with an image -> ok with the note", withG(async (t) => {
  const out = await runG(t);
  assert.equal(out.kind, "ok");
  assert.equal(out.kind === "ok" && out.note, "Google marked this result incomplete");
}, { interactions: [() => googleGenOk({ status: "incomplete" })] }));

test("status failed -> unavailable; cancelled -> timeout with the held text", withG(async (t) => {
  const failed = await runG(t, "4:5", "first");
  assert.equal(failed.kind === "error" && failed.code, "unavailable");
  assert.equal(failed.kind === "error" ? failed.message : "", "Google reported the interaction as failed.");
  const cancelled = await runG(t, "4:5", "second");
  assert.equal(cancelled.kind === "error" && cancelled.code, "timeout");
  assert.match(cancelled.kind === "error" ? cancelled.message : "", /^Google cancelled this call\./);
}, { interactions: [() => jsonRes(200, { id: "int-1", status: "failed", steps: [] }), () => jsonRes(200, { id: "int-2", status: "cancelled", steps: [] })] }));

test("stripping (item 26): the raw response never lands in the DB (only the image and token counts)", withG(async (t) => {
  const out = await runG(t);
  assert.equal(out.kind, "ok");
  const dump = JSON.stringify(ledgerRows(t.app)) + JSON.stringify(t.app.db.prepare("SELECT * FROM generations").all()) + JSON.stringify(t.app.db.prepare("SELECT * FROM events").all());
  assert.equal(dump.includes("sig-should-be-stripped"), false);
  assert.equal(dump.includes("Here is your image"), false);
  assert.equal((t.app.db.prepare("SELECT COUNT(*) AS c FROM generations").get() as { c: number }).c, 0); // the adapter alone writes no row; execute.ts does
  const detail = ledgerRows(t.app)[0].cost_detail as string;
  assert.ok(detail.length < 2000);
}));

test("cap: a $0.10 cap blocks the next call before it is sent", withG(async (t, g) => {
  const first = await runG(t);
  assert.equal(first.kind, "ok");
  const second = await runG(t, "1:1", "a second call");
  assert.equal(second.kind === "error" && second.code, "cap");
  assert.match(second.kind === "error" ? second.message : "", /Monthly cap \$0\.10 reached/);
  assert.equal(g.posts().length, 1);
}, { capUsd: 0.1 }));
