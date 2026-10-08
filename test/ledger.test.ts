// Spend guard behavior (Amendment 1 section 3.4, F20, items 17 and 18; A1 acceptance in section 4 line 279).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { openDb } from "../src/server/db.ts";
import { reserve, settle, markUnresolved, monthTotals, CapRefused, setCapUsd } from "../src/server/ledger.ts";
import { estimate, loadPrices } from "../src/server/prices.ts";
import { REPO_ROOT } from "../src/server/config.ts";

const SPIKE = join(REPO_ROOT, "spike-results", "ledger.json");
const base = { provider: "xai" as const, model: "grok-imagine-image-2.0", kind: "generate" as const, resolution: "1k", quality: "low", generationId: "00000000-0000-4000-8000-000000000000", attempt: 1, estimateSource: "test" };
const OCT = new Date("2026-10-15T12:00:00-04:00");

test("item 18: the 10 spike rows import once and the October view counts $0.5547 ($0.4947 settled + $0.06 held for the 422)", () => {
  const db = openDb(":memory:", { spikeLedgerPath: SPIKE });
  const t = monthTotals(db, "2026-10");
  assert.equal(t.countedMicros, 554740);
  assert.equal(t.heldMicros, 60000);
  assert.equal(t.unresolvedCount, 1);
  assert.equal(t.byProvider.xai + t.byProvider.google, 554740);
  const n = db.prepare("SELECT COUNT(*) AS n FROM spend_ledger").get() as { n: number };
  assert.equal(Number(n.n), 10);
  // Opening again (second app start) does not import twice.
  const again = (db.prepare("SELECT value FROM meta WHERE key='spike_ledger_imported'").get() as { value: string }).value;
  assert.match(again, /"rows":10/);
});

test("item 18: the imported 422 row keeps the spike's narrow cost rule (unresolved, counted), and the 4 settled xAI bills keep their tick figures", () => {
  const db = openDb(":memory:", { spikeLedgerPath: SPIKE });
  const r422 = db.prepare("SELECT status, estimate_micro_usd, http_status FROM spend_ledger WHERE id LIKE 'beb67d2b%'").get() as Record<string, unknown>;
  assert.deepEqual({ ...r422 }, { status: "unresolved", estimate_micro_usd: 60000, http_status: 422 });
  const billed = db.prepare("SELECT COUNT(*) AS n FROM spend_ledger WHERE provider='xai' AND cost_source='billed_provider'").get() as { n: number };
  assert.equal(Number(billed.n), 4);
});

test("F20: a $0.10 cap blocks the next call before anything is written; the refusal is an event, not a ledger row", () => {
  const db = openDb(":memory:", { spikeLedgerPath: null });
  setCapUsd(db, 0.10);
  const a = reserve(db, { ...base, estimateMicros: 40000, now: OCT });
  settle(db, a.id, { actualMicros: 40000, costSource: "billed_provider", httpStatus: 200, outcome: "ok" });
  const b = reserve(db, { ...base, estimateMicros: 40000, now: OCT });
  settle(db, b.id, { actualMicros: 40000, costSource: "billed_provider", httpStatus: 200, outcome: "ok" });
  assert.throws(() => reserve(db, { ...base, estimateMicros: 40000, now: OCT }), (e: unknown) => {
    assert.ok(e instanceof CapRefused);
    assert.equal(e.message, "Monthly cap $0.10 reached ($0.08 counted across xAI and Google). Raise the cap in Settings or wait until Nov 1, 12:00 AM ET.");
    return true;
  });
  assert.equal(Number((db.prepare("SELECT COUNT(*) AS n FROM spend_ledger").get() as { n: number }).n), 2);
  assert.equal(Number((db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='cap_refused'").get() as { n: number }).n), 1);
});

test("F20: an unresolved row counts toward the cap at its full reservation, and the message names the held amount", () => {
  const db = openDb(":memory:", { spikeLedgerPath: null });
  setCapUsd(db, 0.10);
  const a = reserve(db, { ...base, estimateMicros: 70000, now: OCT });
  markUnresolved(db, a.id, { reason: "timeout", httpStatus: null, outcome: "timeout" });
  assert.throws(() => reserve(db, { ...base, estimateMicros: 40000, now: OCT }), /\$0\.07 counted across xAI and Google, including \$0\.07 held for unchecked calls/);
});

test("F20: a call that lands exactly on the cap is allowed; one micro-dollar over is refused", () => {
  const db = openDb(":memory:", { spikeLedgerPath: null });
  setCapUsd(db, 0.08);
  reserve(db, { ...base, estimateMicros: 40000, now: OCT });
  reserve(db, { ...base, estimateMicros: 40000, now: OCT });
  assert.throws(() => reserve(db, { ...base, estimateMicros: 1, now: OCT }), CapRefused);
});

test("F20: the cap is shared across providers (Google spend blocks an xAI call)", () => {
  const db = openDb(":memory:", { spikeLedgerPath: null });
  setCapUsd(db, 0.10);
  db.prepare(`INSERT INTO spend_ledger (id, created_at, month_ny, provider, model, kind, estimate_micro_usd, estimate_source, status, actual_micro_usd, cost_source) VALUES ('g1', '2026-10-15T12:00:00-04:00', '2026-10', 'google', 'gemini-3.1-flash-image', 'generate', 75000, 't', 'settled', 70000, 'estimated_tokens')`).run();
  assert.throws(() => reserve(db, { ...base, estimateMicros: 40000, now: OCT }), CapRefused);
});

test("item 17: the cap month is the America/New_York calendar month of the reservation", () => {
  const db = openDb(":memory:", { spikeLedgerPath: null });
  const cases: Array<[string, string]> = [["2026-11-01T03:59:59Z", "2026-10"], ["2026-11-01T04:00:00Z", "2026-11"], ["2027-01-01T04:59:59Z", "2026-12"], ["2027-01-01T05:00:00Z", "2027-01"]];
  for (const [iso, month] of cases) {
    const r = reserve(db, { ...base, estimateMicros: 40000, now: new Date(iso) });
    assert.equal((db.prepare("SELECT month_ny FROM spend_ledger WHERE id = ?").get(r.id) as { month_ny: string }).month_ny, month, iso);
  }
  // A full October does not block November.
  setCapUsd(db, 0.05);
  assert.throws(() => reserve(db, { ...base, estimateMicros: 40000, now: new Date("2026-10-20T12:00:00Z") }), /wait until Nov 1, 12:00 AM ET/);
  assert.throws(() => reserve(db, { ...base, estimateMicros: 40000, now: new Date("2026-12-20T12:00:00Z") }), /wait until Jan 1, 2027, 12:00 AM ET/);
});

test("section 3.4: the ledger is append-only — no deletes, settled rows are final, fixed columns never change", () => {
  const db = openDb(":memory:", { spikeLedgerPath: null });
  const r = reserve(db, { ...base, estimateMicros: 40000, now: OCT });
  assert.throws(() => db.prepare("DELETE FROM spend_ledger WHERE id = ?").run(r.id), /append-only/);
  assert.throws(() => db.prepare("UPDATE spend_ledger SET estimate_micro_usd = 1 WHERE id = ?").run(r.id), /only status/);
  settle(db, r.id, { actualMicros: 40000, costSource: "billed_provider", httpStatus: 200, outcome: "ok" });
  assert.throws(() => db.prepare("UPDATE spend_ledger SET actual_micro_usd = 0 WHERE id = ?").run(r.id), /settled row is final/);
  assert.throws(() => settle(db, r.id, { actualMicros: 0, costSource: "not_sent", httpStatus: null, outcome: "x" }));
});

test("item 2d: the reservation is the larger of prices.json and the highest bill for the same price key", () => {
  const db = openDb(":memory:", { spikeLedgerPath: null });
  const prices = loadPrices();
  const key = { provider: "xai", model: "grok-imagine-image-2.0", kind: "generate", resolution: "1k", quality: "low" };
  assert.equal(estimate(db, prices, key).micros, 40000);
  const r = reserve(db, { ...base, estimateMicros: 40000, now: OCT });
  settle(db, r.id, { actualMicros: 90000, costSource: "billed_provider", httpStatus: 200, outcome: "ok" });
  assert.equal(estimate(db, prices, key).micros, 90000);
  assert.throws(() => estimate(db, prices, { ...key, resolution: "2k" }), /No price row/);
});
