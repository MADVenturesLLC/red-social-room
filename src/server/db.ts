// SQLite (WAL) database: schema, FTS5 search index kept in sync by triggers (TECH-PLAN-v1.md:77),
// append-only spend ledger (Amendment 1 section 3.4) and the one-time import of the 10 spike rows (item 18)
// plus the seeded A1 live smoke row (src/server/seed/a1-live-smoke.json; Amendment 1 A1 pins 8 and 14, lines 359 and 365).
// Uses Node's built-in node:sqlite (no native add-on to build).
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { validateLedgerFile, toMicros, type LedgerEntry } from "../../spike/lib/ledger.ts";
import { REPO_ROOT } from "./config.ts";
// Bundled into the build (no runtime file path, so it is present in the Docker image too).
import a1LiveSmokeSeed from "./seed/a1-live-smoke.json" with { type: "json" };

export type DB = DatabaseSync;

/** A5: the FTS index over prompt, notes, model, captions and tags (T:77/T:103 "captions and tags join when
 *  they exist"). Caption/tag text is denormalized onto posts on every save, so the same triggers keep it
 *  in sync. Extracted so the migration can rebuild an older four-column index. */
const POSTS_FTS = `CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(prompt, notes, model, caption_text, tag_text, content='posts', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS posts_ai AFTER INSERT ON posts BEGIN
  INSERT INTO posts_fts(rowid, prompt, notes, model, caption_text, tag_text) VALUES (new.id, new.prompt, new.notes, new.model, new.caption_text, new.tag_text);
END;
CREATE TRIGGER IF NOT EXISTS posts_ad AFTER DELETE ON posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, prompt, notes, model, caption_text, tag_text) VALUES ('delete', old.id, old.prompt, old.notes, old.model, old.caption_text, old.tag_text);
END;
CREATE TRIGGER IF NOT EXISTS posts_au AFTER UPDATE ON posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, prompt, notes, model, caption_text, tag_text) VALUES ('delete', old.id, old.prompt, old.notes, old.model, old.caption_text, old.tag_text);
  INSERT INTO posts_fts(rowid, prompt, notes, model, caption_text, tag_text) VALUES (new.id, new.prompt, new.notes, new.model, new.caption_text, new.tag_text);
END;`;

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
  status TEXT NOT NULL                                   -- ok | failed | blocked | running | partial
);

-- A2 (Amendment 1 section 4 item 11): one row per image a run asked for. The in-process queue in runs.ts
-- fills these; a job's generations row lands at completion (same F16 order as A1: files, then rows).
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  creator_id TEXT NOT NULL,                              -- xai | google
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  generation_id TEXT NOT NULL,                           -- the id the ledger and generations row use
  prompt TEXT NOT NULL,
  ratio TEXT NOT NULL,
  status TEXT NOT NULL,                                  -- queued | running | ok | refused | error | blocked | not_sent
  label TEXT,                                            -- the run's real-person check label (P1c send_labeled)
  kind TEXT NOT NULL DEFAULT 'generate',                 -- A3: generate | edit
  parent_asset_id TEXT REFERENCES assets(id),            -- A3: the image being edited (edit) or referenced (reference run)
  created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS jobs_run ON jobs(run_id);

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
  latency_ms INTEGER,
  parent_asset_id TEXT REFERENCES assets(id),            -- A3 lineage: the version this one was made from
  mask_asset_id TEXT REFERENCES assets(id)               -- A3 (reserved): the painted mask, once mask edits exist
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY,                                -- stable rowid for the FTS external-content index
  created_at TEXT NOT NULL,
  generation_id TEXT NOT NULL UNIQUE REFERENCES generations(id),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  prompt TEXT NOT NULL,
  model TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  recipe TEXT,                                           -- A4: the editor recipe (JSON) saved beside the flattened render
  source_asset_id TEXT REFERENCES assets(id),            -- A4: the untouched original the recipe renders from
  caption_text TEXT NOT NULL DEFAULT '',                 -- A5: denormalized for the FTS index (captions table below)
  tag_text TEXT NOT NULL DEFAULT ''                      -- A5: denormalized for the FTS index (tags below)
);

${POSTS_FTS}

-- A5: captions (T:78/T:99): one row per platform per post; UNIQUE(post, platform) so saving replaces.
CREATE TABLE IF NOT EXISTS captions (
  id INTEGER PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts(id),
  platform TEXT NOT NULL,
  text TEXT NOT NULL,
  hashtags TEXT NOT NULL DEFAULT '',
  alt_text TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(post_id, platform)
);

-- A6: per-platform renditions (T:78): exact-size files for export; UNIQUE(post, preset) so re-making replaces.
CREATE TABLE IF NOT EXISTS renditions (
  id INTEGER PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts(id),
  preset_id TEXT NOT NULL,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  source_asset_id TEXT NOT NULL REFERENCES assets(id),  -- review 3: what it was made FROM; a design change makes it stale
  method TEXT NOT NULL CHECK (method IN ('crop','ai_extend','ai_rerender','local_outpaint','recraft_outpaint')),
  created_at TEXT NOT NULL,
  UNIQUE(post_id, preset_id)
);

-- A5: tags (T:78/T:103): suggested by the caption model, added only when the user ticks them.
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS post_tags (
  post_id INTEGER NOT NULL REFERENCES posts(id),
  tag_id INTEGER NOT NULL REFERENCES tags(id),
  PRIMARY KEY (post_id, tag_id)
);

-- A4: the Brand kit (T:96). Logos are ordinary assets (png/jpeg/webp/svg); this table is the kit's list.
CREATE TABLE IF NOT EXISTS brand_kit (
  id INTEGER PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

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
  kind TEXT NOT NULL CHECK (kind IN ('generate','edit','outpaint','caption','adjustment','prompt_check')), -- prompt_check: A1 pin 5, line 356
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
-- A1 pin 18, line 369 (Amendment 1 at 5c773d7): a late result's bill is kept in an unresolved row's cost_detail
-- ("detail" is one of the fields item 18, line 61 lets change) as late_micro_usd. Before reconcile it never goes
-- down or away, so the cap never counts less than was spent (FD:5). A2 reconcile settles the row; nothing here does.
CREATE TRIGGER IF NOT EXISTS spend_ledger_late_bill BEFORE UPDATE OF cost_detail ON spend_ledger
  WHEN NEW.status <> 'settled' AND json_valid(OLD.cost_detail) AND json_extract(OLD.cost_detail, '$.late_micro_usd') IS NOT NULL
    AND (NOT json_valid(NEW.cost_detail) OR json_extract(NEW.cost_detail, '$.late_micro_usd') IS NULL
      OR json_extract(NEW.cost_detail, '$.late_micro_usd') < json_extract(OLD.cost_detail, '$.late_micro_usd'))
BEGIN
  SELECT RAISE(ABORT, 'spend_ledger: a late bill is never lowered or removed before reconcile');
END;
-- Argus note to Surface on 0e2f1f4: a late bill must be a whole, non-negative number of micro-dollars. A hand edit
-- that stored text or a fraction would sort above every number in MAX() and count as $0 in SUM(); refuse it.
-- New trigger names, so databases created before this get them at the next start too (CREATE ... IF NOT EXISTS).
CREATE TRIGGER IF NOT EXISTS spend_ledger_late_bill_integer BEFORE UPDATE OF cost_detail ON spend_ledger
  WHEN NEW.status <> 'settled' AND json_valid(NEW.cost_detail) AND json_type(NEW.cost_detail, '$.late_micro_usd') IS NOT NULL
    AND (json_type(NEW.cost_detail, '$.late_micro_usd') <> 'integer' OR json_extract(NEW.cost_detail, '$.late_micro_usd') < 0)
BEGIN
  SELECT RAISE(ABORT, 'spend_ledger: a late bill must be a whole, non-negative number of micro-dollars');
END;
CREATE TRIGGER IF NOT EXISTS spend_ledger_late_bill_integer_insert BEFORE INSERT ON spend_ledger
  WHEN json_valid(NEW.cost_detail) AND json_type(NEW.cost_detail, '$.late_micro_usd') IS NOT NULL
    AND (json_type(NEW.cost_detail, '$.late_micro_usd') <> 'integer' OR json_extract(NEW.cost_detail, '$.late_micro_usd') < 0)
BEGIN
  SELECT RAISE(ABORT, 'spend_ledger: a late bill must be a whole, non-negative number of micro-dollars');
END;
CREATE TRIGGER IF NOT EXISTS spend_ledger_settled_final BEFORE UPDATE ON spend_ledger WHEN OLD.status = 'settled' BEGIN
  SELECT RAISE(ABORT, 'spend_ledger: a settled row is final');
END;

-- Counted amount = actual if settled, otherwise the estimate (reserved or unresolved). section 3.4 "Views".
-- A1 pin 18, line 369 (and the pointers at item 18, line 61 and section 3.4 Views, line 263, Amendment 1 at 5c773d7):
-- an unresolved row with a late bill counts the larger of its estimate and that bill (FD:5). Every total (cap check,
-- month and per-provider totals, held amount, Unresolved list) reads counted_micro_usd from this one view.
CREATE VIEW IF NOT EXISTS spend_counted AS
  SELECT *, CASE WHEN json_valid(cost_detail) THEN json_extract(cost_detail, '$.late_micro_usd') END AS late_micro_usd,
    CASE WHEN status = 'settled' THEN actual_micro_usd
         WHEN status = 'unresolved' THEN MAX(estimate_micro_usd, COALESCE(CASE WHEN json_valid(cost_detail) THEN json_extract(cost_detail, '$.late_micro_usd') END, 0))
         ELSE estimate_micro_usd END AS counted_micro_usd
  FROM spend_ledger;
CREATE VIEW IF NOT EXISTS spend_by_month AS
  SELECT month_ny, SUM(counted_micro_usd) AS counted_micro_usd FROM spend_counted GROUP BY month_ny;
CREATE VIEW IF NOT EXISTS spend_by_month_provider AS
  SELECT month_ny, provider, SUM(counted_micro_usd) AS counted_micro_usd FROM spend_counted GROUP BY month_ny, provider;

-- A7 (FD:6 + F23): one row per nightly backup attempt; the red banner shows when the last ok row is
-- older than 48 h (or there is none). Rows are never edited after completion.
CREATE TABLE IF NOT EXISTS backups (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  ok INTEGER,                                           -- NULL while running; 1 = finished; 0 = failed
  error TEXT,
  files_uploaded INTEGER NOT NULL DEFAULT 0,
  files_total INTEGER NOT NULL DEFAULT 0,
  bytes_uploaded INTEGER NOT NULL DEFAULT 0,
  db_bytes INTEGER,
  db_sha256 TEXT,
  manifest_key TEXT
);

-- A7: every asset file already pushed to R2, so each night uploads only what is new (the store is
-- content-addressed and append-only, so a file never changes under its name).
CREATE TABLE IF NOT EXISTS backup_files (
  rel TEXT PRIMARY KEY,                                 -- images/<xx>/<sha256>.<ext>
  bytes INTEGER NOT NULL,
  uploaded_at TEXT NOT NULL
);

-- A7 (F17): the nightly search-index check and any manual rebuild, newest first in Settings.
CREATE TABLE IF NOT EXISTS maintenance_log (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL,                                   -- fts_check | fts_rebuild | backup_skip
  detail TEXT NOT NULL                                  -- JSON
);

-- A7 (T:76 "saved snippets"): style phrases saved from the prompt box and re-inserted with one click.
CREATE TABLE IF NOT EXISTS snippets (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS snippets_text ON snippets(text);
`;

export const SPIKE_LEDGER_PATH = join(REPO_ROOT, "spike-results", "ledger.json");

/** Ledger rows seeded from outside the spike file (A1 pin 14, line 365), imported once together with it. */
export interface SeedFile {
  name: string; source_log: string;
  entries: Array<{
    id: string; created_at: string; month_ny: string; provider: string; model: string; kind: string; resolution: string | null; quality: string | null;
    generation_id: string | null; attempt: number; estimate_micro_usd: number; estimate_source: string; status: string; actual_micro_usd: number;
    cost_source: string; billed_ticks: number; cost_basis: string; provider_request_id: string; provider_trace: Record<string, string> | null;
    http_status: number; outcome: string; settled_at: string;
  }>;
}
export const LEDGER_SEEDS: readonly SeedFile[] = Object.freeze([a1LiveSmokeSeed as SeedFile]);

/**
 * opts.spikeLedgerPath: null skips the one-time import (unit tests that need an empty ledger).
 * opts.seeds: defaults to LEDGER_SEEDS whenever the spike import runs, so both land on the very first start.
 */
export function openDb(path: string, opts: { spikeLedgerPath?: string | null; seeds?: readonly SeedFile[] } = {}): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;");
  migrateLedger(db);
  db.exec(SCHEMA);
  migrateA3(db);
  migrateA4(db);
  migrateA5(db);
  const spike = opts.spikeLedgerPath === undefined ? SPIKE_LEDGER_PATH : opts.spikeLedgerPath;
  importLedgerOnce(db, spike, opts.seeds ?? (spike ? LEDGER_SEEDS : []));
  return db;
}

/**
 * A1 pin 18, line 369: the counting views are dropped so SCHEMA recreates them from this code on every start;
 * a view kept from an older database would count a late bill at the estimate.
 */
function migrateLedger(db: DB): void {
  db.exec("DROP VIEW IF EXISTS spend_by_month_provider; DROP VIEW IF EXISTS spend_by_month; DROP VIEW IF EXISTS spend_counted;");
}

/**
 * A3: CREATE TABLE IF NOT EXISTS never alters an existing table, so older databases get the lineage and
 * job-kind columns added here. New databases already have them from SCHEMA; this is a no-op for them.
 */
function migrateA3(db: DB): void {
  const cols = (t: string) => new Set((db.prepare(`PRAGMA table_info(${/* fixed name */ t})`).all() as Array<{ name: string }>).map((c) => c.name));
  const jobs = cols("jobs");
  if (!jobs.has("kind")) db.exec("ALTER TABLE jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'generate'");
  if (!jobs.has("parent_asset_id")) db.exec("ALTER TABLE jobs ADD COLUMN parent_asset_id TEXT REFERENCES assets(id)");
  const gens = cols("generations");
  if (!gens.has("parent_asset_id")) db.exec("ALTER TABLE generations ADD COLUMN parent_asset_id TEXT REFERENCES assets(id)");
  if (!gens.has("mask_asset_id")) db.exec("ALTER TABLE generations ADD COLUMN mask_asset_id TEXT REFERENCES assets(id)");
}

/** A4: CREATE TABLE IF NOT EXISTS never alters an existing table, so older databases get the editor's
 *  posts columns here (the brand_kit table comes from SCHEMA above; it is new, so it always exists). */
function migrateA4(db: DB): void {
  const cols = new Set((db.prepare("PRAGMA table_info(posts)").all() as Array<{ name: string }>).map((c) => c.name));
  if (!cols.has("recipe")) db.exec("ALTER TABLE posts ADD COLUMN recipe TEXT");
  if (!cols.has("source_asset_id")) db.exec("ALTER TABLE posts ADD COLUMN source_asset_id TEXT REFERENCES assets(id)");
}

/** A5: the posts columns the FTS index reads, and a rebuild of an older four-column index. The captions,
 *  tags and post_tags tables come from SCHEMA (all new, so they always exist). */
function migrateA5(db: DB): void {
  const cols = new Set((db.prepare("PRAGMA table_info(posts)").all() as Array<{ name: string }>).map((c) => c.name));
  if (!cols.has("caption_text")) db.exec("ALTER TABLE posts ADD COLUMN caption_text TEXT NOT NULL DEFAULT ''");
  if (!cols.has("tag_text")) db.exec("ALTER TABLE posts ADD COLUMN tag_text TEXT NOT NULL DEFAULT ''");
  const fts = (db.prepare("PRAGMA table_info(posts_fts)").all() as Array<{ name: string }>).map((c) => c.name);
  if (fts.length && !fts.includes("caption_text")) {
    db.exec("DROP TRIGGER IF EXISTS posts_ai; DROP TRIGGER IF EXISTS posts_ad; DROP TRIGGER IF EXISTS posts_au; DROP TABLE IF EXISTS posts_fts;");
    db.exec(POSTS_FTS);
    db.exec("INSERT INTO posts_fts(posts_fts) VALUES ('rebuild')");
  }
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
 * Amendment 1 item 18 + A1 pins 8 (line 359) and 14 (line 365): the one-time import of the 10 spike rows and every seed file
 * (the A1 live smoke row), with their "imported" markers, runs in ONE transaction (BEGIN IMMEDIATE). Everything
 * is validated before the transaction starts (a bad file stops startup, fail closed); a throw partway through
 * rolls back every row and marker, so the import simply runs again on the next start. Already-imported parts
 * (marker present) are skipped, so it never runs twice.
 */
export function importLedgerOnce(db: DB, spikePath: string | null, seeds: readonly SeedFile[]): number {
  const spikeDone = !spikePath || !!db.prepare("SELECT 1 FROM meta WHERE key = 'spike_ledger_imported'").get();
  let spike: LedgerEntry[] = [];
  if (!spikeDone) {
    const f = JSON.parse(readFileSync(spikePath!, "utf8")) as { entries: LedgerEntry[] };
    const errs = validateLedgerFile(f);
    if (errs.length) throw new Error(`spike ledger import refused: ${spikePath} failed validation: ${errs.slice(0, 5).join("; ")}`);
    spike = f.entries;
  }
  const todo = seeds.filter((s) => {
    const errs = validateSeed(s);
    if (errs.length) throw new Error(`ledger seed import refused: ${errs.slice(0, 5).join("; ")}`);
    return !db.prepare("SELECT 1 FROM meta WHERE key = ?").get(`seed_imported:${s.name}`);
  });
  if (spikeDone && todo.length === 0) return 0;
  return tx(db, () => {
    let n = 0;
    if (!spikeDone) {
      n += insertSpikeRows(db, spike);
      db.prepare("INSERT INTO meta (key, value) VALUES ('spike_ledger_imported', ?)").run(JSON.stringify({ rows: spike.length, at: new Date().toISOString() }));
    }
    for (const s of todo) {
      n += insertSeedRows(db, s);
      db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(`seed_imported:${s.name}`, JSON.stringify({ rows: s.entries.length, at: new Date().toISOString() }));
    }
    return n;
  });
}

function insertSpikeRows(db: DB, entries: LedgerEntry[]): number {
  const ins = db.prepare(`INSERT INTO spend_ledger (id, created_at, month_ny, provider, model, kind, resolution, quality, generation_id, attempt,
    estimate_micro_usd, estimate_source, status, actual_micro_usd, cost_source, cost_detail, http_status, outcome, settled_at, note, imported_from)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const e of entries) {
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
  return entries.length;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NY_TIME_RE = /^(\d{4}-\d{2})-\d{2}T\d{2}:\d{2}:\d{2}-0[45]:00$/;

/** Every seed row must be a billed, settled provider call whose amount equals its ticks (1 tick = 1e-10 USD). */
export function validateSeed(s: SeedFile): string[] {
  const errs: string[] = [];
  if (!s || typeof s.name !== "string" || !/^[a-z0-9-]+$/.test(s.name)) return ["seed name missing or not [a-z0-9-]"];
  if (typeof s.source_log !== "string" || s.source_log.startsWith("/") || s.source_log.includes("..")) errs.push(`${s.name}: source_log must be a relative path`);
  if (!Array.isArray(s.entries) || s.entries.length === 0) return [...errs, `${s.name}: no entries`];
  for (const e of s.entries) {
    const at = `${s.name}/${e?.id}`;
    if (!UUID_RE.test(e.id)) errs.push(`${at}: id is not a UUID`);
    const m = NY_TIME_RE.exec(e.created_at);
    if (!m || m[1] !== e.month_ny) errs.push(`${at}: created_at must be New York time in month_ny`);
    if (e.provider !== "xai" && e.provider !== "google") errs.push(`${at}: unknown provider`);
    if (e.status !== "settled" || e.cost_source !== "billed_provider") errs.push(`${at}: a seed row must be settled from a provider bill`);
    if (!Number.isSafeInteger(e.billed_ticks) || e.billed_ticks < 0 || e.billed_ticks % 10_000 !== 0 || e.billed_ticks / 10_000 !== e.actual_micro_usd) errs.push(`${at}: actual_micro_usd must equal billed_ticks / 10000`);
    if (!Number.isSafeInteger(e.estimate_micro_usd) || e.estimate_micro_usd <= 0) errs.push(`${at}: estimate must be a positive whole micro-USD`);
    if (typeof e.provider_request_id !== "string" || !e.provider_request_id) errs.push(`${at}: provider_request_id missing`);
  }
  return errs;
}

function insertSeedRows(db: DB, s: SeedFile): number {
  const ins = db.prepare(`INSERT INTO spend_ledger (id, created_at, month_ny, provider, model, kind, resolution, quality, generation_id, attempt,
    estimate_micro_usd, estimate_source, status, actual_micro_usd, cost_source, cost_detail, provider_request_id, provider_trace, http_status, outcome, settled_at, note, imported_from)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const e of s.entries) {
    ins.run(e.id, e.created_at, e.month_ny, e.provider, e.model, e.kind, e.resolution, e.quality, e.generation_id, e.attempt,
      e.estimate_micro_usd, e.estimate_source, e.status, e.actual_micro_usd, e.cost_source,
      JSON.stringify({ basis: e.cost_basis, ticks: e.billed_ticks, seed: `src/server/seed/${s.name}.json` }),
      e.provider_request_id, e.provider_trace ? JSON.stringify(e.provider_trace) : null, e.http_status, e.outcome, e.settled_at,
      `seeded from ${s.source_log} (not in the repo)`, s.source_log);
  }
  return s.entries.length;
}
