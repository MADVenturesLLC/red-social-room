# MADVentures Red Social Room

Act 0 spike (see `spike-results/REPORT.md`) and the A1 app (below). Plan: `docs/plan/TECH-PLAN-v1.md`, amended by `docs/plan/TECH-PLAN-v1-AMENDMENT-1.md` (the amendment wins where they differ). Founder decisions: `docs/plan/FOUNDER-DECISIONS.md`. Model research: `docs/plan/RESEARCH-models.md`.

## Requirements

- **Node >= 22.18** (runs `.ts` directly via type stripping). On the box the default `node` is v20, which cannot run these scripts, so first:
  `export PATH=/home/box/node22/bin:$PATH` (Node 22.19). Every npm script starts with `spike/check-node.mjs`, which fails with this hint on an older Node.
- Runtime dependencies (A1 app): `next`, `react`, `react-dom`, `sharp`. Dev: `typescript`, `@types/node`, `@types/react`, `@types/react-dom`. All pinned in `package.json` / `package-lock.json` and installed with `npm ci`. The spike scripts themselves use only Node built-ins.
- Paid scripts need `XAI_API_KEY` / `GEMINI_API_KEY` in the environment. Tests, typecheck and the leak scan's pattern rules need no keys and make no network calls.

## Offline (no network, no spend)

```
npm ci                 # dev deps for the typecheck
npm run typecheck      # tsc -p tsconfig.json (strict, noEmit)
npm test               # node --test "spike/test/*.test.ts" "test/*.test.ts": the spike tests (spend guard, ledger validation, step outputs,
                       # scan rules, Gemini cost rule, paid scripts against a fake transport) plus the A1 app unit tests (fake xAI,
                       # dummy keys, nothing sent). npm run test:e2e builds and starts the app against a local fake xAI.
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

Exit codes of `xai.ts` / `gemini.ts`: `0` finished (or stopped for a recorded reason such as a provider error or no image); `1` aborted on an error (e.g. `LedgerBusy`, `LedgerCorrupt`); `3` a step was refused by the spend guard (cap reached or ledger locked; that step and the rest were not sent).

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

## A1 app (Next.js + SQLite + Grok)

TECH-PLAN-v1.md section 9 A1, as amended by Amendment 1 section 4: prompt -> Grok image -> Save to library -> search by prompt text, with the spend guard (one shared monthly cap, default $50), the real-person name-list check, and keys kept on the server.

- Code: `src/server/` (DB, ledger, key store, prompt check, xAI adapter), `src/app/` (pages and API routes). Reuses `spike/lib/xai-shape.ts` (cost rule), `spike/lib/ledger.ts` (micro-USD rounding, New York month), `spike/lib/image.ts`.
- Config (no code change needed): `config/switches.json` (pending Founder decisions P1/P4/P5/P6/P7; a value A1 doesn't build stops startup), `config/prices.json` (pre-call estimates), `config/real-person-names.txt` (one name per line; an empty or missing list blocks every prompt).
- Data (`RSR_DATA_DIR`, default `./data`, `/data` in Docker): `db/rsr.sqlite` (WAL, FTS5), `images/<aa>/<sha256>.<ext>`, `secrets/xai_api_key` (mode 600, only if saved from Settings). On first start the 10 spike rows from `spike-results/ledger.json` and the one billed A1 live smoke call (`src/server/seed/a1-live-smoke.json`, $0.04, xAI request `cb478eea-cf55-96df-bc20-38346f7f013b`) are imported into the spend ledger in one transaction, so October starts at $0.5947 counted.

### Run it locally (no Docker)

```
export PATH=/home/box/node22/bin:$PATH   # Node >= 22.18
npm ci
npm run build && npm start               # http://127.0.0.1:3000 (binds 127.0.0.1 only, not the LAN); key from XAI_API_KEY or Settings
npm test                                 # spike + app unit tests (no network, dummy keys)
npm run test:e2e                         # next build + next start against a local fake xAI; key-leak scan
```

### Run it with Docker Compose + Tailscale Serve (untested on the build box: no Docker or Tailscale there)

```
cp .env.example .env && chmod 600 .env   # put XAI_API_KEY=... in it, or leave it empty and use Settings
mkdir -p data                            # on Linux, if the container can't write it: sudo chown 1000:1000 data
docker compose up -d --build             # listens on 127.0.0.1:3000 only
tailscale serve --bg --https=443 http://127.0.0.1:3000
tailscale serve status                   # shows https://<machine>.<tailnet>.ts.net/
```

Open the `https://<machine>.<tailnet>.ts.net/` URL on the phone (signed in to the same tailnet). To stop sharing: `tailscale serve --https=443 off`. The app has no login of its own; Tailscale is the only way in. `npm start` binds 127.0.0.1, and the compose file publishes the port on 127.0.0.1 only (inside the container the app listens on 0.0.0.0, `npm run start:container` / the Dockerfile `CMD`), so neither is reachable from the LAN. Tailscale Serve proxies to 127.0.0.1, so that is enough for it.

### Allowed hosts (A1 pin 17, Amendment 1 line 368)

Every page, API route and asset first checks the `Host` header (DNS-rebinding guard). The host name is compared without its port and case-insensitively. Allowed by default: `localhost`, `127.0.0.1`, `[::1]`. Add more with `RSR_ALLOWED_HOSTS` (comma-separated, spaces trimmed), read when the server starts handling requests (no rebuild needed), e.g. in `.env`:

```
RSR_ALLOWED_HOSTS=<machine>.<tailnet>.ts.net
```

A missing, empty or unlisted `Host` gets `403 {"error":"Host not allowed."}` and nothing runs. `X-Forwarded-Host` is ignored. Which `Host` `tailscale serve` passes through is UNVERIFIED (pin 17): if the phone gets that 403, add the `ts.net` name above and restart.
