# MADVentures Red Social Room

Act 0 spike only (see `spike-results/REPORT.md`). Plan: `madc-rulings/docs-drafts/red-social-room/TECH-PLAN-v1.md`.

## Requirements

- **Node >= 22.18** (runs `.ts` directly via type stripping). On the box the default `node` is v20, which cannot run these scripts, so first:
  `export PATH=/home/box/node22/bin:$PATH` (Node 22.19). Every npm script starts with `spike/check-node.mjs`, which fails with this hint on an older Node.
- No runtime dependencies. Dev only: `typescript` and `@types/node` (pinned in `package.json` / `package-lock.json`), installed with `npm ci`.
- Paid scripts need `XAI_API_KEY` / `GEMINI_API_KEY` in the environment. Tests, typecheck and the leak scan's pattern rules need no keys and make no network calls.

## Offline (no network, no spend)

```
npm ci                 # dev deps for the typecheck
npm run typecheck      # tsc -p tsconfig.json (strict, noEmit)
npm test               # node --test "spike/test/*.test.ts": spend guard, ledger validation, step outputs, scan rules, Gemini cost rule,
                       # and the paid scripts run against a fake transport (spike/test/fixtures/fetch-stub.mjs, dummy keys, nothing sent)
npm run check-secrets  # leak scan: pattern rules always; exact key match too if the keys are in env (prints counts only)
npm run ledger         # spend ledger view (shared $50/month cap, $3 spike cap)
```

## Paid / live (each goes through the spend guard in `spike/lib/ledger.ts` first)

```
node spike/preflight.ts        # free: key + model-id check, no images
node spike/xai.ts              # paid (~$0.18): generate 3:4, edit, aspect edit
node spike/gemini.ts           # paid (~$0.27 est.), gated by a free preflight; every call sends store=false
node spike/delete-interactions.ts  # one-off, DONE 2026-10-03 22:33 ET; refuses to re-send unless FORCE_REDELETE=1
```

**Opt-in probes (off by default).** These steps are skipped unless the variable is exactly `1`:

| Variable | Step | Why it is off |
|---|---|---|
| `RUN_REFUSAL_PROBE=1` | `xai.ts` step 04 and `gemini.ts` step 05: the photoreal "named real person" refusal probe (`spike/prompts.ts` `refusal`). **One flag enables it for BOTH providers** (whichever script you run with it set); there is no second confirmation. | Founder decision 7 forbids sending prompts for photoreal images of named real people. The 2026-10-03 results are already recorded (`spike-results/xai/04-refusal-probe.json`, `spike-results/gemini/05-refusal-probe.json`). |
| `RUN_XAI_4X5_PROBE=1` | `xai.ts` step 01: generate at 4:5, then fall back once to 3:4 | xAI rejects 4:5 with HTTP 422 (`spike-results/xai/01-generate-4x5.json`); the Founder decided to generate 3:4 and crop. By default the script goes straight to 3:4. (Replaces the old `SKIP_4X5_PROBE`.) |

## Spend ledger

- `spike-results/ledger.json` is never created implicitly: a missing ledger fails closed. Create a new one only with `npm run ledger:init` (refuses if one exists).
- Resolve a held reservation after checking the provider console, instead of hand-editing the file:
  `node spike/ledger-reconcile.ts <entry-id or 8+ char prefix> <usd|not-charged> "<what you checked>"`
  (e.g. the xAI 422 row: `node spike/ledger-reconcile.ts beb67d2b not-charged "console.x.ai shows no charge for 22:09:17 ET"`).
- Don't run two paid scripts at once: `reserve()` refuses while the ledger is locked; `settle()` waits up to ~5 s and, if still locked, writes the step's outputs and results.json entry and then stops with `LedgerBusy` (the reservation stays counted).
- **Stale lock** (a crashed run leaves `spike-results/ledger.lock`; there is no TTL): if no spike script is running, delete `spike-results/ledger.lock`, then run `ledger-reconcile` for any row the LedgerBusy message named. `ledger-reconcile` needs the same lock, so it fails until the stale lock is gone.
- Every load validates every ledger row (amounts present, non-negative, whole micro-USD; known status/provider; `YYYY-MM` month; `spike: true`). A bad row stops everything with `LedgerCorrupt`; restore the file from git rather than editing it by hand.
