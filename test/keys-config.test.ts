// Server-side key handling (TECH-PLAN-v1.md:79, F7) and the Founder-decision switches (config/switches.json).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyStore, KeyRejectedInput } from "../src/server/keys.ts";
import { parseSwitches, loadSwitches, ConfigError, qualityFor, resolutionFor } from "../src/server/config.ts";
import { xaiBaseUrlFromEnv } from "../src/server/app.ts";
import { DUMMY_KEY, DEFAULT_SWITCHES } from "./helpers.ts";

const OTHER = "dummy_TESTONLY2_YN37HqzjWJUVBEzSe0yEx85UHWPO5NEramEpLdk3wQs5ingajTDuNgrguPUC";

function withDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "rsr-keys-"));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("status shows only the source and last 4 characters", () => withDir((dir) => {
  const k = new KeyStore({ secretsDir: dir, env: { XAI_API_KEY: DUMMY_KEY } });
  assert.deepEqual(k.status(), { set: true, source: "env", last4: DUMMY_KEY.slice(-4) });
  assert.equal(JSON.stringify(k.status()).includes(DUMMY_KEY.slice(0, 12)), false);
  assert.deepEqual(new KeyStore({ secretsDir: dir, env: {} }).status(), { set: false, source: null, last4: null });
}));

test("a key saved from Settings is written mode 600 in a mode 700 folder, wins over .env, and is never returned", () => withDir((dir) => {
  const secrets = join(dir, "secrets");
  const k = new KeyStore({ secretsDir: secrets, env: { XAI_API_KEY: DUMMY_KEY } });
  const s = k.save(`  ${OTHER}\n`);
  assert.deepEqual(s, { set: true, source: "settings", last4: OTHER.slice(-4) });
  assert.equal(statSync(join(secrets, "xai_api_key")).mode & 0o777, 0o600);
  assert.equal(statSync(secrets).mode & 0o777, 0o700);
  assert.equal(readFileSync(join(secrets, "xai_api_key"), "utf8").trim(), OTHER);
  assert.deepEqual(k.authHeader(), { Authorization: `Bearer ${OTHER}` });
  assert.equal(JSON.stringify(s).includes(OTHER.slice(4, 16)), false);
}));

test("a malformed key is refused and the error text never contains what was typed", () => withDir((dir) => {
  const k = new KeyStore({ secretsDir: dir, env: {} });
  const typed = "short secret value with spaces 12345";
  assert.throws(() => k.save(typed), (e: unknown) => e instanceof KeyRejectedInput && !e.message.includes("secret value") && !e.message.includes("12345"));
  assert.throws(() => k.save(42), KeyRejectedInput);
  assert.equal(k.status().set, false);
}));

test("scrub also removes any bearer token, whatever its format (case-insensitive 'Bearer')", () => withDir((dir) => {
  const k = new KeyStore({ secretsDir: join(dir, "s"), env: {} });
  assert.equal(k.scrub("Authorization: Bearer abc.DEF-123_xyz=, then bearer zz9 ok"), "Authorization: Bearer [REDACTED], then bearer [REDACTED] ok");
}));

test("scrub removes every known key value and anything shaped like an xAI key", () => withDir((dir) => {
  const k = new KeyStore({ secretsDir: dir, env: { XAI_API_KEY: DUMMY_KEY, GEMINI_API_KEY: "dummyg_TESTONLY_q8Zr3LmPw0XkVt5N" } });
  const out = k.scrub(`a ${DUMMY_KEY} b dummyg_TESTONLY_q8Zr3LmPw0XkVt5N c xai-UNKNOWNbutKeyShaped1234567890 d`);
  assert.equal(out, "a [REDACTED] b [REDACTED] c [REDACTED] d");
}));

test("the fingerprint changes when the key changes (drops a cached key check)", () => withDir((dir) => {
  const k = new KeyStore({ secretsDir: join(dir, "s"), env: { XAI_API_KEY: DUMMY_KEY } });
  const a = k.fingerprint();
  k.save(OTHER);
  assert.notEqual(k.fingerprint(), a);
  assert.equal(String(k.fingerprint()).includes(OTHER.slice(4, 16)), false);
}));

test("switches: the committed defaults parse to the A1 defaults (Amendment 1 section 4 line 272)", () => {
  const s = loadSwitches();
  assert.deepEqual(JSON.parse(JSON.stringify(s)), DEFAULT_SWITCHES);
  assert.equal(resolutionFor(s), "1k");
  assert.deepEqual(qualityFor(s, "generate"), { priceQuality: "low", send: false });
  assert.ok(Object.isFrozen(s) && Object.isFrozen(s.promptCheck));
});

test("switches: a value A1 doesn't build stops startup instead of silently using the default", () => {
  for (const bad of [{ promptCheck: { ...DEFAULT_SWITCHES.promptCheck, method: "model" } }, { xaiQuality: "all_medium" }, { finalResolution: "2k" }, { xaiRejectionCost: "anything" }, { xaiDataRetention: undefined }]) {
    assert.throws(() => parseSwitches({ ...DEFAULT_SWITCHES, ...bad }), ConfigError, JSON.stringify(bad));
  }
});

test("RSR_XAI_BASE_URL (tests only) is accepted only for loopback http, so the key can't be pointed elsewhere", () => {
  assert.equal(xaiBaseUrlFromEnv(undefined), undefined);
  assert.equal(xaiBaseUrlFromEnv("http://127.0.0.1:4010"), "http://127.0.0.1:4010");
  for (const bad of ["https://evil.example", "http://127.0.0.1.evil.example:80", "http://localhost:4010", "http://127.0.0.1:4010/path"]) assert.throws(() => xaiBaseUrlFromEnv(bad), bad);
});
