// A1 pin 17, line 368 (Amendment 1 at 5c773d7): Host allowlist, checked before anything else on every request.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hostName, hostAllowed, allowedHosts, hostGuard, HOST_REFUSED_BODY, DEFAULT_ALLOWED_HOSTS } from "../src/server/hosts.ts";
import { guardPost } from "../src/server/route-util.ts";
import { proxy } from "../src/proxy.ts";
import { REPO_ROOT } from "../src/server/config.ts";

test("A1 pin 17, line 368: host names are compared without the port and case-insensitively; bracketed IPv6 keeps its brackets", () => {
  assert.equal(hostName("LocalHost:3000"), "localhost");
  assert.equal(hostName("127.0.0.1"), "127.0.0.1");
  assert.equal(hostName("[::1]:3000"), "[::1]");
  assert.equal(hostName("[::1]"), "[::1]");
  for (const bad of [null, undefined, "", "   ", "::1", "[::1", "a b", "evil.example:x", "host:1:2", "a/b", "[zz]"]) assert.equal(hostName(bad as string), null, String(bad));
});

test("A1 pin 17, line 368: default list is localhost, 127.0.0.1, [::1]; RSR_ALLOWED_HOSTS adds names (comma-separated, trimmed, port and case ignored)", () => {
  assert.deepEqual([...DEFAULT_ALLOWED_HOSTS], ["localhost", "127.0.0.1", "[::1]"]);
  for (const h of ["localhost:3000", "127.0.0.1:3000", "[::1]:3000", "LOCALHOST"]) assert.equal(hostAllowed(h, undefined), true, h);
  const env = "  Phone.Tailnet-Example.ts.net , other.example:443 ,, ";
  assert.deepEqual([...allowedHosts(env)].sort(), ["127.0.0.1", "[::1]", "localhost", "other.example", "phone.tailnet-example.ts.net"]);
  assert.equal(hostAllowed("PHONE.tailnet-example.TS.NET:443", env), true);
  assert.equal(hostAllowed("other.example", env), true);
  for (const h of [null, "", "attacker.example", "attacker.example:3000", "phone.tailnet-example.ts.net.attacker.example", "localhost.attacker.example", "127.0.0.2"]) assert.equal(hostAllowed(h, env), false, String(h));
});

test("A1 pin 17, line 368: a refused Host gets 403 with the fixed JSON body (the header is never echoed)", async () => {
  const r = hostGuard(new Request("http://x/", { headers: { host: "attacker.example:3000" } }), undefined)!;
  assert.equal(r.status, 403);
  const body = await r.text();
  assert.equal(body, HOST_REFUSED_BODY);
  assert.equal(body.includes("attacker"), false);
  assert.equal(hostGuard(new Request("http://x/"), undefined)!.status, 403, "missing Host");
  assert.equal(hostGuard(new Request("http://x/", { headers: { host: "" } }), undefined)!.status, 403, "empty Host");
  assert.equal(hostGuard(new Request("http://x/", { headers: { host: "127.0.0.1:3000" } }), undefined), null);
});

test("A1 pin 17, line 368: X-Forwarded-Host is ignored in both directions", () => {
  assert.equal(hostGuard(new Request("http://x/", { headers: { host: "attacker.example", "x-forwarded-host": "localhost" } }), undefined)!.status, 403);
  assert.equal(hostGuard(new Request("http://x/", { headers: { host: "localhost:3000", "x-forwarded-host": "attacker.example" } }), undefined), null);
});

test("A1 pin 17, line 368: the POST guard checks Host first (a foreign Host with a wrong content type gets the Host 403, not 415)", async () => {
  const r = guardPost(new Request("http://x/", { method: "POST", headers: { host: "attacker.example", "x-rsr": "1", "content-type": "text/plain", "sec-fetch-site": "same-origin" }, body: "x" }))!;
  assert.equal(r.status, 403);
  assert.equal(await r.text(), HOST_REFUSED_BODY);
});

test("A1 pin 17, line 368: src/proxy.ts gates every path - it refuses a foreign Host and has no matcher that would exclude any path", async () => {
  const refused = proxy(new Request("http://x/settings", { headers: { host: "attacker.example" } }));
  assert.equal(refused?.status, 403);
  assert.equal(proxy(new Request("http://x/_next/static/chunks/a.js", { headers: { host: "localhost:3000" } })), undefined);
  const src = readFileSync(join(REPO_ROOT, "src", "proxy.ts"), "utf8");
  assert.doesNotMatch(src, /\bmatcher\b|export const config/, "no matcher: Next runs Proxy on every request, static files included");
});
