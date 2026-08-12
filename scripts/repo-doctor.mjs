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
//   node scripts/repo-doctor.mjs --strip-idle        # drop node_modules/.next from idle worktrees
//   node scripts/repo-doctor.mjs --strip-idle=480    # ...only if idle 8h+ (default 120 minutes)
//   node scripts/repo-doctor.mjs --fix --force   # skip the concurrent-session guard
//
// WHY --strip-idle EXISTS. The 2026-08-04 cleanup was an hour of manual analysis that reclaimed
// 727,861 paths, and every path of it was `node_modules` and `.next` — regenerable by
// `pnpm install`, never a line of anyone's work. It has to be one command, because the growth is
// relentless: while that cleanup was running, parallel sessions rebuilt ~500,000 paths back. A
// worktree costs ~85,000 paths the moment someone runs `pnpm install` in it, and 12 live worktrees
// is the normal state here. Deleting worktrees is the wrong lever — they hold in-flight branches.
// Deleting their build caches costs nothing but a later `pnpm install`.
//
// THE THREE CONDITIONS, all required, all re-proven immediately before deletion:
//   1. Zero uncommitted files. Something uncommitted exists only on this disk.
//   2. Zero commits absent from every origin ref. If it is not on GitHub, it is not backed up.
//      Checked with `rev-list HEAD --not --remotes=origin`, which is squash-merge-safe — unlike
//      comparing against origin/main, where a squashed branch always looks unmerged.
//   3. Idle longer than the threshold, measured from the newest SOURCE write (node_modules,
//      .next and .git excluded — those churn constantly and would mask a dormant worktree).
// Condition 3 is the one that matters most: on 2026-08-04 a worktree that had been clean an hour
// earlier had, by the time it was about to be deleted, a new untracked 211-line migration that
// existed in no other copy anywhere. Idle time is the only signal that a session is not mid-edit.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const deep = args.includes("--deep");
const fix = args.includes("--fix");
const force = args.includes("--force");
const stripArg = args.find((a) => a === "--strip-idle" || a.startsWith("--strip-idle="));
const stripIdle = stripArg !== undefined;
// Default 120 minutes. Two hours is long enough that a session pausing to think does not lose its
// node_modules mid-task, and short enough to still catch yesterday's abandoned worktrees.
//
// ZERO IS REFUSED, not clamped. The idle test is `idle < threshold`, and computed idle time is
// never negative, so a threshold of 0 means the test can never fire — the guard silently disables
// itself and the tool strips worktrees someone is actively typing in. Two spellings reach it:
// `--strip-idle=0`, and `--strip-idle=` where a trailing-equals typo makes Number("") === 0. The
// empty string is therefore checked before the numeric range, because Number("") is a finite 0 and
// would otherwise sail through. Same failure shape as the concurrent-session guard fixed on #1727:
// the dangerous state is not a wrong value, it is a check that stops being a check.
// (Caught in review on PR #1733.)
const rawThreshold = stripArg?.includes("=") ? stripArg.split("=")[1] : null;
const idleThresholdMin = rawThreshold === null ? 120 : Number(rawThreshold);
if (stripIdle && (rawThreshold === "" || !Number.isFinite(idleThresholdMin) || idleThresholdMin < 1)) {
  console.error(
    `repo-doctor aborted — --strip-idle needs a threshold of at least 1 minute, got ${JSON.stringify(rawThreshold)}. ` +
      "A threshold of 0 would disable the idle check entirely and strip worktrees that are being edited right now.",
  );
  process.exit(1);
}

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

/** Path entries held by a worktree's regenerable build caches. */
function cacheEntries(dir) {
  let n = 0;
  for (const name of ["node_modules", ".next"]) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) continue;
    const w = walk(p);
    n += w.files + w.dirs + w.links;
  }
  return n;
}

/**
 * Minutes since the newest SOURCE write. node_modules/.next/.git are excluded deliberately:
 * they churn on every build and every git command, so including them makes a worktree that
 * nobody has touched in days look active.
 */
function idleMinutes(dir) {
  let newest = 0;
  const skip = new Set(["node_modules", ".next", ".git"]);
  const visit = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!skip.has(e.name)) visit(p);
      } else if (e.isFile()) {
        try {
          const m = fs.statSync(p).mtimeMs;
          if (m > newest) newest = m;
        } catch {
          /* a file that vanished mid-walk cannot be the newest one that matters */
        }
      }
    }
  };
  visit(dir);
  if (newest === 0) return null; // nothing readable — treat as unknown, never as idle
  return Math.floor((Date.now() - newest) / 60000);
}

/**
 * Commits reachable from HEAD but from no origin ref. Squash-merge-safe: comparing against
 * origin/main would report every squashed branch as unpushed, because a squash merge never
 * makes the branch an ancestor of main (AGENTS.md section 2).
 */
function unpushedCount(dir) {
  const out = git(["-C", dir, "rev-list", "HEAD", "--not", "--remotes=origin"]);
  if (out === null) return null; // could not determine — caller must refuse
  return out === "" ? 0 : out.split("\n").length;
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
  // A retirable worktree can hold the only copy of real work in TWO independent ways, and both
  // have to be reported: uncommitted files, and commits that exist on no origin ref. This block
  // used to check only the first, so for a worktree carrying unpushed commits it printed an
  // unqualified `git branch -D` — while the --strip-idle pass below, in the SAME run, refused that
  // very worktree as "not backed up". Hit live 2026-08-12: `_wt-mm-closing` held 2 unpushed
  // commits, another session ran the commands as printed, and `git branch -D` left them reachable
  // only as dangling objects. They were recovered with `git fsck`, but that is luck, not design.
  //
  // `?? null`, never `?? ""` — the same trap the post-strip verification documents further down.
  // git() returns null when the command FAILS and "" when the tree is clean, so collapsing the two
  // renders a failed check as a verified-clean one. Not knowing must read LOUDER than clean, never
  // quieter. Fourth instance of this shape in this file.
  const status = git(["-C", r.dir, "status", "--porcelain"]);
  const dirty = status === null ? null : status.split("\n").filter(Boolean).length;
  const unpushed = unpushedCount(r.dir); // null = could not determine
  if (pr) merged.push({ ...r, branch, pr, dirty, unpushed });
}

if (merged.length) {
  console.log(`RETIRABLE worktrees (PR already merged): ${merged.length}`);
  for (const m of merged) {
    // The warning goes on BOTH the header and the `git branch -D` line, on purpose. The header is
    // what a human skims; the branch -D line is what actually gets copied, and copying it is the
    // irreversible step. A caveat that lives only in the header is a caveat that gets scrolled past.
    const warn = [];
    if (m.dirty === null) warn.push("CANNOT READ git status");
    else if (m.dirty) warn.push(`${num(m.dirty)} uncommitted file(s)`);
    if (m.unpushed === null) warn.push("CANNOT DETERMINE what is pushed");
    else if (m.unpushed) warn.push(`${num(m.unpushed)} commit(s) on NO origin ref`);
    const note = warn.length ? `  -- ${warn.join(" + ")}, review before removing` : "";
    console.log(`  PR #${m.pr}  ${m.branch}${note}`);
    console.log(`    git worktree remove "${m.dir}"`);
    console.log(`    git branch -D ${m.branch}    # -D: a squash merge is never an ancestor of main`);
    if (m.unpushed === null) {
      console.log("    # ^^ STOP — cannot determine what is pushed here. Verify by hand first.");
    } else if (m.unpushed > 0) {
      console.log(
        `    # ^^ STOP — ${num(m.unpushed)} commit(s) exist on NO origin ref. That line strands them as`,
      );
      console.log("    #    dangling objects. Push or `git branch rescue/<name> <tip>` them FIRST.");
    }
    console.log(`    node scripts/repo-doctor.mjs --fix   # then clear the husk it leaves behind`);
  }
  console.log("  Removal needs owner approval (AGENTS.md section 6) — nothing was removed.");
  console.log("");
}

// ── mutating modes: --fix (husks) and --strip-idle (build caches) ──────────────────
if (!fix && !stripIdle) {
  if (husks.length) {
    console.log(`Run with --fix to delete ${husks.length} husk(s) (${num(huskEntries)} empty path entries).`);
  } else {
    console.log("No husks to clear.");
  }
  const reclaimable = live.reduce((a, r) => a + cacheEntries(r.dir), 0);
  if (reclaimable > 0) {
    console.log(
      `Run with --strip-idle to drop ${num(reclaimable)} path entries of node_modules/.next from ` +
        "worktrees that are clean, fully pushed, and idle (pnpm install restores them).",
    );
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

if (fix) {
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
}

// ── --strip-idle: regenerable build caches from provably dormant worktrees ─────────
if (stripIdle) {
  console.log(`--strip-idle: worktrees idle ${idleThresholdMin}+ min, clean, and fully pushed`);
  console.log("");
  let stripped = 0;
  let reclaimed = 0;
  let unverified = 0;
  for (const r of live) {
    const label = rel(r.dir);
    const cached = cacheEntries(r.dir);
    if (cached === 0) {
      continue; // already stripped, or never installed
    }
    // Every check is re-run here rather than reused from the inventory above: that data is
    // seconds to minutes old, and this is the moment where being wrong deletes something.
    const dirty = (git(["-C", r.dir, "status", "--porcelain"]) ?? null);
    if (dirty === null) {
      console.log(`  SKIP  ${label.padEnd(52)} cannot read git status`);
      continue;
    }
    const dirtyCount = dirty === "" ? 0 : dirty.split("\n").length;
    if (dirtyCount > 0) {
      console.log(`  SKIP  ${label.padEnd(52)} ${dirtyCount} uncommitted file(s) — exists only on this disk`);
      continue;
    }
    const unpushed = unpushedCount(r.dir);
    if (unpushed === null) {
      console.log(`  SKIP  ${label.padEnd(52)} cannot determine what is pushed`);
      continue;
    }
    if (unpushed > 0) {
      console.log(`  SKIP  ${label.padEnd(52)} ${unpushed} commit(s) not on any origin ref — not backed up`);
      continue;
    }
    const idle = idleMinutes(r.dir);
    if (idle === null) {
      console.log(`  SKIP  ${label.padEnd(52)} cannot read its files to judge idleness`);
      continue;
    }
    if (idle < idleThresholdMin) {
      console.log(`  SKIP  ${label.padEnd(52)} touched ${idle} min ago — a session may be mid-edit`);
      continue;
    }
    try {
      for (const name of ["node_modules", ".next"]) {
        const p = path.join(r.dir, name);
        if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
      }
      // Prove the source survived. A cache strip that changed the working tree is a bug.
      //
      // `?? null`, never `?? ""`. git() returns null when the command fails, and "" when the
      // tree is clean — collapsing those with `?? ""` makes a FAILED verification print as a
      // verified-clean one, which is the "confidently wrong" outcome AGENTS.md rule 1 exists to
      // stop. A git failure here is plausible rather than theoretical: on Windows, with parallel
      // sessions and antivirus, a status right after deleting ~85,000 files can lose a
      // file-locking race. Third instance of this shape in this file (see the concurrent-session
      // guard and the --strip-idle=0 threshold) — a check that silently stops being a check.
      //
      // The counters below stay unconditional ON PURPOSE, which is a deliberate divergence from
      // the review suggestion to only count verified-clean strips. By the time control reaches
      // here the directories are already deleted — the paths ARE reclaimed, and not counting them
      // would under-report real work and make the totals wrong in the opposite direction. What
      // was missing is not a smaller number, it is the warning surviving into the summary: a
      // reader who only sees the last line must not be told everything was fine. So a suspect
      // strip is counted AND tallied separately, and the summary says so.
      const after = git(["-C", r.dir, "status", "--porcelain"]);
      let verdict;
      if (after === null) {
        verdict = "  !! could NOT verify the tree afterwards — check this worktree by hand";
        unverified++;
      } else {
        const afterCount = after === "" ? 0 : after.split("\n").length;
        verdict = afterCount === 0 ? "" : `  !! tree now shows ${afterCount} changed file(s)`;
        if (afterCount !== 0) unverified++;
      }
      console.log(`  strip ${label.padEnd(52)} -${num(cached)} paths (idle ${idle} min)${verdict}`);
      stripped++;
      reclaimed += cached;
    } catch (err) {
      console.log(`  FAILED ${label} — ${err.message}`);
    }
  }
  console.log("");
  console.log(
    `Stripped ${stripped} worktree(s), ${num(reclaimed)} path entries reclaimed.` +
      (unverified > 0
        ? ` ${unverified} could NOT be verified clean afterwards — check those by hand, they are flagged !! above.`
        : "") +
      " Run `pnpm install` in any of them before working there again.",
  );
}
