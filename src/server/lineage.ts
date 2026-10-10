// A3: the version chain for one asset (TECH-PLAN-v1.md §4 step 4 / §9 A3). Every edit writes a new child;
// lineage is read back from generations.parent_asset_id. The chain starts at the root (an uploaded image,
// or the first generation in the run), then lists every descendant in creation order — including failed
// edit attempts, which have no output asset but stay visible with their error (F13).
import { generationCostText } from "./ledger.ts";
import type { DB } from "./db.ts";

export type LineageKind = "source" | "generate" | "edit" | "reference";
export type LineageStatus = "source" | "ok" | "refused" | "error" | "blocked" | "not_sent";

export interface LineageNode {
  generationId: string | null;
  /** null for a failed attempt: nothing was stored for it. */
  assetId: string | null;
  kind: LineageKind;
  status: LineageStatus;
  parentAssetId: string | null;
  instruction: string | null;
  model: string | null;
  provider: string | null;
  createdAt: string | null;
  costText: string | null;
  /** A3/F13: a failed edit's error, shown on its strip entry (no image). */
  error: string | null;
}

interface GenRow {
  id: string; kind: string; status: string; prompt: string; provider: string; model: string;
  created_at: string; parent_asset_id: string | null; output_asset_id: string | null; display_asset_id: string | null;
  error_message: string | null; rid: number;
}

const GENS = "SELECT id, kind, status, prompt, provider, model, created_at, parent_asset_id, output_asset_id, display_asset_id, error_message, rowid AS rid FROM generations";

function genForAsset(db: DB, assetId: string): GenRow | undefined {
  return db.prepare(`${GENS} WHERE (output_asset_id = ? OR display_asset_id = ?) AND status = 'ok' ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(assetId, assetId) as unknown as GenRow | undefined;
}

function kindOf(g: GenRow): LineageKind {
  if (g.kind === "edit") return "edit";
  return g.parent_asset_id ? "reference" : "generate";
}

function nodeOf(db: DB, g: GenRow, assetId: string | null): LineageNode {
  return {
    generationId: g.id,
    assetId,
    kind: kindOf(g),
    status: g.status as LineageStatus,
    parentAssetId: g.parent_asset_id,
    instruction: g.prompt,
    model: g.model,
    provider: g.provider,
    createdAt: g.created_at,
    costText: generationCostText(db, g.id),
    error: g.error_message ?? null,
  };
}

/**
 * The whole chain that contains `assetId`: walk up to the root, then walk every descendant down.
 * Returns null when the asset is not in the store.
 */
export function lineageFor(db: DB, assetId: string): { rootAssetId: string; nodes: LineageNode[] } | null {
  const asset = db.prepare("SELECT id FROM assets WHERE id = ?").get(assetId) as { id: string } | undefined;
  if (!asset) return null;

  // Up to the root: keep following parent links while the current asset was produced by a generation.
  let root = assetId;
  const seenUp = new Set<string>();
  while (!seenUp.has(root)) {
    seenUp.add(root);
    const g = genForAsset(db, root);
    if (!g || !g.parent_asset_id) break;
    root = g.parent_asset_id;
  }

  const nodes: LineageNode[] = [];
  const rootGen = genForAsset(db, root);
  nodes.push(rootGen
    ? nodeOf(db, rootGen, root)
    : { generationId: null, assetId: root, kind: "source", status: "source", parentAssetId: null, instruction: null, model: null, provider: null, createdAt: null, costText: null, error: null });

  // Every descendant, walked for cycles but listed in creation order (time, then rowid). A failed
  // attempt has no output, so nothing descends from it.
  const seen = new Set<string>([root]);
  const descendants: GenRow[] = [];
  const frontier: string[] = [root];
  while (frontier.length) {
    const cur = frontier.shift()!;
    const kids = db.prepare(`${GENS} WHERE parent_asset_id = ? ORDER BY created_at, rowid`).all(cur) as unknown as GenRow[];
    for (const k of kids) {
      descendants.push(k);
      const out = k.output_asset_id;
      if (out && !seen.has(out)) { seen.add(out); frontier.push(out); }
    }
  }
  descendants.sort((a, b) => (a.created_at === b.created_at ? a.rid - b.rid : (a.created_at < b.created_at ? -1 : 1)));
  for (const k of descendants) nodes.push(nodeOf(db, k, k.output_asset_id ?? k.display_asset_id));
  return { rootAssetId: root, nodes };
}
