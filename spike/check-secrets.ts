// Key-leak / credential scan (Argus F5). Prints rule names, locations and COUNTS only, never values.
//
// Two layers:
//  1. Pattern rules (spike/lib/scan.ts): provider key shapes, bearer/auth-header values, URL credentials,
//     PEM blocks, generic high-entropy secret=value. They need no keys, so they always run (CI-friendly).
//  2. Exact match against XAI_API_KEY / GEMINI_API_KEY if they are in the env: full value, base64 form and
//     12-char head/middle/tail fragments, compared in-process. Skipped (not an error) when no key is loaded.
//
// Targets: the working tree (minus node_modules, which is third-party and git-ignored); every file under .git
// EXCEPT objects/ (config can hold credentials in remote URLs, logs/reflog and COMMIT_EDITMSG hold messages,
// hooks are executable); every git object (loose + packed) read through `git cat-file --batch-all-objects`;
// and `git log --all --reflog -p --binary`. Any git failure aborts with exit 2 (no silent pass).
//
// Exit: 0 clean, 1 findings, 2 scan error, 3 self-test failure.
// Usage: node spike/check-secrets.ts [extra paths...]
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { countKeyHitsDetailed, loadedKeyNames, leakCheckerSelfTest, NEEDLE_KINDS, scrub } from "./lib/secrets.ts";
import { PATTERN_RULES, patternSelfTest, scanText } from "./lib/scan.ts";

const ROOT = join(import.meta.dirname, "..");
const extra = process.argv.slice(2);
const keyNames = loadedKeyNames();
const findings: string[] = [];
let patternHits = 0, exactHits = 0;

function scan(where: string, buf: Buffer): void {
  const text = buf.toString("latin1");
  const ph = scanText(text);
  for (const h of ph) findings.push(`PATTERN ${h.rule} at ${where}:${h.line} (match length ${h.length})`);
  patternHits += ph.length;
  if (keyNames.length) {
    for (const [name, kinds] of Object.entries(countKeyHitsDetailed(text))) {
      const n = Object.values(kinds).reduce((a, b) => a + (b ?? 0), 0);
      exactHits += n;
      findings.push(`EXACT ${name} in ${where}: ${JSON.stringify(kinds)}`);
    }
  }
}

function git(args: string[], maxBuffer = 1 << 30): Buffer {
  try {
    return execFileSync("git", ["-C", ROOT, ...args], { maxBuffer, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const err = e as Error & { stderr?: Buffer };
    console.error(`SCAN ERROR: git ${args.join(" ")} failed: ${scrub(err.stderr?.toString().trim() || err.message)}`);
    process.exit(2);
  }
}

function walk(dir: string, skip: (rel: string, name: string) => boolean, onFile: (p: string) => void): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (skip(relative(ROOT, p), name)) continue;
    const st = statSync(p);
    if (st.isDirectory()) walk(p, skip, onFile);
    else if (st.isFile()) onFile(p);
  }
}

// --- self-tests (positive + negative controls) ---
const pf = patternSelfTest();
if (pf.length) { console.log(`self-test FAILED (patterns): ${pf.join("; ")}`); process.exit(3); }
if (keyNames.length && !leakCheckerSelfTest()) { console.log("self-test FAILED (exact): checker could not detect an in-memory key or fragment"); process.exit(3); }
console.log(`self-test ok: ${PATTERN_RULES.length} pattern rules fired on synthetic samples and stayed quiet on negatives${keyNames.length ? `; exact-match positive control ok for ${keyNames.join(",")}` : ""}`);

// --- working tree ---
let treeFiles = 0;
walk(ROOT, (_rel, name) => name === ".git" || name === "node_modules", (p) => { treeFiles++; scan(relative(ROOT, p), readFileSync(p)); });
let extraFiles = 0;
for (const e of extra) {
  if (!existsSync(e)) { console.error(`SCAN ERROR: extra path ${e} does not exist`); process.exit(2); }
  if (statSync(e).isDirectory()) walk(e, (_r, n) => n === ".git" || n === "node_modules", (p) => { extraFiles++; scan(p, readFileSync(p)); });
  else { extraFiles++; scan(e, readFileSync(e)); }
}

// --- git ---
const GIT_DIR = join(ROOT, ".git");
if (!existsSync(GIT_DIR)) { console.error(`SCAN ERROR: ${GIT_DIR} not found; this scan must cover git history`); process.exit(2); }
let gitMetaFiles = 0;
walk(GIT_DIR, (rel) => rel === join(".git", "objects"), (p) => { gitMetaFiles++; scan(relative(ROOT, p), readFileSync(p)); });

// Object inventory first (independent count), then contents, parsed per object so findings name the object.
const check = git(["cat-file", "--batch-all-objects", "--batch-check"]).toString("utf8").trim().split("\n").filter(Boolean);
const byType: Record<string, number> = {};
for (const l of check) { const t = l.split(" ")[1]; byType[t] = (byType[t] ?? 0) + 1; }
const batch = git(["cat-file", "--batch-all-objects", "--batch"]);
let off = 0, parsed = 0;
while (off < batch.length) {
  const nl = batch.indexOf(0x0a, off);
  if (nl < 0) break;
  const [sha, type, sizeStr] = batch.subarray(off, nl).toString("utf8").split(" ");
  const size = Number(sizeStr);
  if (!/^[0-9a-f]{40,64}$/.test(sha) || !Number.isInteger(size)) { console.error(`SCAN ERROR: unexpected cat-file header at byte ${off}`); process.exit(2); }
  scan(`git object ${sha.slice(0, 12)} (${type})`, batch.subarray(nl + 1, nl + 1 + size));
  off = nl + 1 + size + 1; // content + trailing LF
  parsed++;
}
if (parsed !== check.length) { console.error(`SCAN ERROR: parsed ${parsed} objects but --batch-check listed ${check.length}`); process.exit(2); }
const co = Object.fromEntries(git(["count-objects", "-v"]).toString("utf8").trim().split("\n").map((l) => l.split(": ")));
const logp = git(["log", "--all", "--reflog", "-p", "--binary"]);
scan("git log --all --reflog -p --binary", logp);

console.log(`exact-match: ${keyNames.length ? `keys compared=${keyNames.join(",")} needles/key=${NEEDLE_KINDS.join("+")}` : "SKIPPED (no keys in env); pattern rules still ran"}`);
console.log(`scanned: worktree_files=${treeFiles} extra_files=${extraFiles} git_meta_files=${gitMetaFiles} git_objects=${parsed} (${Object.entries(byType).map(([k, v]) => `${k}=${v}`).join(", ")}; loose=${co.count ?? "?"}, in_pack=${co["in-pack"] ?? "?"}) git_log_bytes=${logp.length}`);
for (const f of findings) console.log(f);
console.log(`pattern_hits=${patternHits} exact_hits=${exactHits}`);
console.log(patternHits + exactHits === 0 ? "RESULT: CLEAN" : "RESULT: FINDINGS (see above)");
process.exit(patternHits + exactHits === 0 ? 0 : 1);
