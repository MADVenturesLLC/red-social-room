// Offline spend-guard tests (no network; temp ledgers only). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync, unlinkSync, readFileSync, fstatSync, statSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { Ledger, LedgerBusy, LedgerCorrupt, LedgerMissing, SpendRefused, SETTLE_LOCK_RETRIES, SETTLE_LOCK_RETRY_MS, currentMonthNY, validateLedgerFile, ledgerIo, type LedgerOptions } from "../lib/ledger.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const r = (l: Ledger, usd: number, provider: "xai" | "google" = "xai", label = "t") => l.reserve({ provider, model: "m", label, estimate_usd: usd, estimate_basis: "test" });

function withLedger(fn: (l: Ledger, dir: string) => void | Promise<void>, opts: LedgerOptions = {}) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "rsr-ledger-"));
    try { await fn(Ledger.init(join(dir, "ledger.json"), opts), dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  };
}

test("shared cap across providers, spike cap, settle replaces reservation, unresolved keeps it", withLedger((l) => {
  const a = r(l, 1.2, "xai"); const b = r(l, 1.2, "google");
  assert.throws(() => r(l, 0.7), SpendRefused); // 2.4 + 0.7 > 3
  l.settle(a.id, 0.04, "billed", 200);
  assert.equal(l.totals().spikeAllTime, 1.24);
  l.markUnresolved(b.id, "timeout", null);
  assert.equal(l.totals().spikeAllTime, 1.24);
  r(l, 1.7); // 2.94
  assert.throws(() => r(l, 0.07, "google"), /Spike cap \$3/);
  assert.deepEqual(l.totals().byProvider, { xai: 1.74, google: 1.2 });
}));

test("estimates of 0, negative, NaN, Infinity are refused before sending", withLedger((l) => {
  for (const v of [0, -1, NaN, Infinity]) assert.throws(() => r(l, v), /No positive cost estimate/);
  assert.equal(l.entries().length, 0);
}));

test("$50 monthly cap is enforced across providers (spike cap lifted for this test)", withLedger((l) => {
  for (let i = 0; i < 10; i++) r(l, 4.9, i % 2 ? "xai" : "google");
  assert.throws(() => r(l, 1.01), /Monthly cap \$50/);
  r(l, 1.0); // exactly 50.00 is allowed
  assert.equal(l.totals().month, 50);
  assert.throws(() => r(l, 0.000001), /Monthly cap/);
}, { spikeCapUsd: 1000 }));

test("F9: integer micro-USD at the cap edge: exactly 50 x $0.06 fit under $3, the 51st is refused", withLedger((l) => {
  for (let i = 0; i < 50; i++) r(l, 0.06);
  assert.equal(l.totals().spikeAllTime, 3);
  assert.throws(() => r(l, 0.06), /Spike cap/);
  assert.equal(l.entries().length, 50);
}));

test("F4: settle rejects negative (Argus -10 case), NaN and non-finite actuals; the cap is unchanged", withLedger((l) => {
  const a = r(l, 0.06);
  for (const v of [-10, -0.01, NaN, Infinity, -Infinity]) assert.throws(() => l.settle(a.id, v, "bad", 200), RangeError);
  const e = l.entries()[0];
  assert.equal(e.status, "reserved"); assert.equal(e.actual_usd, null);
  assert.equal(l.totals().spikeAllTime, 0.06);
  r(l, 2.9); // 2.96 ok; with the -10 bug a further 2.90 would also have passed
  assert.throws(() => r(l, 2.9), /Spike cap/);
}));

test("F4: settle refuses to overwrite an already-settled row (Argus A7: billed $0.07 must not become $0)", withLedger((l) => {
  const a = r(l, 0.07);
  l.settle(a.id, 0.07, "billed", 200);
  assert.throws(() => l.settle(a.id, 0, "estimated $0", 422), /already settled/);
  assert.throws(() => l.markUnresolved(a.id, "x", null), /already settled/);
  assert.equal(l.entries()[0].actual_usd, 0.07);
}));

test("F7: a missing ledger fails closed; init creates it; init refuses to overwrite", () => {
  const dir = mkdtempSync(join(tmpdir(), "rsr-ledger-"));
  try {
    const p = join(dir, "ledger.json");
    assert.throws(() => new Ledger(p), LedgerMissing);
    assert.equal(existsSync(p), false, "constructor must not create the file");
    const l = Ledger.init(p);
    r(l, 0.06);
    assert.throws(() => Ledger.init(p), /already exists/);
    assert.equal(new Ledger(p).entries().length, 1, "history survives a second init attempt");
    unlinkSync(p); // e.g. git clean / checkout removed it
    assert.throws(() => new Ledger(p), LedgerMissing);
    assert.deepEqual(readdirSync(dir).filter((f) => f.includes(".tmp")), [], "no temp files left behind");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("F7: ledger-init CLI refuses an existing ledger and creates a missing one", () => {
  const dir = mkdtempSync(join(tmpdir(), "rsr-ledger-"));
  try {
    const p = join(dir, "ledger.json");
    const run = () => spawnSync(process.execPath, [join(ROOT, "spike", "ledger-init.ts"), "--ledger", p], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
    assert.equal(run().status, 0);
    assert.equal(JSON.parse(readFileSync(p, "utf8")).entries.length, 0);
    const second = run();
    assert.equal(second.status, 1); assert.match(second.stderr, /already exists/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a corrupt or wrong-shape ledger is refused", withLedger((l) => {
  writeFileSync(l.path, JSON.stringify({ hello: 1 }));
  assert.throws(() => new Ledger(l.path), LedgerCorrupt);
  writeFileSync(l.path, "{ not json");
  assert.throws(() => new Ledger(l.path), /not valid JSON/);
}));

test("F3: reserve() fails fast while the lock is held (nothing is sent)", withLedger((l) => {
  writeFileSync(l.lockPath, "");
  assert.throws(() => r(l, 0.06), SpendRefused);
  unlinkSync(l.lockPath);
}));

test("F3: settle() waits (bounded) for a lock held by another process, then succeeds", withLedger(async (l) => {
  const a = r(l, 0.06);
  writeFileSync(l.lockPath, "");
  // Another process releases the lock after ~300 ms.
  const child = spawn(process.execPath, ["-e", `setTimeout(() => require("node:fs").unlinkSync(${JSON.stringify(l.lockPath)}), 300)`]);
  await new Promise((res) => setTimeout(res, 50));
  const l2 = new Ledger(l.path, { settleLockRetries: 100, settleLockRetryMs: 20 }); // up to ~2 s
  l2.settle(a.id, 0.04, "billed", 200);
  await new Promise((res) => child.on("exit", res));
  assert.equal(l.entries()[0].status, "settled");
  assert.equal(l.totals().spikeAllTime, 0.04);
}));

test("F3: settle() gives up after the bounded wait with LedgerBusy; reservation stays counted", withLedger((l) => {
  const a = r(l, 0.06);
  writeFileSync(l.lockPath, "");
  const l2 = new Ledger(l.path, { settleLockRetries: 3, settleLockRetryMs: 5 });
  assert.throws(() => l2.settle(a.id, 0.04, "billed", 200), (e: unknown) => e instanceof LedgerBusy && /ledger-reconcile/.test((e as Error).message));
  unlinkSync(l.lockPath);
  assert.equal(l.entries()[0].status, "reserved");
  assert.equal(l.totals().spikeAllTime, 0.06);
}));

test("F6: reconcile resolves an unresolved row (not-charged or an amount) by id prefix, and refuses settled rows", withLedger((l) => {
  const a = r(l, 0.06); l.markUnresolved(a.id, "unresolved: HTTP 422", 422);
  const b = r(l, 0.06); l.markUnresolved(b.id, "timeout", null);
  const e = l.reconcile(a.id.slice(0, 8), 0, "not charged; console checked");
  assert.equal(e.status, "settled"); assert.equal(e.actual_usd, 0); assert.equal(e.prior_status, "unresolved");
  assert.equal(e.prior_cost_basis, "unresolved: HTTP 422"); assert.match(e.cost_basis ?? "", /^manual_reconcile: /);
  assert.equal(l.totals().spikeAllTime, 0.06);
  l.reconcile(b.id, 0.04, "console shows $0.04");
  assert.equal(l.totals().spikeAllTime, 0.04);
  assert.throws(() => l.reconcile(a.id, 0.06, "again"), /already settled/);
  assert.throws(() => l.reconcile(b.id.slice(0, 4), 0, "x"), /not found/); // prefix too short
  const c = r(l, 0.06);
  assert.throws(() => l.reconcile(c.id, -10, "x"), RangeError);
  assert.throws(() => l.reconcile(c.id, 0, "  "), /needs a note/);
}));

test("F6: ledger-reconcile CLI settles the row and rejects bad amounts", withLedger((l) => {
  const a = r(l, 0.06); l.markUnresolved(a.id, "unresolved: HTTP 422", 422);
  const cli = (...args: string[]) => spawnSync(process.execPath, [join(ROOT, "spike", "ledger-reconcile.ts"), ...args, "--ledger", l.path], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
  assert.equal(cli(a.id.slice(0, 8), "-10", "note").status, 2);
  assert.equal(cli(a.id.slice(0, 8), "abc", "note").status, 2);
  assert.equal(cli(a.id.slice(0, 8)).status, 2); // no amount / note
  const ok = cli(a.id.slice(0, 8), "not-charged", "console.x.ai shows no charge");
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /unresolved -> settled at \$0\.0000/);
  assert.equal(l.entries()[0].cost_basis, "manual_reconcile: not charged; console.x.ai shows no charge");
  assert.equal(cli(a.id, "0.04", "again").status, 1);
}));

// ---- Argus N1: every row is validated on load; bad rows fail CLOSED ----
const goodRow = (o: Record<string, unknown> = {}) => ({ id: "row-" + Math.random().toString(36).slice(2), created_at: "2026-10-04T04:00:00-04:00", month: currentMonthNY(), provider: "xai", model: "m", label: "hand", estimate_usd: 0.06, estimate_basis: "b", status: "settled", actual_usd: 0.04, cost_basis: "c", http_status: 200, spike: true, ...o });
const fileWith = (entries: unknown[]) => ({ version: 1, monthly_cap_usd: 50, spike_cap_usd: 3, entries });

test("N1: the committed spike-results/ledger.json passes row validation", () => {
  assert.deepEqual(validateLedgerFile(JSON.parse(readFileSync(join(ROOT, "spike-results", "ledger.json"), "utf8"))), []);
});

// Each bad row names the check that must catch it, so a clean removal of any one check fails a test
// (Argus P4: "unknown status" used to be caught only by the actual_usd rule).
const BAD: Array<[string, unknown, RegExp]> = [
  ["estimate_usd missing (Argus B1)", goodRow({ status: "reserved", actual_usd: null, estimate_usd: undefined }), /estimate_usd must be/],
  ["actual_usd not a number (B3)", goodRow({ actual_usd: "abc" }), /settled row needs actual_usd/],
  ["actual_usd = -10 (B2)", goodRow({ actual_usd: -10 }), /settled row needs actual_usd/],
  ["actual_usd NaN-ish null on a settled row", goodRow({ actual_usd: null }), /settled row needs actual_usd/],
  ["actual_usd set on a reserved row", goodRow({ status: "reserved", actual_usd: 0.04 }), /reserved row must have actual_usd null/],
  ["amount not whole micro-USD", goodRow({ actual_usd: 0.0000001 }), /settled row needs actual_usd/],
  ["estimate_usd 0", goodRow({ estimate_usd: 0 }), /estimate_usd must be/],
  ["absurd amount 1e300", goodRow({ actual_usd: 1e300 }), /settled row needs actual_usd/],
  ["unknown status", goodRow({ status: "paid" }), /status must be one of/],
  ["unknown status with actual_usd null (P4: only the status rule can catch it)", goodRow({ status: "paid", actual_usd: null }), /status must be one of/],
  ["status missing", goodRow({ status: undefined, actual_usd: null }), /status must be one of/],
  ["unknown provider", goodRow({ provider: "openai" }), /provider must be one of/],
  ["month wrong type (B13)", goodRow({ month: 202610 }), /month must be/],
  ["month wrong format", goodRow({ month: "2026-13" }), /month must be/],
  ["spike not true", goodRow({ spike: "yes" }), /spike must be true/],
  ["http_status not a code", goodRow({ http_status: "200" }), /http_status must be/],
  ["null row (B4)", null, /not an object/],
  ["id missing", goodRow({ id: undefined }), /id must be/],
  ["created_at missing (Q4)", goodRow({ created_at: undefined }), /created_at must be a string/],
  ["created_at not a string (Q4)", goodRow({ created_at: 20261004 }), /created_at must be a string/],
  ["prior_status unknown (Q4)", goodRow({ prior_status: "paid" }), /prior_status is not a known status/],
];
for (const [name, row, why] of BAD) {
  test(`N1: refuses a ledger with a bad row: ${name}`, withLedger((l) => {
    writeFileSync(l.path, JSON.stringify(fileWith([goodRow(), row])));
    assert.throws(() => new Ledger(l.path), (e: unknown) => e instanceof LedgerCorrupt && /row 1/.test((e as Error).message) && why.test((e as Error).message));
    assert.match(validateLedgerFile(fileWith([goodRow(), row])).join(";"), why);
  }));
}

test("N1: duplicate ids and bad top-level caps are refused", () => {
  const a = goodRow();
  assert.match(validateLedgerFile(fileWith([a, { ...a }])).join(";"), /duplicate id/);
  assert.match(validateLedgerFile({ version: 1, monthly_cap_usd: "50", spike_cap_usd: 3, entries: [] }).join(";"), /monthly_cap_usd/);
});

test("N1: a row corrupted AFTER open makes reserve() and totals() throw instead of letting a send through", withLedger((l) => {
  r(l, 0.06);
  const f = JSON.parse(readFileSync(l.path, "utf8"));
  f.entries[0].estimate_usd = "oops";
  writeFileSync(l.path, JSON.stringify(f));
  assert.throws(() => r(l, 2.9), LedgerCorrupt);
  assert.throws(() => l.totals(), LedgerCorrupt);
  assert.equal(existsSync(l.lockPath), false, "lock released after the refusal");
}));

// ---- Argus N4: stale-lock recovery is in both messages ----
test("N4: LedgerBusy and the reserve() refusal both explain how to clear a stale lock", withLedger((l) => {
  const a = r(l, 0.06);
  writeFileSync(l.lockPath, "");
  assert.throws(() => r(l, 0.06), /delete spike-results\/ledger\.lock/);
  const l2 = new Ledger(l.path, { settleLockRetries: 1, settleLockRetryMs: 1 });
  assert.throws(() => l2.settle(a.id, 0.04, "b", 200), (e: unknown) => e instanceof LedgerBusy && /delete spike-results\/ledger\.lock/.test((e as Error).message) && /reconcile needs the same lock/.test((e as Error).message));
  unlinkSync(l.lockPath);
}));

// ---- Argus N5: the production lock wait is pinned at ~5 s (with a fake sleep, so the suite stays fast) ----
test("N5: default settle lock wait is 100 x 50 ms = 5 s", withLedger((l) => {
  assert.equal(SETTLE_LOCK_RETRIES, 100);
  assert.equal(SETTLE_LOCK_RETRY_MS, 50);
  const a = r(l, 0.06);
  writeFileSync(l.lockPath, "");
  let calls = 0, slept = 0;
  const l2 = new Ledger(l.path, { sleep: (ms) => { calls++; slept += ms; } }); // default retries/ms
  assert.throws(() => l2.settle(a.id, 0.04, "b", 200), LedgerBusy);
  assert.equal(calls, 100);
  assert.equal(slept, 5000);
  unlinkSync(l.lockPath);
}));

// ---- Argus N6: amounts round UP to whole micro-USD ----
test("N6: tiny estimates reserve at least 1 micro-USD; amounts round up, float noise does not", withLedger((l) => {
  assert.equal(r(l, 1e-7).estimate_usd, 0.000001);
  assert.equal(r(l, 0.0000015).estimate_usd, 0.000002);
  assert.equal(r(l, 0.07).estimate_usd, 0.07);
  const a = r(l, 0.08);
  l.settle(a.id, 0.0690775, "b", 200);
  assert.equal(l.entries().find((e) => e.id === a.id)!.actual_usd, 0.069078);
  assert.throws(() => r(l, 1e-13), SpendRefused); // rounds to 0 -> refused
}));

// ---- Argus N7: ledger-report totals are integer sums ----
test("N7: ledger-report prints integer-summed totals, with reserved rows counted as held", withLedger((l) => {
  const a = r(l, 0.1); l.settle(a.id, 0.000123, "billed: x", 200); // (123 / 1e6) * 1e6 is 123.00000000000001 in floats
  const b = r(l, 0.2); l.settle(b.id, 0.2, "estimated: y", 200);
  const c = r(l, 0.07); l.settle(c.id, 0.07, "estimated: z", 200);
  r(l, 0.06); // reserved
  const out = spawnSync(process.execPath, [join(ROOT, "spike", "ledger-report.ts"), "--ledger", l.path], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
  assert.equal(out.status, 0, out.stderr);
  assert.ok(out.stdout.includes("billed (provider-reported) $0.000123 (123 micro-USD) | estimated $0.270000 (270000 micro-USD) | unresolved/reserved $0.060000 (60000 micro-USD) | total $0.330123 (330123 micro-USD)"), out.stdout);
}));

// ---- Argus P5: reserve() fails fast on a held lock; every write fsyncs the file, renames, then fsyncs the dir ----
test("P5: reserve() never waits for the lock: one attempt, zero sleeps, SpendRefused, nothing added", withLedger((l) => {
  let sleeps = 0;
  const l2 = new Ledger(l.path, { sleep: () => { sleeps++; } });
  writeFileSync(l.lockPath, "");
  assert.throws(() => r(l2, 0.06), (e: unknown) => e instanceof SpendRefused && /ledger is locked/.test((e as Error).message));
  assert.equal(sleeps, 0, "reserve() must not wait (a waiting reserve could send while another run is mid-write)");
  unlinkSync(l.lockPath);
  assert.equal(l2.entries().length, 0);
}));

test("P5: a ledger write fsyncs the temp file, renames it, then fsyncs the ledger directory", withLedger((l, dir) => {
  const seen: Array<{ dir: boolean; ino: number; ledgerHasRow: boolean }> = [];
  const real = ledgerIo.fsync;
  ledgerIo.fsync = (fd) => {
    const st = fstatSync(fd);
    seen.push({ dir: st.isDirectory(), ino: st.ino, ledgerHasRow: readFileSync(l.path, "utf8").includes('"label": "fsync-probe"') });
    real(fd);
  };
  try { r(l, 0.06, "xai", "fsync-probe"); } finally { ledgerIo.fsync = real; }
  assert.equal(seen.length, 2, JSON.stringify(seen));
  assert.deepEqual([seen[0].dir, seen[0].ledgerHasRow], [false, false], "temp file synced BEFORE the rename");
  assert.deepEqual([seen[1].dir, seen[1].ino, seen[1].ledgerHasRow], [true, statSync(dir).ino, true], "ledger dir synced AFTER the rename");
}));

test("Q7: the production fsync hook really calls fs.fsyncSync (file + directory per write)", withLedger((l) => {
  const fs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
  const real = fs.fsyncSync; let calls = 0;
  fs.fsyncSync = ((fd: number) => { calls++; return real(fd); }) as typeof fs.fsyncSync;
  syncBuiltinESMExports();
  try { r(l, 0.06); } finally { fs.fsyncSync = real; syncBuiltinESMExports(); }
  assert.equal(calls, 2);
}));

// ---- Argus P7: credential file names are ignored, tracked files are not ----
test("P7: .gitignore covers credential JSON names and keeps the tracked JSON files", () => {
  const d = mkdtempSync(join(tmpdir(), "rsr-ignore-"));
  try {
    assert.equal(spawnSync("git", ["init", "-q", d]).status, 0);
    copyFileSync(join(ROOT, ".gitignore"), join(d, ".gitignore"));
    const ignored = (f: string) => spawnSync("git", ["-C", d, "check-ignore", "-q", "--no-index", f]).status === 0;
    for (const f of ["service-account.json", "prod-service-account.json", "my_service_account.json", "client_secret_123.apps.googleusercontent.com.json", "gcp-key.json", "api_key.json", "credentials.json", "application_default_credentials.json", "keys/x.p12", ".env", ".npmrc", "id_rsa", "spike-results/ledger.lock", "cert.pfx", "id_ecdsa", "id_ecdsa.pub", "key.json", "token.json", "sub/token.json"]) assert.ok(ignored(f), `${f} should be ignored`);
    for (const f of ["package.json", "package-lock.json", "tsconfig.json", "spike-results/ledger.json", "spike-results/xai/results.json", "spike-results/gemini/05-refusal-probe.json"]) assert.ok(!ignored(f), `${f} must stay trackable`);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
