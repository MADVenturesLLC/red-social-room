// B1 "Who's using it": identity from Cloudflare Access, the spend gate, and who-saved-what attribution.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { makeApp, fakeProviders } from "./helpers.ts";
import { openDb } from "../src/server/db.ts";
import { monthTotals } from "../src/server/ledger.ts";
import { putImage } from "../src/server/store.ts";
import { insertAsset } from "../src/server/execute.ts";
import { saveUploadedPost, searchPosts } from "../src/server/library.ts";
import { runView } from "../src/server/runs.ts";
import { actorFromHeaders, spendDenied, ownerDenied, loadUsers, loadUsersFrom, UsersConfigError, ACCESS_EMAIL_HEADER, type UsersConfig, type Actor } from "../src/server/actor.ts";

const CFG: UsersConfig = {
  users: [
    { email: "djmikeyrawk1@gmail.com", name: "Michael", role: "Founder", canSpend: true, isOwner: true },
    { email: "scjimenez00@yahoo.com", name: "Stephanie", role: null, canSpend: true, isOwner: false },
  ],
  localOwnerEmail: "djmikeyrawk1@gmail.com",
};

const withHeader = (email: string | null) => (name: string) => (name === ACCESS_EMAIL_HEADER ? email : null);

test("B1: the shipped config lists Michael (Founder, owner) and Stephanie, both able to spend", () => {
  const cfg = loadUsers();
  const michael = cfg.users.find((u) => u.email === "djmikeyrawk1@gmail.com");
  const stephanie = cfg.users.find((u) => u.email === "scjimenez00@yahoo.com");
  assert.ok(michael, "Michael is in config/users.json");
  assert.equal(michael!.name, "Michael");
  assert.equal(michael!.role, "Founder");
  assert.equal(michael!.canSpend, true);
  assert.equal(michael!.isOwner, true, "Michael is the owner");
  assert.ok(stephanie, "Stephanie is in config/users.json");
  assert.equal(stephanie!.name, "Stephanie");
  assert.equal(stephanie!.role, null, "no invented title for Stephanie");
  assert.equal(stephanie!.canSpend, true);
  assert.equal(stephanie!.isOwner, false, "Stephanie spends but does not administer");
  assert.equal(cfg.localOwnerEmail, "djmikeyrawk1@gmail.com");
});

test("B1: a broken allowlist is refused (startup validation calls this)", () => {
  assert.throws(() => loadUsersFrom({}), UsersConfigError, "no users");
  assert.throws(() => loadUsersFrom({ users: [] }), UsersConfigError, "empty list");
  assert.throws(() => loadUsersFrom({ users: [{ email: "", name: "x" }] }), UsersConfigError, "missing email");
  assert.throws(() => loadUsersFrom({ users: [{ email: "a@b.c" }] }), UsersConfigError, "missing name");
  assert.throws(() => loadUsersFrom({ users: [{ email: "a@b.c", name: "A", canSpend: true }] }), UsersConfigError, "no owner");
  assert.throws(() => loadUsersFrom({ users: [{ email: "a@b.c", name: "A", isOwner: true }], localOwnerEmail: "x@y.z" }), UsersConfigError, "owner email not in the list");
});

test("B1: ownerDenied stops non-owners; the owner passes", async () => {
  const owner = actorFromHeaders(withHeader("djmikeyrawk1@gmail.com"), CFG);
  assert.equal(ownerDenied(owner), null);
  for (const email of ["scjimenez00@yahoo.com", "someone@example.com"]) {
    const denied = ownerDenied(actorFromHeaders(withHeader(email), CFG));
    assert.ok(denied, `${email} gets a response`);
    assert.equal(denied!.status, 403);
    const body = (await denied!.json()) as { error: string };
    assert.match(body.error, /can't change settings/i);
  }
});

test("B1: the Access header maps to the person; case and spaces do not matter", () => {
  const m = actorFromHeaders(withHeader("  DJMIKEYRAWK1@GMAIL.COM  "), CFG);
  assert.equal(m.name, "Michael");
  assert.equal(m.role, "Founder");
  assert.equal(m.canSpend, true);
  assert.equal(m.via, "access");

  const s = actorFromHeaders(withHeader("scjimenez00@yahoo.com"), CFG);
  assert.equal(s.name, "Stephanie");
  assert.equal(s.role, null);
  assert.equal(s.canSpend, true);
  assert.equal(s.via, "access");
});

test("B1: a signed-in account that is not on the allowlist is view-only", () => {
  const stranger = actorFromHeaders(withHeader("someone@example.com"), CFG);
  assert.equal(stranger.name, "someone@example.com");
  assert.equal(stranger.canSpend, false);
  assert.equal(stranger.via, "unknown");
});

test("B1: no Access header (the box or the tailnet) counts as the owner", () => {
  const local = actorFromHeaders(withHeader(null), CFG);
  assert.equal(local.name, "Michael");
  assert.equal(local.canSpend, true);
  assert.equal(local.via, "local");
});

test("B1: spendDenied refuses a view-only account with its name and lets the owner through", async () => {
  const stranger: Actor = actorFromHeaders(withHeader("someone@example.com"), CFG);
  const denied = spendDenied(stranger);
  assert.ok(denied, "view-only gets a response");
  assert.equal(denied!.status, 403);
  const body = (await denied!.json()) as { error: string };
  assert.match(body.error, /view-only/i);
  assert.match(body.error, /someone@example\.com/);

  const owner: Actor = actorFromHeaders(withHeader("djmikeyrawk1@gmail.com"), CFG);
  assert.equal(spendDenied(owner), null);
});

test("B1: older databases gain the created_by column on the next open", () => {
  const dir = mkdtempSync(join(tmpdir(), "rsr-b1-"));
  const file = join(dir, "old.sqlite");
  try {
    const older = openDb(file, { spikeLedgerPath: null });
    older.exec("ALTER TABLE posts DROP COLUMN created_by"); // simulate a database from before B1
    older.close();
    const reopened = openDb(file, { spikeLedgerPath: null });
    const cols = new Set((reopened.prepare("PRAGMA table_info(posts)").all() as Array<{ name: string }>).map((c) => c.name));
    assert.equal(cols.has("created_by"), true);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B1: every post records who saved it", async () => {
  const p = fakeProviders();
  const t = makeApp({ fetch: p.fetch });
  try {
    const bytes = await sharp({ create: { width: 32, height: 32, channels: 3, background: "#334455" } }).png().toBuffer();
    const stored = putImage(t.app.imagesDir, bytes);
    insertAsset(t.app.db, stored);
    saveUploadedPost(t.app.db, { assetId: stored.id, prompt: "Stephanie's upload" }, "Stephanie");

    const row = t.app.db.prepare("SELECT created_by FROM posts WHERE asset_id = ?").get(stored.id) as { created_by: string | null };
    assert.equal(row.created_by, "Stephanie");
    const found = searchPosts(t.app.db, "stephanie's upload");
    assert.equal(found.length, 1);
    assert.equal(found[0].created_by, "Stephanie");
  } finally {
    t.cleanup();
  }
});

test("B1: /api/run refuses a view-only account before anything is sent; the owner's call goes through", async () => {
  const p = fakeProviders();
  const t = makeApp({ fetch: p.fetch });
  const g = globalThis as typeof globalThis & { __rsrApp?: unknown };
  g.__rsrApp = t.app;
  try {
    const { POST: runRoute } = await import("../src/app/api/run/route.ts");
    const post = (email: string) => runRoute(new Request("http://localhost:3000/api/run", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-rsr": "1",
        host: "localhost:3000",
        [ACCESS_EMAIL_HEADER]: email,
      },
      body: JSON.stringify({ prompt: "A lighthouse at dusk", ratio: "1:1", creators: [{ id: "google", n: 1 }] }),
    }));

    const refused = await post("someone@example.com");
    assert.equal(refused.status, 403);
    const body = (await refused.json()) as { error: string };
    assert.match(body.error, /view-only/i);
    assert.equal(p.xai.posts().length, 0, "no xAI request for a view-only account");
    assert.equal(p.google.posts().length, 0, "no Google request for a view-only account");

    const allowed = await post("scjimenez00@yahoo.com");
    assert.equal(allowed.status, 200);
    const { runId } = (await allowed.clone().json()) as { runId: string };
    const t0 = Date.now();
    while (runView(t.app, runId)?.status === "running") {
      if (Date.now() - t0 > 2000) throw new Error("timed out waiting for the owner's run");
      await new Promise((r) => setTimeout(r, 10));
    }
  } finally {
    delete g.__rsrApp;
    t.cleanup();
  }
});

test("B1: /api/optimize refuses a view-only account with zero provider calls", async () => {
  const p = fakeProviders();
  const t = makeApp({ fetch: p.fetch });
  const g = globalThis as typeof globalThis & { __rsrApp?: unknown };
  g.__rsrApp = t.app;
  try {
    const { POST: optimizeRoute } = await import("../src/app/api/optimize/route.ts");
    const res = await optimizeRoute(new Request("http://localhost:3000/api/optimize", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-rsr": "1",
        host: "localhost:3000",
        [ACCESS_EMAIL_HEADER]: "someone@example.com",
      },
      body: JSON.stringify({ prompt: "a cat" }),
    }));
    assert.equal(res.status, 403);
    assert.equal(p.google.posts().length, 0);
  } finally {
    delete g.__rsrApp;
    t.cleanup();
  }
});

test("B1: /api/whoami answers the signed-in person from the Access header", async () => {
  const p = fakeProviders();
  const t = makeApp({ fetch: p.fetch });
  const g = globalThis as typeof globalThis & { __rsrApp?: unknown };
  g.__rsrApp = t.app;
  try {
    const { GET } = await import("../src/app/api/whoami/route.ts");
    const call = (email?: string) => GET(new Request("http://localhost:3000/api/whoami", {
      headers: { host: "localhost:3000", ...(email ? { [ACCESS_EMAIL_HEADER]: email } : {}) },
    }));

    const stephanie = (await (await call("scjimenez00@yahoo.com")).json()) as { name: string; role: string | null; canSpend: boolean; isOwner: boolean; via: string };
    assert.deepEqual(stephanie, { name: "Stephanie", role: null, email: "scjimenez00@yahoo.com", canSpend: true, isOwner: false, via: "access" });

    const owner = (await (await call()).json()) as { name: string; canSpend: boolean; via: string };
    assert.equal(owner.name, "Michael");
    assert.equal(owner.canSpend, true);
    assert.equal(owner.via, "local");

    const stranger = (await (await call("someone@example.com")).json()) as { name: string; canSpend: boolean; via: string };
    assert.equal(stranger.name, "someone@example.com");
    assert.equal(stranger.canSpend, false);
    assert.equal(stranger.via, "unknown");
  } finally {
    delete g.__rsrApp;
    t.cleanup();
  }
});

test("B1: owner-only routes refuse Stephanie and unknown accounts, and the owner's change lands", async () => {
  const p = fakeProviders();
  const t = makeApp({ fetch: p.fetch });
  const g = globalThis as typeof globalThis & { __rsrApp?: unknown };
  g.__rsrApp = t.app;
  const call = (path: string, email?: string, body: unknown = {}) => new Request(`http://localhost:3000${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-rsr": "1",
      host: "localhost:3000",
      ...(email ? { [ACCESS_EMAIL_HEADER]: email } : {}),
    },
    body: JSON.stringify(body),
  });
  try {
    const { POST: capRoute } = await import("../src/app/api/settings/cap/route.ts");
    const { POST: keyRoute } = await import("../src/app/api/settings/key/route.ts");
    const { POST: deleteRoute } = await import("../src/app/api/posts/delete/route.ts");
    const { POST: backupRoute } = await import("../src/app/api/backup/run/route.ts");
    const { POST: ftsRoute } = await import("../src/app/api/maintenance/fts/route.ts");

    // Stephanie may spend, but the cap, keys, deletions and backups are the owner's.
    for (const [name, route, body] of [
      ["settings/cap", capRoute, { usd: 250 }],
      ["settings/key", keyRoute, { key: "sk-" + "x".repeat(40) }],
      ["posts/delete", deleteRoute, { id: 1 }],
      ["backup/run", backupRoute, {}],
      ["maintenance/fts", ftsRoute, { action: "check" }],
    ] as const) {
      const denied = await route(call(`/api/${name}`, "scjimenez00@yahoo.com", body));
      assert.equal(denied.status, 403, `${name} refuses Stephanie`);
      assert.match(((await denied.json()) as { error: string }).error, /can't change settings/i);
    }
    assert.equal(monthTotals(t.app.db).capMicros, 50_000_000, "Stephanie's refusal did not change the cap");

    // The owner's own change goes through.
    const allowed = await capRoute(call("/api/settings/cap", "djmikeyrawk1@gmail.com", { usd: 250 }));
    assert.equal(allowed.status, 200);
    assert.equal(monthTotals(t.app.db).capMicros, 250_000_000);

    // A view-only account is refused on the same routes.
    for (const [name, route, body] of [
      ["settings/cap", capRoute, { usd: 1 }],
      ["posts/delete", deleteRoute, { id: 1 }],
      ["backup/run", backupRoute, {}],
    ] as const) {
      const denied = await route(call(`/api/${name}`, "someone@example.com", body));
      assert.equal(denied.status, 403, `${name} refuses the unknown account`);
    }
  } finally {
    delete g.__rsrApp;
    t.cleanup();
  }
});

test("B1: POST /api/library saves under the signed-in name", async () => {
  const p = fakeProviders();
  const t = makeApp({ fetch: p.fetch });
  const bytes = await sharp({ create: { width: 24, height: 24, channels: 3, background: "#996633" } }).png().toBuffer();
  const stored = putImage(t.app.imagesDir, bytes);
  insertAsset(t.app.db, stored);
  const g = globalThis as typeof globalThis & { __rsrApp?: unknown };
  g.__rsrApp = t.app;
  try {
    const { POST: libraryRoute } = await import("../src/app/api/library/route.ts");
    const res = await libraryRoute(new Request("http://localhost:3000/api/library", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-rsr": "1",
        host: "localhost:3000",
        [ACCESS_EMAIL_HEADER]: "scjimenez00@yahoo.com",
      },
      body: JSON.stringify({ assetId: stored.id, prompt: "Saved by Stephanie" }),
    }));
    assert.equal(res.status, 200);
    const row = t.app.db.prepare("SELECT created_by FROM posts WHERE asset_id = ?").get(stored.id) as { created_by: string | null };
    assert.equal(row.created_by, "Stephanie");
  } finally {
    delete g.__rsrApp;
    t.cleanup();
  }
});
