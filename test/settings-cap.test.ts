// Amendment 1 A1 pin 11, line 362 (Surface commit 3241fff): the monthly cap is editable in Settings and defaults to
// $50 (FOUNDER-DECISIONS.md:5) when unset. Drives the real Settings route handler against a temp app.
import { test } from "node:test";
import assert from "node:assert/strict";
import { POST as capPost } from "../src/app/api/settings/cap/route.ts";
import { capMicros, monthTotals, reserve, CapRefused } from "../src/server/ledger.ts";
import { appStatus } from "../src/server/status.ts";
import { makeApp, fakeXai } from "./helpers.ts";

const g = globalThis as typeof globalThis & { __rsrApp?: unknown };
function withApp(fn: (t: ReturnType<typeof makeApp>) => Promise<void> | void) {
  return async () => {
    const t = makeApp({ fetch: fakeXai().fetch });
    g.__rsrApp = t.app;
    try { await fn(t); } finally { delete g.__rsrApp; t.cleanup(); }
  };
}
const post = (body: unknown, headers: Record<string, string> = { "content-type": "application/json", "x-rsr": "1" }) =>
  capPost(new Request("http://127.0.0.1:3000/api/settings/cap", { method: "POST", headers, body: JSON.stringify(body) }));
const base = { provider: "xai" as const, model: "grok-imagine-image-2.0", kind: "generate" as const, resolution: "1k", quality: "low", generationId: "00000000-0000-4000-8000-000000000000", attempt: 1, estimateSource: "test", now: new Date("2026-10-08T12:00:00-04:00") };

test("A1 pin 11, line 362: with no cap saved, the cap is $50 (FD:5) and Settings shows $50.00", withApp((t) => {
  assert.equal(t.app.db.prepare("SELECT COUNT(*) AS n FROM settings").get()!.n, 0);
  assert.equal(capMicros(t.app.db), 50_000_000);
  assert.equal(monthTotals(t.app.db).capMicros, 50_000_000);
  assert.equal(appStatus(t.app).totalsText.cap, "$50.00");
}));

test("A1 pin 11, line 362: the Settings cap route changes the cap, and the cap check uses the new value", withApp(async (t) => {
  const r = await post({ usd: 0.05 });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { capText: "$0.05", countedText: "$0.00" });
  assert.equal(capMicros(t.app.db), 50_000);
  reserve(t.app.db, { ...base, estimateMicros: 40_000 });
  assert.throws(() => reserve(t.app.db, { ...base, estimateMicros: 40_000 }), CapRefused);
  const back = await post({ usd: 50 });
  assert.equal(back.status, 200);
  assert.equal(capMicros(t.app.db), 50_000_000);
}));

test("A1 pin 11, line 362: a bad cap value or a cross-site request leaves the cap unchanged", withApp(async (t) => {
  for (const usd of [-1, "10", 10_001, null]) assert.equal((await post({ usd })).status, 400, String(usd));
  assert.equal((await post({ usd: 1 }, { "content-type": "application/json" })).status, 403);
  assert.equal(capMicros(t.app.db), 50_000_000);
}));
