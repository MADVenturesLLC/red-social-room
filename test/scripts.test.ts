// Argus M1 on fa3d359 / L2 on f63676e: `npm start` (outside the container) listens on this computer only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../src/server/config.ts";

const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };

test("Argus M1: `npm start` binds 127.0.0.1 (never 0.0.0.0); only `start:container` and the Dockerfile CMD bind 0.0.0.0 inside the container", () => {
  const start = pkg.scripts.start;
  assert.match(start, /\bnext start\b/);
  assert.match(start, /(?:^|\s)(?:-H|--hostname)\s+127\.0\.0\.1(?:\s|$)/);
  assert.doesNotMatch(start, /0\.0\.0\.0|::(?!1)|\[::\]/);
  assert.equal((start.match(/(?:-H|--hostname)\s/g) ?? []).length, 1, "exactly one host flag");
  assert.match(pkg.scripts["start:container"], /-H 0\.0\.0\.0/);
  assert.match(readFileSync(join(REPO_ROOT, "Dockerfile"), "utf8"), /CMD \[.*"start", "-H", "0\.0\.0\.0"/);
});
