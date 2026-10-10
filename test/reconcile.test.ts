// A2 reconcile screen rules: marking held rows by hand (F21) and the Google console total check
// (Amendment 1 item 7/8). Direct ledger calls; no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reserve, markUnresolved, settle, reconcileRow, setGoogleConsoleTotal, googleConsoleState, monthTotals, unresolvedRows, generationCostText, RowNotReserved } from "../src/server/ledger.ts";
import { makeApp, fakeProviders } from "./helpers.ts";

const GEN = "33333333-3333-4333-8333-333333333333";
const GOOGLE = { provider: "google" as const, model: "gemini-3.1-flash-image", kind: "generate" as const, resolution: "1k", quality: null };

function heldRow(t: ReturnType<typeof makeApp>, micros = 75000): string {
  const { id } = reserve(t.app.db, { ...GOOGLE, generationId: GEN, attempt: 1, estimateMicros: micros, estimateSource: "test" });
  markUnresolved(t.app.db, id, { reason: "timeout", httpStatus: null, outcome: "timeout" });
  return id;
}

test("F21: marking a held row 'not charged' settles it at $0 and drops the hold", () => {
  const t = makeApp({ fetch: fakeProviders().fetch });
  try {
    const id = heldRow(t);
    assert.equal(monthTotals(t.app.db).countedMicros, 75000);
    assert.equal(unresolvedRows(t.app.db).length, 1);
    reconcileRow(t.app.db, id, { action: "not_charged" });
    assert.equal(monthTotals(t.app.db).countedMicros, 0);
    assert.equal(unresolvedRows(t.app.db).length, 0);
    const row = t.app.db.prepare("SELECT status, actual_micro_usd, cost_source FROM spend_ledger WHERE id = ?").get(id) as { status: string; actual_micro_usd: number; cost_source: string };
    assert.deepEqual([row.status, row.actual_micro_usd, row.cost_source], ["settled", 0, "manual_reconcile"]);
    assert.throws(() => reconcileRow(t.app.db, id, { action: "not_charged" }), RowNotReserved);
  } finally { t.cleanup(); }
});

test("F21: noting the charged amount settles the row by hand", () => {
  const t = makeApp({ fetch: fakeProviders().fetch });
  try {
    const id = heldRow(t);
    reconcileRow(t.app.db, id, { action: "charged", usd: 0.09 });
    const row = t.app.db.prepare("SELECT actual_micro_usd FROM spend_ledger WHERE id = ?").get(id) as { actual_micro_usd: number };
    assert.equal(row.actual_micro_usd, 90000);
    assert.equal(monthTotals(t.app.db).countedMicros, 90000);
    assert.throws(() => reconcileRow(t.app.db, id, { action: "charged", usd: 1 }), RowNotReserved);
  } finally { t.cleanup(); }
});

test("item 8: a higher Google console total adds ONE adjustment row and never rewrites per-call rows", () => {
  const t = makeApp({ fetch: fakeProviders().fetch });
  try {
    for (let i = 0; i < 2; i++) {
      const { id } = reserve(t.app.db, { ...GOOGLE, generationId: GEN, attempt: 1, estimateMicros: 75000, estimateSource: "test" });
      settle(t.app.db, id, { actualMicros: 68500, costSource: "estimated_tokens", httpStatus: 200, outcome: "ok" });
    }
    assert.equal(googleConsoleState(t.app.db).estimateMicros, 137000);
    const out = setGoogleConsoleTotal(t.app.db, 1.0);
    assert.equal(out.adjustmentMicros, 863000);
    assert.equal(out.state.differenceMicros, 0);
    assert.equal(monthTotals(t.app.db).countedMicros, 1_000_000);
    const adj = t.app.db.prepare("SELECT provider, kind, status, estimate_micro_usd, actual_micro_usd, cost_source FROM spend_ledger WHERE kind = 'adjustment'").all() as Array<Record<string, unknown>>;
    assert.equal(adj.length, 1);
    assert.deepEqual([adj[0].provider, adj[0].status, adj[0].estimate_micro_usd, adj[0].actual_micro_usd, adj[0].cost_source], ["google", "settled", 863000, 863000, "manual_reconcile"]);
    const perCall = t.app.db.prepare("SELECT DISTINCT actual_micro_usd FROM spend_ledger WHERE kind <> 'adjustment'").all() as Array<{ actual_micro_usd: number }>;
    assert.deepEqual(perCall.map((r) => r.actual_micro_usd), [68500]);
    // Same total again: no second row.
    assert.equal(setGoogleConsoleTotal(t.app.db, 1.0).adjustmentMicros, 0);
    assert.equal((t.app.db.prepare("SELECT COUNT(*) AS c FROM spend_ledger WHERE kind = 'adjustment'").get() as { c: number }).c, 1);
    // A lower total is shown, not booked.
    const lower = setGoogleConsoleTotal(t.app.db, 0.5);
    assert.equal(lower.adjustmentMicros, 0);
    assert.equal(lower.state.differenceMicros, -500000);
    // Back up to the same total: still idempotent.
    assert.equal(setGoogleConsoleTotal(t.app.db, 1.0).adjustmentMicros, 0);
    assert.equal(monthTotals(t.app.db).countedMicros, 1_000_000);
  } finally { t.cleanup(); }
});

test("generationCostText renders settled, held, manual and assumed-zero rows", () => {
  const t = makeApp({ fetch: fakeProviders().fetch });
  try {
    const billed = reserve(t.app.db, { provider: "xai", model: "grok-imagine-image-2.0", kind: "generate", resolution: "1k", quality: "low", generationId: GEN, attempt: 1, estimateMicros: 60000, estimateSource: "test" });
    settle(t.app.db, billed.id, { actualMicros: 40000, costSource: "billed_provider", httpStatus: 200, outcome: "ok" });
    assert.equal(generationCostText(t.app.db, GEN), "$0.04");
    // A retry attempt on the same generation: attempt 2 is the latest row.
    const { id } = reserve(t.app.db, { ...GOOGLE, generationId: GEN, attempt: 2, estimateMicros: 75000, estimateSource: "test" });
    markUnresolved(t.app.db, id, { reason: "timeout", httpStatus: null, outcome: "timeout" });
    assert.equal(generationCostText(t.app.db, GEN), "$0.07 held (cost unknown)");
    const zero = reserve(t.app.db, { ...GOOGLE, generationId: GEN, attempt: 3, estimateMicros: 75000, estimateSource: "test" });
    settle(t.app.db, zero.id, { actualMicros: 0, costSource: "assumed_zero_429", httpStatus: 429, outcome: "http_error" });
    assert.equal(generationCostText(t.app.db, GEN), "$0.00 (confirm against console)");
  } finally { t.cleanup(); }
});
