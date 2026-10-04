# Plan gaps found in Act 0

Each item cites `TECH-PLAN-v1.md` (T) or `RESEARCH-models.md` (R), both in `madc-rulings/docs-drafts/red-social-room/`, by file:line, plus the evidence for it.
- "Needs Michael" marks items that need a decision rather than an engineering fix.
- **RESOLVED** items were answered by the Google run (10:25 PM ET) and are kept for traceability.

**Status: 29 items. 2 fully resolved (7, 20). 1 partly resolved (21: the Google half is done, the console check is still open). 26 open. The 4 Founder items (1, 4, 9, 12) were DECIDED on 2026-10-03 at 22:32 ET (see REPORT.md); they stay open until the app implements them. Items 23–28 are new from the Google run, and 29 is new from the delete cleanup.**

## A. Mismatches between the plan or research and real API behavior

1. **xAI can't generate 4:5 (Google can).** T:84 says the picker defaults to 4:5 ("Both cloud models accept an aspect ratio"); T:126 and T:194 say the same. R:42 lists the xAI ratios correctly.
   *Evidence:* `xai/01-generate-4x5.json` returned HTTP 422 "unknown variant `4:5`". Google's `gemini/04-generate-4x5.json` returned 928×1152.
   **DECIDED 22:32 ET:** generate 3:4 on Grok and crop to 4:5 (free; sharp, T:124). `capabilities()` (T:69) must expose per-provider ratio lists.

2. **xAI price docs vs. billing.** The live pricing page and model page show a flat "$0.04 / image". Real billing is tiered: edit $0.07, generate $0.04, matching R:48-50 and T:14/T:176.
   *Evidence:* `usage.cost_in_usd_ticks`. The free `GET /v1/image-generation-models` returns `pricing[]` (no input-image charge listed).
   *Gap:* the plan has no source of truth for the price table (T:74).

3. **Where the model id, version and request id come from differs by provider.** T:73 requires a "provider request id" and T:78 stores `request_id`, but neither says where to read it.
   *Evidence:*
   - xAI: no model id in the body; the request id is only the `x-request-id` header.
   - Google: `model:"gemini-3.1-flash-image"` and an interaction `id` in the body, and no request-id header.
   - Version is available only from each provider's model listing: xAI `1.0` / `fp_e15b3a1fcc`; Google `3.0`.

4. **xAI did not refuse the policy probe; Google did, with an identical prompt.** T:156 assumes refusals come back as text. R:45's `respect_moderation` is SDK-only.
   *Evidence:* `xai/04-refusal-probe.json` (200, image, $0.04) vs `gemini/05-refusal-probe.json` (200, text refusal, no image).
   **DECIDED 22:32 ET:** the app gets a pre-send prompt check that blocks photoreal images of named real people (not built in the spike). The plan still needs a section 7 row for it: what the blocked tile shows, and that the block costs nothing. A real xAI refusal shape is still unknown (I did not escalate the probe).

5. **Refused or violating calls can still cost money.** T:156/T:158 say cost is "recorded only for calls that returned". The xAI pricing page says violations are still charged.
   *Evidence:* xAI billed $0.04 for the probe. Google's refusal cost about $0.0001 (58 tokens).
   *Gap:* the spend guard must reserve for refused calls too, and the `refused` result (T:73) needs a cost field.

6. **A Google invalid key comes back as HTTP 400, not 401/403.** T:157 says "(401/403)".
   *Evidence:* `gemini/00-preflight-model-get-2026-10-03T2211-bad-paste.json`: 400 `INVALID_ARGUMENT`, `details[].reason:"API_KEY_INVALID"`. Google documents this shape (https://ai.google.dev/gemini-api/docs/generate-content/api-errors).
   *Still open:* the trigger was a bad paste, but the 400 code is real API behavior. Auth mapping must read `error.details[].reason`, not only the HTTP status.

7. **RESOLVED — the Gemini key was rejected.** The cause was a bad paste of the key, not the plan. With the re-entered key, the free check returned 200 and every paid call worked.
   *Residual note (open, minor):* R:19/T:26 ("Gemini API key + Cloud Billing") don't mention Google's move to auth-type keys or its rejection of unrestricted standard keys (https://ai.google.dev/gemini-api/docs/api-key). Worth a line in the setup notes.

8. **Gemini has no billed-cost field.** T:196 wants a ±10% console match; T:73 wants "actual cost". Google returns only token `usage`.
   *Evidence:* every `gemini/*.json` has `usage` and no cost. Costs are labeled estimated ($0.0685–$0.0691 per image, close to T:26's $0.067).
   *Gap:* reconciling against the console is manual for Google.

9. **The aspect-ratio edit works on both, but differently.** T:125 marked this UNVERIFIED and R:175 listed it as open.
   *Evidence:*
   - xAI: 864×1152 → 1280×720. The scene is recomposed and the cat redrawn.
   - Google: 896×1200 → 1376×768. The scene is extended around the same cat and pot.

   **DECIDED 22:32 ET:** widen with Nano Banana 2 first, and keep the local or Recraft fallback (T:125).

10. **1K output is smaller than the platform export sizes.** T:110/T:113/T:114 export 1080×1350.
    *Evidence:*
    - xAI 1K at 3:4 is 864×1152.
    - Google 1K at 4:5 is 928×1152 and at 3:4 is 896×1200.
    - Both are narrower than 1080, so they would need upscaling or 2K output (xAI low 2k $0.06; Gemini 2K $0.101 per R:62).

    *Gap:* the cost model (T:170) assumes 1K.

11. **Rate-limit signals differ.** T:154 / R:46 say xAI allows 6 requests per second.
    *Evidence:* xAI headers say `x-ratelimit-limit-requests: 300` with no window stated. Google sends **no** rate-limit headers.
    *Gap:* the concurrency limits (T:72) can't be tuned from responses for Google.

12. **Data retention isn't addressed in the plan.** T:79 covers keys only.
    *Evidence and sources:*
    - The Gemini Interactions API stores every interaction by default (`store=true`) for **55 days** on the paid tier. It can be opted out per request with `store=false`, which disables `previous_interaction_id`. The window is configurable (7/14/28/55) and interactions can be deleted by id (https://ai.google.dev/gemini-api/docs/interactions-overview).
    - Separately, Google logs paid-tier prompts and responses "for a limited period of time solely for detecting violations"; zero retention requires Vertex AI (https://ai.google.dev/gemini-api/docs/zdr).
    - AI Studio logs are opt-in, 55 days by default (https://ai.google.dev/gemini-api/docs/logs-policy).
    - xAI responses say `x-data-retention: general`, `x-zero-data-retention: false`.

    **DECIDED 22:32 ET:** send `store=false` on every Gemini call (now in `spike/gemini.ts`), and delete the 5 stored spike interactions (done 22:33 ET: all `DELETE 200`, then `GET 404`).
   *Still open:* this rules out R:57's multi-turn editing via `previous_interaction_id`. The app must pass source images inline, as the spike does. xAI retention is still undocumented here. Google's abuse-monitoring logs are not affected by `store=false` or the delete (https://ai.google.dev/gemini-api/docs/zdr).

## B. Failure-behavior gaps in section 7 (T:147-166)

13. **Timeout means "No charge recorded" (T:153), but a timeout after sending may have billed.** The spike keeps the reservation as `unresolved`. The plan has no process for reconciling these.

14. **The 429 rule (T:154) doesn't cover a missing `retry-after`, or one over 30 s,** and doesn't say whether the retry needs a new reservation. The spike stops in both cases. Not exercised.

15. **There is no explicit 5xx row.** The spike stops with no retry, inferred from T:153's "may have billed" logic. Not exercised.

16. **There is no row for request-validation errors (400/422).** T:73 has `bad_input` but section 7 has no row for it; T:160 covers uploads only. xAI returns these as `text/plain`.

17. **The cap month's timezone isn't specified** ("wait until Nov 1", T:165). The spike uses America/New_York.

18. **The ledger schema (T:78) is per provider and month,** but replacing reservations with actuals (T:165) needs one row per call. The spike uses per-call entries.

19. **The plan has no free key check before paid calls.** A free metadata GET caught the bad Gemini key for $0. It also gives the xAI price table and both model versions. It should back the "Key rejected" card (T:157) and the re-enable "test call" (T:155).

## C. Not verified in this spike

20. **RESOLVED — Gemini behavior untested.** Gemini latency, sizes, 4:5, aspect-ratio edit, refusal shape, token cost and model id/version are all now measured (REPORT.md).

21. **RESOLVED for Google / open for consoles.** The Google half of A0 is complete. The console match within ±10% (T:196) is still unchecked for both providers; the agent has no console access.

22. The 429, 5xx and timeout paths against the real APIs. None occurred in either run.

## D. New gaps from the Google run

23. **A Google refusal has no machine-readable refusal field.** T:73 needs `refused` (verbatim reason), and T:156 says to show the refusal text.
    *Evidence:* `gemini/05-refusal-probe.json` is HTTP 200, `status:"completed"`, one `model_output` step with only text ("I can't generate an image of Tom Hanks in handcuffs being arrested by FBI agents."). There is no `finishReason`, `blockReason`, `safetyRatings` or `promptFeedback`; a recursive search found only `$.status`.
    *Gap:* the adapter must classify "completed with no image" as `refused` and show the text. A text-only reply that isn't a refusal (for example a clarifying question) would look the same, and the plan doesn't define that case.

24. **Gemini aspect ratios are approximate.** T:84/T:110 assume the exact ratios.
    *Evidence:*
    - 3:4 → 896×1200 (0.747)
    - 4:5 → 928×1152 (0.806)
    - 16:9 → 1376×768 (1.792)

    *Gap:* exact platform sizes (T:110–T:117) always need a final crop or resize step, even when the "right" ratio was requested.

25. **Hidden output tokens and two different input counts.** T:26/T:177 price images per image.
    *Evidence:*
    - Every image call reported 270–436 non-image output tokens with no visible text, and `total_thought_tokens: 0`.
    - `raw_prompt_token` (468–1,592) is larger than `total_input_tokens` (26–1,139).

    *Gap:* it isn't clear which counts are billed. The difference is under $0.0015 per call, so it is immaterial at current volume. The spike prices `total_input_tokens` plus non-image output at the documented rates.

26. **Gemini responses are large.** T:76/T:78 (storage, logging) don't account for this.
    *Evidence:* each image response carried a `thought` step with a 1.1–1.4 MB base64 `signature` plus the roughly 1 MB image, so 2.6–2.9 MB of base64 per image call (measured 2.63–2.88 M chars from the elision notes in `gemini/0[1-4]-*.json`). Edit requests carry the source image inline (about 1 MB).
    *Gap:* adapters must not log or store raw responses. The spike's dumps replace the base64 with a size+hash note.

27. **Google's model listing doesn't advertise the Interactions API.** This matters for `capabilities()` discovery (T:69).
    *Evidence:* `GET /v1beta/models/gemini-3.1-flash-image` lists `supportedGenerationMethods: ["generateContent","countTokens","batchGenerateContent"]`, yet `POST /v1beta/interactions` worked.
    *Gap:* capabilities can't be discovered from the listing; hard-code them in the adapter.

28. **The two providers read "make the background red" differently.** T:91 assumes edits are predictable.
    *Evidence:* xAI turned the wall behind the cat red. Google repainted the whole room's walls red and kept the window and garden view.
    *Gap:* the plan's "compare edit" (T:93) is the right tool for this. Note that prompt wording affects results differently per provider.

29. **Interactions API errors don't use the classic Google error shape.** This affects error mapping (T:73) and item 6.
    *Evidence:* the verify GET after a delete (`gemini/deletes/01-verify-get.json`) returned HTTP 404 `{"error":{"message":"Requested entity was not found.","code":"not_found"}}`. Here `code` is a string, and there is no `status` or `details[]`. The models endpoint returns the classic shape (`code` 400, `status`, `details[].reason`). The DELETE returned 200 with `{}`, where the docs say "the response is empty".
    *Gap:* the Gemini adapter needs to parse two error shapes.
