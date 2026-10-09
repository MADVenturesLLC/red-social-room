// Pre-call estimates from config/prices.json (Amendment 1 item 2b), reservation = max(price row,
// highest settled bill for the same key) (item 2d).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toMicros } from "../../spike/lib/ledger.ts";
import { REPO_ROOT } from "./config.ts";
import { highestBillMicros } from "./ledger.ts";
import type { DB } from "./db.ts";

export interface PriceRow { provider: string; model: string; kind: string; resolution: string; quality: string | null; usd: number; source: string; read_on: string }
export interface PriceKey { provider: string; model: string; kind: string; resolution: string; quality: string | null }

export function loadPrices(path = join(REPO_ROOT, "config", "prices.json")): readonly PriceRow[] {
  const f = JSON.parse(readFileSync(/*turbopackIgnore: true*/ path, "utf8")) as { version?: unknown; rows?: unknown };
  if (f.version !== 1 || !Array.isArray(f.rows)) throw new Error(`${path}: expected { version: 1, rows: [...] }`);
  const rows = f.rows.map((r: PriceRow, i: number) => {
    if (typeof r.usd !== "number" || !Number.isFinite(r.usd) || r.usd <= 0) throw new Error(`${path}: row ${i} usd must be a positive number`);
    for (const k of ["provider", "model", "kind", "resolution", "source", "read_on"] as const) if (typeof r[k] !== "string" || !r[k]) throw new Error(`${path}: row ${i} ${k} missing`);
    return Object.freeze({ ...r });
  });
  return Object.freeze(rows);
}

export function estimate(db: DB, prices: readonly PriceRow[], k: PriceKey): { micros: number; source: string } {
  const row = prices.find((r) => r.provider === k.provider && r.model === k.model && r.kind === k.kind && r.resolution === k.resolution && (r.quality ?? null) === k.quality);
  if (!row) throw new Error(`No price row for ${k.provider}/${k.model}/${k.kind}/${k.resolution}/${k.quality}; refusing to send an unpriced call.`);
  const table = toMicros(row.usd);
  const billed = highestBillMicros(db, k);
  return billed > table
    ? { micros: billed, source: `highest bill in ledger for ${k.provider}/${k.model}/${k.kind}/${k.resolution}/${k.quality} (above prices.json ${row.usd})` }
    : { micros: table, source: `prices.json ${k.provider}/${k.model}/${k.kind}/${k.resolution}/${k.quality} $${row.usd} (read ${row.read_on})` };
}
