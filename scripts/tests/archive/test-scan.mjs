// Does the refresh still shrink the net? Two harnesses — the shipped loadRepos and the old one —
// each with its own throwaway archive, each handed a cache holding a tree the scan CANNOT find
// (the harness repo lives under AppData, which findRepos skips) plus one tree that is really gone.
// The shipped form must keep the first and drop the second; the old form must lose both.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import os from "node:os";
// The racers sit beside this file; the harnesses go in a stable temp folder of their own.
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const SP = path.join(os.tmpdir(), "phx-archive-tests").split(path.sep).join("/");
fs.mkdirSync(SP, { recursive: true });
const SRC = "C:/Users/satoh/.claude/scripts";
const REPO = `${SP}/harness-repo`;
const GONE = `${SP}/harness-repo-that-was-removed`;

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`);
  if (!ok) failed++;
};

const OLD_LOADREPOS = `export function loadRepos(refresh) {
  if (!refresh) { try { return JSON.parse(fs.readFileSync(REPOS_FILE, 'utf8')); } catch {} }
  const repos = findRepos();
  try { fs.writeFileSync(REPOS_FILE, JSON.stringify(repos, null, 2)); } catch {}
  return repos;
}`;

const prod = fs.readFileSync(`${SRC}/repo-archive.mjs`, "utf8");
const start = prod.indexOf("/**\n * The repository list, refreshed against the cache");
const end = prod.indexOf("function loadIndex()");
check("the shipped loadRepos is where the harness expects it", start > 0 && end > start);

function buildHarness(name, loadReposSource) {
  const dir = `${SP}/${name}`;
  const arch = `${SP}/${name}-archive`;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(arch, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(arch, { recursive: true });
  const sa = fs.readFileSync(`${SRC}/scratchpad-archive.mjs`, "utf8")
    .replace("export const ARCHIVE = 'F:/Claude Scratchpad Archive';", `export const ARCHIVE = '${arch}';`);
  fs.writeFileSync(`${dir}/scratchpad-archive.mjs`, sa);
  fs.writeFileSync(`${dir}/repo-archive.mjs`, loadReposSource ? prod.slice(0, start) + loadReposSource + "\n\n" + prod.slice(end) : prod);
  // The cache: one tree the scan cannot see, one tree that no longer exists.
  fs.writeFileSync(`${arch}/_repos.json`, JSON.stringify([
    { dir: REPO.split("/").join("\\"), main: REPO.split("/").join("\\"), worktree: false, label: "HARNESS - repo" },
    { dir: GONE.split("/").join("\\"), main: GONE.split("/").join("\\"), worktree: false, label: "HARNESS - removed" },
  ]));
  return dir;
}

// The unfindable-but-present repository.
if (!fs.existsSync(`${REPO}/.git`)) {
  fs.mkdirSync(REPO, { recursive: true });
  execFileSync("git", ["init", "-q", REPO], { stdio: "pipe" });
}
fs.rmSync(GONE, { recursive: true, force: true });
check("the cached tree really is invisible to the scan (AppData is skipped)", fs.existsSync(`${REPO}/.git`));
check("the removed tree really is gone", !fs.existsSync(GONE));

// --- the shipped form -------------------------------------------------------------------
const newDir = buildHarness("harness-new", null);
const { loadRepos: loadNew } = await import(`file:///${newDir}/repo-archive.mjs`);
const after = loadNew(true);
const hasHarness = (list) => list.some((r) => String(r.dir).toLowerCase() === REPO.split("/").join("\\").toLowerCase());
const hasGone = (list) => list.some((r) => String(r.dir).toLowerCase() === GONE.split("/").join("\\").toLowerCase());
check("shipped: the scan found the real repositories", after.length > 40, `${after.length} trees`);
check("shipped: the tree the scan missed is KEPT", hasHarness(after));
check("shipped: the tree that was removed is DROPPED", !hasGone(after));
check("shipped: the kept tree is written back to _repos.json",
  hasHarness(JSON.parse(fs.readFileSync(`${SP}/harness-new-archive/_repos.json`, "utf8"))));

// --- THE BREAK: the old form, same inputs ------------------------------------------------
const oldDir = buildHarness("harness-old", OLD_LOADREPOS);
const { loadRepos: loadOld } = await import(`file:///${oldDir}/repo-archive.mjs`);
const oldAfter = loadOld(true);
check("BREAK fires: the old form LOSES the tree the scan missed", !hasHarness(oldAfter),
  `${oldAfter.length} trees, harness kept = ${hasHarness(oldAfter)}`);
check("BREAK fires: and writes the shortened list over the cache",
  !hasHarness(JSON.parse(fs.readFileSync(`${SP}/harness-old-archive/_repos.json`, "utf8"))));
check("both forms agree on the tree that is genuinely gone", !hasGone(oldAfter));
console.log(`      shipped kept ${after.length} trees; the old form kept ${oldAfter.length}`);

console.log(failed === 0 ? "\nALL SCAN TESTS PASS" : `\n${failed} SCAN TEST(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
