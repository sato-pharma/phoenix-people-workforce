#!/usr/bin/env node
// Reports — and optionally removes — the dead weight that makes this checkout slow.
//
// WHY THIS EXISTS. Measured 2026-08-04 on the primary checkout: the folder every tool
// scans held 1,887,820 file paths and took 40s to walk, while the actual project is
// 4,107 tracked files (282ms via `git ls-files`). A 460x amplification. The breakdown:
//
//   .claude/worktrees/   1,563,904 paths   83%   6 live worktrees, ~268k paths each
//   node_modules           271,270 paths   14%
//   .next                   45,651 paths  2.4%
//   real source              ~4,000 paths  0.2%
//
// Every parallel session installs its own node_modules and builds its own .next inside
// the SAME directory tree the primary session's file-search tools walk. Scripts that
// honour .gitignore (tsc, eslint, git) stay fast — status is 97ms, typecheck 16s warm.
// What degrades is everything that does NOT: agent file search, `grep -r`, `dir /s`,
// naive watchers. That is why the repo feels unresponsive while `pnpm run lint` looks fine.
//
// THE RESIDUE BUG THIS CATCHES. `git worktree remove` deletes tracked files and the
// worktree's registry entry, but leaves gitignored directories — node_modules/ and
// .next/ — behind. The leftover is a HUSK: a tree of empty directories with no .git
// file, no registry entry, and zero files. `git worktree prune` cannot see it because
// it is no longer registered, and .claude/hooks/worktree-exit-guard.mjs cannot see it
// because that guard bails when `git rev-parse --git-dir` finds no linked worktree.
// So husks accumulate forever. Six of them held 30,182 empty directories on 2026-08-04.
//
// SAFETY. --fix removes ONLY husks, and a husk is defined by proof, not by name:
// not registered as a worktree, no .git entry, and a full recursive walk finding
// ZERO files. A directory holding even one file is reported as NEEDS-REVIEW and never
// touched — orphaned worktrees have historically held the only copy of real work.
// The zero-file test also satisfies AGENTS.md's "never delete a .xlsx or .pdf" rule by
// construction; it is re-asserted explicitly before each removal anyway.
//
// Removal of REGISTERED worktrees is deliberately never automated. AGENTS.md section 6
// requires separate owner approval for that, so this prints the exact commands instead —
// the same report-don't-act stance as .claude/hooks/worktree-exit-guard.mjs.
//
// Usage:
//   node scripts/repo-doctor.mjs             # inventory + verdict, changes nothing
//   node scripts/repo-doctor.mjs --deep      # also time a full walk of the scanned root
//   node scripts/repo-doctor.mjs --fix       # delete proven husks (empty dir skeletons)
//   node scripts/repo-doctor.mjs --fix --force   # skip the concurrent-session guard
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const deep = args.includes("--deep");
const fix = args.includes("--fix");
const force = args.includes("--force");

function git(gitArgs, opts = {}) {
  try {
    return execFileSync("git", gitArgs, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      ...opts,
    }).trim();
  } catch {
    return null;
  }
}

function fail(message) {
  console.error("repo-doctor aborted — " + message);
  process.exit(1);
}

const commonDir = git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
if (!commonDir) fail("not inside a git repository.");
const primaryRoot = path.resolve(path.dirname(commonDir));
const parentDir = path.dirname(primaryRoot);

/** Windows paths differ in slash and case between git and node — compare canonically. */
const canon = (p) => path.resolve(p).replace(/\\/g, "/").toLowerCase().replace(/\/$/, "");

const registered = new Set(
  (git(["worktree", "list", "--porcelain"]) ?? "")
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => canon(l.slice("worktree ".length))),
);

/**
 * Recursive count that does NOT follow symlinks, and counts them as links rather than
 * files. Both halves matter and each cost a wrong number while writing this:
 *
 *  - Not following them: pnpm's node_modules is a web of directory symlinks into .pnpm.
 *    Following them turns 271k real paths into 1.9M and a 40s walk.
 *  - Not counting them as files: Dirent.isDirectory() is FALSE for a symlink, so the
 *    obvious `else { files++ }` scores every pnpm link as a file. That reported 3,540
 *    files in husks that PowerShell and .NET both (correctly) reported as holding zero,
 *    and it is the difference between "safe to delete" and "needs review". Use isFile().
 */
function walk(dir) {
  let files = 0;
  let dirs = 0;
  let links = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { files, dirs, links, unreadable: true };
  }
  let unreadable = false;
  for (const e of entries) {
    if (e.isSymbolicLink()) {
      links++;
    } else if (e.isDirectory()) {
      dirs++;
      const sub = walk(path.join(dir, e.name));
      files += sub.files;
      dirs += sub.dirs;
      links += sub.links;
      unreadable = unreadable || sub.unreadable;
    } else if (e.isFile()) {
      files++;
    }
  }
  return { files, dirs, links, unreadable };
}

// ── Collect every worktree-shaped folder, wherever this repo puts them ──────────────
const candidates = [];
function addFrom(dir, filter = () => true) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!filter(e.name)) continue;
    candidates.push(path.join(dir, e.name));
  }
}
const isWt = (n) => n.startsWith("_wt-");
addFrom(path.join(primaryRoot, ".claude", "worktrees"));
addFrom(path.join(primaryRoot, ".codex-worktrees"));
addFrom(primaryRoot, isWt);
addFrom(parentDir, isWt);

const live = [];
const husks = [];
const review = [];

for (const dir of candidates) {
  const isRegistered = registered.has(canon(dir));
  const hasGitEntry = fs.existsSync(path.join(dir, ".git"));
  const { files, dirs, links, unreadable } = walk(dir);
  const row = { dir, files, dirs, links, isRegistered, hasGitEntry, unreadable };
  if (isRegistered || hasGitEntry) live.push(row);
  else if (files === 0 && !unreadable) husks.push(row);
  else review.push(row);
}

const rel = (p) => (p.startsWith(parentDir) ? p.slice(parentDir.length + 1) : p);
const num = (n) => n.toLocaleString("en-US");

console.log("repo-doctor — " + primaryRoot);
console.log("");

const tracked = (git(["ls-files"]) ?? "").split("\n").filter(Boolean).length;
console.log(`tracked project files (the real work): ${num(tracked)}`);

if (deep) {
  const started = Date.now();
  const root = walk(primaryRoot);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `scanned-root contents (no symlink following): ${num(root.files)} files, ${num(root.dirs)} dirs, ` +
      `${num(root.links)} links = ${num(root.files + root.dirs + root.links)} path entries — walked in ${secs}s`,
  );
}
console.log("");

console.log(`LIVE worktrees (registered, or holding a .git entry): ${live.length}`);
for (const r of live.sort((a, b) => b.files - a.files)) {
  console.log(
    `  ${rel(r.dir).padEnd(58)} ${num(r.files).padStart(9)} files ${num(r.links).padStart(7)} links${r.isRegistered ? "" : "   [on disk but NOT registered — has .git]"}`,
  );
}
const liveFiles = live.reduce((a, r) => a + r.files, 0);
const liveEntries = live.reduce((a, r) => a + r.files + r.dirs + r.links, 0);
console.log(`  -> ${num(liveFiles)} files, ${num(liveEntries)} total path entries inside worktrees`);
console.log("");

console.log(`HUSKS (unregistered, no .git, ZERO files — safe to delete): ${husks.length}`);
for (const r of husks) {
  console.log(
    `  ${rel(r.dir).padEnd(58)} ${num(r.dirs).padStart(9)} dirs ${num(r.links).padStart(7)} dangling links`,
  );
}
const huskEntries = husks.reduce((a, r) => a + r.dirs + r.links, 0);
if (husks.length) console.log(`  -> ${num(huskEntries)} empty path entries reclaimable`);
console.log("");

if (review.length) {
  console.log(`NEEDS REVIEW (unregistered but HOLDS FILES — never auto-deleted): ${review.length}`);
  for (const r of review) {
    console.log(
      `  ${rel(r.dir).padEnd(58)} ${num(r.files).padStart(9)} files${r.unreadable ? " (partly unreadable)" : ""}`,
    );
  }
  console.log("  Inspect these by hand. An orphaned worktree has held the only copy of real work before.");
  console.log("");
}

// ── Retirable registered worktrees: report the commands, never run them ────────────
const merged = [];
for (const r of live) {
  const branch = git(["-C", r.dir, "rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch || branch === "HEAD" || branch === "main" || branch === "master") continue;
  let pr = null;
  try {
    pr = execFileSync(
      "gh",
      ["pr", "list", "--head", branch, "--state", "merged", "--json", "number", "--jq", ".[0].number"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30000 },
    ).trim();
  } catch {
    pr = null;
  }
  const dirty = (git(["-C", r.dir, "status", "--porcelain"]) ?? "").split("\n").filter(Boolean).length;
  if (pr) merged.push({ ...r, branch, pr, dirty });
}

if (merged.length) {
  console.log(`RETIRABLE worktrees (PR already merged): ${merged.length}`);
  for (const m of merged) {
    const note = m.dirty ? `  -- ${m.dirty} uncommitted file(s), review before removing` : "";
    console.log(`  PR #${m.pr}  ${m.branch}${note}`);
    console.log(`    git worktree remove "${m.dir}"`);
    console.log(`    git branch -D ${m.branch}    # -D: a squash merge is never an ancestor of main`);
    console.log(`    node scripts/repo-doctor.mjs --fix   # then clear the husk it leaves behind`);
  }
  console.log("  Removal needs owner approval (AGENTS.md section 6) — nothing was removed.");
  console.log("");
}

// ── --fix: husks only ──────────────────────────────────────────────────────────────
if (!fix) {
  if (husks.length) {
    console.log(`Run with --fix to delete ${husks.length} husk(s) (${num(huskEntries)} empty path entries).`);
  } else {
    console.log("No husks to clear.");
  }
  process.exit(0);
}

if (!force) {
  // Concurrent destructive cleanup is this repo's documented incident pattern
  // (AGENTS.md section 5). Count Claude Code engines only — Claude Desktop ships as
  // WindowsApps\Claude.exe and runs ~14 processes of its own.
  //
  // This guard FAILS CLOSED. An earlier version set `sessions = null` on any error and
  // then tested `sessions !== null && sessions > 1`, so every way of not knowing — a
  // non-Windows host with no powershell.exe, a timeout, a renamed binary — silently
  // skipped the check and let the destructive path run. Not knowing whether a parallel
  // session is live is precisely when it is least safe to proceed: the absence of a
  // signal is not evidence of safety. If the count cannot be established, refuse and
  // make the caller say --force out loud. (Caught in review on PR #1727.)
  let sessions = null;
  let blindSpot = null;
  if (process.platform !== "win32") {
    blindSpot = `session counting is implemented for Windows only (this host is ${process.platform})`;
  } else {
    try {
      const out = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "@(Get-Process claude -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*claude-code*' }).Count",
        ],
        { encoding: "utf8", timeout: 5000, windowsHide: true },
      );
      const parsed = parseInt(out.trim(), 10);
      if (Number.isFinite(parsed)) sessions = parsed;
      else blindSpot = `could not parse a session count from powershell output ${JSON.stringify(out.trim())}`;
    } catch (err) {
      blindSpot = `could not run the session count (${err.code ?? err.message})`;
    }
  }
  if (blindSpot !== null) {
    fail(
      `${blindSpot}. Refusing to delete anything while blind to how many sessions are live — ` +
        "concurrent cleanup is how this repo lost work before. Pass --force if you are sure.",
    );
  }
  if (sessions > 1) {
    fail(
      `${sessions} Claude Code sessions are running. Another session removing worktrees at the same ` +
        "time is how this repo lost work before. Close the others, or pass --force if you are sure.",
    );
  }
}

let removed = 0;
for (const r of husks) {
  // Re-prove emptiness immediately before deleting: the inventory above may be seconds
  // old, and a parallel session could have started reusing this path.
  const recheck = walk(r.dir);
  if (recheck.files !== 0 || recheck.unreadable) {
    console.log(`  SKIPPED ${rel(r.dir)} — it now holds ${num(recheck.files)} file(s).`);
    continue;
  }
  if (fs.existsSync(path.join(r.dir, ".git")) || registered.has(canon(r.dir))) {
    console.log(`  SKIPPED ${rel(r.dir)} — it became a live worktree.`);
    continue;
  }
  try {
    fs.rmSync(r.dir, { recursive: true, force: true });
    console.log(`  removed ${rel(r.dir)} (${num(r.dirs + r.links)} empty path entries)`);
    removed++;
  } catch (err) {
    console.log(`  FAILED  ${rel(r.dir)} — ${err.message}`);
  }
}
console.log("");
console.log(`Removed ${removed} husk(s). Registered worktrees and anything holding files were left alone.`);
git(["worktree", "prune"]);
console.log("Ran `git worktree prune` to clear any stale registry entries.");
