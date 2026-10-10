# MADVentures Red Social Room

Act 0 spike (see `spike-results/REPORT.md`), the A1 app, the A2 additions, the A3 edits/lineage additions, the A4 editor, the A5 captions, the A6 export and the A7 library/backup work (below). Plan: `docs/plan/TECH-PLAN-v1.md`, amended by `docs/plan/TECH-PLAN-v1-AMENDMENT-1.md` (the amendment wins where they differ). Founder decisions: `docs/plan/FOUNDER-DECISIONS.md`. Model research: `docs/plan/RESEARCH-models.md`.

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
                       # scan rules, Gemini cost rule, paid scripts against a fake transport) plus the A1/A2 app unit tests (fake xAI
                       # and Google, the real-socket mock provider server under test/mock/, dummy keys, nothing sent).
                       # npm run test:e2e builds and starts the app against local fakes for xAI and Google.
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
- Data (`RSR_DATA_DIR`, default `./data`, `/data` in Docker): `db/rsr.sqlite` (WAL, FTS5), `images/<aa>/<sha256>.<ext>`, `secrets/xai_api_key` and `secrets/gemini_api_key` (mode 600, only if saved from Settings). On first start the 10 spike rows from `spike-results/ledger.json` and the one billed A1 live smoke call (`src/server/seed/a1-live-smoke.json`, $0.04, xAI request `cb478eea-cf55-96df-bc20-38346f7f013b`) are imported into the spend ledger in one transaction, so October starts at $0.5947 counted.

One server per data directory, on one host (A1 pin 18, line 369 of Amendment 1 at `5c773d7`). Two containers or two hosts sharing one data directory are **not supported**.

- **The startup lock.** At start the server holds an exclusive SQLite lock on `<data>/rsr.lock` for as long as it runs. The operating system drops it when the process ends for any reason (normal exit, crash, `kill -9`), so a leftover lock never blocks the next start and there is nothing to delete by hand. A second server on the same host and data directory waits about a second, then exits 1 with `refusing to start: Another Red Social Room server (pid N) is already using the data directory ...`. `<data>/rsr.lock.pid` only names the holder for that message; nothing decides on it, and a stale one is harmless.
- **A data directory that is not writable** (A1 pin 19 (d), line 370 of Amendment 1 at `9a890fb`). At start, the lock cannot be taken there, so the server exits 1 with `refusing to start: The data directory is not writable: <dir> (cannot create or write <dir>/rsr.lock) ...` (never the "another server" message, and no raw SQLite text); the same applies if `db/` or `images/` is not writable. If the directory or the database stops being writable while the server runs, it keeps running, and every image request answers 500 `The data directory is not writable, so nothing was sent to the provider and nothing was charged.` before any provider call. This check covers the data directory, `db/`, the database files, `images/` and every existing `images/<xx>/` folder (an image's folder is named after its hash, which is only known once xAI has answered, so all of them are checked). Saving a key, the cap or a Library post on a data directory that is not writable answers 500 `The data directory is not writable, so nothing was saved.` Make it writable again and the next request goes through. A read-only `rsr.lock` counts as not writable: SQLite would open it read-only and report an "exclusive" lock to every process at once, so the lock makes a real write (`PRAGMA user_version`) to prove it really holds it, and refuses to start if it cannot.
- **Interrupted and late calls.** At start, ledger rows still `reserved` from a server that stopped mid-call are listed as unresolved ("interrupted"). A call that finishes after its row left `reserved` is kept as a `late_result` event; the row stays unresolved (nothing settles automatically), and until it is reconciled the cap counts it at the larger of its estimate and the late bill, which Settings -> Unresolved shows next to the held amount.

### A2: Google (Nano Banana 2), creator cards, the run queue and the reconcile screen

A2 (Amendment 1 section 4) adds: **Nano Banana 2** (`gemini-3.1-flash-image`) beside Grok; **creator cards** (tick one or both, 1-4 images each) that send one prompt to every chosen card; an in-process **job queue** with static per-provider concurrency (xAI 2, Google 2, `src/server/config.ts`); a **side-by-side grid** of tiles (each with model, time, cost, ref, Save to library, Retry) fed by server-sent events; **reconcile**: Settings -> Spend lists every `unresolved` row and settles it by hand ("not charged" / "charged $x"), and you can enter the **Google console total** for the month - when it is higher than the app's estimate, one adjustment row is added so the cap counts real spend (per-call rows are never rewritten); and the **mock provider server** (`test/mock/provider.ts`) that speaks both providers over real sockets with fault injection.

- Google rules: every request carries `store: false` and never a `previous_interaction_id` (D4); responses are stripped on arrival (id, status, usage token counts and the image only); a text-only 200 is a refusal ("Google returned no image" plus the provider's text verbatim); both documented error-body shapes are mapped; cost is always the token estimate (item 8) with `cost_source = estimated_tokens`; `config/prices.json` reserves $0.075 per Google call (the spike number; the spike's recorded usage prices at about $0.0685).
- Google key: paste it in Settings (saved server-side to `data/secrets/gemini_api_key`, mode 600) or set `GEMINI_API_KEY`. The free check is `GET /v1beta/models/gemini-3.1-flash-image`.
- The roster also carries **Nano Banana Pro** (`gemini-3-pro-image`) as its own card, unticked by default (FD:11). Its model id and price were confirmed against the live pricing page on 2026-10-09 ($120/1M image tokens = 1120 tokens per 1K/2K image, about $0.134). Pro calls settle from the same usage token counts at Pro rates (input $2/M, text/thinking $12/M, images $120/M); the cap reserves **$0.25** per Pro call - the published image price plus headroom for text/thinking tokens - and settles at the token estimate. Pro shares the one Google key and the one $50 cap.
- One more card state: after 3 consecutive 5xx results for one provider within 10 minutes the card shows "Provider having problems" until the next success (F5); a badge on the Settings link counts the unresolved rows (F21).

### A3: edits, your own images, and lineage

A3 (Amendment 1 section 4: "unchanged, plus F13 and the compare-edit check"; the own-image scope note added October 10, 2026) adds:

- **Edit by description**: on any tile or uploaded image, **Edit** sends an instruction with the source image to the model that made it (or any edit-capable card, via the dropdown). Every edit writes a **new child file** - the original and every earlier version are never touched. xAI edits go to `POST /v1/images/edits` with the image inline as a data URI; Google edits send `[text, image]` in `input` (single-turn, `store: false`), matching the recorded spike calls. xAI edits reserve and reconcile at the observed **$0.07** (no `quality` field is sent, A1 pin 2); Google edits settle from the same token estimate as their generations ($0.075 flash row; the Pro edit row is $0.25, cap-safe).
- **Compare edit**: tick "compare edit" to send the *identical instruction string* to two models side by side (item 28 - the plan's tool for "the two providers read the same edit instruction differently"); the cost is shown before running.
- **The version strip**: under the edit panel, the whole chain is shown (an upload is the root, each edit a child; a failed edit is a red entry with its error and no image, F13). Click any version to view it; the next edit starts from the selected version ("step back to any earlier version"); **Save this version to library** saves whichever one you pick. Nothing is ever overwritten.
- **Your own images (F14)**: **Bring your own image** accepts PNG/JPEG/WebP up to 20 MB and 8,000 px a side; the browser checks first and offers "Resize to 4096 px and continue?" for larger ones, and the server re-checks everything before storing. Uploading is free (no provider call, no ledger row) and lands in the same content-addressed store (`images/<aa>/<sha256>.<ext>` plus an `assets` row).
- **Use as reference**: take an uploaded or generated image into a *new* image - the image rides with your prompt in one single-turn call. Google takes it (`[text, image]` input; up to 14 reference images per the docs); **Grok takes no reference images**, so that button is disabled on the xAI card and the server refuses it with the reason - nothing is silently dropped.
- **Data**: `db/rsr.sqlite` gains `generations.parent_asset_id` / `mask_asset_id` and `jobs.kind` / `parent_asset_id` (older databases migrate at start); lineage is read back from those links only (`src/server/lineage.ts`, `GET /api/lineage?id=<sha>`). Mask painting and the local ComfyUI creator wait on A0b (the GPU spike), per the plan's "if the GPU is ready".

### A4: the deterministic editor

A4 (TECH-PLAN-v1.md :80, :96-97, :211) is the canvas editor - crop, rotate, four colour sliders, text layers and Brand-kit logos, all in the browser, with **no model and no cost**:

- **Open a design**: any Library image gets a **Design** link (`/design/<post>`). The editor renders from the post's *original* image plus its saved recipe, so nothing is ever re-done; "Save design" flattens the canvas to a PNG, uploads it through the normal F14 path, points the post at the render and stores the recipe (`posts.recipe`), keeping the untouched original as `posts.source_asset_id`.
- **Recipe, not a destructive edit**: the recipe (`src/lib/recipe.ts`) is a small JSON document - crop box, rotation, slider values, text and logo layers - in relative coordinates, so the same recipe is valid at any resolution (a 4:5 crop stays 4:5; a headline stays where it was placed).
- **What you can do**: crop with 1:1 / 4:5 / 16:9 / 9:16 presets or free-drag (Reset crop removes it); rotate in 90° steps; brightness / contrast / saturation / warmth sliders (-100…100, 0 = untouched); add text layers (fonts **Inter** and **Anton**, bundled locally from their OFL releases in `public/fonts/` with license texts - font, size, colour, stroke with its own colour, shadow) and drag them where you want; place Brand-kit logos, drag to move, corner handles to scale.
- **Brand kit**: upload PNG/JPEG/WebP/SVG logos (up to 50, raster to the usual F14 limits, SVG to 1 MB). SVG is allowed *only* here - a logo is drawn on your canvas and never sent to a model. SVGs carrying scripts, event handlers, `<foreignObject>` or `javascript:` links are refused with the reason, and stored SVGs are served under `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox` (`/api/assets/`, so opening the URL directly runs nothing). Removing a logo takes it out of the kit; the file stays in the content-addressed store.
- **Reopen and change one thing**: the acceptance path - add a logo and headline, crop, adjust warmth, save, reopen, change the headline without redoing the rest - is covered over HTTP (the crop, the slider and the logo all stay).
- The flatten step caps the output's longest side at 2,048 px (`FLATTEN_MAX_SIDE`), so even an 8,000 px upload never makes a giant PNG. Mask painting and the local ComfyUI creator still wait on A0b.

### A5: captions

A5 (TECH-PLAN-v1.md :214-216, section 6) writes captions from the final image with **no image model involved**:

- **One click, four platforms**: every Library image gets a **Captions** link (`/captions/<post>`). Tick platforms (Instagram, X, LinkedIn, Facebook, TikTok, Pinterest, YouTube), pick a tone, add notes — one call returns **two caption options, hashtags and alt text per platform**, with live counters against each platform's real limit (`config/platforms.json`, section 6). **Anything over its limit is flagged red, never silently cut**; the chosen option is edited inline and saved per platform.
- **Model**: Gemini 3.1 Flash-Lite (paid tier, $0.25/$1.50 per 1M tokens) on the same Google key, the same `/v1beta/interactions` endpoint, single-turn, `store: false`, with structured JSON output (`response_format: {type:"text", mime_type:"application/json", schema}`). Cost settles from the API's token usage like every Google call; the reservation is $0.005 and the cap check runs per attempt before anything is sent. A caption call costs well under a cent.
- **Tones** (`config/tones.json`): MAD Ventures confident / casual / educational / playful. **Brand voice**: write it once on the captions page; it rides with every call.
- **Suggested tags**: come back with the captions; only the ones you tick are added. Captions and tags are searchable in the Library (the FTS index covers prompt, notes, model, captions and tags; older databases rebuild automatically at start).
- **Failure behavior**: the same real-person check runs on the free text before anything is sent (a block sends nothing, records no money); an unreadable reply is reported plainly, still billed, and never retried automatically (a chosen default — press the button again for a new call); rate limits follow the same bounded rule as the image calls.

### A6: platform sizing + export

A6 (TECH-PLAN-v1.md :218-220, sections 5-6; amendment items 9, 10, 24) turns one finished image into per-platform files:

- **Every Library image gets an Export link** (`/export/<post>`). Tick placements from the presets JSON (`config/sizes.json` — thirteen entries: Instagram square/portrait/Story, X, LinkedIn square/landscape/vertical, Facebook square/portrait/Story, TikTok, Pinterest, YouTube, each with exact pixels, ratio, quality, the YouTube 2 MB limit and the Story safe zone) and "Make renditions".
- **The exact-size step (item 24)**: every rendition and export is `sharp resize(w, h, {fit:"cover", position: attention})` to the preset's exact pixels — 928×1152 becomes exactly 1080×1350; 1376×768 becomes exactly 1280×720; the YouTube file stays under 2 MB. Original files are never altered (hash-checked in the tests). When the source ratio is more than 1% off the asked one, the tile shows "asked 9:16, got 928×1152 = 0.806" in grey.
- **Smart crop, then drag**: attention picks the subject; "Adjust crop" drags an aspect-locked frame and re-renders the same exact pixels. A rendition made from a smaller source says "Upscaled from N px wide" (item 10 / P5 default A).
- **Safe zone**: the Instagram Story preview draws the 1080×1610 safe-zone box.
- **AI extend (Nano Banana 2)** (D3, item 9): when a crop would cut the subject, one paid Google edit widens to the platform's ratio (`response_format.aspect_ratio` + the image inline), stored with method `ai_extend` and put through the same exact-size step. Grok is never used for widening. A refusal shows Google's real text; the fallback slot follows the `outpaintFallback` switch (**P3 ruled B on 2026-10-10, FD:12 — "No fallback on this computer yet. Crop instead?"; local ComfyUI arrives with A0b**).
- **Download ZIP**: one image per ticked platform plus a `captions.txt` built from the saved captions (hashtags and alt included; platforms without a caption say so). Missing renditions stop the export with the platform named.

### A7: Library polish, backup, and the success test

A7 (TECH-PLAN-v1.md :222-224; amendment F17/F23 and FD:6) adds:

- **Tag filters** on the Library: a row of tag chips (with counts) beside the search box; cards show their tags, and `?tag=` combines with the search word.
- **Reuse** on every card: opens the create box with that post's prompt and model already filled in (`/?reuse=<post>`).
- **Recent prompts and snippets** (T:76): the last five prompts appear as chips under the prompt box; **Save as snippet** stores the current prompt and every snippet can be inserted with one click or removed with its × .
- **Delete** (housekeeping): removes a post's rows — its captions, tags and renditions — while every image file stays on disk, because other posts may share them.
- **Nightly backup to Cloudflare R2** (FD:6): the app itself runs the job once a night, in the first tick at/after 3 AM New York (no cron, no external timer; `RSR_DISABLE_SCHEDULER=1` turns it off). A run snapshots the database (`VACUUM INTO`), uploads only image files that have not been uploaded before (the store is content-addressed, so a file never changes under its name), and writes a manifest (`rsr/manifest.json`) that lists everything a restore needs. **Back up now** runs the same job on demand. Settings shows the last good backup and turns a red banner when there is none or it is older than 48 hours (F23). The target — endpoint, bucket, access key id, secret — lives in Settings → Backup; the two keys are stored as mode-600 files, exactly like the provider keys, and only the key's last 4 shown back.
- **The restore drill**: `node scripts/restore-drill.mjs` pulls the newest backup into a clean folder (or `--from-dir <tree>` from a local copy), verifies the database's sha256, every file byte-for-byte against the hash in its name, and the restored row counts, then prints PASS/FAIL. This is the plan's acceptance: a restore from backup onto a clean folder brings the library back.
- **Search index (F17)**: the scheduler checks the index against the posts table once a day and rebuilds it automatically if they differ (logged to Maintenance); Settings has **Check** and **Rebuild** buttons for peace of mind.
- **The success test**: the plan's real acceptance is a full week of posts (7) without opening another app. It starts once this act is deployed — it is Michael's week, not a test the machine can run for him.

One manual step stays in Settings → Spend: entering the Google console total for the month (the A0 close-out item 21 reconcile).

### Run it locally (no Docker)

```
export PATH=/home/box/node22/bin:$PATH   # Node >= 22.18
npm ci
npm run build && npm start               # http://127.0.0.1:3000 (binds 127.0.0.1 only, not the LAN); keys from XAI_API_KEY / GEMINI_API_KEY or Settings
npm test                                 # spike + app unit tests (no network, dummy keys)
npm run test:e2e                         # next build + next start against a local fake xAI; key-leak scan
```

### Run it with Docker Compose + Tailscale Serve (verified on the build box, October 9, 2026)

```
cp .env.example .env && chmod 600 .env   # put XAI_API_KEY=... and/or GEMINI_API_KEY=... in it, or paste keys in Settings
mkdir -p data                            # on Linux, if the container can't write it: sudo chown 1000:1000 data
docker compose up -d --build             # listens on 127.0.0.1:3000 only
tailscale serve --bg --https=443 http://127.0.0.1:3000
tailscale serve status                   # shows https://<machine>.<tailnet>.ts.net/
```

This runbook carried A1's acceptance on the Z890 box on October 9, 2026 (image built, container healthy on `127.0.0.1:3000`, `tailscale serve` live, and the phone test passed: make an image, save it, find it by a prompt word, no key in browser traffic). Open the `https://<machine>.<tailnet>.ts.net/` URL on the phone (signed in to the same tailnet). To stop sharing: `tailscale serve --https=443 off`. The app has no login of its own; Tailscale is the only way in. `npm start` binds 127.0.0.1, and the compose file publishes the port on 127.0.0.1 only (inside the container the app listens on 0.0.0.0, `npm run start:container` / the Dockerfile `CMD`), so neither is reachable from the LAN. Tailscale Serve proxies to 127.0.0.1, so that is enough for it.

### Allowed hosts (A1 pin 17, Amendment 1 line 368)

Every page, API route and asset first checks the `Host` header (DNS-rebinding guard). The host name is compared without its port and case-insensitively. Allowed by default: `localhost`, `127.0.0.1`, `[::1]`. Add more with `RSR_ALLOWED_HOSTS` (comma-separated, spaces trimmed), read when the server starts handling requests (no rebuild needed), e.g. in `.env`:

```
RSR_ALLOWED_HOSTS=<machine>.<tailnet>.ts.net
```

An empty or unlisted `Host` gets `403 {"error":"Host not allowed."}` and nothing runs; a request with no `Host` line at all gets Node's own `400` before the app runs (the pin allows either). `X-Forwarded-Host` is ignored. Which `Host` `tailscale serve` passes through is UNVERIFIED (pin 17): if the phone gets that 403, add the `ts.net` name above and restart.
