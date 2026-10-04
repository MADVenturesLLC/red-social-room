# MADVentures Red Social Room — Technical Plan v1

For: Michael Daley (MAD Ventures)
From: Surface Architect
Date: Saturday, October 3, 2026, ~8:15 PM ET
Status: Draft for Michael's review. Plan only; no code, repos, or accounts created.
Sources: every price and spec here is cited in `RESEARCH-models.md` (same folder). Items marked UNVERIFIED could not be confirmed on an official page.

---

## 1. Summary

- **Riskiest assumption: it does not hold as written.** None of the consumer subscriptions (SuperGrok / X Premium, Google AI Pro, ChatGPT Plus, Claude Pro) give API access. Each provider bills its API separately, per image, with its own key. Automating the consumer websites instead is against each provider's terms and risks the accounts. So the app uses API keys that Michael owns and pays for directly. No middleman is paid, which keeps the spirit of the brief.
- **Per-image prices (1K images, Oct 3, 2026):** Grok Imagine 2.0 $0.04 to generate, about $0.07 to edit. Google Nano Banana 2 (`gemini-3.1-flash-image`) $0.067. OpenAI GPT Image 2: $0.006 low / $0.053 medium / $0.211 high. Local models on the RTX 5060 Ti: $0 per image (electricity only).
- **Recommended first roster:** 2 cloud + 1 local: Grok Imagine 2.0, Nano Banana 2, and a local slot on the Buildroom GPU running FLUX.2 [klein] 4B (generate + edit) and Qwen-Image-Edit-2511 (edit + mask). Both local models are Apache 2.0, so the output is safe to monetize later.
- **Stack:** one Next.js (TypeScript) app on the Buildroom Linux box in Docker, reachable only over Tailscale. SQLite with full-text search for the library, image files on local disk, nightly backup off the box. API keys stay on the server.
- **Cost:** about $20 a month for a 30-post month (assumptions in section 8). Hard cap (Founder decision, 2026-10-03): one shared $50 a month across all cloud providers, enforced by the app before every call.
- **First step (Act 0):** small scripts that generate and edit one image with each chosen provider using Michael's own keys, and record the real cost, time, and failure behavior.

## 2. Model roster v1

| Provider | Model | Generate | Edit by description | Mask / inpaint | Price per image | Access needed | Source |
|---|---|---|---|---|---|---|---|
| xAI | `grok-imagine-image-2.0` | Yes | Yes | No (not documented) | Gen $0.04 (1K low) to $0.08 (2K medium); edit adds $0.01 input, defaults to medium: ~$0.07 at 1K | xAI Console API key + prepaid credits | https://docs.x.ai/developers/pricing |
| xAI | `grok-imagine-image` (base) | Yes | Yes | No | $0.02 + $0.002 per input image | same | https://docs.x.ai/developers/pricing |
| Google | `gemini-3.1-flash-image` (Nano Banana 2) | Yes | Yes (multi-turn) | No (not documented) | $0.045 (0.5K), $0.067 (1K), $0.101 (2K) | Gemini API key + Cloud Billing (no free tier for image models) | https://ai.google.dev/gemini-api/docs/pricing |
| Google | `gemini-3-pro-image` (Nano Banana Pro) | Yes | Yes | No | $0.134 (1K/2K), $0.24 (4K) | same | same |
| OpenAI | `gpt-image-2.5-sunburst` / `-flare`; `gpt-image-2` | Yes | Yes | **Yes** (alpha mask) | gpt-image-2 1024²: $0.006 / $0.053 / $0.211 (low/med/high). 2.5 per-image: UNVERIFIED | OpenAI Platform key + prepaid credits | https://developers.openai.com/api/docs/guides/image-generation |
| Anthropic | Claude (any) | **No** (cannot make raster images) | No | No | n/a (captions only, Haiku 4.5 $1/$5 per 1M tokens) | Anthropic API key | https://support.claude.com/en/articles/9002504-can-claude-produce-images |
| Black Forest Labs | FLUX.2 [pro] API | Yes | Yes | FLUX.1 Fill [pro] $0.05 | from $0.03 gen / $0.045 edit | BFL key + credits | https://docs.bfl.ml/quick_start/pricing |
| Local (ComfyUI) | FLUX.2 [klein] 4B | Yes | Yes | Via ComfyUI workflow | $0 | Buildroom GPU, ~13 GB VRAM, Apache 2.0 | https://huggingface.co/black-forest-labs/FLUX.2-klein-4B |
| Local (ComfyUI) | Qwen-Image-Edit-2511 (Q4_K_M GGUF, 13.2 GB) | No | Yes (strong) | Via ComfyUI workflow | $0 | Buildroom GPU, Apache 2.0 | https://localaimaster.com/blog/qwen-image-edit-local-guide |

Not recommended: Imagen through the Gemini API (listed as shut down), `gemini-2.5-flash-image` (shut down Oct 2, 2026), `grok-imagine-image-quality` (retirement notice for Nov 2, 2026), and FLUX [dev] models (non-commercial license; gray zone for content he plans to monetize).

**Recommended first roster (each shows as a "creator" card in the app):**
1. **Grok Imagine 2.0** (xAI). Cheapest good cloud option. Michael already likes Grok Imagine.
2. **Nano Banana 2** (Google). Strong text-in-image and multi-turn editing. Nano Banana Pro is on the roster as its own creator card (Founder decision 11, 2026-10-04). Nano Banana 2 is the default, and Pro costs about twice as much per image against the shared cap.
3. **Local studio** (Buildroom GPU). FLUX.2 klein 4B for free drafts; Qwen-Image-Edit for edits and painted-mask fixes. It comes online once the RTX 5060 Ti is installed. Until then, v1 works with the two cloud models.

OpenAI is the one cloud option with a documented mask parameter. Leave it out of v1 and add it only if local mask edits disappoint (Open decision 5).

## 3. Architecture

```
Browser (laptop / phone on Tailscale)
   │  HTTPS via `tailscale serve` (tailnet only)
   ▼
Next.js app (TypeScript, Node) ── Docker on Buildroom (Ubuntu 24.04)
   ├─ UI: prompt bar, roster, compare grid, editor canvas, library
   ├─ API routes (server only; holds API keys)
   ├─ Job runner (in-process, SQLite-backed queue)
   │    ├─ xAI adapter ──────────► api.x.ai
   │    ├─ Gemini adapter ───────► generativelanguage.googleapis.com
   │    ├─ ComfyUI adapter ──────► localhost:8188 (GPU queue, 1 at a time)
   │    └─ Caption adapter ──────► Gemini Flash-Lite (or Ollama later)
   ├─ Spend guard (one shared $50 monthly cap across all providers, checked before every call)
   ├─ SQLite (WAL) + FTS5 index  ── /data/db
   └─ Image files (content-addressed) ── /data/images
Nightly backup: db snapshot + new images → Cloudflare R2 (or a second disk)
```

Choices and short reasons:

- **Self-host on Buildroom, not Vercel or Render.** The local models, the image files, and the library all live on that box. One user does not need public hosting. Tailscale Serve gives HTTPS reachable only on his tailnet, so there is no public login page to defend. Vercel functions cap at 300–800 s and have no persistent disk (UNVERIFIED limits), and they can't reach ComfyUI without exposing it. A hosted copy can come later if he wants it.
- **Before the GPU box is ready:** the same Docker Compose file runs on any Linux or Mac machine with the two cloud models. Nothing in Acts 0–2 needs the GPU.
- **Next.js + TypeScript.** One codebase for UI and server, a mature canvas ecosystem, and it fits his GitHub/Vercel habits.
- **Provider adapter layer.** Every model sits behind one interface:
  - `capabilities()` → generate, edit, mask, max reference images, aspect ratios, resolutions, max input size
  - `estimateCost(request)` → USD, used by the spend guard
  - `generate({prompt, aspectRatio, resolution, n})`
  - `edit({image, instruction, mask?, aspectRatio?})`
  - Every call returns exactly one of: `ok` (images + actual cost + provider request id), `refused` (provider's reason, verbatim), or `error` (`timeout | rate_limit | quota | auth | unavailable | bad_input | gpu_oom`).
  Adding a model later means writing one adapter file and one price-table row.
- **Job queue.** A `jobs` table in SQLite plus an in-process worker. Each provider has its own concurrency limit (xAI 2, Gemini 2, ComfyUI 1). The UI subscribes to job updates (server-sent events). No Redis is needed for one user.
- **Storage.** Images are stored on disk under their SHA-256 hash, written to a temp file, fsynced, then renamed (atomic). Originals are never overwritten. SQLite in WAL mode holds all metadata.
- **Library search.** An SQLite FTS5 external-content index over prompt, captions, tags, model names, and notes, kept in sync by triggers, with a `rebuild` command for repair. Postgres is not needed at this scale and would add a service to run.
- **Data model (main tables):** `runs` (one prompt session), `generations` (provider, model, kind = generate | edit | outpaint, prompt or instruction, params, parent_asset_id, mask_asset_id, output_asset_id, status, error, cost_usd, request_id, timings), `assets` (hash, path, mime, width, height), `posts` (the saved library entry: final asset, prompt, notes), `renditions` (post, platform, asset, method = crop | outpaint), `captions` (post, platform, text, model), `tags` / `post_tags`, `spend_ledger` (provider, month, reserved_usd, actual_usd).
- **Secrets.** API keys go in an `.env` file on the box (mode 600) that Docker reads. They are used only inside server routes and never sent to the browser or written to logs. One key per provider, named "red-social-room", so it can be revoked without touching his other projects. The repo never contains keys, and `.env` is in `.gitignore`.
- **Deterministic editing in the browser.** Crop, rotate, brightness, contrast, saturation, warmth, text, and logo overlays happen on a client canvas (Konva). No model is involved, so these edits are free and exact. The app saves the edit "recipe" (JSON) alongside the flattened PNG so a change can be redone later. Fonts are bundled locally from open-license (OFL) fonts.

## 4. Feature design, step by step

**Step 1: Prompt.** A single prompt box with an aspect-ratio picker that defaults to the primary platform's ratio (for example 4:5 for Instagram). Generating at the right ratio from the start avoids crops later. Both cloud models accept an aspect ratio. Recent prompts and saved "prompt snippets" (style phrases he reuses) sit under the box.

**Step 2: Pick creators.** The roster shows each model as a creator card: name, what it is good at, price per image, and its status (ready / no key / cap reached / offline). He ticks one or more cards and picks how many images each makes (1–4). Before running, the app shows the total estimated cost, for example "4 images · est. $0.21".

**Step 3: Side-by-side compare.** Results land in one grid, a column per creator, as they finish. Each tile shows model, time, and cost. Actions on each tile: Keep (star), Discard, Edit, Use as reference, Regenerate. Discarded images stay in a run history for 30 days, then they are pruned. Kept images move on to editing.

**Step 4: Edit in place.**
- *Describe a change* ("make the background red"). **Routing (answers the open question):**
  1. By default the edit goes to the same model that made the image, if that model can edit.
  2. A dropdown lets him choose any other edit-capable model. Optional "compare edit" sends the same instruction to two models side by side (costs double, shown first).
  3. If he paints a mask, only mask-capable models are offered (local in v1). If the chosen model can't take a mask, the app says so and offers two choices: describe the area in words instead, or switch to a mask-capable model. It never silently drops the mask.
  4. Every edit creates a new child image. The original is never changed. Lineage (parent → child, instruction, model, cost) is stored and shown as a small version strip, so he can step back to any earlier version.
- *Text / logo*: drag-and-drop text layers (font, size, color, stroke, shadow) and logo layers (his PNG/SVG logos are stored in a "Brand kit" panel). This is all canvas work, with no model.
- *Crop / color*: crop with ratio presets, plus sliders. Also canvas work, with no model.

**Step 5: Caption.** The "Write captions" button sends the final image, the original prompt, the chosen platforms, and a tone (saved presets such as "MAD Ventures confident", "casual", "educational") to the caption model. He gets 2–3 options per platform, each with a live character count against that platform's limit (section 6). He can edit them inline. Hashtags are a separate field so they can be trimmed per platform.

**Step 6: Platform sizing.** He ticks platforms and the app makes one rendition per platform (section 5). Each rendition opens in a preview with the platform's safe zone drawn on top. Per rendition he can drag the crop, switch to AI outpaint, or accept. Export downloads a ZIP with one image per platform plus a `captions.txt`. There is no posting; posting is out of scope.

**Step 7: Save to library.** "Save to library" writes the final image, renditions, captions, prompt, model, lineage, and tags in one database transaction, after the files are safely on disk. Tags come from manual entry plus suggested tags from the caption model (he must accept them; none are added silently). The library has full-text search over prompt, caption, and tags; filters by model, platform, tag, and date; and a "reuse" action that opens a post's prompt and settings as a new run.

## 5. Platform sizing

| Platform / placement | Export size (px) | Ratio | Source |
|---|---|---|---|
| Instagram feed, square | 1080×1080 | 1:1 | Hootsuite Oct 2026 |
| Instagram feed, portrait | 1080×1350 (in-app allows up to 1080×1440, 3:4) | 4:5 | Instagram Help; Hootsuite |
| Instagram Story | 1080×1920 (key content in middle 1080×1610) | 9:16 | Hootsuite |
| X | 1280×720 or 1080×1080 | 16:9 or 1:1 | Hootsuite |
| LinkedIn feed | 1200×1200 square; 1200×627 landscape; vertical 4:5 (Hootsuite lists 720×900; I'd export 1080×1350, same ratio, sharper) | 1:1 / 1.91:1 / 4:5 | Hootsuite |
| Facebook feed | 1080×1080; 1080×1350 (Hootsuite says 1080×1359); Story 1080×1920 | 1:1 / 4:5 / 9:16 | Hootsuite |
| TikTok photo / carousel | 1080×1920 | 9:16 | Hootsuite |
| Pinterest Pin | 1000×1500 | 2:3 | Hootsuite; Pinterest Help (file types, 20 MB, safe zones) |
| YouTube thumbnail | 1280×720 minimum target; YouTube recommends 3840×2160; under 2 MB if uploading from mobile | 16:9 | YouTube Help |

Links: https://blog.hootsuite.com/social-media-image-sizes-guide/ · https://help.instagram.com/1631821640426723/ · https://help.pinterest.com/en/article/review-pin-specs · https://support.google.com/youtube/answer/72431

Sizes live in a JSON preset file so they can be updated without code changes. Each preset holds size, ratio, file-size limit, and safe zone.

**Smart crop vs. outpaint:**
- *Smart crop (default, free, instant):* server-side `sharp` with `fit: cover` and the `attention` strategy, which focuses on saturated, high-detail, and skin-tone regions (https://sharp.pixelplumbing.com/api-resize). He can then drag the crop box. This works when the subject sits well inside the frame.
- *Outpaint (on request, costs one edit):* used when the crop would cut the subject, for example turning 1:1 into 9:16. The app sends the image to an edit model with "extend the scene to fill a 9:16 frame, keep the subject unchanged," or runs a local ComfyUI outpaint workflow. Whether the xAI and Gemini edit calls accept a new aspect ratio is UNVERIFIED and is tested in Act 0. If neither does, the local workflow or Recraft's outpainting API ($0.04) is the fallback.
- *Best practice built in:* generate at the most demanding ratio first (usually 4:5 or 9:16), then crop down.

## 6. Captions

- **Model (recommended):** Gemini 3.1 Flash-Lite on the paid tier: $0.25 / $1.50 per 1M tokens, takes images, and paid-tier data is not used to train Google's products. A caption call costs well under $0.01. It uses the same Google key as Nano Banana 2.
- **Alternatives behind the same adapter:** Claude Haiku 4.5 ($1 / $5 per 1M tokens; good tone control), Grok via the xAI key, or local `qwen3-vl` through Ollama at $0. The local option competes with ComfyUI for the 16 GB of VRAM, so local captions only run while no image job is using the GPU.
- **Inputs:** final image, original prompt, platform list, tone preset, optional notes ("mention the Buildroom launch"), and a short "brand voice" text he writes once.
- **Output:** strict JSON per platform: caption text, hashtags, alt text. The app enforces limits after the model responds: anything over the limit is flagged in red, never silently cut.

| Platform | Hard limit | Visible before "more" (approx.) | Source |
|---|---|---|---|
| Instagram | 2,200 chars | ~125 | Hootsuite |
| X | 280 (25,000 Premium) | — | Hootsuite |
| LinkedIn | 3,000 | ~140 | Hootsuite |
| Facebook | 63,206 | ~80 ideal | Hootsuite |
| TikTok | 4,000 in-app (UNVERIFIED; third-party only) | ~90–100 | RecurPost / boomp |
| Pinterest | Title 100; description 800 | — | Pinterest Help |
| YouTube | Title 100; description 5,000 | — | Hootsuite |

Link: https://blog.hootsuite.com/ideal-social-media-post-length/

## 7. Failure behavior

Rule for every case: show the real state plainly, never invent a result, never lose the original, never spend past a cap.

| Failure | What the app does |
|---|---|
| Provider API down or timeout | Each call has a hard timeout (cloud 120 s, which matches OpenAI's "up to 2 minutes" note; local 300 s). That tile shows "Grok timed out after 120 s. No charge recorded." with a Retry button. Other creators' results still show. There is one automatic retry only for connection errors before any response, never after a response that may have billed. |
| Rate limit (429) | One automatic retry after the provider's `retry-after` (max 30 s), with "waiting for rate limit" shown on the tile. If it fails again, the tile says "rate limited" with a Retry button. The per-provider concurrency limits are set below the documented limits (xAI 6 req/s). |
| Provider quota / credits exhausted | The tile shows "xAI credits exhausted — top up in console.x.ai." That creator card is marked unavailable until a test call succeeds. No retry loop. |
| Content-policy refusal | The tile shows the provider's refusal text word for word, with the label "Refused by Google" (for example). No placeholder image, no silent retry with a reworded prompt. He can edit the prompt himself. Refusals are logged with the prompt so patterns are visible. |
| Invalid or expired API key (401/403) | The creator card shows "Key rejected" with a link to the settings page. Other creators continue. The key value is never logged or displayed; only its last 4 characters show in settings. |
| Partial side-by-side results | The grid shows whatever finished. Missing tiles show their specific error. The run is marked "partial" in history. Cost is recorded only for calls that returned. |
| Edit fails | The original image and all earlier versions stay untouched (edits always write new files). The failed edit appears in the version strip as a failed entry with its error and no image. |
| Oversized or unsupported upload | Checked in the browser and again on the server before any provider call. Allowed: PNG, JPEG, WebP, up to 20 MB, up to 8,000 px on a side (my limits; tune to the providers). Larger images are offered a downscale ("Resize to 4096 px and continue?"). Anything else is rejected with the reason. Nothing is sent to a provider that would reject it. |
| Storage write failure (disk full, I/O error) | Files go to a temp path, are fsynced, then renamed. The DB transaction commits only after the file is in place. On failure the transaction rolls back and the temp file is deleted, so there are no half-saved library entries. The app shows "Save failed: disk full (2.1 GB free)." A free-space check on startup and every hour warns below 10 GB. |
| Search index out of sync | FTS is maintained by triggers inside the same transaction. A nightly check compares row counts and spot-checks entries. If they differ, the app runs FTS `rebuild` and logs it. Settings also has a manual "Rebuild search index" button. |
| Local GPU out of memory | ComfyUI's error is caught and the tile says "Local GPU out of memory." The app offers one retry at a smaller size (1K) after asking ComfyUI to free memory. It never falls back to a paid cloud model on its own. |
| ComfyUI or Ollama down | Health check every 30 s. The Local creator card shows "Offline" and can't be selected; jobs already queued fail with "Local studio offline." Cloud creators are not affected. |
| Cost cap reached | Before every call, the spend guard reserves the estimated cost in `spend_ledger` inside a transaction. If reserved + spent + estimate, summed across all providers, would pass the shared $50 monthly cap, the call is refused before it is sent: "Monthly cap $50 reached ($49.93 used across xAI and Google). Raise cap in Settings or wait until Nov 1." Spend is still recorded per provider for reporting, but there is no per-provider cap. After the call, the reservation is replaced by the actual cost. A warning shows at 80%. Provider-side prepaid credits are the backstop if the app's math is wrong. |
| Backup fails | The nightly job records success or failure. A red banner appears in the app if the last good backup is more than 48 hours old. |

## 8. Cost

**Assumed usage ("a full week of posts," repeated for a month):** 7 finished posts a week, about 30 a month. For each post: 2 prompt rounds × 2 cloud creators × 2 images = 8 cloud generations, 3 AI edits, 0.5 AI outpaints, and 1 caption call covering 4 platforms. Images at 1K.

| Item | Count / month | Unit price | Monthly |
|---|---|---|---|
| Grok Imagine 2.0 generations | 120 | $0.04 | $4.80 |
| Nano Banana 2 generations | 120 | $0.067 | $8.04 |
| Grok edits + outpaints | 53 | ~$0.07 | $3.71 |
| Nano Banana 2 edits + outpaints | 52 | ~$0.068 | $3.54 |
| Captions (Gemini 3.1 Flash-Lite) | 30 | <$0.01 | <$0.30 |
| Local generations and edits | any | $0 | $0 |
| **Total** | | | **~$20** |

- Heavy month (3× the exploring, or 2K outputs): about $55–70.
- Using the local creator for first drafts and sending only the best prompts to the cloud can cut cloud spend roughly in half (my estimate).
- Using Nano Banana Pro instead of Nano Banana 2 roughly doubles the Google line.
- **Hard cap (Founder decision, 2026-10-03, enforced by the app):** one shared $50 a month across xAI and Google (images + captions). No per-provider split. Backstops on the provider side: prepaid credits on xAI (or a low invoiced spending limit) and prepay or a spend-cap budget on Google Cloud. Google's alerts-only budgets do not stop spending.
- Optional backup storage on Cloudflare R2: a few GB a year. R2 pricing was not checked (UNVERIFIED), but it is likely under $1 a month at this size.

## 9. Build order

Each act is small, shippable, and ends with something Michael can use or judge.

**A0 — Spike: prove the riskiest assumption (1–2 days)**
- Michael creates an xAI Console API key and a Gemini API key on his own accounts, each with a small prepaid balance ($10). This is his action; the agent does not sign up for anything.
- One script per provider (`spike/xai.ts`, `spike/gemini.ts`). Each one: generates one 4:5 image from a fixed prompt; edits it with "make the background red"; tries an edit with a different aspect ratio (outpaint test); sends one prompt likely to be refused, to capture the refusal format; and logs latency, output size, and billed cost.
- A0b (when the GPU is installed): `spike/comfy.ts` runs FLUX.2 klein 4B generate + edit and Qwen-Image-Edit Q4_K_M with a mask through the ComfyUI API, and logs VRAM peak and seconds.
- Acceptance: for each provider, one generated and one edited image are saved, cost matches the console within ±10%, and a one-page results table is written. If a provider fails, it drops from the roster before any app code exists.

**A1 — Skeleton + one creator + library save**
- Next.js app in Docker; SQLite schema; file store; Tailscale Serve; settings page for keys (server-side); Grok adapter only; prompt → image → Save to library → search by prompt text.
- Acceptance: from his phone on Tailscale, he makes an image, saves it, and finds it by a word from the prompt. Keys never appear in browser network traffic.

**A2 — Roster, side-by-side, spend guard, failure states**
- Gemini adapter; creator cards; job queue with per-provider concurrency; compare grid; spend ledger and caps; all section 7 cloud failure states.
- Acceptance: one prompt to both creators shows both results; a test with a bad key or a forced timeout shows the right message while the other creator still returns; a $0.10 test cap blocks the next call before it is sent.

**A3 — Edit by description + lineage**
- Edit routing as in section 4; version strip; compare-edit; local creator (ComfyUI) with mask painting if the GPU is ready.
- Acceptance: three chained edits, then a revert to version 1; the original file hash is unchanged; a mask edit on a non-mask model shows the choice prompt and is not silently dropped.

**A4 — Deterministic editor**
- Canvas crop, color sliders, text layers, Brand kit logos, saved recipe.
- Acceptance: he adds a logo and headline, crops, adjusts warmth, saves, reopens, and changes the headline without redoing the rest.

**A5 — Captions**
- Caption adapter; tone presets; per-platform limits and counters; suggested tags.
- Acceptance: one click gives captions for 4 platforms, each within limits or flagged red.

**A6 — Platform sizing + export**
- Presets JSON; smart crop; safe-zone overlay; outpaint option; ZIP export.
- Acceptance: one image exports correct sizes for every ticked platform, and the YouTube file is under 2 MB.

**A7 — Library polish, backup, and the success test**
- Tag filters, reuse-run, nightly backup + restore drill, FTS check job.
- Acceptance (from the brief): Michael makes a full week of posts (7) without opening another app. A restore from backup onto a clean folder brings the library back.

## 10. Open decisions for Michael

1. **First roster.** *Recommendation:* Grok Imagine 2.0 + Nano Banana 2 + Local studio (FLUX.2 klein 4B + Qwen-Image-Edit). *Decided 2026-10-04 (decision 11):* Nano Banana Pro is on the roster as its own creator card, Nano Banana 2 stays the default, and Nano Banana 2 Lite is not included.
2. **Where it runs.** Self-host on the Buildroom box behind Tailscale, or a hosted deploy (Vercel/Render). *Recommendation:* self-host. Until the box is built, run the same container on his current computer with only the cloud creators.
3. **Monthly spend caps.** *Decided 2026-10-03:* one shared $50 a month across both providers, no per-provider split. Prepaid credits per provider remain the provider-side backstop.
4. **Caption model.** *Recommendation:* Gemini 3.1 Flash-Lite on the paid tier (same Google key, near-zero cost). Add local `qwen3-vl` later if he wants captions fully offline.
5. **Add OpenAI for cloud mask edits?** *Recommendation:* not in v1. Local Qwen-Image-Edit handles masks. Add `gpt-image-2.5-sunburst` only if local mask edits are not good enough.
6. **Backup target.** *Recommendation:* nightly copy to a private Cloudflare R2 bucket (he already uses Cloudflare). Alternative: a second local disk.
7. **Code home.** Private GitHub repo, or his Forgejo on Buildroom. *Recommendation:* private GitHub now for CI and backups, mirrored to Forgejo once it is running. *Decided:* private `MADVenturesLLC/red-social-room` (Michael, 2026-10-04).
8. **RAM: 32 GB or 64 GB.** The Qwen-Image-Edit guide calls 32 GB system RAM the "practical floor" and 64 GB "comfortable" (third-party judgment). *Recommendation:* start with 32 GB; upgrade if model switching or swapping is slow in A0b.

## 11. Out of scope (from the brief)

- Video generation or editing.
- Posting or scheduling to social accounts.
- Client workspaces and billing.
- Other users or a team.
- A public portfolio page.

Also out of scope by design: automating the consumer websites (grok.com, gemini.google.com, chatgpt.com, claude.ai) to reuse subscriptions.
