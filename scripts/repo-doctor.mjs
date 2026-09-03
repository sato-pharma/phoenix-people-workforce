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
//   node scripts/repo-doctor.mjs --no-auth   # skip the orphan-auth-user check (offline / no creds)
//   node scripts/repo-doctor.mjs --deep      # ...also names every unlinked memory file, not the
//                                            #    first 20, and every one reachable via AGENTS.md
//
// THE ORPHAN AUTH USER CHECK. Added 2026-08-19 after four Supabase `auth.users` rows were
// found with no Phoenix account behind them — two duplicate employee entries from 20 May, a
// `ZZ-TOUR` test account that still held a live session and refresh token, and a terminated
// employee's login that survived his deactivation. Nothing in the platform deletes an
// `auth.users` row when the app-side account goes: the account disappears, the login stays,
// and no screen in Phoenix lists logins with no account. So they accumulate silently — the
// oldest had sat there for three months. This section is read-only and never deletes; removing
// an auth user is a production mutation and needs the owner's approval per AGENTS.md section 6.
//
// THE MEMORY INDEX CHECK. Added 2026-08-19 after a sweep found 194 of 734 memory files with no
// pointer from MEMORY.md or MEMORY-ARCHIVE.md — written, then unreachable, the oldest since May.
// Only MEMORY.md loads automatically, so an unlinked memory is invisible rather than merely
// hard to find, and the next session re-derives what it already knows. Read-only, like the auth
// check: it names the orphans and the broken pointers, and leaves the judgement to a person.
//
// AND AGENTS.md COUNTS AS REACHABILITY — added 2026-08-29. The check above asked only whether an
// index points at the file, which stopped being the whole question once AGENTS.md section 2.2 made
// RELOCATION the prescribed remedy for an over-budget index: when compression runs out, a hook
// moves into section 2.1 / 2.3 / 4, which CLAUDE.md loads in full with no cliff. Every such move
// therefore produced fresh "orphans" — and, far worse, the advice line told the next session to
// give each one an index line, i.e. to undo the relocation and push MEMORY.md back over budget,
// with this script's authority behind it. Measured the morning six hooks moved out: 7 orphans
// reported, 6 of them relocated on purpose hours earlier. Logic and wording now live in
// memory-index-reachability.mjs, beside each other, for the same reason the budget arithmetic does.
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
//   2. Zero commits whose CONTENT is absent from GitHub. If the work is nowhere upstream, it is
//      not backed up. Reachability alone cannot answer that: `delete_branch_on_merge` is ON, so a
//      merged branch's own remote ref is gone and its commits sit on no origin ref — while the
//      work itself is on main under the squash commit's SHA. `repo-doctor-unpushed.mjs` pairs the
//      reachability sweep with `git cherry` so a squash artifact stops counting and genuinely
//      stranded work still does.
//   3. Idle longer than the threshold, measured from the newest SOURCE write (node_modules,
//      .next and .git excluded — those churn constantly and would mask a dormant worktree).
// Condition 3 is the one that matters most: on 2026-08-04 a worktree that had been clean an hour
// earlier had, by the time it was about to be deleted, a new untracked 211-line migration that
// existed in no other copy anywhere. Idle time is the only signal that a session is not mid-edit.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assessAutoloadFootprint,
  assessMemoryIndexSize,
  autoloadFootprintLines,
  memoryIndexBudgetLines,
} from "./memory-index-budget.mjs";
import { classifyMemoryReachability, memoryReachabilityLines } from "./memory-index-reachability.mjs";
import { classifyBranchPr, listBranchPrs } from "./branch-pr-state.mjs";
import { countUnpushedCommits } from "./repo-doctor-unpushed.mjs";
import { archivePushTarget, listArchiveRefs, strandedArchives } from "./repo-doctor-archive-refs.mjs";

const args = process.argv.slice(2);
const deep = args.includes("--deep");
const fix = args.includes("--fix");
const force = args.includes("--force");
const skipAuth = args.includes("--no-auth");
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
 * Commits that exist ONLY on this laptop. Lives in its own module so a test can drive it against a
 * real squash-merge topology — see the header of `repo-doctor-unpushed.mjs` for why reachability
 * alone got this wrong, and got it wrong in the dangerous direction, on every merged worktree.
 */
function unpushedCount(dir) {
  return countUnpushedCommits(dir);
}

/**
 * The three conditions --strip-idle deletes under, as ONE function.
 *
 * It exists because the read-only offer and the mutating pass disagreed. The offer summed
 * `cacheEntries` over EVERY live worktree and advertised the total; the pass then applied the
 * gates below and stripped only what qualified. On 2026-09-02 that printed "Run with
 * --strip-idle to drop 159,776 path entries", followed on the same machine minutes later by
 * "Stripped 0 worktree(s), 0 path entries reclaimed", because one worktree was being edited and
 * the other held uncommitted work. Neither number was wrong on its own; the offer was answering
 * a question nobody asked (how much cache exists) in the words of the one they did (how much
 * can I get back).
 *
 * The gates are unchanged, and are still re-run at strip time by the call site, where being
 * wrong deletes something. This only makes the advertised figure come from the same test as the
 * deletion, so a gate added in one place cannot silently miss the other.
 *
 * Returns `{ ok: true, reason: null, idleMin }`, or `{ ok: false, reason, idleMin }` where
 * `reason` is the text printed after SKIP. Not knowing always reads as NOT eligible: a git
 * command that fails is a worktree this refuses, never one it strips. `idleMin` is null when
 * the verdict was reached before idleness was measured, so a caller must not print it blind.
 */
function stripIdleVerdict(dir, thresholdMin) {
  const status = git(["-C", dir, "status", "--porcelain"]);
  if (status === null) return { ok: false, reason: "cannot read git status", idleMin: null };
  const dirtyCount = status === "" ? 0 : status.split("\n").filter(Boolean).length;
  if (dirtyCount > 0) {
    return {
      ok: false,
      reason: `${dirtyCount} uncommitted file(s) — exists only on this disk`,
      idleMin: null,
    };
  }

  const unpushed = unpushedCount(dir);
  if (unpushed === null) {
    return { ok: false, reason: "cannot determine what is pushed", idleMin: null };
  }
  if (unpushed > 0) {
    return {
      ok: false,
      reason: `${unpushed} commit(s) found nowhere upstream — not backed up`,
      idleMin: null,
    };
  }

  const idle = idleMinutes(dir);
  if (idle === null) {
    return { ok: false, reason: "cannot read its files to judge idleness", idleMin: null };
  }
  if (idle < thresholdMin) {
    return {
      ok: false,
      reason: `touched ${idle} min ago — a session may be mid-edit`,
      idleMin: idle,
    };
  }

  return { ok: true, reason: null, idleMin: idle };
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
/** Worktrees a PR state kept OUT of the list above, each with the reason. Printed, never silent. */
const heldFromRetirement = [];
for (const r of live) {
  const branch = git(["-C", r.dir, "rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch || branch === "HEAD" || branch === "main" || branch === "master") continue;
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
  // The tip is read HERE, at the gate, and reused verbatim on the printed push line. Never re-read
  // it at deletion time from the branch NAME: a parallel session can delete the branch between this
  // scan and the moment a human copies the commands, and a push spelled by name then fails with the
  // work already unreachable. Measured 2026-08-29 - a branch vanished inside a 2-minute window and
  // its archive survived only because the push carried the SHA rather than the name.
  const tip = git(["-C", r.dir, "rev-parse", "HEAD"]); // null = could not determine
  // Retirability is decided from the NEWEST pull request for this branch, never from the first
  // merged one — see scripts/branch-pr-state.mjs for the whole account. In short: this repository
  // reuses a branch after its PR merges, so "has this branch ever had a merged PR" keeps answering
  // yes for work that has not merged at all. `claude/vigorous-gould-7cdf82` was reported retirable
  // off merged PR #2952 on 2026-09-03 while #2965 was OPEN on the same head and a session was
  // editing in that folder.
  //
  // Anything short of "newest PR merged AND HEAD is still the commit it merged" is held back and
  // NAMED below. A worktree that silently stops appearing reads as one that no longer exists.
  const verdict = classifyBranchPr(listBranchPrs(branch), tip);
  if (verdict.verdict === "retirable") {
    merged.push({ ...r, branch, pr: verdict.pr, dirty, unpushed, tip });
  } else if (verdict.verdict !== "none") {
    heldFromRetirement.push(`${rel(r.dir)} (${branch}) — ${verdict.reason}`);
  }
}

if (merged.length) {
  console.log(
    `RETIRABLE worktrees (newest PR merged, HEAD unmoved since): ${merged.length}`,
  );
  for (const m of merged) {
    // The warning goes on BOTH the header and the `git branch -D` line, on purpose. The header is
    // what a human skims; the branch -D line is what actually gets copied, and copying it is the
    // irreversible step. A caveat that lives only in the header is a caveat that gets scrolled past.
    const warn = [];
    if (m.dirty === null) warn.push("CANNOT READ git status");
    else if (m.dirty) warn.push(`${num(m.dirty)} uncommitted file(s)`);
    if (m.unpushed === null) warn.push("CANNOT DETERMINE what is pushed");
    else if (m.unpushed) warn.push(`${num(m.unpushed)} commit(s) found NOWHERE upstream`);
    const note = warn.length ? `  -- ${warn.join(" + ")}, review before removing` : "";
    console.log(`  PR #${m.pr}  ${m.branch}${note}`);
    console.log(`    git worktree remove "${m.dir}"`);
    // Archive OFF this laptop before the delete, and in that order. `git update-ref
    // refs/deleted-branches/...` is what this repo reached for historically, but that ref lives in
    // this checkout only: a sweep on 2026-08-29 found 17 of 129 such archives existing nowhere
    // else at all. AGENTS.md section 2.1 is explicit that refs/backups/* on ORIGIN is the only copy
    // that survives losing this machine, so that is what gets printed here.
    //
    // The `else` is belt-and-braces since the gate above went PR-aware: a worktree whose tip could
    // not be read is now held back rather than listed, because an unreadable HEAD cannot be
    // compared against the merged head SHA. Kept anyway — this branch prints a STOP, and a check
    // that is merely redundant costs nothing next to one that silently stopped existing.
    if (m.tip) {
      console.log(
        `    git push origin ${m.tip}:refs/backups/${m.branch}    # archive OFF-laptop FIRST - by SHA, never by name`,
      );
    } else {
      console.log("    # STOP - cannot read this worktree's tip SHA, so no archive line can be");
      console.log("    #        printed. Resolve that by hand BEFORE deleting anything.");
    }
    console.log(`    git branch -D ${m.branch}    # -D: a squash merge is never an ancestor of main`);
    if (m.unpushed === null) {
      console.log("    # ^^ STOP — cannot determine what is pushed here. Verify by hand first.");
    } else if (m.unpushed > 0) {
      console.log(
        `    # ^^ STOP — ${num(m.unpushed)} commit(s) hold work found NOWHERE upstream, not even under`,
      );
      console.log("    #    another SHA. That line strands them as dangling objects. Rescue them with");
      console.log("    #    `git branch rescue/<name> <tip>` FIRST — do NOT push this branch. It is");
      console.log("    #    already merged, and pushing a squash-merged branch is what makes a");
      console.log("    #    conflicting PR (AGENTS.md section 2.1).");
    }
    console.log(`    node scripts/repo-doctor.mjs --fix   # then clear the husk it leaves behind`);
  }
  console.log("  Removal needs owner approval (AGENTS.md section 6) — nothing was removed.");
  console.log("");
}

// The other half of the retirability answer, and it has to be printed. A worktree held back is one
// that used to appear under RETIRABLE and now does not, and an unexplained disappearance reads as
// "that folder is gone" rather than "that folder is still in play" — the same distinction the
// --strip-idle offer below draws between "there is no cache" and "there is a great deal of it and
// it is being protected". It is also the only place an UNKNOWN surfaces: gh unreachable on a plane
// puts every branch here, which is correct and must be visible, because the alternative reading of
// an empty RETIRABLE list is "nothing is retirable".
if (heldFromRetirement.length) {
  console.log(`NOT retirable — the newest PR says the work is still in flight: ${heldFromRetirement.length}`);
  for (const line of heldFromRetirement) console.log(`  ${line}`);
  console.log("");
}

// The read-only verdict on the filesystem half, printed here rather than beside its
// `process.exit(0)` further down so it stays next to the counts it is talking about. Guarded
// the same way that exit is: under --fix or --strip-idle these lines would be telling you to
// run the flag you are already running.
if (!fix && !stripIdle) {
  if (husks.length) {
    console.log(`Run with --fix to delete ${husks.length} husk(s) (${num(huskEntries)} empty path entries).`);
  } else {
    console.log("No husks to clear.");
  }
  // Only worktrees that would actually pass the strip gates are counted here. Summing every
  // live worktree's cache instead advertises a saving the command then refuses to deliver:
  // measured on 2026-09-02 as 159,776 path entries offered and 0 reclaimed, one worktree being
  // edited and the other holding uncommitted work. `idleThresholdMin` is its default 120 on
  // this path, since --strip-idle is not set; that is the same threshold the flag itself uses
  // unless you pass --strip-idle=N, so a different N can still move the figure.
  //
  // The held-back worktrees are named rather than quietly dropped. A bare "nothing to reclaim"
  // reads as "there is no cache", when the truth is that there is a great deal of it and it is
  // being protected — a distinction that decides whether the next move is to free space
  // somewhere else or simply to wait.
  let reclaimable = 0;
  let eligible = 0;
  let heldEntries = 0;
  const heldBack = [];
  for (const r of live) {
    const cached = cacheEntries(r.dir);
    if (cached === 0) continue; // already stripped, or never installed
    const verdict = stripIdleVerdict(r.dir, idleThresholdMin);
    if (verdict.ok) {
      eligible++;
      reclaimable += cached;
    } else {
      heldEntries += cached;
      heldBack.push(`${rel(r.dir)} — ${verdict.reason}`);
    }
  }
  if (reclaimable > 0) {
    console.log(
      `Run with --strip-idle to drop ${num(reclaimable)} path entries of node_modules/.next from ` +
        `${eligible} worktree(s) that are clean, fully pushed, and idle ` +
        "(node scripts/new-session.mjs --repair <task> restores them).",
    );
  } else if (heldEntries > 0) {
    console.log(
      "Nothing for --strip-idle to reclaim right now: every worktree holding a cache is one it " +
        "would refuse.",
    );
  }
  if (heldBack.length) {
    console.log(
      `  ${heldBack.length} worktree(s) held back, ${num(heldEntries)} path entries kept:`,
    );
    for (const line of heldBack) console.log(`    ${line}`);
  }
}

// ── Orphan auth users: Supabase logins with no Phoenix account behind them ─────────
//
// Deliberately the LAST thing reported, and deliberately incapable of failing the run.
// Everything above is offline filesystem work that must finish even when there is no network,
// no .env.local and no credentials — a laptop on a plane still needs to clear husks. So every
// failure path here prints a line and moves on; none of them exits non-zero or throws.
//
// It sits ABOVE the mutating modes, and that placement is load-bearing. The read-only path —
// the way this script is run almost every time — used to end in `process.exit(0)` right below,
// so this section's first draft, appended to the end of the file, never executed at all: the
// run printed nothing and looked entirely normal. That exit has since been removed (see the
// mutating-modes comment), which is what lets this section end the process cleanly instead of
// killing it mid-request. Do not move this below those blocks and do not reintroduce the exit.
//
// Zero new dependencies, on purpose. This file boots on node builtins alone and that is worth
// keeping: pulling in @supabase/supabase-js to run two GET requests would make the common
// offline case pay for the rare online one. Node 18+ has global fetch, and both endpoints are
// plain REST — GoTrue's admin user list, and PostgREST for the app's own account table.
//
// READ-ONLY, always. Deleting an auth user is a production mutation that needs the owner's
// approval in conversation (AGENTS.md section 6) — the same report-don't-act stance this file
// already takes for registered worktrees.
//
// WHY IT EXISTS. Added 2026-08-19 after four auth.users rows were found with no Phoenix account
// behind them: two duplicate employee entries from 20 May, a ZZ-TOUR test account still holding
// a live session and refresh token, and a terminated employee's login that outlived his
// deactivation. Nothing in the platform deletes an auth.users row when the app-side account
// goes, and no screen in Phoenix lists logins with no account — so they accumulate unseen. The
// oldest had sat there three months.

/**
 * hr_ids that are SUPPOSED to have a login and no employee-facing account.
 * `admin-HR` is the Phoenix System Administrator — no employees row by design, in daily use.
 * Add here only after confirming an entry is intentional, never to silence a finding you have
 * not explained.
 */
const AUTH_ORPHAN_ALLOWLIST = new Set(["admin-HR"]);

/**
 * Minimal .env reader. Values already in process.env win, so CI and one-off shell overrides
 * behave the way every other script here behaves. Strips a UTF-8 BOM (Windows editors add one,
 * and it would otherwise become part of the first key's name), an `export ` prefix, surrounding
 * quotes, and trailing comments on unquoted values.
 */
function readEnvFile(file) {
  const out = {};
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  // A UTF-8 BOM is stripped by charCode rather than by regex so this file holds no
  // invisible characters of its own.
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, "").trim();
    let value = line.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1);
    if (quoted) {
      value = value.slice(1, -1);
    } else {
      const comment = value.indexOf(" #");
      if (comment !== -1) value = value.slice(0, comment).trim();
    }
    out[key] = value;
  }
  return out;
}

/**
 * GET returning parsed JSON, or an Error. Never throws, and never logs the key.
 *
 * The cleanup in here is not decoration — without it this crashed. The read-only path ends in
 * `process.exit(0)`, and exiting while fetch still holds live handles trips a libuv assertion on
 * Windows (`!(handle->flags & UV_HANDLE_CLOSING)`, src\win\async.c) and returns exit code 127.
 * Reproduced 2026-08-19 on the HTTP 401 branch, which used to return without ever reading the
 * response — leaving an undrained socket behind. Two handles have to go:
 *
 *   1. The body, on EVERY path, success or failure. An unread body keeps its connection open.
 *   2. The timeout timer, cleared in `finally`. `AbortSignal.timeout()` gives no handle to clear,
 *      so this uses an explicit controller and an unref'd timer that cannot hold the loop open.
 *
 * The failure mode is what makes it worth the words: the report printed correctly and looked
 * completely fine, then the process died on the way out, so `repo-doctor` failed while telling
 * you everything was healthy.
 */
async function getJson(url, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  if (typeof timer.unref === "function") timer.unref();
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) {
      await res.text().catch(() => {});
      return new Error("HTTP " + res.status + " " + res.statusText);
    }
    return await res.json();
  } catch (err) {
    if (controller.signal.aborted) return new Error("request timed out after 20s");
    return new Error((err && err.message) || String(err));
  } finally {
    clearTimeout(timer);
  }
}

if (!skipAuth) {
  console.log("");
  console.log("ORPHAN AUTH USERS (Supabase logins with no Phoenix account behind them)");

  const fileEnv = readEnvFile(path.join(primaryRoot, ".env.local"));
  const baseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL || fileEnv.NEXT_PUBLIC_SUPABASE_URL || "")
    .trim()
    .replace(/\/+$/, "");
  const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || fileEnv.SUPABASE_SERVICE_ROLE_KEY || "").trim();

  if (!baseUrl || !serviceKey) {
    console.log("  SKIPPED — no NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in the environment or .env.local.");
    console.log("  Everything above is unaffected. Pass --no-auth to silence this line.");
  } else {
    // Print the project ref, never the key. Which database this ran against is the single most
    // important fact in the output — AGENTS.md section 8 requires the target be shown, and
    // .env.local on this machine points at PRODUCTION.
    const ref = baseUrl.replace(/^https?:\/\//, "").split(".")[0];
    console.log("  project: " + ref + "  (" + baseUrl + ")");

    const headers = { apikey: serviceKey, Authorization: "Bearer " + serviceKey };

    // GoTrue caps per_page at 1000 and returns no total, so page until a short page arrives.
    const authUsers = [];
    let failure = null;
    for (let page = 1; page <= 50; page++) {
      const body = await getJson(baseUrl + "/auth/v1/admin/users?page=" + page + "&per_page=1000", headers);
      if (body instanceof Error) {
        failure = "could not list auth users — " + body.message;
        break;
      }
      const batch = Array.isArray(body && body.users) ? body.users : [];
      authUsers.push(...batch);
      if (batch.length < 1000) break;
    }

    // PostgREST applies its own max-rows ceiling, so page this one too rather than trusting a
    // single unbounded select. A short read here would invent orphans that do not exist.
    const accountHrIds = new Set();
    if (failure === null) {
      for (let offset = 0; offset < 100000; offset += 1000) {
        const body = await getJson(
          baseUrl + "/rest/v1/app_auth_users?select=hr_id&limit=1000&offset=" + offset,
          headers,
        );
        if (body instanceof Error) {
          failure = "could not read app_auth_users — " + body.message;
          break;
        }
        const rows = Array.isArray(body) ? body : [];
        for (const r of rows) if (r && typeof r.hr_id === "string") accountHrIds.add(r.hr_id);
        if (rows.length < 1000) break;
      }
    }

    if (failure !== null) {
      // A failed lookup is reported as a failed lookup, never as a clean result. Silence here
      // would read as "no orphans" — the confidently-wrong outcome AGENTS.md rule 1 exists for.
      console.log("  UNKNOWN — " + failure);
      console.log("  Treat this as 'not checked', not as 'nothing found'.");
    } else {
      // The app matches hr_id EXACTLY, so a case-only difference is a real defect rather than an
      // orphan: the login exists, the account exists, and the two fail to find each other. Seen
      // in production on 2026-08-19, where notification metadata carried "a-16" for "A-16".
      const lowerToAccount = new Map();
      for (const id of accountHrIds) lowerToAccount.set(id.toLowerCase(), id);

      const orphans = [];
      const casing = [];
      for (const u of authUsers) {
        const meta = (u && u.user_metadata) || {};
        const appMeta = (u && u.app_metadata) || {};
        const raw = typeof meta.hr_id === "string" ? meta.hr_id : typeof appMeta.hr_id === "string" ? appMeta.hr_id : "";
        const label = raw.trim() === "" ? null : raw.trim();
        if (label !== null && AUTH_ORPHAN_ALLOWLIST.has(label)) continue;
        if (label !== null && accountHrIds.has(label)) continue;
        const person = typeof meta.name === "string" && meta.name !== "" ? meta.name : "(no name in metadata)";
        const seen = u && u.last_sign_in_at ? String(u.last_sign_in_at).slice(0, 10) : "never";
        const id = (u && u.id) || "(no id)";
        if (label === null) {
          orphans.push({ id, label: "(no hr_id)", person, seen });
        } else if (lowerToAccount.has(label.toLowerCase())) {
          casing.push({ id, label, person, account: lowerToAccount.get(label.toLowerCase()) });
        } else {
          orphans.push({ id, label, person, seen });
        }
      }

      console.log(
        "  " +
          num(authUsers.length) +
          " auth users, " +
          num(accountHrIds.size) +
          " app accounts, " +
          AUTH_ORPHAN_ALLOWLIST.size +
          " allowlisted",
      );
      for (const o of orphans) {
        console.log(
          "  ORPHAN  " + o.label.padEnd(16) + " " + o.person.padEnd(32) + " last sign-in " + o.seen.padEnd(10) + " " + o.id,
        );
      }
      for (const c of casing) {
        console.log(
          "  CASING  " + c.label.padEnd(16) + " " + c.person.padEnd(32) + ' account is "' + c.account + '" ' + c.id,
        );
      }
      if (orphans.length === 0 && casing.length === 0) {
        console.log("  -> none. Every login has an account behind it.");
      } else {
        console.log(
          "  -> " +
            orphans.length +
            " orphan(s), " +
            casing.length +
            " casing mismatch(es). Nothing was changed — deleting an auth user needs the owner's " +
            "approval (AGENTS.md section 6).",
        );
      }
    }
  }
}

/**
 * The session memory directory for THIS checkout, or null if there is none.
 *
 * Claude Code stores per-project memory at `<config>/projects/<slug>/memory`, where the slug is
 * the absolute project path with every non-alphanumeric character replaced by a hyphen — so
 * `F:\Phoenix Workforce\phoenix-workforce` becomes `F--Phoenix-Workforce-phoenix-workforce`
 * (the drive colon and the separator each contribute their own hyphen, which is why the doubled
 * one is correct and not a typo). `CLAUDE_CONFIG_DIR` relocates the config root when set.
 *
 * Returning null rather than guessing matters: this script also runs on machines and in CI
 * checkouts that have no memory directory at all, and a wrong guess there would print findings
 * about someone else's project.
 */
function memoryDirFor(projectRoot) {
  const configRoot = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
  const slug = path.resolve(projectRoot).replace(/[^A-Za-z0-9]/g, "-");
  const dir = path.join(configRoot, "projects", slug, "memory");
  try {
    return fs.statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

// ── MEMORY INDEX INTEGRITY (read-only) ─────────────────────────────────────────────
// WHY THIS EXISTS. Swept 2026-08-19: 194 of the 734 files in this project's memory directory had
// NO pointer from MEMORY.md or MEMORY-ARCHIVE.md. They had been written, then became unreachable —
// the oldest had sat unlinked since May. Only MEMORY.md is loaded into a session automatically, so
// an unlinked file is not "slightly harder to find", it is invisible: nothing recalls it, nothing
// greps it, and the next session re-derives the fact it already contains. The failure is silent by
// construction, which is why it needed a check rather than a habit.
//
// It catches the mirror defect too — a pointer whose file was renamed or deleted, which reads as a
// working index entry right up until someone follows it.
//
// READ-ONLY, ALWAYS. This prints; it never writes an index line and never deletes a memory file.
// Deciding whether an orphan deserves an index line, an archive line, or retirement is a judgement
// about what is still true, and that belongs to a person — the same report-don't-act stance the
// husk and orphan-auth sections take. It also never changes the exit code: an orphan is a backlog,
// not a broken repo, and failing the command would make people stop running it.
// Declared out here so the footprint section below can reuse the very figure the index section
// graded, instead of measuring MEMORY.md a second time. Two numbers for one file in one report is
// how a reader ends up trusting whichever they read first.
let autoloadedIndexBytes = null;

{
  console.log("");
  console.log("MEMORY INDEX (memory files with no pointer, and pointers with no file)");

  const memoryDir = memoryDirFor(primaryRoot);
  if (memoryDir === null) {
    console.log("  SKIPPED — this checkout has no session memory directory.");
    console.log("  Expected " + path.join(process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude"), "projects", "<slug>", "memory") + ".");
  } else {
    // Both indexes count as reachability. MEMORY.md is what loads every session; MEMORY-ARCHIVE.md
    // is where depth and closed items are parked on purpose, and a file pointed at from there is
    // findable by grep, which is the whole contract the archive advertises.
    const INDEX_FILES = ["MEMORY.md", "MEMORY-ARCHIVE.md"];
    const indexText = INDEX_FILES.map((f) => {
      try {
        return fs.readFileSync(path.join(memoryDir, f), "utf8");
      } catch {
        return "";
      }
    }).join("\n");

    // `.bak` copies are deliberate point-in-time snapshots taken before an index rewrite. They are
    // not memories and must never be reported as orphans, or every compaction would create noise.
    const memoryFiles = fs
      .readdirSync(memoryDir)
      .filter((f) => f.endsWith(".md") && !INDEX_FILES.includes(f) && !f.includes(".bak"));

    // AGENTS.md is the third reachable home, per its own section 2.2. Read from primaryRoot, not
    // from the worktree this command happens to run in — the same lookup the memory dir uses, and
    // the one that makes this agree with 2.2's both-halves rule: a relocation is only finished when
    // the destination is MERGED, so a hook written on an unmerged branch SHOULD still read as an
    // orphan here. An unreadable file yields "", and every memory then falls through to the
    // pre-2026-08-29 answer — a false orphan, never a false "reachable".
    let agentsText = "";
    try {
      agentsText = fs.readFileSync(path.join(primaryRoot, "AGENTS.md"), "utf8");
    } catch {
      // Left empty on purpose. See above: the safe failure is to under-claim reachability.
    }

    const { relocated, orphans } = classifyMemoryReachability({
      files: memoryFiles,
      indexText,
      agentsText,
    });

    // A markdown pointer to a `.md` inside the memory directory. Relative links only — an index
    // line may legitimately point at a repo file or a URL, and neither is this check's business.
    const linked = new Set(
      [...indexText.matchAll(/\]\(([^):\s]+\.md)\)/g)].map((m) => m[1]).filter((t) => !t.includes("/")),
    );
    const broken = [...linked]
      .filter((t) => !INDEX_FILES.includes(t) && !fs.existsSync(path.join(memoryDir, t)))
      .sort();

    // Index SIZE is a correctness issue, not a tidiness one: past the loader's cliff the file stops
    // being read in one go and every session silently starts from a partial index. The alarm sits
    // at a BUDGET below that cliff rather than on the cliff itself, because an alarm that only
    // fires once hooks are already being dropped cannot prevent anything. Arithmetic and wording
    // both live in memory-index-budget.mjs so the figure and the sentence cannot drift apart.
    let indexBytes = 0;
    try {
      indexBytes = fs.statSync(path.join(memoryDir, "MEMORY.md")).size;
    } catch {
      // Left at 0, which the assessment reports as UNKNOWN rather than as healthy.
    }

    console.log("  memory: " + memoryDir);
    console.log("  " + num(memoryFiles.length) + " memory files, " + num(linked.size) + " index pointers");
    for (const line of memoryIndexBudgetLines(assessMemoryIndexSize(indexBytes))) console.log(line);
    autoloadedIndexBytes = indexBytes;

    // No silent caps: when the list is long the count that was not printed is stated out loud, and
    // so is the flag that prints the rest. A truncated list that does not say it was truncated
    // reads as "that is all of them", which is the confidently-wrong outcome this repo bans.
    const LIST_LIMIT = 20;
    const shown = deep ? orphans : orphans.slice(0, LIST_LIMIT);
    for (const f of shown) console.log("  ORPHAN  " + f);
    if (orphans.length > shown.length) {
      console.log("  ORPHAN  ... and " + num(orphans.length - shown.length) + " more not listed — re-run with --deep for the full list.");
    }
    // Relocated files are named only under --deep. They are a healthy state, not a backlog, so
    // listing them by default would grow with every relocation and train people to skim past the
    // ORPHAN lines sitting next to them.
    if (deep) for (const f of relocated) console.log("  AGENTS  " + f + "  (named in AGENTS.md — reachable, not an orphan)");
    for (const f of broken) console.log("  BROKEN  " + f + "  (pointed at by an index, file does not exist)");

    for (const line of memoryReachabilityLines({ relocated, orphans, broken })) console.log(line);
  }
}

// ── BRANCH ARCHIVES THAT EXIST ONLY ON THIS LAPTOP (read-only) ─────────────────────
//
// A deleted branch is archived with `git update-ref refs/deleted-branches/<name>` — the deliberate
// step AGENTS.md section 2.1 exists to insist on, because a plain `git branch -D` archives NOTHING.
// What that rule ALSO says, and what practice quietly drifted from, is that the local ref is not a
// backup: refs/backups/* on ORIGIN is the only copy that survives losing this machine.
//
// Measured 2026-08-29 — 17 of 129 archives existed nowhere but this disk. One of them was a branch
// a parallel session deleted about ninety seconds before the only off-laptop copy was pushed, and
// that copy landed only because the push carried the SHA instead of the branch name.
//
// Nothing else measures this. Local archive refs are invisible to `git branch`, refs/backups/* is
// not in the default fetch refspec so they are never pulled back by accident, and CI cannot see a
// local ref at all. The gap is silent by construction, which is why it gets a section.
//
// READ-ONLY, and it never touches the exit code — the same reasoning as the two sections above. A
// missing archive is a backlog item, not a broken repo, and a command that fails is one people
// stop running.
{
  console.log("");
  console.log("BRANCH ARCHIVES (local archive refs with no copy on origin)");

  // Patterns and parsing live in `repo-doctor-archive-refs.mjs` so a test can drive the REAL
  // globs against a throwaway repo; this file runs its whole report at import time and cannot be
  // imported from. `null` means git itself failed and must NOT read as "no archives".
  const archiveRefs = listArchiveRefs();

  if (archiveRefs === null) {
    console.log("  -> COULD NOT READ local archive refs (git failed). Do NOT read this as clean.");
  } else if (archiveRefs.length === 0) {
    console.log("  -> no local archive refs to check.");
  } else {
    // `?? null`, never `?? ""` — the trap this file already documents four times over. git()
    // returns null when the command FAILED and "" when it succeeded with no output, so collapsing
    // the two renders an unreachable remote as "every archive is safely backed up". That inversion
    // would make this check worse than not having it. Not knowing must read LOUDER than clean.
    const remote = git(["ls-remote", "origin"], { timeout: 60000 });

    if (remote === null) {
      console.log(
        `  ${num(archiveRefs.length)} local archive ref(s) found, but ORIGIN COULD NOT BE READ.`,
      );
      console.log("  -> CANNOT DETERMINE whether any of them exist off this laptop. Re-run when the");
      console.log("     remote is reachable. Do NOT read this as clean.");
    } else {
      const onOrigin = new Set(
        remote
          .split("\n")
          .map((line) => line.split("\t")[0])
          .filter(Boolean),
      );
      // Not `!onOrigin.has(sha)`: an archived tip is normally an ordinary ANCESTOR of main, not
      // a ref tip. See strandedArchives for why a remote-tracking ref alone cannot prove it.
      const stranded = strandedArchives(archiveRefs, onOrigin);
      console.log(
        `  ${num(archiveRefs.length)} local archive ref(s), ${num(stranded.length)} with no copy on origin`,
      );

      if (stranded.length === 0) {
        console.log("  -> none. Every archived tip also exists on origin.");
      } else {
        // Own constant: the MEMORY INDEX section's LIST_LIMIT is block-scoped to that block.
        const ARCHIVE_LIST_LIMIT = 20;
        const shown = deep ? stranded : stranded.slice(0, ARCHIVE_LIST_LIMIT);
        for (const entry of shown) {
          console.log(`    git push origin ${entry.sha}:${archivePushTarget(entry.ref)}`);
        }
        if (stranded.length > shown.length) {
          console.log(
            "    ... and " +
              num(stranded.length - shown.length) +
              " more not listed — re-run with --deep for the full list.",
          );
        }
        console.log("  -> these commits exist on this disk ONLY. The lines above are ADDITIVE and");
        console.log("     safe: each creates a new ref on origin and changes no branch, no history.");
      }
    }
  }
}

// THE SECTION ABOVE POLICED A ~21KB FILE AND SAID NOTHING ABOUT THE ~112KB LOADED BESIDE IT.
//
// `CLAUDE.md` pulls `AGENTS.md` in via `@AGENTS.md` in full, so all three of these are re-sent to
// the model on every single request. Only `MEMORY.md` had a budget — and AGENTS.md section 2.2
// prescribes AGENTS.md as the RELIEF VALVE for an over-budget index, on the grounds that it
// "auto-loads in full and has no cliff". Both land in the same context window, so that relocation
// frees nothing: it moves the bytes past the only counter that was watching them. AGENTS.md went
// 32,243 bytes on 2026-08-19 to 146,898 on 2026-08-29 with nothing reporting it.
//
// READ-ONLY and it never touches the exit code, for the same reason as the section above: a
// footprint over budget is a backlog to work off, not a broken repo, and a command that fails is a
// command people stop running.
{
  console.log("");
  console.log("AUTO-LOADED CONTEXT FOOTPRINT (re-sent to the model on every request)");

  const parts = [];
  for (const label of ["CLAUDE.md", "AGENTS.md"]) {
    try {
      parts.push({ label, bytes: fs.statSync(path.join(primaryRoot, label)).size });
    } catch (err) {
      // ENOENT means this checkout does not have the file, which is silence. Anything else means it
      // has one we could not size, which must poison the total rather than shrink it.
      if (err?.code !== "ENOENT") parts.push({ label, bytes: null });
    }
  }
  if (autoloadedIndexBytes !== null) parts.push({ label: "MEMORY.md", bytes: autoloadedIndexBytes });

  const lines = autoloadFootprintLines(assessAutoloadFootprint(parts));
  if (lines.length === 0) {
    console.log("  SKIPPED — this checkout has no auto-loaded instruction files.");
  } else {
    for (const line of lines) console.log(line);
  }

  // THE FIGURE ABOVE IS THE PRIMARY CHECKOUT'S, AND THE PRIMARY IS OFTEN BEHIND.
  //
  // Every section of this report reads primaryRoot, which is right — memory belongs to the project,
  // not to the worktree a session sits in. But a footprint is the one verdict where a stale tree
  // produces a confident, actionable, WRONG answer: measured 2026-08-29 the primary sat 3 commits
  // behind on the pre-#2620 AGENTS.md and this section printed OVER BUDGET for a condition that was
  // not true of `main`. A tired session at 4am acts on that and starts cutting a file that is
  // already inside budget. Naming the commit costs one line and makes the number checkable.
  //
  // Read from the LOCAL remote-tracking ref — no fetch, so this stays offline and cheap, and it
  // under-claims staleness rather than over-claiming it when the ref itself is old.
  const head = git(["rev-parse", "--short", "HEAD"], { cwd: primaryRoot });
  const behind = git(["rev-list", "--count", "HEAD..origin/main"], { cwd: primaryRoot });
  if (head) {
    const suffix = behind && behind !== "0" ? ` — ${behind} commit(s) BEHIND origin/main` : "";
    console.log(`  measured on the primary checkout at ${head}${suffix}.`);
    if (behind && behind !== "0") {
      console.log("  The figure above is that tree's, NOT main's. Pull before acting on it.");
    }
  }
  // Named out loud rather than left to inference: a total quietly missing the index reads as a
  // smaller footprint, and under-reporting is the one direction nobody checks.
  if (autoloadedIndexBytes === null) {
    console.log("  MEMORY.md is NOT counted above — this checkout has no session memory directory.");
  }
}

// ── mutating modes: --fix (husks) and --strip-idle (build caches) ──────────────────
// This used to open with `if (!fix && !stripIdle) process.exit(0)`. That exit is GONE, and must
// not come back: the auth check above runs before it, and calling process.exit() while fetch
// still holds live handles crashes libuv on Windows with exit code 127 — see getJson. Both
// blocks below already test their own flag, so read-only mode simply falls through them and
// the process ends on its own, which is also the only clean way to leave a network handle.
//
// The session guard is the one thing that did NOT test a flag, because the old early exit was
// doing that job for it. It has to test both flags now, or a plain read-only `repo-doctor`
// would abort with exit 1 whenever a second Claude Code session happens to be open.
//
// NARROWED 2026-09-01 (owner-approved): this census now gates --fix ONLY. --strip-idle gets a
// lock instead, immediately below — see that block for the measurements and the reasoning.
// --fix deletes DIRECTORIES and keeps the blunt instrument; --strip-idle deletes only caches
// that `new-session.mjs --repair` restores, and already proves per worktree what this count guesses.
if (fix && !force) {
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

// ── --strip-idle concurrency: a LOCK, not a session census (narrowed 2026-09-01) ───
// The census above is kept verbatim for --fix. It was the WRONG instrument for --strip-idle,
// and provably so rather than arguably: ram-guard.ps1 has invoked --strip-idle every 20 hours
// since 2026-08-26, and it has NEVER ONCE been allowed to run, because this repo is worked
// with 4+ Claude Code sessions open at all times. A guard that never permits the cleanup is
// not protecting anything — it is a cleanup that silently does not exist. Measured
// 2026-09-01: 425,638 reclaimable path entries against 5,595 real project files, and DOUBLING
// inside one night as worktrees went 3 -> 6. That payload is what makes file search here slow
// (AGENTS.md section 5, "Worktree payload ... is what makes this checkout feel slow").
//
// What the census actually proxied for is "something might be using this worktree right now".
// --strip-idle answers that DIRECTLY and per worktree, which a global process count cannot:
// it re-reads git status and skips anything dirty, re-reads what is pushed and skips any
// commit that exists nowhere upstream, requires no file touched for 120+ minutes, and
// verifies the tree survived the strip. A session count cannot distinguish a session editing
// THIS worktree from one editing an unrelated folder — it is strictly less informed.
//
// The one genuine risk the census did cover is two repo-doctors stripping simultaneously.
// That is a mutual-exclusion problem and gets a mutual-exclusion answer. The lock lives in the
// COMMON git dir, so every worktree of this repo contends on the same file.
//
// Deliberately unchanged: --fix still takes the census, --strip-idle still deletes only
// regenerable caches, and --force still overrides everything.
const stripLockPath = path.join(commonDir, "repo-doctor-strip.lock");
const STRIP_LOCK_STALE_MS = 30 * 60 * 1000;

/** True if the pid exists. EPERM means it exists but belongs to someone else — still alive. */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

if (stripIdle && !force) {
  let holder = null;
  try {
    holder = JSON.parse(fs.readFileSync(stripLockPath, "utf8"));
  } catch {
    holder = null; // absent or unreadable/corrupt — treat as free, then overwrite it below
  }
  if (holder && Number.isInteger(holder.pid)) {
    const startedMs = Date.parse(holder.startedAt ?? "");
    const ageMs = Number.isFinite(startedMs) ? Date.now() - startedMs : Infinity;
    // Both conditions must hold to refuse. A dead holder is a crashed run, and an ancient one
    // is a run that died without unlinking — neither should block the cleanup forever, which
    // is the exact failure this whole block exists to stop repeating.
    if (pidAlive(holder.pid) && ageMs < STRIP_LOCK_STALE_MS) {
      fail(
        `another repo-doctor --strip-idle is already running (pid ${holder.pid}, started ` +
          `${holder.startedAt}). Stripping the same worktrees twice at once is the one real ` +
          `race here. Wait for it, or pass --force if you are sure it is dead.`,
      );
    }
  }
  try {
    fs.writeFileSync(
      stripLockPath,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2),
      "utf8",
    );
  } catch (err) {
    // Fail closed, exactly like the census does when it cannot count: not being able to take
    // the lock is precisely when it is least safe to assume nobody else holds it.
    fail(`could not take the strip-idle lock at ${stripLockPath} (${err.message}).`);
  }
  // Synchronous unlink only — see the note above about process.exit() and live fetch handles.
  process.on("exit", () => {
    try {
      const mine = JSON.parse(fs.readFileSync(stripLockPath, "utf8"));
      if (mine?.pid === process.pid) fs.unlinkSync(stripLockPath);
    } catch {
      /* someone else's lock, or already gone — never unlink a lock we do not own */
    }
  });
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
    //
    // The gates themselves live in stripIdleVerdict, shared with the read-only offer, so the
    // number that was advertised and the number that is deleted cannot drift apart the way they
    // did before that function existed. Re-running them is the point; sharing them is what
    // stops a fourth gate being added to one caller and not the other.
    const verdict = stripIdleVerdict(r.dir, idleThresholdMin);
    if (!verdict.ok) {
      console.log(`  SKIP  ${label.padEnd(52)} ${verdict.reason}`);
      continue;
    }
    const idle = verdict.idleMin;
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
      // The restore advice is about worktrees THIS RUN emptied, so it only belongs after a run
      // that emptied one. Trailing it after "Stripped 0 worktree(s)" pointed the word "them" at
      // nothing, and read as though something had been taken away and now needed putting back -
      // the opposite of what a zero means. The NEVER-pnpm warning travels with it deliberately:
      // it is a caveat about running --repair, not a standalone rule that needs saying here.
      (stripped > 0
        ? " Restore any of them with `node scripts/new-session.mjs --repair <task>` before working" +
          " there again — NEVER `pnpm install` inside a worktree (AGENTS.md 5)."
        : ""),
  );
}
