# Red Social Room — Model and Platform Research Notes

Prepared for: Michael Daley (MAD Ventures)
Prepared by: Surface Architect
Date: Saturday, October 3, 2026, ~8:15 PM ET
Status: research notes behind TECH-PLAN-v1.md. Every claim has a source link. Items I could not confirm on an official page are marked **UNVERIFIED**.

Prices change often. All prices are USD list prices as read on the pages below on Oct 3, 2026. Re-check them in Act 0.

---

## 0. The riskiest assumption, answered

The brief assumed each model could be used "through Michael's own accounts" inside one app. The answer, provider by provider:

| Provider | Does the consumer subscription give API access? | What the app actually needs | Source |
|---|---|---|---|
| xAI (Grok / SuperGrok / X Premium) | No. Consumer plans and the xAI API are billed separately. API use is prepaid credits or monthly invoice in the xAI Console. | xAI Console account + API key + prepaid credits | https://docs.x.ai/developers/faq/billing , https://x.ai/api . Third-party confirmations: https://aionx.co/ai-comparisons/grok-premium-pricing/ , https://continuumcode.ai/guides/supergrok-pricing/ |
| Google (Google AI Pro / Ultra) | No. Google says plan benefits "apply only within the Google AI Studio web interface. Direct use of the Gemini API (such as using API keys or external applications) is billed and managed separately." | Gemini API key on a Google Cloud project with Cloud Billing (image models have no free tier) | https://ai.google.dev/gemini-api/docs/google-ai-plans , https://ai.google.dev/gemini-api/docs/pricing |
| OpenAI (ChatGPT Plus / Pro) | No. "ChatGPT and the API platform have separate billing systems." "API usage is billed separately from your ChatGPT subscription." | OpenAI Platform account + API key + prepaid credits | https://help.openai.com/en/articles/9039756-managing-billing-for-chatgpt-and-the-api-platform |
| Anthropic (Claude Pro / Max) | Claude Design is included in paid Claude plans and uses subscription limits; it is a product inside claude.ai, not an API. The Claude API is a separate product with its own keys. | Anthropic API key (only if Claude is used for captions) | https://www.anthropic.com/news/claude-design-anthropic-labs , https://support.claude.com/en/articles/14604416-get-started-with-claude-design , https://docs.anthropic.com/en/api/overview |

Conclusion: the app cannot reuse Michael's consumer subscriptions. Every cloud model is reached with a pay-per-image API key that he owns. That still satisfies the brief's "no one else paid" rule (he pays the model provider directly, no middleman), but it is a new, separate bill.

### Why not automate the consumer web apps instead

Driving grok.com, gemini.google.com, or chatgpt.com with a bot or script to reuse the subscription is against their terms and risks account suspension:

- xAI Acceptable Use Policy prohibits "Accessing the Services through unauthorized automated or non-human means, whether through a bot, script, or otherwise" and "Scraping, harvesting or reselling any Input or Output." https://x.ai/legal/acceptable-use-policy
- OpenAI Terms of Use prohibit: "Automatically or programmatically extract data or Output." https://openai.com/policies/row-terms-of-use/
- Anthropic Consumer Terms prohibit access "through automated or non-human means, whether through a bot, script, or otherwise," except via an Anthropic API key. https://www.anthropic.com/legal/consumer-terms
- Google Terms of Service prohibit "using automated means to access content from any of our services in violation of the machine-readable instructions on our web pages" and list scraping as a reason to disable accounts. https://policies.google.com/terms?hl=en-US

Besides the terms, UI automation breaks whenever the site changes, cannot be monitored for cost, and would put his main Google/X/OpenAI accounts at risk. Do not build it.

---

## 1. xAI — Grok Imagine (API)

- Models in the API: `grok-imagine-image-2.0` (current default in docs), `grok-imagine-image` (cheaper base), `grok-imagine-image-quality` (older). https://docs.x.ai/developers/models , https://docs.x.ai/developers/pricing
- `grok-imagine-image-quality` has a docs entry titled "Imagine Image Quality Retirement (Nov 2, 2026)". Do not build on it. https://docs.x.ai/developers/pricing (navigation entry; details page not read)
- Generation: `POST https://api.x.ai/v1/images/generations`; `n` 1–10; `aspect_ratio` includes 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 2:1, 1:2, 19.5:9, 20:9, 21:9, 5:2, auto; `resolution` 1k or 2k; `quality` low / medium / auto (only on 2.0; auto = low for generation, medium for editing). Returned URLs are temporary; base64 output is available. https://docs.x.ai/developers/model-capabilities/images/generation
- Editing by description: yes. `POST https://api.x.ai/v1/images/edits` with a source image (URL, base64 data URI, or file_id) plus a prompt. Multi-turn editing by chaining outputs. The OpenAI SDK's `images.edit()` is not supported (xAI needs JSON, not multipart). https://docs.x.ai/developers/model-capabilities/images/editing
- Mask / inpainting: no mask parameter is documented on the editing page. Treat as **no mask support**. https://docs.x.ai/developers/model-capabilities/images/editing
- Moderation: the SDK exposes `respect_moderation` to show if an image was filtered. https://docs.x.ai/developers/model-capabilities/images/generation
- Rate limit: 6 requests per second for both image models. https://docs.x.ai/developers/models/grok-imagine-image-2.0 , https://docs.x.ai/developers/models/grok-imagine-image
- Pricing (pricing page table, Oct 3, 2026): https://docs.x.ai/developers/pricing
  - `grok-imagine-image-2.0`: input image $0.01/img; output 1K low $0.04, 1.5K low $0.05, 2K low $0.06, 1K medium $0.06, 1.5K medium $0.07, 2K medium $0.08.
  - `grok-imagine-image`: input image $0.002/img; output $0.02 at 1K or 2K.
  - So a 1K generation on 2.0 at low is $0.04; a 1K edit on 2.0 (default medium) is about $0.01 + $0.06 = $0.07.
- Billing: prepaid credits, or monthly invoicing with an "invoiced spending limit". https://docs.x.ai/developers/faq/billing

## 2. Google — Gemini API image models ("Nano Banana") and Imagen

- Current image models in the Gemini API: `gemini-3.1-flash-image` (Nano Banana 2), `gemini-3.1-flash-lite-image` (Nano Banana 2 Lite), `gemini-3-pro-image` (Nano Banana Pro). `gemini-2.5-flash-image` is deprecated with shutdown on October 2, 2026. https://ai.google.dev/gemini-api/docs/image-generation , https://ai.google.dev/gemini-api/docs/pricing
- Imagen in the Gemini API is listed as "Google's legacy text-to-image models (shut down)." Do not build on Imagen through the Gemini API. https://ai.google.dev/gemini-api/docs/image-generation . (Imagen still appears on Google Cloud's Vertex/Agent Platform pricing page; not recommended here.) https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing
- Editing by description: yes. Send image + text instruction; multi-turn editing via `previous_interaction_id`. Up to 14 reference images. Aspect ratio and size (512px on Flash only, 1K, 2K, 4K) set in `response_format`. Flash Lite Image is 1K only and "not optimized for ... multi-turn sequential editing." https://ai.google.dev/gemini-api/docs/image-generation
- Mask / inpainting: no mask parameter in the Gemini API docs. Treat as **no mask support**. https://ai.google.dev/gemini-api/docs/image-generation
- All generated images carry a SynthID watermark. https://ai.google.dev/gemini-api/docs/image-generation
- Free tier: image models are "Not available" on the free tier. Paid only. https://ai.google.dev/gemini-api/docs/pricing
- Pricing (standard tier): https://ai.google.dev/gemini-api/docs/pricing
  - `gemini-3.1-flash-image`: $0.045 (0.5K), $0.067 (1K), $0.101 (2K), $0.151 (4K) per output image. Input $0.50 per 1M text/image tokens. Batch: half.
  - `gemini-3.1-flash-lite-image`: $0.0336 per 1K image.
  - `gemini-3-pro-image`: $0.134 per 1K/2K image, $0.24 per 4K. Input image about $0.0011.
- Paid tier data is "not used to improve our products"; free tier data is. https://ai.google.dev/gemini-api/docs/pricing
- Spend control: Google Cloud alerts-only budgets "don't automatically cap" spending; a "spend cap budget (preview)" exists where supported; AI Studio also supports prepay billing. https://cloud.google.com/billing/docs/how-to/budgets , https://ai.google.dev/gemini-api/docs/google-ai-plans

## 3. OpenAI — GPT Image

- Current models in the image guide: `gpt-image-2.5-sunburst` ("editing precision") and `gpt-image-2.5-flare` ("fast, high-quality everyday image generation"). Earlier: `gpt-image-2`, `gpt-image-1.5`, `gpt-image-1`, `gpt-image-1-mini`. https://developers.openai.com/api/docs/guides/image-generation
- Endpoints: `/v1/images/generations` and `/v1/images/edits`. https://developers.openai.com/api/docs/models/gpt-image-2
- Mask inpainting: yes. Mask must be same size/format as the image, under 50 MB, and have an alpha channel (transparent = area to edit). https://developers.openai.com/api/docs/guides/image-generation (API reference says PNG under 4 MB: https://developers.openai.com/api/reference/go/resources/images/methods/edit/ — the two pages differ; test in Act 0.)
- Pricing: token based. GPT Image 2.5: $8/1M image input tokens, $30/1M image output tokens, $5/1M text input. https://developers.openai.com/api/docs/guides/image-generation
- Per-image reference from OpenAI's table for `gpt-image-2` at 1024x1024: low $0.006, medium $0.053, high $0.211. https://developers.openai.com/api/docs/guides/image-generation
- Per-image cost for GPT Image 2.5 at medium: **UNVERIFIED** (OpenAI shows it only in an interactive calculator). Assume it is similar to gpt-image-2 until Act 0 measures it.
- Rate limits for gpt-image-2: Tier 1 = 5 images per minute. https://developers.openai.com/api/docs/models/gpt-image-2
- Moderation errors come back as `error.code = "moderation_blocked"`; OpenAI says do not auto-retry these without changing the input. https://developers.openai.com/api/docs/guides/image-generation
- ChatGPT Plus does not include API usage (see section 0).

## 4. Anthropic — Claude Design and Claude API

- Claude Design is an Anthropic Labs product for "designs, prototypes, slides, one-pagers" through conversation, powered by Claude Opus 4.7, included in Pro/Max/Team/Enterprise plans and using subscription limits. It exports HTML, PDF, PPTX and hands off to Claude Code. https://www.anthropic.com/news/claude-design-anthropic-labs , https://support.claude.com/en/articles/14604416-get-started-with-claude-design
- No public Claude Design API was found. **UNVERIFIED that none exists**; the help pages describe it only as a claude.ai / Claude Code feature.
- Claude does not generate raster images: "Claude doesn't generate photos or illustrations the way image-generation tools do." It can make HTML/SVG visuals and can analyze images. https://support.claude.com/en/articles/9002504-can-claude-produce-images
- Use in this app: captions (vision input + text output) and as a reference for the feel of the editor (conversation beside a canvas, inline edits). Claude Haiku 4.5 API: $1 / 1M input, $5 / 1M output. https://platform.claude.com/docs/en/about-claude/pricing

## 5. Other options (brief)

| Provider | What it is good for | Price | Source |
|---|---|---|---|
| Black Forest Labs API | FLUX.2 [pro] gen from $0.03, edit from $0.045 (per MP); FLUX.2 [klein] 4B from $0.014; FLUX 3 Image $0.048 at 1K; FLUX.1 Fill [pro] mask inpainting $0.05; FLUX.1 Kontext [pro] $0.04 | as listed | https://docs.bfl.ml/quick_start/pricing |
| Ideogram API | Strong text-in-image | Search summary says Ideogram 4.5: $0.03 low / $0.06 medium / $0.10 high per image. **UNVERIFIED** (page loads prices dynamically; I could not read them) | https://ideogram.ai/platform/pricing |
| Recraft API | Vector output, inpainting/outpainting, background removal, cheap utilities | V4.1 raster $0.035; V4.1 Flash $0.007; inpainting/outpainting (V3) $0.04; background removal $0.01; crisp upscale $0.004 | https://www.recraft.ai/docs/api-reference/pricing |

None of these is needed for v1. Recraft's $0.04 outpainting and $0.01 background removal are a cheap fallback if local outpainting is poor.

## 6. Local open-weight models on an RTX 5060 Ti 16 GB

| Model | Gen | Edit by description | License (commercial?) | Fits 16 GB? | Source |
|---|---|---|---|---|---|
| FLUX.2 [klein] 4B | Yes | Yes (single and multi-reference) | Apache 2.0 — commercial OK | Yes: "~13GB VRAM", runs on RTX 3090/4070 | https://huggingface.co/black-forest-labs/FLUX.2-klein-4B |
| FLUX.2 [klein] 9B | Yes | Yes | FLUX Non-Commercial License | **UNVERIFIED** | same page (release note) |
| Qwen-Image-Edit-2511 | No (edit model) | Yes, strongest local editor per source | Apache 2.0 — commercial OK | Yes as GGUF: Q4_K_M 13.2 GB or Q5_K_S 14.3 GB; FP8 (20.5 GB) wants 24 GB. Text encoder 9.38 GB runs first and is released. 32 GB system RAM "practical floor." | https://localaimaster.com/blog/qwen-image-edit-local-guide (sizes from HF repos; no official VRAM spec exists) |
| Qwen-Image (gen) | Yes | — | Apache 2.0 | Similar 20B size; GGUF needed. **UNVERIFIED** exact fit | https://github.com/QwenLM/Qwen-Image |
| FLUX.1 [dev], FLUX.1 Kontext [dev], FLUX.2 [dev] | Yes | Kontext: yes | FLUX [dev] Non-Commercial License v2.0 | FLUX.1 dev FP8 runs on 16 GB (see speed below) | https://bfl.ai/legal/non-commercial-license-terms |

FLUX [dev] license detail (important for monetizing later): section 2(d) says "You may use Output for any purpose (including for commercial purposes)". But section 1(c) says a Non-Commercial Purpose excludes use "for revenue-generating activity," and section 4(a) bars using the model "or any data produced by the FLUX [dev] Model" for "commercial or production purposes." Running a dev model to produce content for a business he plans to monetize sits in a gray zone. Recommendation: use Apache 2.0 models (FLUX.2 klein 4B, Qwen-Image-Edit) locally and avoid [dev] models. This is a reading of the license, not legal advice. https://bfl.ai/legal/non-commercial-license-terms

Speed on RTX 5060 Ti 16 GB (third-party measurements, treat as rough):
- FLUX.1 schnell FP8, 1024x1024, 4 steps: about 4 s; FLUX.1 dev FP8, 25 steps: about 14 s. https://gigagpu.com/rtx-5060-ti-16gb-comfyui-setup/ (from search summary; page not opened — **UNVERIFIED**)
- Flux dev class at 992x1440, 20 steps: 53 s sampling, 122 s first run including model load. Qwen image edit (4-step "Rapid-AIO" merge) at about 840x1240: about 20 s sampling, 34 s total on a warm second run, 124 s first run. https://blog.aidec.tw/post/rtx5060ti-comfyui-test
- FLUX.2 klein 4B: BFL says "sub-second" end to end on fast hardware; on a 5060 Ti expect a few seconds. **UNVERIFIED** on this card. https://huggingface.co/black-forest-labs/FLUX.2-klein-4B

Practical constraint: only one large model fits in 16 GB at a time. Switching models costs a reload (often 30–120 s cold, per the aidec numbers above). The app must queue GPU jobs one at a time.

Programmatic control of ComfyUI: `POST /prompt` with an API-format workflow, a websocket at `/ws` for progress, `GET /history/{prompt_id}` and `GET /view` to fetch outputs. https://docs.comfy.org/development/comfyui-server/api-examples , https://docs.comfy.org/development/comfyui-server/comms_routes

Local caption model option: Ollama `qwen3-vl` (2B–235B variants, text+image input, needs Ollama 0.12.7+). https://ollama.com/library/qwen3-vl:latest . VRAM for the 8B variant: **UNVERIFIED**; it competes with ComfyUI for the same 16 GB.

## 7. Caption text models (cheap options)

| Model | Price (per 1M tokens in / out) | Note | Source |
|---|---|---|---|
| Gemini 3.1 Flash-Lite | $0.25 / $1.50 (free tier also exists, but free-tier data is used to improve Google products) | Vision input | https://ai.google.dev/gemini-api/docs/pricing |
| Gemini 3.5 Flash-Lite | $0.30 / $2.50 | Vision input | https://ai.google.dev/gemini-api/docs/pricing |
| Claude Haiku 4.5 | $1 / $5 | Vision input; good tone control | https://platform.claude.com/docs/en/about-claude/pricing |
| Grok 4.7 (xAI) | $2 / $6 | Same xAI key as images | https://x.ai/api |
| Ollama qwen3-vl (local) | $0 | Needs the GPU box | https://ollama.com/library/qwen3-vl:latest |

A caption call with one image (~1,500 input tokens) and ~300 output tokens costs well under $0.01 on any of the paid options (my arithmetic from the rates above).

## 8. Platform image sizes (October 2026)

| Platform / placement | Size (px) | Ratio | Source |
|---|---|---|---|
| Instagram feed square | 1080x1080 | 1:1 | https://blog.hootsuite.com/social-media-image-sizes-guide/ |
| Instagram feed portrait | 1080x1350 (4:5). Instagram's own help page says photos between 1.91:1 and 3:4 (up to 1080x1440) keep their resolution. | 4:5 or 3:4 | https://help.instagram.com/1631821640426723/ , Hootsuite above |
| Instagram Story | 1080x1920; keep key content in the middle 1080x1610 | 9:16 | Hootsuite above |
| X (in-stream) | 1280x720 landscape; 1080x1080 square; 720x1280 vertical; max 5 MB mobile / 15 MB web | 16:9 or 1:1 recommended | Hootsuite above |
| LinkedIn feed | 1200x1200 square; 1200x627 landscape; 720x900 vertical (4:5) | 1:1, 1.91:1, 4:5 | Hootsuite above |
| Facebook feed | 1080x1080 square; 1080x1359 vertical (4:5); 1080x566 landscape; Stories 1080x1920 | 1:1, 4:5, 1.91:1, 9:16 | Hootsuite above |
| TikTok photo / carousel | 1080x1920 | 9:16 (1:1 and 4:5 work but don't fill screen) | Hootsuite above |
| Pinterest Pin | 1000x1500 | 2:3 (also 9:16, 3:4, 4:5, 1:1) | Hootsuite above; file types, 20 MB web limit, safe zones: https://help.pinterest.com/en/article/review-pin-specs |
| YouTube thumbnail | YouTube recommends 3840x2160 (min width 640); 1280x720 common; JPG/PNG; 2 MB mobile / 50 MB desktop upload limit | 16:9 | https://support.google.com/youtube/answer/72431?co=GENIE.Platform%3DDesktop&hl=en |

## 9. Caption length limits

| Platform | Limit | Source |
|---|---|---|
| Instagram caption | 2,200 characters (truncates around 125) | https://blog.hootsuite.com/ideal-social-media-post-length/ |
| X post | 280 characters (25,000 for Premium) | same |
| LinkedIn post | 3,000 characters ("See more" at ~140) | same |
| Facebook post | 63,206 characters | same |
| TikTok caption | 4,000 in-app; 2,200 via API/schedulers — **UNVERIFIED** (third-party only) | https://recurpost.com/tiktok-scheduler/tiktok-character-limits-and-hashtags/ , https://boomp.net/resources/questions/tiktok-caption-length-2026 |
| Pinterest | Title 100; description 800 (Hootsuite says 500; Pinterest's own page says 800 — use 800) | https://help.pinterest.com/en/article/review-pin-specs |
| YouTube | Title 100; description 5,000 | https://blog.hootsuite.com/ideal-social-media-post-length/ |
| Threads | 500 | same |

## 10. Supporting infrastructure facts

- Vercel Functions: Hobby max 300 s; Pro default 300 s, configurable to 800 s. https://vercel.com/docs/functions/configuring-functions/duration (from search summary; **UNVERIFIED** on the page itself)
- Tailscale Serve: `tailscale serve 3000` publishes a local port as HTTPS on the tailnet only, with automatic TLS. https://tailscale.com/docs/features/tailscale-serve
- SQLite FTS5 external-content tables keep only the index; triggers keep it in sync; `INSERT INTO fts(fts) VALUES('rebuild')` repairs it. https://www.sqlite.org/fts5.html
- sharp `fit: cover` with `position: sharp.strategy.attention` crops toward "the region with the highest luminance frequency, colour saturation and presence of skin tones"; `entropy` is the other option. https://sharp.pixelplumbing.com/api-resize

## 11. Things I could not verify

1. GPT Image 2.5 per-image prices at each quality (calculator only).
2. Ideogram API per-image prices (dynamic page).
3. Whether a Claude Design API exists (none found).
4. FLUX.2 klein speed and Qwen-Image (gen) fit on the 5060 Ti specifically.
5. TikTok's official caption limit.
6. Exact VRAM of Ollama qwen3-vl 8B.
7. Vercel duration limits (search summary only).
8. Whether xAI or Gemini edits accept an `aspect_ratio` different from the source (needed for AI outpainting) — test in Act 0.
