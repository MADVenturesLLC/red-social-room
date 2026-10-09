// Grok adapter behavior against a scripted fake xAI (Amendment 1 sections 3.2/3.3 xAI column; section 4
// line 272 A1 defaults; Surface room note 2026-10-07). No network, dummy key only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generate, QUOTA_429_RE } from "../src/server/xai/adapter.ts";
import { markInterrupted, monthTotals, unresolvedRows, unresolvedHeldText } from "../src/server/ledger.ts";
import type { DB } from "../src/server/db.ts";
import { appStatus } from "../src/server/status.ts";
import { loadPrices } from "../src/server/prices.ts";
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

// ---- Amendment 1 "A1 interim pins" (Surface commit 3241fff) ----

const QUOTA_429 = () => jsonRes(429, { code: "quota_exceeded", error: "Your team has reached its monthly spending limit." });
const PIN1_CASES: Array<[string, Handler]> = [
  ["401", () => jsonRes(401, { error: "invalid authorization token" })],
  ["402", () => jsonRes(402, { error: "no credits" })],
  ["403", () => jsonRes(403, { error: "forbidden" })],
  ["429 (retry-after 45, no retry)", () => jsonRes(429, { error: "slow down" }, { "retry-after": "45" })],
  ["429 quota/billing", QUOTA_429],
];
for (const [name, h] of PIN1_CASES) for (const p7 of ["spike_narrow_422", "item16_assumed_zero"] as const) {
  test(`A1 pin 1, line 352 (P7 ${p7}): xAI ${name} -> one POST, one row 'unresolved', counted at its $0.04 estimate`, withApp(async (t, x) => {
    const out = await run(t);
    assert.equal(out.kind, "error");
    assert.equal(x.posts().length, 1);
    const rows = ledgerRows(t.app);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "unresolved");
    assert.equal(rows[0].actual_micro_usd, null);
    assert.equal(rows[0].estimate_micro_usd, 40000);
    assert.equal(monthTotals(t.app.db).countedMicros, 40000);
  }, { gen: [h], switches: { xaiRejectionCost: p7 } }));
}

for (const [p7, status, actual] of [["spike_narrow_422", "unresolved", null], ["item16_assumed_zero", "settled", 0]] as const) {
  test(`A1 pin 1, line 352: an xAI 400 whose free key re-check fails is 'Key rejected' and follows P7 like any 400 (${p7} -> ${status})`, async () => {
    let checks = 0;
    const x = fakeXai({ gen: [() => jsonRes(400, { error: "Incorrect API key" })], keyCheck: () => (++checks === 1 ? KEY_OK() : jsonRes(401, { error: "bad key" })) });
    const t = makeApp({ fetch: x.fetch, switches: { xaiRejectionCost: p7 } });
    try {
      const out = await run(t);
      assert.equal(out.kind === "error" && out.code, "auth");
      assert.equal(checks, 2, "the 400 forced a key re-check");
      const [row] = ledgerRows(t.app);
      assert.equal(row.status, status);
      assert.equal(row.actual_micro_usd, actual);
      if (status === "settled") assert.equal(row.cost_source, "assumed_zero_rejected");
      assert.equal(monthTotals(t.app.db).countedMicros, status === "settled" ? 0 : 40000);
    } finally { t.cleanup(); }
  });
}

test("A1 pin 2, line 353: no quality field is sent and the row is priced at 'low' 1K ($0.04 from prices.json)", withApp(async (t, x) => {
  await run(t);
  assert.equal("quality" in x.posts()[0].body!, false);
  assert.equal(x.posts()[0].body!.resolution, "1k");
  const [row] = ledgerRows(t.app);
  assert.equal(row.resolution, "1k"); assert.equal(row.quality, "low"); assert.equal(row.estimate_micro_usd, 40000);
  assert.match(String(row.estimate_source), /generate\/1k\/low \$0\.04/);
}));

test("A1 pin 2, line 353 + item 2(d)/(e) + F22 (line 205): if xAI bills medium ($0.06) against the $0.04 low reservation, the ledger keeps the bill, Settings shows the drift notice, prices.json is unchanged, and the next reservation rises to $0.06", withApp(async (t, x) => {
  const out = await run(t);
  assert.equal(out.kind, "ok");
  const [row] = ledgerRows(t.app);
  assert.equal(row.estimate_micro_usd, 40000);
  assert.equal(row.status, "settled"); assert.equal(row.actual_micro_usd, 60000); assert.equal(row.cost_source, "billed_provider");
  const drift = appStatus(t.app).priceDrift;
  assert.equal(drift.length, 1);
  assert.match(drift[0].text, /^Price drift: xAI grok-imagine-image-2\.0 generate 1k\/low billed \$0\.0600 against a \$0\.0400 reservation/);
  assert.equal(loadPrices().find((p) => p.provider === "xai" && p.kind === "generate")!.usd, 0.04);
  await run(t);
  assert.equal(ledgerRows(t.app)[1].estimate_micro_usd, 60000, "item 2(d): reservation = max(prices.json, highest bill)");
  assert.equal(appStatus(t.app).priceDrift.length, 1, "a $0.06 bill against a $0.06 reservation is not drift");
}, { gen: [() => genOk(600000000), () => genOk(600000000)] }));

test("F22: a bill at the $0.04 reservation, or a held (unbilled) row, shows no drift notice", withApp(async (t) => {
  await run(t); await run(t);
  assert.deepEqual(appStatus(t.app).priceDrift, []);
}, { gen: [() => genOk(400000000), () => jsonRes(503, { error: "busy" })] }));

test("A1 pin 4, line 355: one ledger row and one cap check per attempt - with a $0.08 cap, 429s send 2 attempts and the 3rd is refused by the cap", withApp(async (t, x) => {
  const out = await run(t);
  assert.equal(out.kind === "error" && out.code, "cap");
  assert.equal(x.posts().length, 2);
  assert.deepEqual(ledgerRows(t.app).map((r) => r.attempt), [1, 2]);
  assert.equal(Number((t.app.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='cap_refused'").get() as { n: number }).n), 1);
}, { gen: [() => jsonRes(429, { error: "slow down" })], capUsd: 0.08 }));

const PIN10_CASES: Array<[string, Handler]> = [
  ["401", () => jsonRes(401, { error: "invalid authorization token" })],
  ["402", () => jsonRes(402, { error: "no credits" })],
  ["403", () => jsonRes(403, { error: "forbidden" })],
  ["429 quota/billing", QUOTA_429],
];
for (const [name, h] of PIN10_CASES) {
  test(`A1 pin 10, line 361: after xAI ${name}, the key check re-runs before the next paid call`, withApp(async (t, x) => {
    await run(t);
    const before = x.requests.length;
    const out = await run(t);
    assert.equal(out.kind, "ok");
    assert.deepEqual(x.requests.slice(before).map((r) => `${r.method} ${r.path}`), ["GET /v1/api-key", "GET /v1/image-generation-models", "POST /v1/images/generations"]);
  }, { gen: [h, () => genOk()] }));

  test(`A1 pin 10, line 361: after xAI ${name}, a failing re-check blocks the next paid call`, async () => {
    let checks = 0;
    const keyCheck: Handler = () => (++checks === 1 ? KEY_OK() : jsonRes(200, { redacted_api_key: "xai-...QRST", api_key_blocked: true, api_key_disabled: false, team_blocked: false }));
    await withApp(async (t, x) => {
      await run(t);
      const out = await run(t);
      assert.equal(out.kind === "error" && out.code, "auth");
      assert.equal(checks, 2);
      assert.equal(x.posts().length, 1);
      assert.equal(ledgerRows(t.app).length, 1);
    }, { gen: [h, () => genOk()], keyCheck })();
  });
}

test("A1 pin 10, line 361: a plain rate-limit 429 is not an auth/quota error - the cached key check is reused", withApp(async (t, x) => {
  await run(t);
  await run(t);
  assert.equal(x.requests.filter((r) => r.path === "/v1/api-key").length, 1);
}, { gen: [() => jsonRes(429, { error: "slow down" }, { "retry-after": "45" }), () => genOk()] }));

test("A1 pin 10, line 361: a quota/billing 429 is not retried and says so", withApp(async (t, x) => {
  const out = await run(t);
  assert.equal(out.kind === "error" && out.code, "quota");
  assert.equal(out.kind === "error" && out.message, "xAI quota or billing limit reached (HTTP 429) — check console.x.ai.");
  assert.equal(x.posts().length, 1);
  assert.deepEqual(t.sleeps, []);
}, { gen: [QUOTA_429] }));

// ---- Surface ruling, room 2026-10-07 11:38 PM ET (A1 pin 15, line 366): quota-429 words + 429 body notes ----

for (const body of ["QUOTA exceeded for this team", "Spending Limit reached", "BILLING is on hold", "Insufficient Balance", "out of Credits"]) {
  test(`A1 pin 15, line 366: the quota-429 word list matches case-insensitively ('${body}') -> quota, no retry`, withApp(async (t, x) => {
    const out = await run(t);
    assert.equal(out.kind === "error" && out.code, "quota");
    assert.equal(x.posts().length, 1);
    assert.deepEqual(t.sleeps, []);
  }, { gen: [text(429, body)] }));
}

// A1 pin 15, line 366 (Amendment 1 at 5c773d7): "quota, billing, credit or credits, spending limit, insufficient funds, balance or
// payment, each word or phrase matched on its own (so "balance" alone matches)". Each body below holds exactly one
// listed term; with that term taken out the body matches nothing, so each term is proven to match alone.
for (const [term, body] of [
  ["quota", "quota reached"], ["billing", "billing problem"], ["credit", "No credit left on this team"], ["credits", "out of credits"],
  ["spending limit", "Spending limit reached"], ["insufficient funds", "insufficient funds"], ["balance", "Your balance is too low"], ["payment", "payment required"],
] as const) {
  test(`A1 pin 15, line 366: '${term}' on its own marks a 429 as quota ('${body}') -> F8, no retry, key re-checked`, withApp(async (t, x) => {
    assert.equal(QUOTA_429_RE.test(body.replace(new RegExp(term, "i"), "")), false, "no other listed term in the body");
    const out = await run(t);
    assert.equal(out.kind === "error" && out.code, "quota");
    assert.equal(x.posts().length, 1);
    assert.deepEqual(t.sleeps, []);
    await run(t);
    assert.equal(x.requests.filter((r) => r.path === "/v1/api-key").length, 2, "the key check re-ran before the next paid call");
  }, { gen: [text(429, body), () => genOk()] }));
}

// A1 pin 18 (c), line 369 (Amendment 1 at 5c773d7): words match anywhere, even inside longer words; "credit"/"credits"
// must not be followed by a letter (an underscore, digit, space, punctuation or the end of the body may follow);
// "spending limit" and "insufficient funds" take a space, underscore, hyphen or nothing between the words.
// A1 pin 19 (c), line 370 (Amendment 1 at 9a890fb): exactly one space, underscore or hyphen, or none; two spaces, a tab
// and camelCase such as creditLimit do not match.
test("A1 pin 18 (c), line 369 / A1 pin 19 (c), line 370: quota-word boundaries - inside longer words, credit/credits not followed by a letter, separators", () => {
  const yes = ["rebalance needed", "QUOTAS", "prepayment", "rebilling", "credit", "credits", "Credit.", "no credits!", "discredit", "credit limit",
    "credit_limit", "credit_limit_exceeded", "credits_exhausted", "CREDIT_LIMIT", "credit2", "credit-limit", "out_of_credits", "{\"code\":\"credit\"}",
    "spending limit", "spending_limit", "spending-limit", "spendinglimit", "SPENDING-LIMIT", "insufficient funds", "insufficient_funds", "insufficient-funds", "insufficientfunds"];
  const no = ["creditor", "CREDITORS", "credited", "creditworthy", "creditLimit", "CreditLimit", "spending  limit", "insufficient  funds", "spending\tlimit", "insufficient\tfunds", "spending__limit", "insufficient--funds", "spending/limit", "funds insufficient"];
  for (const b of yes) assert.equal(QUOTA_429_RE.test(b), true, `should match: ${b}`);
  for (const b of no) assert.equal(QUOTA_429_RE.test(b), false, `should not match: ${b}`);
});

test("A1 pin 18 (c), line 369: a 429 whose body is the code 'credit_limit_exceeded' is a quota 429 (F8: no retry)", withApp(async (t, x) => {
  const out = await run(t);
  assert.equal(out.kind === "error" && out.code, "quota");
  assert.equal(x.posts().length, 1);
  assert.deepEqual(t.sleeps, []);
}, { gen: [text(429, "{\"error\":{\"code\":\"credit_limit_exceeded\"}}", "application/json")] }));

test("A1 pin 15, line 366: a 429 with none of the listed words is a rate limit (F4), not quota", () => {
  for (const b of ["slow down", "Too many requests", "rate limit exceeded, retry later", "creditor"]) assert.equal(QUOTA_429_RE.test(b), false, b);
});

test("A1 pin 15, line 366: a 429 body longer than 500 characters stores exactly the first 500 (code points, emoji at the cut kept whole)", withApp(async (t) => {
  const body = "r".repeat(499) + "\u{1F600}" + "s".repeat(300);
  await run(t);
  const [row] = ledgerRows(t.app);
  assert.equal(row.status, "unresolved");
  const note = String(row.note);
  assert.equal(note, Array.from(body).slice(0, 500).join(""));
  assert.equal(Array.from(note).length, 500);
  assert.ok(note.endsWith("\u{1F600}"));
  assert.equal(note.includes("\uFFFD"), false);
  assert.equal(/[\uD800-\uDBFF]$/.test(note), false, "no lone high surrogate at the cut");
}, { gen: [text(429, "r".repeat(499) + "\u{1F600}" + "s".repeat(300), "text/plain; charset=utf-8")] }));

test("A1 pin 15, line 366: a 429 body echoing the key or a bearer token is redacted before it reaches the ledger", withApp(async (t) => {
  await run(t);
  const [row] = ledgerRows(t.app);
  const note = String(row.note);
  assert.match(note, /^key \[REDACTED\] hit its limit; Authorization: Bearer \[REDACTED\]; other bearer \[REDACTED\] end$/);
  const all = JSON.stringify(t.app.db.prepare("SELECT * FROM spend_ledger").all()) + JSON.stringify(t.app.db.prepare("SELECT * FROM events").all());
  for (const n of [...secretNeedles(DUMMY_KEY), "abc.DEF-123_xyz"]) assert.equal(all.includes(n), false);
}, { gen: [text(429, `key ${DUMMY_KEY} hit its limit; Authorization: Bearer ${DUMMY_KEY}; other bearer abc.DEF-123_xyz end`, "text/plain")] }));

test("A1 pin 15, line 366: a non-quota 429 still follows F4 (2 s, 4 s, 3 attempts) and every row keeps its note, all unresolved", withApp(async (t, x) => {
  const out = await run(t);
  assert.equal(out.kind === "error" && out.code, "rate_limit");
  assert.equal(x.posts().length, 3);
  assert.deepEqual(t.sleeps, [2000, 4000]);
  const rows = ledgerRows(t.app);
  assert.deepEqual(rows.map((r) => r.status), ["unresolved", "unresolved", "unresolved"]);
  assert.deepEqual(rows.map((r) => r.note), Array(3).fill('{"error":"slow down, too many requests"}'));
}, { gen: [() => jsonRes(429, { error: "slow down, too many requests" })] }));

test("A1 pin 15, line 366: a quota 429 follows F8 - no retry, note kept, unresolved, and the key check re-runs before the next paid call", withApp(async (t, x) => {
  const out = await run(t);
  assert.equal(out.kind === "error" && out.code, "quota");
  assert.equal(x.posts().length, 1);
  assert.deepEqual(t.sleeps, []);
  const [row] = ledgerRows(t.app);
  assert.equal(row.status, "unresolved");
  assert.equal(row.note, '{"code":"quota_exceeded","error":"Your team has reached its monthly spending limit."}');
  const before = x.requests.length;
  await run(t);
  assert.deepEqual(x.requests.slice(before).map((r) => `${r.method} ${r.path}`), ["GET /v1/api-key", "GET /v1/image-generation-models", "POST /v1/images/generations"]);
}, { gen: [QUOTA_429, () => genOk()] }));

for (const off of [480, 490, 495, 499, 500, 520, 560]) {
  test(`A1 pin 15, line 366 (Argus L1): a key starting at character ${off} of a 429 body is redacted BEFORE the 500-character cut (plain and Bearer)`, withApp(async (t) => {
    await run(t);
    const rows = ledgerRows(t.app);
    assert.equal(rows.length, 3, "a non-quota 429 follows F4: 3 attempts, each with its note");
    const note = rows.map((r) => String(r.note)).join("\n");
    for (const r of rows) assert.equal(Array.from(String(r.note)).length, 500);
    const all = JSON.stringify(t.app.db.prepare("SELECT * FROM spend_ledger").all()) + JSON.stringify(t.app.db.prepare("SELECT * FROM events").all());
    for (const n of secretNeedles(DUMMY_KEY)) { assert.equal(note.includes(n), false, n); assert.equal(all.includes(n), false, n); }
  }, { gen: [text(429, "q".repeat(off) + DUMMY_KEY + " and Bearer " + DUMMY_KEY + " " + "z".repeat(300))] }));
}

for (const [label, ticks] of [["1e30", 1e30], ["-5", -5], ["1.5", 1.5], ["a string", "400000000"], ["null", null]] as const) {
  test(`Argus L2: usage.cost_in_usd_ticks = ${label} on a 200 -> row unresolved with a note (never stuck 'reserved', never $0), estimate keeps counting`, withApp(async (t) => {
    const out = await run(t);
    assert.equal(out.kind, "ok", "the image is still delivered");
    const [row] = ledgerRows(t.app);
    assert.equal(row.status, "unresolved");
    assert.equal(row.actual_micro_usd, null);
    assert.match(String(row.note), /^invalid usage\.cost_in_usd_ticks: /);
    assert.match(String(row.cost_detail), /invalid usage\.cost_in_usd_ticks/);
    assert.equal(monthTotals(t.app.db).countedMicros, 40000);
    assert.equal(Number((t.app.db.prepare("SELECT COUNT(*) AS n FROM spend_ledger WHERE status = 'reserved'").get() as { n: number }).n), 0);
  }, { gen: [async () => { const ok = await genOk(); const j = await ok.json() as { usage: Record<string, unknown> }; j.usage.cost_in_usd_ticks = ticks; return jsonRes(200, j); }] }));
}

test("Argus L2: a valid large bill (1e12 ticks = $100, the ceiling) still settles as billed", withApp(async (t) => {
  await run(t);
  const [row] = ledgerRows(t.app);
  assert.equal(row.status, "settled"); assert.equal(row.actual_micro_usd, 100_000_000);
}, { gen: [() => genOk(1_000_000_000_000)], capUsd: 1000 }));

test("Argus L2 on f63676e: one tick over the ceiling (1e12 + 1) is held unresolved with a note, not settled", withApp(async (t) => {
  const out = await run(t);
  assert.equal(out.kind, "ok");
  const [row] = ledgerRows(t.app);
  assert.equal(row.status, "unresolved"); assert.equal(row.actual_micro_usd, null);
  assert.match(String(row.note), /^invalid usage\.cost_in_usd_ticks: 1000000000001 /);
  assert.equal(monthTotals(t.app.db).countedMicros, 40000);
}, { gen: [() => genOk(1_000_000_000_001)], capUsd: 1000 }));

test("Argus L2 on f63676e: if settle itself throws (the ledger refuses the update), the row ends unresolved and keeps counting; no 500", withApp(async (t) => {
  t.app.db.exec("CREATE TEMP TRIGGER test_refuse_settle BEFORE UPDATE OF status ON spend_ledger WHEN NEW.status = 'settled' BEGIN SELECT RAISE(ABORT, 'test: settle refused'); END");
  const out = await run(t);
  assert.equal(out.kind, "ok", "the image is still delivered");
  assert.deepEqual(out.kind === "ok" && out.cost, { micros: null, source: "unresolved", heldMicros: 40000 });
  const [row] = ledgerRows(t.app);
  assert.equal(row.status, "unresolved");
  assert.match(String(row.cost_detail), /settling failed \(Error: test: settle refused\)/);
  assert.equal(monthTotals(t.app.db).countedMicros, 40000);
}));

// Argus L1 on f63676e: a call whose row left `reserved` while it was out (here: swept as interrupted mid-call).
let sweepDb: DB | null = null;
const sweepThen = (h: Handler): Handler => async (req, init) => { assert.equal(markInterrupted(sweepDb!), 1); return h(req, init); };
const lateEvents = (t: ReturnType<typeof makeApp>) => (t.app.db.prepare("SELECT detail FROM events WHERE kind = 'late_result'").all() as Array<{ detail: string }>).map((e) => JSON.parse(e.detail));

test("Argus L1 on f63676e / A1 pin 18, line 369: a bill that arrives after the row was swept is kept as a late_result event (request id, $0.04); the image is delivered, no 500, the row still counts its estimate", withApp(async (t) => {
  sweepDb = t.app.db;
  const out = await run(t);
  assert.equal(out.kind, "ok");
  assert.deepEqual(out.kind === "ok" && out.cost, { micros: null, source: "unresolved", heldMicros: 40000 });
  const [row] = ledgerRows(t.app);
  assert.equal(row.status, "unresolved"); assert.equal(row.outcome, "interrupted");
  const [ev] = lateEvents(t);
  assert.equal(ev.ledger_id, row.id); assert.equal(ev.row_status, "unresolved"); assert.equal(ev.row_outcome, "interrupted");
  assert.equal(ev.provider_request_id, "req-test-1"); assert.equal(ev.http_status, 200); assert.equal(ev.outcome, "ok");
  assert.equal(ev.actual_micro_usd, 40000); assert.equal(ev.cost_source, "billed_provider");
  assert.equal(monthTotals(t.app.db).countedMicros, 40000);
  assert.ok(t.logs.some((l) => /late result: row was already unresolved/.test(l)));
}, { gen: [sweepThen(() => genOk())] }));

for (const [ticks, bill, counted] of [[900_000_000, 90000, 90000], [200_000_000, 20000, 40000]] as const) {
  test(`A1 pin 18, line 369: a late bill of $${(bill / 1e6).toFixed(2)} on the $0.04 estimate counts $${(counted / 1e6).toFixed(2)}; the row stays unresolved and the Unresolved list shows the late bill`, withApp(async (t) => {
    sweepDb = t.app.db;
    const out = await run(t);
    assert.equal(out.kind, "ok");
    assert.deepEqual(out.kind === "ok" && out.cost, { micros: null, source: "unresolved", heldMicros: counted });
    const [row] = ledgerRows(t.app);
    assert.equal(row.status, "unresolved"); assert.equal(row.actual_micro_usd, null);
    assert.equal(lateEvents(t)[0].actual_micro_usd, bill);
    assert.equal(monthTotals(t.app.db).countedMicros, counted);
    const [u] = unresolvedRows(t.app.db);
    assert.equal(unresolvedHeldText(u), `$${(counted / 1e6).toFixed(2)} held (late bill $${(bill / 1e6).toFixed(2)})`);
  }, { gen: [sweepThen(() => genOk(ticks))] }));
}

test("Argus L2 on 9b837ac: no connection after the row was swept - the $0 'not sent' result is a late_result event, no throw; the retry goes out and the swept row keeps counting its estimate", withApp(async (t, x) => {
  sweepDb = t.app.db;
  const out = await run(t);
  assert.equal(out.kind === "error" && out.code, "unavailable");
  const evs = lateEvents(t);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].outcome, "no_connection"); assert.equal(evs[0].actual_micro_usd, 0); assert.equal(evs[0].cost_source, "not_sent");
  assert.equal(x.posts().length, 2, "F2: one retry after no connection");
  const rows = ledgerRows(t.app);
  assert.deepEqual(rows.map((r) => r.status), ["unresolved", "settled"]);
  assert.equal(monthTotals(t.app.db).countedMicros, 40000, "swept row at max($0.04, $0); the retry released at $0");
}, { gen: [sweepThen(netError("ECONNREFUSED")), netError("ECONNREFUSED")] }));

const keyBody = (prefix: string) => `${prefix} key=${DUMMY_KEY} Authorization: Bearer ${DUMMY_KEY} end`;
const noKeyAnywhere = (t: ReturnType<typeof makeApp>) => {
  const all = JSON.stringify(t.app.db.prepare("SELECT * FROM events").all()) + JSON.stringify(t.app.db.prepare("SELECT * FROM spend_ledger").all());
  for (const n of secretNeedles(DUMMY_KEY)) assert.equal(all.includes(n), false, n);
};

test("Argus L2 on 9b837ac: a 429 after the row was swept - the late_result note keeps the body with the key and Bearer token redacted; no key fragment in events or the ledger", withApp(async (t) => {
  sweepDb = t.app.db;
  await run(t);
  const [ev] = lateEvents(t);
  assert.equal(ev.http_status, 429);
  assert.match(String(ev.note), /^quota exceeded key=\[REDACTED\] Authorization: Bearer \[REDACTED\] end$/);
  noKeyAnywhere(t);
}, { gen: [sweepThen(text(429, keyBody("quota exceeded")))] }));

test("Argus L2 on 9b837ac: a billed 200 after the row was swept whose body echoes the key - the late_result event holds no key fragment (settle path)", withApp(async (t) => {
  sweepDb = t.app.db;
  const out = await run(t);
  assert.equal(out.kind, "ok");
  const [ev] = lateEvents(t);
  assert.equal(ev.actual_micro_usd, 40000);
  noKeyAnywhere(t);
}, { gen: [sweepThen(async () => { const ok = await genOk(); const j = await ok.json() as Record<string, unknown>; j.echo = keyBody("echo"); return jsonRes(200, j); })] }));

test("Argus L1 on f63676e / A1 pin 18, line 369: an unknown-cost result (500) after the row was swept is kept as a late_result event; the user gets the normal error, the row still counts its estimate", withApp(async (t) => {
  sweepDb = t.app.db;
  const out = await run(t);
  assert.equal(out.kind, "error");
  const [ev] = lateEvents(t);
  assert.equal(ev.http_status, 500); assert.equal(ev.actual_micro_usd, null); assert.equal(ev.cost_source, null);
  assert.equal(ledgerRows(t.app).length, 1, "no retry row was added past the swept one");
  assert.equal(monthTotals(t.app.db).countedMicros, 40000);
}, { gen: [sweepThen(text(500, "{\"error\":\"internal\"}", "application/json"))] }));

const OTHER_KEY = "dummy_TESTONLY3_oNAtfjvv5ih0HYWRRuWU8LBitF9rMInFMku3I8KH641Xs4qM";
test("A1 pin 10, line 361 (Argus L6): a key change re-runs the key check even without a forced check (fingerprint guard on the cache)", withApp(async (t, x) => {
  assert.equal((await run(t)).kind, "ok");
  t.app.keys.save(OTHER_KEY); // no checkKey(force) here, unlike the Settings route
  assert.equal((await run(t)).kind, "ok");
  assert.equal(x.requests.filter((r) => r.path === "/v1/api-key").length, 2);
  assert.deepEqual(x.posts().map((p) => p.headers.authorization), [`Bearer ${DUMMY_KEY}`, `Bearer ${OTHER_KEY}`]);
  const checks = x.requests.filter((r) => r.path === "/v1/api-key").map((r) => r.headers.authorization);
  assert.deepEqual(checks, [`Bearer ${DUMMY_KEY}`, `Bearer ${OTHER_KEY}`]);
}, { gen: [() => genOk()] }));

test("A1 pin 16, line 367: after a 402 the re-check passes and the next paid call goes out; each 402 is held at its estimate (no extra block)", withApp(async (t, x) => {
  const a = await run(t);
  const b = await run(t);
  assert.equal(a.kind === "error" && a.code, "quota");
  assert.equal(b.kind === "error" && b.code, "quota");
  assert.equal(x.posts().length, 2);
  assert.equal(x.requests.filter((r) => r.path === "/v1/api-key").length, 2);
  assert.deepEqual(ledgerRows(t.app).map((r) => r.status), ["unresolved", "unresolved"]);
  assert.equal(monthTotals(t.app.db).countedMicros, 80000);
}, { gen: [() => jsonRes(402, { error: "no credits" })] }));

test("only 429 rows get a body note (a 503 row's note stays empty)", withApp(async (t) => {
  await run(t);
  assert.equal(ledgerRows(t.app)[0].note, null);
}, { gen: [() => jsonRes(503, { error: "busy" })] }));

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
