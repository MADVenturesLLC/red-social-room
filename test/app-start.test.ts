// Argus L2 on fa3d359: the real app start (getApp) marks rows left `reserved` by a previous process unresolved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/server/db.ts";
import { reserve, unresolvedRows } from "../src/server/ledger.ts";
import { getApp } from "../src/server/app.ts";

test("Argus L2: app start turns a leftover 'reserved' row into 'unresolved' (interrupted) so Settings lists it", () => {
  const dir = mkdtempSync(join(tmpdir(), "rsr-start-"));
  const g = globalThis as typeof globalThis & { __rsrApp?: { db: { close(): void } } };
  const saved = { data: process.env.RSR_DATA_DIR, xai: process.env.XAI_API_KEY, gem: process.env.GEMINI_API_KEY };
  try {
    // No key in this process env, so app start makes no key-check request.
    delete process.env.XAI_API_KEY; delete process.env.GEMINI_API_KEY;
    process.env.RSR_DATA_DIR = dir;
    const db = openDb(join(dir, "db", "rsr.sqlite"));
    const r = reserve(db, { provider: "xai", model: "grok-imagine-image-2.0", kind: "generate", resolution: "1k", quality: "low", generationId: "00000000-0000-4000-8000-000000000000", attempt: 1, estimateMicros: 40000, estimateSource: "test", now: new Date("2026-10-20T12:00:00-04:00") });
    db.close();
    delete g.__rsrApp;
    const app = getApp();
    const row = app.db.prepare("SELECT status, outcome FROM spend_ledger WHERE id = ?").get(r.id) as Record<string, unknown>;
    assert.deepEqual({ ...row }, { status: "unresolved", outcome: "interrupted" });
    assert.ok(unresolvedRows(app.db).some((u) => u.id === r.id));
  } finally {
    g.__rsrApp?.db.close(); delete g.__rsrApp;
    for (const [k, v] of [["RSR_DATA_DIR", saved.data], ["XAI_API_KEY", saved.xai], ["GEMINI_API_KEY", saved.gem]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(dir, { recursive: true, force: true });
  }
});
