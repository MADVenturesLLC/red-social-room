// SQLite (WAL) database: schema, FTS5 search index kept in sync by triggers (TECH-PLAN-v1.md:77),
// append-only spend ledger (Amendment 1 section 3.4) and the one-time import of the 10 spike rows (item 18).
// Uses Node's built-in node:sqlite (no native add-on to build).
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { validateLedgerFile, toMicros, type LedgerEntry } from "../../spike/lib/ledger.ts";
import { REPO_ROOT } from "./config.ts";

export type DB = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY CHECK (length(id) = 64),         -- sha256 hex of the file bytes
  rel_path TEXT NOT NULL,
  mime TEXT NOT NULL,
  width INTEGER, height INTEGER,
  bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL                                   -- ok | failed | blocked
);

CREATE TABLE IF NOT EXISTS generations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  created_at TEXT NOT NULL,
  provider TEXT NOT NULL, model TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('generate','edit','outpaint')),
  prompt TEXT NOT NULL,
  params TEXT NOT NULL,                                  -- JSON: requested/sent ratio, resolution, n
  status TEXT NOT NULL,                                  -- ok | refused | error | blocked | not_sent
  error_code TEXT, error_message TEXT,
  client_request_id TEXT,                                -- last attempt's ledger id (Amendment 1 item 3)
  provider_request_id TEXT, provider_trace TEXT, model_returned TEXT, model_version_listing TEXT,
  output_asset_id TEXT REFERENCES assets(id),            -- original, stored unchanged
  display_asset_id TEXT REFERENCES assets(id),           -- what the tile shows (e.g. the 4:5 crop, D2)
  display_note TEXT,
  latency_ms INTEGER
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY,                                -- stable rowid for the FTS external-content index
  created_at TEXT NOT NULL,
  generation_id TEXT NOT NULL UNIQUE REFERENCES generations(id),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  prompt TEXT NOT NULL,
  model TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT ''
);

CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(prompt, notes, model, content='posts', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS posts_ai AFTER INSERT ON posts BEGIN
  INSERT INTO posts_fts(rowid, prompt, notes, model) VALUES (new.id, new.prompt, new.notes, new.model);
END;
CREATE TRIGGER IF NOT EXISTS posts_ad AFTER DELETE ON posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, prompt, notes, model) VALUES ('delete', old.id, old.prompt, old.notes, old.model);
END;
CREATE TRIGGER IF NOT EXISTS posts_au AFTER UPDATE ON posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, prompt, notes, model) VALUES ('delete', old.id, old.prompt, old.notes, old.model);
  INSERT INTO posts_fts(rowid, prompt, notes, model) VALUES (new.id, new.prompt, new.notes, new.model);
END;

CREATE TABLE IF NOT EXISTS prompt_checks (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL,
  prompt_sha256 TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('allowed','blocked','unavailable')),
  reason TEXT,
  method TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL,                                    -- e.g. cap_refused
  detail TEXT NOT NULL                                   -- JSON
);

-- Amendment 1 section 3.4. Money in integer micro-USD. One row per attempt sent; never deleted.
CREATE TABLE IF NOT EXISTS spend_ledger (
  id TEXT PRIMARY KEY,                                   -- = client_request_id (UUID v4)
  created_at TEXT NOT NULL,
  month_ny TEXT NOT NULL CHECK (month_ny GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  provider TEXT NOT NULL CHECK (provider IN ('xai','google')),
  model TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('generate','edit','outpaint','caption','adjustment')),
  resolution TEXT, quality TEXT,                         -- price key for the item 2d max rule (open question)
  generation_id TEXT,
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt BETWEEN 1 AND 3),
  estimate_micro_usd INTEGER NOT NULL CHECK (estimate_micro_usd > 0),
  estimate_source TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reserved','settled','unresolved')),
  actual_micro_usd INTEGER CHECK (actual_micro_usd IS NULL OR actual_micro_usd >= 0),
  cost_source TEXT CHECK (cost_source IS NULL OR cost_source IN ('billed_provider','estimated_tokens','estimated_price_table','assumed_zero_rejected','assumed_zero_429','not_sent','manual_reconcile')),
  cost_detail TEXT,
  provider_request_id TEXT, provider_trace TEXT,
  http_status INTEGER, outcome TEXT,
  settled_at TEXT, note TEXT,
  imported_from TEXT,
  CHECK ((status = 'settled') = (actual_micro_usd IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS spend_ledger_month ON spend_ledger(month_ny);

CREATE TRIGGER IF NOT EXISTS spend_ledger_no_delete BEFORE DELETE ON spend_ledger BEGIN
  SELECT RAISE(ABORT, 'spend_ledger is append-only: rows are never deleted');
END;
CREATE TRIGGER IF NOT EXISTS spend_ledger_fixed_cols BEFORE UPDATE OF id, created_at, month_ny, provider, model, kind, resolution, quality, generation_id, attempt, estimate_micro_usd, estimate_source, imported_from ON spend_ledger
  WHEN NEW.id IS NOT OLD.id OR NEW.created_at IS NOT OLD.created_at OR NEW.month_ny IS NOT OLD.month_ny OR NEW.provider IS NOT OLD.provider
    OR NEW.model IS NOT OLD.model OR NEW.kind IS NOT OLD.kind OR NEW.resolution IS NOT OLD.resolution OR NEW.quality IS NOT OLD.quality
    OR (OLD.generation_id IS NOT NULL AND NEW.generation_id IS NOT OLD.generation_id) OR NEW.attempt IS NOT OLD.attempt
    OR NEW.estimate_micro_usd IS NOT OLD.estimate_micro_usd OR NEW.estimate_source IS NOT OLD.estimate_source OR NEW.imported_from IS NOT OLD.imported_from
BEGIN
  SELECT RAISE(ABORT, 'spend_ledger: only status, actual, source, detail, ids, settled_at and note may change');
END;
CREATE TRIGGER IF NOT EXISTS spend_ledger_settled_final BEFORE UPDATE ON spend_ledger WHEN OLD.status = 'settled' BEGIN
  SELECT RAISE(ABORT, 'spend_ledger: a settled row is final');
END;

-- Counted amount = actual if settled, otherwise the estimate (reserved or unresolved). section 3.4 "Views".
CREATE VIEW IF NOT EXISTS spend_counted AS
  SELECT *, CASE WHEN status = 'settled' THEN actual_micro_usd ELSE estimate_micro_usd END AS counted_micro_usd FROM spend_ledger;
CREATE VIEW IF NOT EXISTS spend_by_month AS
  SELECT month_ny, SUM(counted_micro_usd) AS counted_micro_usd FROM spend_counted GROUP BY month_ny;
CREATE VIEW IF NOT EXISTS spend_by_month_provider AS
  SELECT month_ny, provider, SUM(counted_micro_usd) AS counted_micro_usd FROM spend_counted GROUP BY month_ny, provider;
`;

export const SPIKE_LEDGER_PATH = join(REPO_ROOT, "spike-results", "ledger.json");

export function openDb(path: string, opts: { spikeLedgerPath?: string | null } = {}): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;");
  db.exec(SCHEMA);
  const spike = opts.spikeLedgerPath === undefined ? SPIKE_LEDGER_PATH : opts.spikeLedgerPath;
  if (spike) importSpikeLedger(db, spike);
  return db;
}

/** Run fn inside BEGIN IMMEDIATE ... COMMIT (rolled back on throw). */
export function tx<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const out = fn(); db.exec("COMMIT"); return out; } catch (e) { db.exec("ROLLBACK"); throw e; }
}

function kindFromLabel(label: string): "generate" | "edit" {
  if (/edit/.test(label)) return "edit";
  if (/generate|refusal-probe/.test(label)) return "generate";
  throw new Error(`spike ledger import: cannot tell the kind of row "${label}"`);
}

function costSourceFromBasis(basis: string | null, provider: string): string | null {
  if (!basis) return null;
  if (basis.startsWith("billed:")) return "billed_provider";
  if (basis.startsWith("manual_reconcile:")) return "manual_reconcile";
  if (basis.startsWith("estimated $0")) return "assumed_zero_rejected";
  if (basis.startsWith("estimated") || basis.startsWith("usage")) return provider === "google" ? "estimated_tokens" : "estimated_price_table";
  return provider === "google" ? "estimated_tokens" : "estimated_price_table";
}

/**
 * Amendment 1 item 18: import the 10 spike rows once, in one transaction, so they count toward the same
 * $50 October cap. The file is validated with the spike's own validator; a bad file stops startup (fail closed).
 */
export function importSpikeLedger(db: DB, path: string): number {
  const done = db.prepare("SELECT value FROM meta WHERE key = 'spike_ledger_imported'").get() as { value: string } | undefined;
  if (done) return 0;
  const f = JSON.parse(readFileSync(path, "utf8")) as { entries: LedgerEntry[] };
  const errs = validateLedgerFile(f);
  if (errs.length) throw new Error(`spike ledger import refused: ${path} failed validation: ${errs.slice(0, 5).join("; ")}`);
  const ins = db.prepare(`INSERT INTO spend_ledger (id, created_at, month_ny, provider, model, kind, resolution, quality, generation_id, attempt,
    estimate_micro_usd, estimate_source, status, actual_micro_usd, cost_source, cost_detail, http_status, outcome, settled_at, note, imported_from)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  return tx(db, () => {
    for (const e of f.entries) {
      const kind = kindFromLabel(e.label);
      const status = e.status;
      ins.run(e.id, e.created_at, e.month, e.provider, e.model, kind,
        "1k", e.provider === "xai" ? (kind === "generate" ? "low" : "medium") : null,
        toMicros(e.estimate_usd), `spike: ${e.estimate_basis}`.slice(0, 500), status,
        status === "settled" && e.actual_usd !== null ? toMicros(e.actual_usd) : null,
        status === "settled" ? costSourceFromBasis(e.cost_basis, e.provider) : null,
        JSON.stringify({ spike_label: e.label, spike_cost_basis: e.cost_basis }),
        e.http_status, status === "settled" ? "ok" : "unresolved",
        e.reconciled_at ?? null, null, "spike-results/ledger.json");
    }
    db.prepare("INSERT INTO meta (key, value) VALUES ('spike_ledger_imported', ?)").run(JSON.stringify({ rows: f.entries.length, at: new Date().toISOString() }));
    return f.entries.length;
  });
}
