// A2 creator-card states: the F5 "Provider having problems" rule (Amendment 1 item 15) and the card
// math. Fakes only; no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appStatus, providerProblems } from "../src/server/status.ts";
import { reserve, settle, markUnresolved } from "../src/server/ledger.ts";
import { checkKey } from "../src/server/xai/adapter.ts";
import { checkGoogleKey } from "../src/server/google/adapter.ts";
import { googleDepsOf } from "../src/server/execute.ts";
import { makeApp, fakeProviders } from "./helpers.ts";

const GEN = "55555555-5555-4555-8555-555555555555";

async function readyApp() {
  const t = makeApp({ fetch: fakeProviders().fetch });
  await checkKey(t.app);
  await checkGoogleKey(googleDepsOf(t.app));
  return t;
}
const card = (t: ReturnType<typeof makeApp>, id: "xai" | "google") => appStatus(t.app).creators.find((c) => c.id === id)!;
const seed = (t: ReturnType<typeof makeApp>, minsAgo: number, httpStatus: number) => {
  const now = new Date(Date.now() - minsAgo * 60_000);
  const { id } = reserve(t.app.db, { provider: "google", model: "gemini-3.1-flash-image", kind: "generate", resolution: "1k", quality: null, generationId: GEN, attempt: 1, estimateMicros: 75000, estimateSource: "test", now });
  if (httpStatus === 200) settle(t.app.db, id, { actualMicros: 68500, costSource: "estimated_tokens", httpStatus: 200, outcome: "ok" });
  else markUnresolved(t.app.db, id, { reason: "5xx", httpStatus, outcome: "http_error" });
};

test("F5/item 15: 3 consecutive 5xx for a provider within 10 minutes -> 'Provider having problems' until the next success", async () => {
  const t = await readyApp();
  try {
    assert.equal(card(t, "google").state, "ready");
    seed(t, 2, 503);
    seed(t, 1, 503);
    assert.equal(providerProblems(t.app.db, "google"), false, "2 in a row is not enough");
    seed(t, 0, 503);
    assert.equal(providerProblems(t.app.db, "google"), true);
    const c = card(t, "google");
    assert.equal(c.state, "provider_problems");
    assert.equal(c.stateText, "Provider having problems");
    assert.equal(card(t, "xai").state, "ready", "the other card is unaffected");
    seed(t, 0, 200); // a success breaks the streak
    assert.equal(providerProblems(t.app.db, "google"), false);
    assert.equal(card(t, "google").state, "ready");
  } finally { t.cleanup(); }
});

test("F5/item 15: 3 5xx spread beyond 10 minutes do not raise the card", async () => {
  const t = await readyApp();
  try {
    seed(t, 40, 503);
    seed(t, 30, 503);
    seed(t, 20, 503);
    assert.equal(providerProblems(t.app.db, "google"), false);
    assert.equal(card(t, "google").state, "ready");
  } finally { t.cleanup(); }
});
