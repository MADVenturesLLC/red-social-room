// The A2 mock provider server over real sockets (Amendment 1 item 22): every fault the list names —
// 429 without and with retry-after, 503, a hang past the timeout, a connection refused, a Google 400
// API_KEY_INVALID body, an xAI 422 text body, a Google text-only 200, an xAI 200 with no b64_json —
// injected and asserted with zero real provider calls. The adapters here use the real fetch: base URLs
// point at 127.0.0.1, so headers, bodies, aborts and timeouts travel the network stack.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { startMockProvider, type MockProvider } from "./mock/provider.ts";
import { generate as xaiGenerate } from "../src/server/xai/adapter.ts";
import { generate as googleGenerate } from "../src/server/google/adapter.ts";
import { googleDepsOf } from "../src/server/execute.ts";
import { makeApp, ledgerRows, DUMMY_KEY, DUMMY_GOOGLE_KEY } from "./helpers.ts";
import type { FetchLike } from "../src/server/xai/http.ts";

let mockP: MockProvider;
before(async () => { mockP = await startMockProvider(); });
after(async () => { await mockP.close(); });

const GEN = "44444444-4444-4444-8444-444444444444";
const GEN2 = "44444444-4444-4444-8444-444444444445";
const realFetch: FetchLike = (url, init) => fetch(url, init);

function appAt(o: { timeoutMs?: number } = {}) {
  return makeApp({ fetch: realFetch, xaiBaseUrl: mockP.url, googleBaseUrl: mockP.url, timeoutMs: o.timeoutMs ?? 3000 });
}
const runXai = (t: ReturnType<typeof makeApp>, ratio = "1:1", generationId = GEN) => xaiGenerate(t.app, { prompt: "a mock cat", ratio, generationId });
const runGoogle = (t: ReturnType<typeof makeApp>, ratio = "1:1", generationId = GEN) => googleGenerate(googleDepsOf(t.app), { prompt: "a mock cat", ratio, generationId });

async function closedPort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const p = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return p;
}

test("both providers answer over real sockets; the Google body carries store:false", async () => {
  const t = appAt();
  try {
    const x = await runXai(t);
    assert.equal(x.kind, "ok");
    assert.equal(x.kind === "ok" && x.clientRequestId !== null, true);
    const g = await runGoogle(t);
    assert.equal(g.kind, "ok");
    const rows = ledgerRows(t.app);
    assert.deepEqual(rows.map((r) => [r.provider, r.status, r.actual_micro_usd]), [["xai", "settled", 40000], ["google", "settled", 68500]]);
    const wire = mockP.requests.find((r) => r.provider === "google" && r.path === "/v1beta/interactions")!;
    assert.equal((JSON.parse(wire.body) as Record<string, unknown>).store, false);
  } finally { t.cleanup(); }
});

test("xAI 429 without retry-after over the wire: 3 attempts, 2s then 4s, rows stay unresolved (A1 pin 1)", async () => {
  mockP.xai = "429";
  const t = appAt();
  const n0 = mockP.requests.length;
  try {
    const out = await runXai(t);
    assert.equal(out.kind === "error" && out.code, "rate_limit");
    assert.match(out.kind === "error" ? out.message : "", /^Rate limited by xAI\. Try again\./);
    assert.equal(mockP.requests.slice(n0).filter((r) => r.path === "/v1/images/generations").length, 3);
    assert.deepEqual(t.sleeps, [2000, 4000]);
    const rows = ledgerRows(t.app).filter((r) => r.generation_id === GEN);
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.status === "unresolved"));
  } finally { t.cleanup(); mockP.xai = "ok"; }
});

test("Google 429 with retry-after over the wire: wait then stop; over 30 s is never waited on", async () => {
  mockP.google = "429-retry-after";
  mockP.retryAfterSeconds = 1;
  const t = appAt();
  const n0 = mockP.requests.length;
  try {
    const out = await runGoogle(t);
    assert.equal(out.kind === "error" && out.code, "rate_limit");
    assert.deepEqual(t.sleeps, [1000]);
    assert.equal(mockP.requests.slice(n0).filter((r) => r.path === "/v1beta/interactions").length, 2);
    const first = ledgerRows(t.app).filter((r) => r.generation_id === GEN);
    assert.ok(first.every((r) => r.cost_source === "assumed_zero_429"));
    mockP.retryAfterSeconds = 45;
    const out2 = await runGoogle(t, "1:1", GEN2);
    assert.equal(out2.kind === "error" && out2.code, "rate_limit");
    assert.match(out2.kind === "error" ? out2.message : "", /asked to wait 45 s/);
    assert.equal(ledgerRows(t.app).filter((r) => r.generation_id === GEN2).length, 1);
    assert.deepEqual(t.sleeps, [1000]);
  } finally { t.cleanup(); mockP.google = "ok"; }
});

test("503 over the wire: xAI says retry, the row is held unresolved", async () => {
  mockP.xai = "503";
  const t = appAt();
  try {
    const out = await runXai(t);
    assert.equal(out.kind === "error" && out.code, "unavailable");
    assert.equal(out.kind === "error" ? out.message : "", "xAI error 503 (service unavailable). Retry.");
    assert.equal(ledgerRows(t.app)[0].status, "unresolved");
  } finally { t.cleanup(); mockP.xai = "ok"; }
});

test("a hang past the timeout over the wire: the socket is aborted, the row is held, no retry", async () => {
  mockP.google = "hang";
  const t = appAt({ timeoutMs: 250 });
  const n0 = mockP.requests.length;
  try {
    const out = await runGoogle(t);
    assert.equal(out.kind === "error" && out.code, "timeout");
    assert.match(out.kind === "error" ? out.message : "", /^Google timed out after 0 s\./);
    assert.equal(mockP.requests.slice(n0).filter((r) => r.path === "/v1beta/interactions").length, 1);
    assert.equal(ledgerRows(t.app)[0].status, "unresolved");
  } finally { t.cleanup(); mockP.google = "ok"; }
});

test("a connection refused at a closed port: released at $0 not_sent, retried once, then the message", async () => {
  const port = await closedPort();
  const t = makeApp({ fetch: realFetch, xaiBaseUrl: `http://127.0.0.1:${port}`, googleBaseUrl: mockP.url, timeoutMs: 2000 });
  // Warm the free key check (it would otherwise fail first against the dead port, which is F1, not F2).
  t.app.keyCheck.ok = true;
  t.app.keyCheck.fingerprint = t.app.keys.fingerprint();
  t.app.keyCheck.versionListing = "test";
  try {
    const out = await runXai(t);
    assert.equal(out.kind === "error" && out.code, "unavailable");
    assert.match(out.kind === "error" ? out.message : "", /Couldn't reach xAI \(connection refused\)\./);
    const rows = ledgerRows(t.app);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.cost_source === "not_sent" && r.actual_micro_usd === 0));
  } finally { t.cleanup(); }
});

test("a Google 400 API_KEY_INVALID body over the wire: auth by body shape, $0 assumed_zero_rejected", async () => {
  mockP.google = "400-key-invalid";
  const t = appAt();
  try {
    const out = await runGoogle(t);
    assert.equal(out.kind === "error" && out.code, "auth");
    assert.match(out.kind === "error" ? out.message : "", /^Key rejected \(HTTP 400\)\. Check the Google key in Settings\./);
    assert.equal(ledgerRows(t.app)[0].cost_source, "assumed_zero_rejected");
  } finally { t.cleanup(); mockP.google = "ok"; }
});

test("an xAI 422 text body over the wire: bad_input with the provider text, $0 assumed_zero_rejected (P7 default)", async () => {
  mockP.xai = "422-text";
  const t = appAt();
  try {
    const out = await runXai(t);
    assert.equal(out.kind === "error" && out.code, "bad_input");
    assert.equal(out.kind === "error" ? out.message : "", "xAI rejected the request: Failed to deserialize the JSON body into the target type: aspect_ratio: unknown variant `4:5`");
    assert.equal(ledgerRows(t.app)[0].cost_source, "assumed_zero_rejected");
  } finally { t.cleanup(); mockP.xai = "ok"; }
});

test("a Google text-only 200 over the wire: refused with the provider text, priced from tokens", async () => {
  mockP.google = "text-only";
  const t = appAt();
  try {
    const out = await runGoogle(t);
    assert.equal(out.kind, "refused");
    assert.equal(out.kind === "refused" ? out.message : "", "Google returned no image: I can't draw that.");
    const [row] = ledgerRows(t.app);
    assert.equal(row.status, "settled");
    assert.equal(row.cost_source, "estimated_tokens");
  } finally { t.cleanup(); mockP.google = "ok"; }
});

test("an xAI 200 with no b64_json over the wire: refused, billed from the ticks in the same body", async () => {
  mockP.xai = "ok-no-image";
  const t = appAt();
  try {
    const out = await runXai(t);
    assert.equal(out.kind, "refused");
    assert.match(out.kind === "refused" ? out.message : "", /^Refused by xAI: xAI returned no image/);
    assert.equal(ledgerRows(t.app)[0].actual_micro_usd, 40000);
  } finally { t.cleanup(); mockP.xai = "ok"; }
});
