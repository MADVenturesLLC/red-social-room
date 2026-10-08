// Grok adapter behavior against a scripted fake xAI (Amendment 1 sections 3.2/3.3 xAI column; section 4
// line 272 A1 defaults; Surface room note 2026-10-07). No network, dummy key only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generate } from "../src/server/xai/adapter.ts";
import { monthTotals } from "../src/server/ledger.ts";
import { makeApp, fakeXai, genOk, jsonRes, hang, netError, ledgerRows, DUMMY_KEY, secretNeedles, KEY_OK } from "./helpers.ts";
import type { Handler } from "./helpers.ts";

const GEN = "11111111-1111-4111-8111-111111111111";
const run = (t: ReturnType<typeof makeApp>, ratio = "1:1", prompt = "an orange tabby cat on a windowsill") => generate(t.app, { prompt, ratio, generationId: GEN });
const text = (status: number, body: string, ct = "text/plain"): Handler => () => new Response(body, { status, headers: { "content-type": ct } });

function withApp(fn: (t: ReturnType<typeof makeApp>, x: ReturnType<typeof fakeXai>) => Promise<void>, o: { gen?: Handler[]; keyCheck?: Handler; models?: Handler; switches?: Record<string, unknown>; capUsd?: number; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}) {
  return async () => {
    const x = fakeXai({ gen: o.gen, keyCheck: o.keyCheck, models: o.models });
    const t = makeApp({ fetch: x.fetch, switches: o.switches as never, capUsd: o.capUsd, env: o.env, timeoutMs: o.timeoutMs });
    try { await fn(t, x); } finally { t.cleanup(); }
  };
}

test("ok: free key check first, then one POST; 4:5 is sent as 3:4 at 1K with no quality field; billed ticks settle the row", withApp(async (t, x) => {
  const out = await run(t, "4:5");
  assert.equal(out.kind, "ok");
  assert.deepEqual(x.requests.map((r) => `${r.method} ${r.path}`), ["GET /v1/api-key", "GET /v1/image-generation-models", "POST /v1/images/generations"]);
  const body = x.posts()[0].body!;
  assert.equal(body.aspect_ratio, "3:4");
  assert.equal(body.resolution, "1k");
  assert.equal(body.n, 1);
  assert.equal("quality" in body, false);
  assert.equal(x.posts()[0].headers.authorization, `Bearer ${DUMMY_KEY}`);
  const [row] = ledgerRows(t.app);
  assert.equal(row.status, "settled"); assert.equal(row.actual_micro_usd, 40000); assert.equal(row.cost_source, "billed_provider");
  assert.equal(row.provider_request_id, "req-test-1");
  assert.equal(out.kind === "ok" && out.clientRequestId, row.id);
}));

test("key check is cached: a second generate sends no second key check", withApp(async (t, x) => {
  await run(t); await run(t);
  assert.equal(x.requests.filter((r) => r.path === "/v1/api-key").length, 1);
  assert.equal(x.posts().length, 2);
}));

test("F1 bad key: the key check gets 401 -> zero POSTs, no ledger row, 'Key rejected'", withApp(async (t, x) => {
  const out = await run(t);
  assert.equal(out.kind, "error");
  assert.equal(out.kind === "error" && out.code, "auth");
  assert.match(out.kind === "error" ? out.message : "", /^Key rejected/);
  assert.equal(x.posts().length, 0);
  assert.equal(ledgerRows(t.app).length, 0);
}, { keyCheck: () => jsonRes(401, { error: "Incorrect API key provided" }) }));

for (const [flag, msg] of [["api_key_disabled", /^Key disabled/], ["api_key_blocked", /^Key rejected \(blocked/], ["team_blocked", /^Team blocked/]] as const) {
  test(`F1: ${flag}=true -> zero POSTs and '${msg.source}'`, withApp(async (t, x) => {
    const out = await run(t);
    assert.match(out.kind === "error" ? out.message : "", msg);
    assert.equal(x.posts().length, 0);
  }, { keyCheck: () => jsonRes(200, { api_key_blocked: flag === "api_key_blocked", api_key_disabled: flag === "api_key_disabled", team_blocked: flag === "team_blocked" }) }));
}

test("F1: the key check cannot reach xAI -> nothing paid is sent (fails closed)", withApp(async (t, x) => {
  const out = await run(t);
  assert.equal(out.kind === "error" && out.code, "unavailable");
  assert.equal(x.posts().length, 0);
  assert.equal(ledgerRows(t.app).length, 0);
}, { keyCheck: netError("ECONNREFUSED") }));

test("F1: model missing from the key's listing -> 'Model not available', zero POSTs", withApp(async (t, x) => {
  const out = await run(t);
  assert.match(out.kind === "error" ? out.message : "", /^Model not available/);
  assert.equal(x.posts().length, 0);
}, { models: () => jsonRes(200, { models: [{ id: "grok-imagine-image" }] }) }));

test("no key set -> no request at all", withApp(async (t, x) => {
  const out = await run(t);
  assert.equal(out.kind === "error" && out.code, "no_key");
  assert.equal(x.requests.length, 0);
}, { env: {} }));

test("F11: an unsupported ratio is refused before any request or ledger row", withApp(async (t, x) => {
  const out = await run(t, "4:7");
  assert.equal(out.kind === "error" && out.message, "Not supported by Grok: aspect ratio 4:7");
  assert.equal(x.requests.length, 0);
  assert.equal(ledgerRows(t.app).length, 0);
}));

test("F3 timeout: tile text, row unresolved, full reservation counted, no retry", withApp(async (t, x) => {
  const before = monthTotals(t.app.db).countedMicros;
  const out = await run(t);
  assert.equal(out.kind === "error" && out.code, "timeout");
  assert.equal(out.kind === "error" && out.message, "Grok timed out after 0 s. It may still have been charged; $0.04 is held against your cap until you check.");
  assert.equal(x.posts().length, 1);
  const [row] = ledgerRows(t.app);
  assert.equal(row.status, "unresolved");
  assert.equal(monthTotals(t.app.db).countedMicros - before, 40000);
}, { gen: [hang], timeoutMs: 50 }));

test("F3: the tile names the real timeout (120 s by default)", async () => {
  const { CLOUD_TIMEOUT_MS } = await import("../src/server/xai/http.ts");
  assert.equal(CLOUD_TIMEOUT_MS, 120_000);
});

test("F9 refusal: 200 with no image but billed ticks -> refused, cost from ticks", withApp(async (t) => {
  const out = await run(t);
  assert.equal(out.kind, "refused");
  assert.match(out.kind === "refused" ? out.message : "", /^Refused by xAI: xAI returned no image/);
  const [row] = ledgerRows(t.app);
  assert.equal(row.status, "settled"); assert.equal(row.actual_micro_usd, 40000);
}, { gen: [() => jsonRes(200, { data: [], usage: { cost_in_usd_ticks: 400000000 } })] }));

test("F9/F15: 200 with no image and no usage -> refused and held unresolved (never priced from the table)", withApp(async (t) => {
  const out = await run(t);
  assert.equal(out.kind, "refused");
  assert.equal(ledgerRows(t.app)[0].status, "unresolved");
}, { gen: [() => jsonRes(200, { data: [{ revised_prompt: "x" }] })] }));

test("item 4c: respect_moderation=false -> refused 'xAI marked this image as filtered'", withApp(async (t) => {
  const out = await run(t);
  assert.equal(out.kind === "refused" && out.message, "Refused by xAI: xAI marked this image as filtered.");
}, { gen: [() => genOk(400000000, { respect_moderation: false })] }));

test("F15: a 200 whose body is not JSON -> 'couldn't read', held unresolved", withApp(async (t) => {
  const out = await run(t);
  assert.equal(out.kind === "error" && out.message, "xAI sent a response the app couldn't read (HTTP 200).");
  assert.equal(ledgerRows(t.app)[0].status, "unresolved");
}, { gen: [text(200, "<html>oops", "text/html")] }));

test("F20: a $0.10 cap blocks the third Grok call before it is sent", withApp(async (t, x) => {
  assert.equal((await run(t)).kind, "ok");
  assert.equal((await run(t)).kind, "ok");
  const out = await run(t);
  assert.equal(out.kind === "error" && out.code, "cap");
  assert.match(out.kind === "error" ? out.message : "", /^Monthly cap \$0\.10 reached \(\$0\.08 counted/);
  assert.equal(x.posts().length, 2);
  assert.equal(ledgerRows(t.app).length, 2);
}, { capUsd: 0.10 }));

// ---- P7 default (Surface room note 2026-10-07 ~10:59 PM ET / 11:01 PM ET, pending amendment) ----
const P7: Array<[string, Handler[], string, number | null, RegExp]> = [
  ["non-JSON 422 starting 'Failed to deserialize the JSON body' -> $0 assumed_zero_rejected", [text(422, "Failed to deserialize the JSON body into the target type: aspect_ratio: unknown variant")], "settled", 0, /^xAI rejected the request: Failed to deserialize/],
  ["JSON 422 -> unresolved, counted", [() => jsonRes(422, { error: "Failed to deserialize the JSON body" })], "unresolved", null, /^xAI rejected the request/],
  ["non-JSON 422 starting differently -> unresolved", [text(422, "Invalid prompt. Failed to deserialize the JSON body")], "unresolved", null, /^xAI rejected the request: Invalid prompt/],
  ["400 that passes the key re-check -> bad_input, unresolved", [() => jsonRes(400, { error: "bad n" })], "unresolved", null, /^xAI rejected the request: bad n/],
  ["404 -> 'Model not available', unresolved", [() => jsonRes(404, { error: "model not found" })], "unresolved", null, /^Model not available: model not found/],
  ["405 -> unresolved", [text(405, "Method Not Allowed")], "unresolved", null, /^xAI rejected the request: Method Not Allowed/],
  ["415 -> unresolved", [text(415, "Unsupported Media Type")], "unresolved", null, /^xAI rejected the request: Unsupported Media Type/],
];
for (const [name, gen, status, actual, msg] of P7) {
  test(`P7 default: ${name}`, withApp(async (t, x) => {
    const before = monthTotals(t.app.db).countedMicros;
    const out = await run(t);
    assert.equal(out.kind, "error");
    assert.match(out.kind === "error" ? out.message : "", msg);
    assert.equal(x.posts().length, 1, "no automatic retry");
    const [row] = ledgerRows(t.app);
    assert.equal(row.status, status);
    assert.equal(row.actual_micro_usd, actual);
    if (status === "settled") assert.equal(row.cost_source, "assumed_zero_rejected");
    assert.equal(monthTotals(t.app.db).countedMicros - before, status === "settled" ? 0 : 40000, "held rows count at the reservation");
  }, { gen }));
}

test("P7 default: 400 where the key re-check fails -> 'Key rejected' (auth), row unresolved", async () => {
  let checks = 0;
  const x = fakeXai({ gen: [() => jsonRes(400, { error: "Incorrect API key" })], keyCheck: (r, i) => (++checks === 1 ? KEY_OK() : jsonRes(401, { error: "bad key" })) });
  const t = makeApp({ fetch: x.fetch });
  try {
    const out = await run(t);
    assert.equal(out.kind === "error" && out.code, "auth");
    assert.equal(ledgerRows(t.app)[0].status, "unresolved");
    assert.equal(checks, 2, "the 400 triggered a forced key re-check");
  } finally { t.cleanup(); }
});

test("P7 switch item16_assumed_zero: a JSON 422 settles at $0 (config flips the rule, not code)", withApp(async (t) => {
  await run(t);
  const [row] = ledgerRows(t.app);
  assert.equal(row.status, "settled"); assert.equal(row.actual_micro_usd, 0); assert.equal(row.cost_source, "assumed_zero_rejected");
}, { gen: [() => jsonRes(422, { error: "x" })], switches: { xaiRejectionCost: "item16_assumed_zero" } }));

test("F7: 401 during the paid call -> 'Key rejected', and the next generate re-runs the key check", withApp(async (t, x) => {
  const out = await run(t);
  assert.equal(out.kind === "error" && out.code, "auth");
  await run(t);
  assert.equal(x.requests.filter((r) => r.path === "/v1/api-key").length, 2);
}, { gen: [() => jsonRes(401, { error: "invalid authorization token" }), () => genOk()] }));

test("F8: 402 -> 'xAI credits exhausted', no retry", withApp(async (t, x) => {
  const out = await run(t);
  assert.equal(out.kind === "error" && out.message, "xAI credits exhausted — top up in console.x.ai.");
  assert.equal(x.posts().length, 1);
}, { gen: [() => jsonRes(402, { error: "no credits" })] }));

test("F4: 429 without retry-after -> retries after ~2 s and ~4 s, then success; one ledger row per attempt", withApp(async (t, x) => {
  const out = await run(t);
  assert.equal(out.kind, "ok");
  assert.equal(x.posts().length, 3);
  assert.deepEqual(t.sleeps, [2000, 4000]); // random() = 0.5 -> no jitter offset
  const rows = ledgerRows(t.app);
  assert.deepEqual(rows.map((r) => r.attempt), [1, 2, 3]);
  assert.deepEqual(rows.map((r) => r.status), ["unresolved", "unresolved", "settled"]);
}, { gen: [() => jsonRes(429, { error: "slow down" }), () => jsonRes(429, { error: "slow down" }), () => genOk()] }));

test("F4: 429 three times without retry-after -> stops at 3 attempts with 'Rate limited by xAI'", withApp(async (t, x) => {
  const out = await run(t);
  assert.equal(out.kind === "error" && out.message, "Rate limited by xAI. Try again.");
  assert.equal(x.posts().length, 3);
}, { gen: [() => jsonRes(429, {})] }));

test("F4: retry-after 45 -> exactly one request and the tile says 45 s", withApp(async (t, x) => {
  const out = await run(t);
  assert.equal(out.kind === "error" && out.message, "Rate limited by xAI. xAI asked to wait 45 s. Try again.");
  assert.equal(x.posts().length, 1);
  assert.deepEqual(t.sleeps, []);
}, { gen: [() => jsonRes(429, {}, { "retry-after": "45" })] }));

test("F4: retry-after 5 -> waits 5 s and retries once only", withApp(async (t, x) => {
  await run(t);
  assert.equal(x.posts().length, 2);
  assert.deepEqual(t.sleeps, [5000]);
}, { gen: [() => jsonRes(429, {}, { "retry-after": "5" })] }));

test("F4: each retry passes the cap check; a retry that would pass the cap is not sent", withApp(async (t, x) => {
  const out = await run(t);
  assert.equal(out.kind === "error" && out.code, "cap");
  assert.equal(x.posts().length, 1);
}, { gen: [() => jsonRes(429, {})], capUsd: 0.05 }));

test("F5: 503 -> one request, 'xAI error 503 (service unavailable)', row unresolved", withApp(async (t, x) => {
  const out = await run(t);
  assert.equal(out.kind === "error" && out.message, "xAI error 503 (service unavailable). Retry.");
  assert.equal(x.posts().length, 1);
  assert.equal(ledgerRows(t.app)[0].status, "unresolved");
}, { gen: [() => jsonRes(503, { error: "busy" })] }));

test("F2: connection refused twice -> 2 attempts, both released at $0 not_sent, 'Couldn't reach xAI (connection refused)'", withApp(async (t, x) => {
  const out = await run(t);
  assert.equal(out.kind === "error" && out.message, "Couldn't reach xAI (connection refused).");
  assert.equal(x.posts().length, 2);
  const rows = ledgerRows(t.app);
  assert.deepEqual(rows.map((r) => [r.status, r.actual_micro_usd, r.cost_source]), [["settled", 0, "not_sent"], ["settled", 0, "not_sent"]]);
}, { gen: [netError("ECONNREFUSED")] }));

test("F2: connection refused once, then ok -> success on the automatic retry", withApp(async (t, x) => {
  assert.equal((await run(t)).kind, "ok");
  assert.equal(x.posts().length, 2);
}, { gen: [netError("ECONNREFUSED"), () => genOk()] }));

test("F3 (line 239): a connection dropped after sending (ECONNRESET) is held, not retried", withApp(async (t, x) => {
  const out = await run(t);
  assert.match(out.kind === "error" ? out.message : "", /dropped after the request was sent .*\$0\.04 is held/);
  assert.equal(x.posts().length, 1);
  assert.equal(ledgerRows(t.app)[0].status, "unresolved");
}, { gen: [netError("ECONNRESET")] }));

test("G5/F7: a provider error body that echoes the key is shown with the key removed, and no log line holds it", withApp(async (t) => {
  const out = await run(t);
  const msg = out.kind === "error" ? out.message : "";
  assert.match(msg, /^xAI rejected the request: key \[REDACTED\] is not allowed/);
  for (const n of secretNeedles(DUMMY_KEY)) {
    assert.equal(msg.includes(n), false);
    assert.equal(t.logs.some((l) => l.includes(n)), false);
  }
}, { gen: [text(422, `key ${DUMMY_KEY} is not allowed`)] }));

test("G5: provider-sent header values that reach a log line (rate-limit, ZDR) are scrubbed of the key", withApp(async (t) => {
  const out = await run(t);
  assert.equal(out.kind, "ok");
  assert.ok(t.logs.some((l) => l.includes("rate-limit remaining=[REDACTED]")));
  assert.ok(t.logs.some((l) => l.includes("x-zero-data-retention=[REDACTED]")));
  for (const n of secretNeedles(DUMMY_KEY)) assert.equal(t.logs.some((l) => l.includes(n)), false);
}, {
  switches: { xaiDataRetention: "zdr" },
  gen: [async () => {
    const r = await genOk();
    const h = new Headers(r.headers);
    h.set("x-ratelimit-remaining-requests", DUMMY_KEY); h.set("x-zero-data-retention", DUMMY_KEY);
    return new Response(await r.arrayBuffer(), { status: 200, headers: h });
  }],
}));

test("G5: no raw response body is logged (the image base64 never reaches a log line)", withApp(async (t) => {
  await run(t);
  assert.ok(t.logs.length > 0);
  assert.equal(t.logs.some((l) => l.length > 500 || /\/9j\//.test(l)), false);
}));
