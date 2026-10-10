# Red Social Room: Founder decisions (2026-10-03, Michael)

1. Starting models: Grok Imagine 2.0, Nano Banana 2, and local models on the Linux PC.
2. Runs on the iMac (cloud models only) until the Linux PC is built, then moves there.
3. Cloud access: pay-per-image API keys (consumer subscriptions can't be used from the app). Total API spending cap: one shared $50 a month across xAI and Google, with no per-provider split (Michael confirmed in Hephaestus's chat, 9:42 PM ET).
4. Backup: Cloudflare R2 bucket.
5. Code home: private GitHub repo `MADVenturesLLC/red-social-room` (see item 10), mirrored to Forgejo later.

## Added 2026-10-03, 10:32 PM ET (Michael, in Hephaestus's chat; recorded in /workspace/red-social-room/spike-results/REPORT.md@98b57be:99-119)

6. Gemini: send `store=false` on every call, and delete the 5 spike calls Google stored (done at 98b57be: DELETE 200, then GET 404). Amendment 1 D4.
7. Before any prompt is sent, check it and block photoreal images of named real people. Amendment 1 D1 (the details are pending as P1a–P1d).
8. Grok has no 4:5, so it generates 3:4 and the app crops to 4:5. Amendment 1 D2.
9. Widening (outpaint): Nano Banana 2 first, keeping a local or Recraft fallback. Amendment 1 D3 (iMac fallback pending as P3).
10. Repo: private `MADVenturesLLC/red-social-room`, with an Argus pre-check before the first push. (Corrected 2026-10-04: Michael created the repo under MADVenturesLLC at 4:02 AM ET (GitHub created_at 2026-10-04T08:02:48Z) and confirmed it in the Argus, Hephaestus & Surface room. The earlier record said `decivantiq/red-social-room`.)

## Added 2026-10-04, 3:15 AM ET (Michael, in Surface's chat)

11. Google image roster: Nano Banana 2 (`gemini-3.1-flash-image`, about $0.067 per 1K image) is the default Google creator, and Nano Banana Pro (`gemini-3-pro-image`, about $0.134 per 1K/2K image) joins the roster as its own creator card that Michael can turn on or use to redo an image. Nano Banana 2 Lite is not on the roster. Both models share the one Google key and the one shared $50 monthly cap. Gemini 3.1 Flash-Lite stays only as the text model for the real-person prompt check and captions, and it never makes images. Prices are from TECH-PLAN-v1.md section 2 (https://ai.google.dev/gemini-api/docs/pricing). Pro's model id and price should be confirmed in the Act 1 Gemini adapter work.

## Added 2026-10-10 (Michael, live session)

12. P3 (widen fallback, D3 / amendment item 9): **option B — no third provider.** When "AI extend (Nano Banana 2)" is refused or fails, the tile shows Google's real error and "No fallback on this computer yet. Crop instead?"; local ComfyUI outpaint arrives with A0b (FD:4). Config `outpaintFallback` stays `"none"` (that value is now the ruling, not an interim default). Michael answered with one word: "B", after the strategist's one-line recommendation. Amendment 1 section 2.2 P3 is now decided.
