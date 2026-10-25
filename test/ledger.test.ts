// Spend guard behavior (Amendment 1 section 3.4, F20, items 17 and 18; A1 acceptance in section 4 line 279).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { openDb, LEDGER_SEEDS, validateSeed, type SeedFile } from "../src/server/db.ts";
import { reserve, settle, markUnresolved, monthTotals, CapRefused, setCapUsd, priceDrifts, markInterrupted, unresolvedRows, recordLateResult, unresolvedHeldText } from "../src/server/ledger.ts";
import { estimate, loadPrices } from "../src/server/prices.ts";
import { REPO_ROOT } from "../src/server/config.ts";

const SPIKE = join(REPO_ROOT, "spike-results", "ledger.json");
const base = { provider: "xai" as const, model: "grok-imagine-image-2.0", kind: "generate" as const, resolution: "1k", quality: "low", generationId: "00000000-0000-4000-8000-000000000000", attempt: 1, estimateSource: "test" };
const OCT = new Date("2026-10-15T12:00:00-04:00");
const fmt = (m: number) => `$${(m / 1e6).toFixed(2)}`;

test("item 18: the 10 spike rows alone count $0.5547 for October ($0.4947 settled + $0.06 held for the 422)", () => {
  const db = openDb(":memory:", { spikeLedgerPath: SPIKE, seeds: [] });
  const t = monthTotals(db, "2026-10");
  assert.equal(t.countedMicros, 554740);
  assert.equal(t.heldMicros, 60000);
  assert.equal(t.unresolvedCount, 1);
  assert.equal(t.byProvider.xai + t.byProvider.google, 554740);
  assert.equal(Number((db.prepare("SELECT COUNT(*) AS n FROM spend_ledger").get() as { n: number }).n), 10);
});

test("A1 pin 14, line 365: first start imports the 10 spike rows plus the seeded A1 live smoke row -> October counts $0.5947", () => {
  const db = openDb(":memory:"); // the defaults getApp() uses
  const t = monthTotals(db, "2026-10");
  assert.equal(t.countedMicros, 594740);
  assert.equal(t.heldMicros, 60000);
  assert.equal(t.byProvider.xai, 320000);
  assert.equal(t.byProvider.google, 274740);
  assert.equal(Number((db.prepare("SELECT COUNT(*) AS n FROM spend_ledger").get() as { n: number }).n), 11);
  const r = db.prepare("SELECT * FROM spend_ledger WHERE provider_request_id = 'cb478eea-cf55-96df-bc20-38346f7f013b'").get() as Record<string, unknown>;
  assert.equal(r.status, "settled");
  assert.equal(r.actual_micro_usd, 40000);
  assert.equal(r.cost_source, "billed_provider");
  assert.equal(r.kind, "generate");
  assert.equal(r.resolution, "1k"); assert.equal(r.quality, "low");
  assert.equal(r.imported_from, "red-social-room-logs/a1-live-smoke.out");
  assert.equal(JSON.parse(r.cost_detail as string).ticks, 400000000);
  assert.match(JSON.parse(r.cost_detail as string).basis, /^billed: usage\.cost_in_usd_ticks=400000000/);
});

test("the import runs once: reopening the same database (second start) adds no rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "rsr-seed-"));
  try {
    const p = join(dir, "rsr.sqlite");
    openDb(p).close();
    const db = openDb(p);
    assert.equal(Number((db.prepare("SELECT COUNT(*) AS n FROM spend_ledger").get() as { n: number }).n), 11);
    assert.equal(monthTotals(db, "2026-10").countedMicros, 594740);
    assert.match((db.prepare("SELECT value FROM meta WHERE key='spike_ledger_imported'").get() as { value: string }).value, /"rows":10/);
    assert.match((db.prepare("SELECT value FROM meta WHERE key='seed_imported:a1-live-smoke'").get() as { value: string }).value, /"rows":1/);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("A1 pin 8, line 359: the whole one-time import is ONE transaction - a failure partway leaves zero rows and no marker, and the next start imports all 11", () => {
  const dir = mkdtempSync(join(tmpdir(), "rsr-seed-"));
  try {
    const p = join(dir, "rsr.sqlite");
    const spikeIds = (JSON.parse(readFileSync(SPIKE, "utf8")) as { entries: Array<{ id: string }> }).entries.map((e) => e.id);
    // Valid on its own, but its row id collides with a spike row: the INSERT throws after the 10 spike rows and the
    // live smoke seed row were already written inside the transaction.
    const clash = { ...LEDGER_SEEDS[0], name: "clash", entries: [{ ...LEDGER_SEEDS[0].entries[0], id: spikeIds[3], provider_request_id: "x" }] } as SeedFile;
    assert.deepEqual(validateSeed(clash), []);
    assert.throws(() => openDb(p, { seeds: [LEDGER_SEEDS[0], clash] }), /UNIQUE constraint failed/);
    const raw = new DatabaseSync(p);
    assert.equal(Number((raw.prepare("SELECT COUNT(*) AS n FROM spend_ledger").get() as { n: number }).n), 0);
    assert.equal(Number((raw.prepare("SELECT COUNT(*) AS n FROM meta").get() as { n: number }).n), 0);
    raw.close();
    const db = openDb(p); // next start, normal seeds
    assert.equal(Number((db.prepare("SELECT COUNT(*) AS n FROM spend_ledger").get() as { n: number }).n), 11);
    assert.equal(monthTotals(db, "2026-10").countedMicros, 594740);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the seeded row counts against the cap from the first start (a cap of $0.5947 + one call refuses it)", () => {
  const db = openDb(":memory:");
  setCapUsd(db, 0.63); // 594740 + 40000 = 634740 > 630000
  assert.throws(() => reserve(db, { ...base, estimateMicros: 40000, now: new Date("2026-10-08T12:00:00-04:00") }), CapRefused);
});

test("a seed that is not a billed, settled row (or whose amount disagrees with its ticks) stops startup", () => {
  const good = LEDGER_SEEDS[0];
  assert.deepEqual(validateSeed(good), []);
  const bad = (patch: Record<string, unknown>): SeedFile => ({ ...good, name: "bad-seed", entries: [{ ...good.entries[0], ...patch }] } as SeedFile);
  assert.match(validateSeed(bad({ actual_micro_usd: 0 })).join(), /billed_ticks/);
  assert.match(validateSeed(bad({ status: "unresolved" })).join(), /settled from a provider bill/);
  assert.match(validateSeed(bad({ month_ny: "2026-11" })).join(), /month_ny/);
  assert.match(validateSeed({ ...good, source_log: "/workspace/red-social-room-logs/a1-live-smoke.out" }).join(), /relative/);
  assert.throws(() => openDb(":memory:", { spikeLedgerPath: null, seeds: [bad({ provider_request_id: "" })] }), /ledger seed import refused/);
});

test("item 18: the imported 422 row keeps the spike's narrow cost rule (unresolved, counted), and the 4 settled xAI bills keep their tick figures", () => {
  const db = openDb(":memory:", { spikeLedgerPath: SPIKE, seeds: [] });
  const r422 = db.prepare("SELECT status, estimate_micro_usd, http_status FROM spend_ledger WHERE id LIKE 'beb67d2b%'").get() as Record<string, unknown>;
  assert.deepEqual({ ...r422 }, { status: "unresolved", estimate_micro_usd: 60000, http_status: 422 });
  const billed = db.prepare("SELECT COUNT(*) AS n FROM spend_ledger WHERE provider='xai' AND cost_source='billed_provider'").get() as { n: number };
  assert.equal(Number(billed.n), 4);
});

test("item 2(e) / F22 (line 205): 900000000 ticks against a $0.07 reservation records the bill and a drift notice; exactly +$0.005 does not", () => {
  const db = openDb(":memory:", { spikeLedgerPath: null });
  const edit = { ...base, kind: "edit" as const, quality: "medium", estimateMicros: 70000, now: OCT };
  const a = reserve(db, edit);
  settle(db, a.id, { actualMicros: 90000, costSource: "billed_provider", httpStatus: 200, outcome: "ok" });
  const b = reserve(db, { ...edit, estimateMicros: 70000 });
  settle(db, b.id, { actualMicros: 75000, costSource: "billed_provider", httpStatus: 200, outcome: "ok" });
  const c = reserve(db, { ...edit, estimateMicros: 70000 });
  settle(db, c.id, { actualMicros: 0, costSource: "assumed_zero_rejected", httpStatus: 422, outcome: "rejected" });
  const d = priceDrifts(db);
  assert.equal(d.length, 1);
  assert.equal(d[0].ledgerId, a.id);
  assert.match(d[0].text, /billed \$0\.0900 against a \$0\.0700 reservation/);
  assert.equal((db.prepare("SELECT actual_micro_usd AS v FROM spend_ledger WHERE id = ?").get(a.id) as { v: number }).v, 90000);
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
    assert.equal(e.message, "Monthly cap $0.10 reached ($0.08 counted this month). Raise the cap in Settings or wait until Nov 1, 12:00 AM ET.");
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
  assert.throws(() => reserve(db, { ...base, estimateMicros: 40000, now: OCT }), /\$0\.07 counted this month, including \$0\.07 held for unchecked calls/);
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

test("item 17 (Argus M3): a full October does not block November, and November counts only November spend", () => {
  const db = openDb(":memory:", { spikeLedgerPath: null });
  setCapUsd(db, 0.05);
  const oct = reserve(db, { ...base, estimateMicros: 40000, now: new Date("2026-10-31T12:00:00-04:00") });
  settle(db, oct.id, { actualMicros: 40000, costSource: "billed_provider", httpStatus: 200, outcome: "ok" });
  // Last second of October in New York (03:59:59Z on Nov 1) is still October: refused.
  assert.throws(() => reserve(db, { ...base, estimateMicros: 40000, now: new Date("2026-11-01T03:59:59Z") }), /\$0\.04 counted.*wait until Nov 1, 12:00 AM ET/);
  // First second of November in New York: allowed, because only November is summed.
  const nov = reserve(db, { ...base, estimateMicros: 40000, now: new Date("2026-11-01T04:00:00Z") });
  assert.equal((db.prepare("SELECT month_ny FROM spend_ledger WHERE id = ?").get(nov.id) as { month_ny: string }).month_ny, "2026-11");
  // November now holds $0.04 of its own; the next $0.04 passes the $0.05 cap and is refused, naming only November's $0.04.
  assert.throws(() => reserve(db, { ...base, estimateMicros: 40000, now: new Date("2026-11-15T12:00:00Z") }), /\(\$0\.04 counted this month, including \$0\.04 held/);
  const novT = monthTotals(db, "2026-11"), octT = monthTotals(db, "2026-10");
  assert.equal(novT.countedMicros, 40000);
  assert.equal(octT.countedMicros, 40000);
  // A small November call still fits: 40000 + 10000 = cap.
  reserve(db, { ...base, estimateMicros: 10000, now: new Date("2026-11-15T12:00:00Z") });
});

test("A1 pin 5, line 356 (Argus L4): the ledger accepts kind 'prompt_check'", () => {
  const db = openDb(":memory:", { spikeLedgerPath: null });
  const r = reserve(db, { ...base, kind: "prompt_check", estimateMicros: 100, now: OCT });
  settle(db, r.id, { actualMicros: 0, costSource: "not_sent", httpStatus: null, outcome: "ok" });
  assert.equal((db.prepare("SELECT kind FROM spend_ledger WHERE id = ?").get(r.id) as { kind: string }).kind, "prompt_check");
  assert.throws(() => db.prepare("INSERT INTO spend_ledger (id, created_at, month_ny, provider, model, kind, estimate_micro_usd, estimate_source, status) VALUES ('x', 'now', '2026-10', 'xai', 'm', 'bogus', 1, 't', 'reserved')").run(), /CHECK constraint failed/);
});

test("Argus L2: rows still 'reserved' at app start are marked unresolved ('interrupted'), keep counting, and show in Unresolved", () => {
  const db = openDb(":memory:", { spikeLedgerPath: null });
  const a = reserve(db, { ...base, estimateMicros: 40000, now: OCT });
  const b = reserve(db, { ...base, estimateMicros: 40000, now: OCT });
  settle(db, b.id, { actualMicros: 40000, costSource: "billed_provider", httpStatus: 200, outcome: "ok" });
  assert.equal(markInterrupted(db), 1);
  const row = db.prepare("SELECT status, outcome, note FROM spend_ledger WHERE id = ?").get(a.id) as Record<string, unknown>;
  assert.deepEqual({ ...row }, { status: "unresolved", outcome: "interrupted", note: "interrupted: still reserved at app start" });
  assert.deepEqual(unresolvedRows(db).map((r) => r.id), [a.id]);
  assert.equal(monthTotals(db, "2026-10").countedMicros, 80000);
  assert.equal(markInterrupted(db), 0);
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

// ---- A1 pin 18, line 369 (Amendment 1 at 5c773d7; pointers at item 18, line 61 and section 3.4 Views, line 263) ----
const late = (micros: number | null) => ({ httpStatus: 200, outcome: "ok", providerRequestId: "req-late", providerTrace: null, actualMicros: micros, costSource: micros === null ? null : "billed_provider", reason: "billed", note: null });
function sweptRow(db: ReturnType<typeof openDb>) {
  const r = reserve(db, { ...base, estimateMicros: 40000, now: OCT });
  assert.equal(markInterrupted(db), 1);
  return r.id;
}
const views = (db: ReturnType<typeof openDb>) => ({
  month: Number((db.prepare("SELECT counted_micro_usd AS c FROM spend_by_month WHERE month_ny = '2026-10'").get() as { c: number }).c),
  xai: Number((db.prepare("SELECT counted_micro_usd AS c FROM spend_by_month_provider WHERE month_ny = '2026-10' AND provider = 'xai'").get() as { c: number }).c),
});

for (const [bill, counted] of [[90000, 90000], [20000, 40000]] as const) {
  test(`A1 pin 18, line 369: a late bill of ${fmt(bill)} on a $0.04 estimate counts ${fmt(counted)} everywhere (cap check, month and provider views, held, Unresolved list); the row stays unresolved`, () => {
    const db = openDb(":memory:", { spikeLedgerPath: null });
    const id = sweptRow(db);
    const out = recordLateResult(db, id, late(bill));
    assert.deepEqual(out, { status: "unresolved", countedMicros: counted, actualMicros: null, costSource: null });
    const row = db.prepare("SELECT status, actual_micro_usd, settled_at FROM spend_ledger WHERE id = ?").get(id) as Record<string, unknown>;
    assert.deepEqual({ ...row }, { status: "unresolved", actual_micro_usd: null, settled_at: null }, "nothing settles automatically");
    const t = monthTotals(db, "2026-10");
    assert.equal(t.countedMicros, counted); assert.equal(t.heldMicros, counted); assert.equal(t.byProvider.xai, counted); assert.equal(t.unresolvedCount, 1);
    assert.deepEqual(views(db), { month: counted, xai: counted });
    const [u] = unresolvedRows(db);
    assert.equal(u.counted_micro_usd, counted); assert.equal(u.late_micro_usd, bill); assert.equal(u.estimate_micro_usd, 40000);
    assert.equal(unresolvedHeldText(u), `${fmt(counted)} held (late bill ${fmt(bill)})`);
    // The cap check reads the same amount: with a cap of counted + $0.04 the next $0.04 call fits; one micro-dollar less refuses it.
    setCapUsd(db, (counted + 40000) / 1e6);
    reserve(db, { ...base, estimateMicros: 40000, now: OCT });
    assert.throws(() => reserve(db, { ...base, estimateMicros: 1, now: OCT }), CapRefused);
  });
}

test("A1 pin 18, line 369: a late result with no known bill keeps the estimate; a second, smaller late bill never lowers the first; the database refuses to lower or drop it", () => {
  const db = openDb(":memory:", { spikeLedgerPath: null });
  const id = sweptRow(db);
  assert.equal(recordLateResult(db, id, late(null)).countedMicros, 40000);
  assert.equal(unresolvedRows(db)[0].late_micro_usd, null);
  assert.equal(unresolvedHeldText(unresolvedRows(db)[0]), "$0.04 held");
  assert.equal(recordLateResult(db, id, late(90000)).countedMicros, 90000);
  assert.equal(recordLateResult(db, id, late(20000)).countedMicros, 90000);
  assert.match(String((db.prepare("SELECT cost_detail FROM spend_ledger WHERE id = ?").get(id) as { cost_detail: string }).cost_detail), /"reason":"unresolved: the app stopped/);
  assert.throws(() => db.prepare("UPDATE spend_ledger SET cost_detail = json_set(cost_detail, '$.late_micro_usd', 1) WHERE id = ?").run(id), /never lowered or removed/);
  assert.throws(() => db.prepare("UPDATE spend_ledger SET cost_detail = '{}' WHERE id = ?").run(id), /never lowered or removed/);
  assert.equal(Number((db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'late_result'").get() as { n: number }).n), 3);
  // A2 reconcile (settle with manual_reconcile) is still allowed and then the settled amount counts.
  db.prepare("UPDATE spend_ledger SET status = 'settled', actual_micro_usd = 85000, cost_source = 'manual_reconcile', cost_detail = '{}', settled_at = 'x' WHERE id = ?").run(id);
  assert.equal(monthTotals(db, "2026-10").countedMicros, 85000);
});

test("A1 pin 18, line 369: a late result on a row that was already settled changes nothing but the event", () => {
  const db = openDb(":memory:", { spikeLedgerPath: null });
  const r = reserve(db, { ...base, estimateMicros: 40000, now: OCT });
  settle(db, r.id, { actualMicros: 40000, costSource: "billed_provider", httpStatus: 200, outcome: "ok" });
  assert.deepEqual(recordLateResult(db, r.id, late(90000)), { status: "settled", countedMicros: 40000, actualMicros: 40000, costSource: "billed_provider" });
  assert.equal(monthTotals(db, "2026-10").countedMicros, 40000);
});

test("A1 pin 18, line 369: a database whose spend_counted view predates pin 18 gets the new view at the next start", () => {
  const dir = mkdtempSync(join(tmpdir(), "rsr-view-"));
  try {
    const path = join(dir, "rsr.sqlite");
    let db = openDb(path, { spikeLedgerPath: null });
    const id = sweptRow(db);
    recordLateResult(db, id, late(90000));
    db.exec("DROP VIEW spend_by_month_provider; DROP VIEW spend_by_month; DROP VIEW spend_counted; CREATE VIEW spend_counted AS SELECT *, CASE WHEN status = 'settled' THEN actual_micro_usd ELSE estimate_micro_usd END AS counted_micro_usd FROM spend_ledger; CREATE VIEW spend_by_month AS SELECT month_ny, SUM(counted_micro_usd) AS counted_micro_usd FROM spend_counted GROUP BY month_ny; CREATE VIEW spend_by_month_provider AS SELECT month_ny, provider, SUM(counted_micro_usd) AS counted_micro_usd FROM spend_counted GROUP BY month_ny, provider;");
    assert.equal(monthTotals(db, "2026-10").countedMicros, 40000, "the old view undercounts");
    db.close();
    db = openDb(path, { spikeLedgerPath: null });
    assert.equal(monthTotals(db, "2026-10").countedMicros, 90000);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("A1 pin 19 (b), line 370 (Amendment 1 at 9a890fb): a late bill raises no price-drift notice and does not raise the next estimate; both use settled rows only", () => {
  const db = openDb(":memory:", { spikeLedgerPath: null });
  const prices = loadPrices();
  const k = { provider: "xai" as const, model: base.model, kind: base.kind, resolution: base.resolution, quality: base.quality };
  const before = estimate(db, prices, k);
  const id = sweptRow(db);
  assert.equal(recordLateResult(db, id, late(900000)).countedMicros, 900000, "the cap counts the $0.90 late bill (pin 18 (a))");
  assert.deepEqual(priceDrifts(db), [], "no price-drift notice for a late bill");
  assert.equal(Number((db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'price_drift'").get() as { n: number }).n), 0);
  assert.deepEqual(estimate(db, prices, k), before, "the next estimate is unchanged by the late bill");
  // Control: the same $0.90 on a settled row does raise both (so the check above can fail).
  const r = reserve(db, { ...base, estimateMicros: before.micros, now: OCT });
  settle(db, r.id, { actualMicros: 900000, costSource: "billed_provider", httpStatus: 200, outcome: "ok" });
  assert.equal(priceDrifts(db).length, 1);
  assert.equal(estimate(db, prices, k).micros, 900000);
});

test("Argus note on 0e2f1f4 (A1 pin 18 (a) / 19 (a)): the database refuses a late bill that is text, a fraction, negative or null, so a hand edit cannot make the row count $0; a whole number is accepted", () => {
  const db = openDb(":memory:", { spikeLedgerPath: null });
  const id = sweptRow(db);
  for (const bad of ["'\"90000\"'", "'90000.5'", "'-1'", "'null'", "'\"abc\"'"]) {
    assert.throws(() => db.prepare(`UPDATE spend_ledger SET cost_detail = json_set(cost_detail, '$.late_micro_usd', json(${bad})) WHERE id = ?`).run(id), /whole, non-negative number of micro-dollars/, bad);
  }
  for (const bad of ['"5"', "-5", "5.5"]) {
    assert.throws(() => db.prepare(`INSERT INTO spend_ledger (id, created_at, month_ny, provider, model, kind, generation_id, attempt, estimate_micro_usd, estimate_source, status, cost_detail) SELECT 'x2', created_at, month_ny, provider, model, kind, generation_id, 9, estimate_micro_usd, estimate_source, 'unresolved', '{"late_micro_usd":${bad}}' FROM spend_ledger WHERE id = ?`).run(id), /whole, non-negative number/, `insert ${bad}`);
  }
  assert.equal(monthTotals(db, "2026-10").countedMicros, 40000, "the row still counts its estimate");
  db.prepare("UPDATE spend_ledger SET cost_detail = json_set(cost_detail, '$.late_micro_usd', 90000) WHERE id = ?").run(id);
  assert.equal(monthTotals(db, "2026-10").countedMicros, 90000);
});
