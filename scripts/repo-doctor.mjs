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
// ZERO files. A directory holding even one file is reported under ORPHANED FOLDERS and
// never touched — orphaned worktrees have historically held the only copy of real work.
// The zero-file test also satisfies AGENTS.md's "never delete a .xlsx or .pdf" rule by
// construction; it is re-asserted explicitly before each removal anyway.
//
// THE THIRD CATEGORY. Added 2026-09-05. LIVE and HUSKS split on `isRegistered ||
// hasGitEntry`, which files a DEREGISTERED folder by whatever its leftover `.git` stub
// decides — stub present and it counted as a LIVE WORKTREE, the heading that reads as
// healthy. On 2026-09-04 that hid 861 lines of unsaved work in a folder this report had
// just called fine. ORPHANED FOLDERS keys on REGISTRATION instead and answers by CONTENT,
// holding every file against main's blob, because a file count cannot tell a leftover
// checkout from the only copy of an afternoon. It is report-only and disjoint from --fix's
// input by construction; see scripts/repo-doctor-orphaned-folders.mjs.
//
// THE FOURTH CATEGORY: LOAD-BEARING. Added 2026-10-09, after this report talked three
// separate sessions into breaking the machine in one day. A zero-file folder can still be
// the thing the PRIMARY's module resolution runs through. `_wt-reconcile-deductions` held
// exactly one entry — a `node_modules` junction back to the primary — because a `pnpm run`
// inside that worktree had rewritten all 68 of the primary's top-level package links to
// absolute paths routed through it. Delete the folder and every one of those links dangles
// at once: nothing can import `@supabase/supabase-js`, in the primary and in every worktree
// that junctions into it. The report called it "ZERO files — safe to delete", `--fix` acted
// on it, and the first command run afterwards died with ERR_MODULE_NOT_FOUND. Three times.
//
// So the husk test now asks one more question, and it is a question about PROOF rather than
// about the folder's name: does any of the primary's own package links resolve THROUGH this
// directory? If it does, the folder is load-bearing and is reported under its own heading,
// never under HUSKS — which keeps it out of `--fix`'s input set by construction, the same
// way ORPHANED FOLDERS is. A name-based exception would have been worthless here: the next
// worktree to be retired after a stray `pnpm run` gets the same way, under a different name.
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
//   node scripts/repo-doctor.mjs --snapshot-xlsx  # COPY untracked xlsx/ sheets to the DR set (the
//                                            #    only flag that writes outside this repo)
//   node scripts/repo-doctor.mjs --deep      # ...also names every unlinked memory file, not the
//                                            #    first 20, and every one reachable via AGENTS.md,
//                                            #    and every at-risk file in an ORPHANED folder
//                                            #    rather than the first 10 of each group
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
import {
  classifyMemoryReachabilityAcrossRefs,
  memoryReachabilityLines,
  readModuleMemoryText,
  readReachabilityTextAtRef,
} from "./memory-index-reachability.mjs";
import { cloudMirrorDrift, cloudMirrorDriftReport, crlfToLf } from "./cloud-mirror-drift.mjs";
import { readCloudMirror } from "./cloud-mirror-source.mjs";
import { classifyBranchPr, listBranchPrs } from "./branch-pr-state.mjs";
import { commitDeltaLandedOnMain } from "./delta-landed.mjs";
import { countUnpushedCommits } from "./repo-doctor-unpushed.mjs";
import {
  classifyLooseObjects,
  classifyMaintenanceConfig,
  classifyMaintenanceLock,
  parseGitConfigList,
  parseLooseObjectCount,
} from "./repo-doctor-git-maintenance.mjs";
import { archivePushTarget, listArchiveRefs, strandedArchives } from "./repo-doctor-archive-refs.mjs";
// NOT from check-required-checks.mjs: that file is a CLI and runs its whole report at import time.
import { compareToProtection, declaredRequiredChecks, readProtectionContexts } from "./required-check-names.mjs";
// Same reason for check-dependabot-alerts.mjs: the CLI reports at import time, so the read and the
// judgement come from the module it shares with the test.
import { alertsEnabled, judgeAlerts, readOpenAlerts } from "./dependabot-alerts.mjs";
import { classifySupabaseLink } from "./repo-doctor-supabase-link.mjs";
// THE FOURTH CATEGORY (see the header). Its own file for the usual reason — this one reports at
// import time — and because the property it decides is a runtime one: what real junctions on a real
// disk say, which is what `tests/repo-doctor-load-bearing.test.ts` drives it against.
import {
  directoriesLinkedThrough,
  isLoadBearing,
  linksThroughFolder,
} from "./repo-doctor-load-bearing.mjs";
import { sessionHoldReason } from "./repo-doctor-session-hold.mjs";
import { buildCacheIdleMinutes, livenessVerdict, readHolderProbe } from "./worktree-liveness.mjs";
// The queued-job half of "is somebody using this": a process that has NOT YET entered a worktree
// (a `cd <wt> && node waiter.mjs && next dev` chain) has no cwd in it for the PEB sweep to read.
import { readProcessProbe, referenceHoldReason } from "./worktree-references.mjs";
import {
  classifyOrphanedFolder,
  orphanedFolderLines,
  REGENERABLE_DIRS,
} from "./repo-doctor-orphaned-folders.mjs";
import {
  classifyXlsxSnapshot,
  readSnapshots,
  readSourceFiles,
  snapshotRootFor,
  takeXlsxSnapshot,
  xlsxSnapshotLines,
} from "./repo-doctor-xlsx-snapshot.mjs";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "repo-doctor",
  entry: import.meta.url,
  known: ["--deep", "--fix", "--force", "--no-auth", "--snapshot-xlsx", "--strip-idle"],
  hints: [
    "a bare run only reads; --fix repairs husks, --snapshot-xlsx backs up xlsx/, --no-auth skips the production alerts read",
  ],
});

const args = process.argv.slice(2);
const deep = args.includes("--deep");
const fix = args.includes("--fix");
const force = args.includes("--force");
const skipAuth = args.includes("--no-auth");
const snapshotXlsx = args.includes("--snapshot-xlsx");
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
 * Every directory the PRIMARY's own package links resolve through — read this early, because BOTH
 * destructive passes have to consult it: --fix (the husk bucket, below) and --strip-idle (its fifth
 * gate, in `stripIdleVerdict`). One read, one answer, so the two passes cannot disagree about which
 * folder is holding the primary's dependencies together.
 */
const linkedThrough = directoriesLinkedThrough(primaryRoot);

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

/**
 * Path entries held by a worktree's regenerable build caches.
 *
 * A worktree's `node_modules` is normally a JUNCTION to the primary's (scripts/new-session.mjs),
 * and `walk` follows the root it is handed, so walking the junction counted the PRIMARY's whole
 * tree once per worktree: three worktrees reported 70,720 entries each (212,160 "reclaimed", the
 * same constant three times) when stripping one removed a single link and freed nothing. A link is
 * one path entry; only a real directory is walked.
 */
function cacheEntries(dir) {
  let n = 0;
  for (const name of ["node_modules", ".next"]) {
    const p = path.join(dir, name);
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      continue; // absent, or a dangling link: nothing there to reclaim
    }
    if (st.isSymbolicLink()) {
      n += 1;
      continue;
    }
    const w = walk(p);
    n += w.files + w.dirs + w.links;
  }
  return n;
}

/**
 * What --strip-idle can actually give back: `cacheEntries` WITHOUT a node_modules that is a link.
 *
 * A worktree's node_modules is a junction to the primary's tree (AGENTS.md 5). The junction holds
 * no disk — removing it frees nothing — and it is what lets the next `next dev` or test run in that
 * folder resolve a single package. On 2026-09-17 the strip took that junction out of five worktrees
 * (three still in use) to reclaim one path entry each, and the "restore" it printed does not even
 * reach a `.claude/worktrees/*` folder. So the link is never the payload: only `.next`, and a
 * node_modules that is a REAL directory (an install somebody ran by mistake), are.
 */
function reclaimableEntries(dir) {
  let n = 0;
  for (const name of ["node_modules", ".next"]) {
    const p = path.join(dir, name);
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
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
/**
 * The live-session half of the strip gate: the reason a worktree is occupied, or null.
 *
 * A named function rather than an inline call so the one place that decides what --strip-idle
 * deletes under keeps reading as a list of gates. `buildCacheIdleMinutes` is included because a
 * running `next dev` rewrites `.next` continuously, and `.next` is half of what gets deleted here —
 * stripping it under a live dev server breaks the server, not just the cache.
 */
function stripLivenessReason(dir, probe) {
  const verdict = livenessVerdict({ cacheIdleMin: buildCacheIdleMinutes(dir), dir, probe });
  return verdict.live ? verdict.reason : null;
}

function stripIdleVerdict(dir, thresholdMin, probe) {
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

  // FOURTH GATE — THE MIRROR OF AN INVARIANT THIS REPO ALREADY STATES, AND NEVER WIRED BACK.
  // `worktree-liveness.mjs` routed --strip-idle's own mtime measurement INTO the retirable gate, so
  // nothing this pass refuses as possibly-mid-edit can be offered for DELETION by the same run. The
  // reverse was never wired: the holder probe and the session transcripts that the retirable scan
  // consults were never shown to THIS gate.
  //
  // Measured 2026-09-28. One run's husk section reported
  // `.claude/worktrees/busy-hypatia-186800` as holding a live process (claude pid 17760, node pid
  // 22696, powershell pid 21524) and the --strip-idle pass of the SAME run called it "idle 260 min"
  // and emptied its node_modules under that session. Its files really had sat for 260 minutes —
  // because the session was sitting AT A PROMPT, which is precisely the state an mtime cannot see
  // and a process's PEB can. Nothing committed was lost (the strip only takes caches), but the next
  // build in that folder fails with no stated cause, and the restore advice this script prints
  // names `new-session.mjs --repair <task>`, which does not address a `.claude/worktrees/*` folder.
  //
  // `sourceIdleMin` is deliberately NOT passed. livenessVerdict would then apply its own fixed
  // 120-minute window and pre-empt the threshold `--strip-idle=N` exists to set, and its refusal
  // wording duplicates the one below — which `tests/repo-doctor-strip-idle-offer.test.ts` pins as
  // appearing exactly once, because a second copy means a caller re-implementing a gate.
  //
  // Placed BEFORE the mtime check for the reason livenessVerdict gives for its own ordering: a
  // holder read out of the PEB is direct evidence, an mtime is an inference, so when both would
  // fire the reader gets the specific one. A broken probe answers `live`, so not knowing still
  // reads as NOT eligible.
  //
  // A JOB QUEUED ON THE FOLDER IS A HOLD TOO, and it has no process inside the folder yet.
  // 2026-09-17: two worktrees whose sessions had parked `cd <wt> && node wait-for-dev-window.mjs
  // && next dev` chains were stripped as "idle 120+ min", and the dev server would have died with
  // MODULE_NOT_FOUND the moment memory freed up. See worktree-references.mjs.
  const heldBy =
    sessionHoldReason(dir) ??
    stripLivenessReason(dir, probe) ??
    referenceHoldReason(dir, referenceProbe, { baseDirs: [primaryRoot] });
  if (heldBy) return { ok: false, reason: heldBy, idleMin: null };

  // FIFTH GATE — THE SAME DEFECT AS --fix's, ONE LAYER DOWN. --strip-idle deletes a worktree's
  // `node_modules`, and if the PRIMARY's package links resolve through that very directory, the
  // folder surviving is no comfort at all: the chain breaks exactly as it did when `--fix` removed
  // the whole folder on 2026-10-09. This asks the one question that matters and refuses on a yes.
  // Registered worktrees are the input here, so the husk branch above never sees them — the gate
  // has to be repeated rather than inherited.
  if (isLoadBearing(dir, linkedThrough)) {
    return {
      ok: false,
      reason: "the PRIMARY's package links resolve through its node_modules — stripping it breaks the primary",
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
/**
 * Zero-file folders the PRIMARY's module resolution runs through — see THE FOURTH CATEGORY in the
 * header. Disjoint from `husks` by construction, so `--fix` can never reach one.
 */
const loadBearing = [];

/**
 * Every candidate, in one list, so the ORPHANED FOLDERS section below can ask its own question of
 * all of them. It has to: the two buckets here split on `isRegistered || hasGitEntry`, which files
 * a DEREGISTERED folder under `live` whenever a failed `git worktree remove` left its `.git` stub
 * behind — the shape that hid 861 lines of unsaved work on 2026-09-04. See the header of
 * repo-doctor-orphaned-folders.mjs. `live` and `husks` are deliberately UNCHANGED: --fix's input
 * set is the husk list and nothing else, and this pass must not be able to widen it.
 */
const allRows = [];

for (const dir of candidates) {
  const isRegistered = registered.has(canon(dir));
  const hasGitEntry = fs.existsSync(path.join(dir, ".git"));
  const { files, dirs, links, unreadable } = walk(dir);
  const row = { dir, files, dirs, links, isRegistered, hasGitEntry, unreadable };
  allRows.push(row);
  if (isRegistered || hasGitEntry) live.push(row);
  // THE FOURTH CATEGORY, and it is tested BEFORE the husk test on purpose. A load-bearing folder
  // passes every husk test there is — unregistered, no .git, zero files — so the only way it stays
  // out of `husks` is for this branch to take it first. That keeps it out of --fix's input set by
  // construction rather than by a later filter someone can forget to apply.
  else if (isLoadBearing(dir, linkedThrough)) loadBearing.push(row);
  else if (files === 0 && !unreadable) husks.push(row);
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

// ── LOAD-BEARING: the folder that looks like a husk and holds the machine up ───────
//
// Printed even when empty, unlike HUSKS' reclaimable line, because the useful reading on a healthy
// machine is the explicit zero: it says the question was ASKED. Silence here would be
// indistinguishable from the version of this report that deleted the folder three times.
console.log(
  `LOAD-BEARING folders (zero files, but the PRIMARY's packages resolve THROUGH them — NEVER delete): ${loadBearing.length}`,
);
for (const r of loadBearing) {
  const { count, example } = linksThroughFolder(primaryRoot, r.dir);
  console.log(
    `  ${rel(r.dir).padEnd(58)} ${num(count).padStart(9)} of the primary's package links travel through it`,
  );
  if (example) console.log(`    e.g. node_modules/${example} resolves inside this folder`);
  console.log(
    "    Deleting it dangles every one of those links at once — ERR_MODULE_NOT_FOUND in the " +
      "primary and in every worktree junctioned into it.",
  );
  // No command is printed here ON PURPOSE, and `tests/repo-doctor-worktree-restore-advice.test.ts`
  // caught the first draft of this line for it: the only thing that re-points the primary's links
  // is a dependency reinstall in the PRIMARY, and this report may not put that command in anyone's
  // hands — the same spelling run one folder over purges the primary's node_modules (AGENTS.md §5).
  // It is the owner's own call and his own timing, so this names who decides, not how.
  console.log(
    "    It is NOT in --fix's input set. Retiring it for real means re-pointing the PRIMARY's own " +
      "dependency links first — the owner's call and his timing, never a session's.",
  );
}
console.log("");

// ── ORPHANED FOLDERS: the evidence a file count could not give ─────────────────────
//
// This block replaces a NEEDS REVIEW section that printed one padded line per folder and its file
// count. The count was the whole problem: 4,152 files is what a healthy abandoned worktree looks
// like AND what one holding the only copy of an afternoon's work looks like. Everything below
// exists to tell those two apart by CONTENT, per AGENTS.md 2.1 ("Settle by CONTENT ... never a
// timestamp"), and it runs only for folders git does not account for — normally none, so a healthy
// run pays nothing for it.

/** Hard ceiling on files compared per folder. A full checkout is ~5,900; this leaves headroom. */
const ORPHAN_FILE_CAP = 12000;

/**
 * Like {@link execFileSync} through {@link git}, but treats a git exit code of 1 as an ANSWER
 * rather than a failure. `git check-ignore` exits 1 to mean "none of these paths are ignored",
 * which the plain helper cannot distinguish from "git blew up" — and that difference decides
 * whether six copied `.env.*` files are reported as unsaved work in every orphan on the machine.
 */
function gitTolerant(gitArgs, opts = {}) {
  try {
    return execFileSync("git", gitArgs, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
      ...opts,
    });
  } catch (err) {
    if (err && err.status === 1 && typeof err.stdout === "string") return err.stdout;
    return null;
  }
}

/**
 * Files worth comparing, with their sizes and mtimes. {@link REGENERABLE_DIRS} is skipped whole —
 * `node_modules` is a junction to the primary's copy, `.next` is build output, `.git` is git's own
 * bookkeeping, and hashing 45,000 build artefacts to prove they are build artefacts is a slow way
 * to bury the one file that matters.
 */
function comparableFiles(dir) {
  const out = [];
  let truncated = false;
  const visit = (d, prefix) => {
    if (truncated) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (truncated) return;
      if (e.isSymbolicLink()) continue; // never follow — see walk()
      // Skipped by NAME, before the type is looked at. In a worktree `.git` is a FILE holding a
      // `gitdir:` pointer, not a directory, so a directory-only skip let the stub through and
      // reported it as "on NO branch at all" — the loudest line in the section, spent on the one
      // file in the folder that is certainly not anybody's work.
      if (REGENERABLE_DIRS.has(e.name)) continue;
      const abs = path.join(d, e.name);
      const relPath = prefix === "" ? e.name : `${prefix}/${e.name}`;
      if (e.isDirectory()) {
        visit(abs, relPath);
      } else if (e.isFile()) {
        if (out.length >= ORPHAN_FILE_CAP) {
          truncated = true;
          return;
        }
        let size = null;
        let mtimeMs = null;
        try {
          const st = fs.statSync(abs);
          size = st.size;
          mtimeMs = st.mtimeMs;
        } catch {
          /* a file that vanished mid-walk stays null and reads as unproven, never as safe */
        }
        out.push({ path: relPath, abs, size, mtimeMs });
      }
    }
  };
  visit(dir, "");
  return { files: out, truncated };
}

/** main's tree as path -> blob id, or null when main itself could not be read. */
function readMainTree() {
  for (const ref of ["main", "origin/main"]) {
    // -z rather than --format: NUL-separated records are never quoted, so a path holding a space
    // or a non-ASCII byte parses the same as any other. Nine tracked paths here contain spaces.
    const raw = gitTolerant(["-C", primaryRoot, "ls-tree", "-r", "-z", ref]);
    if (raw === null || raw === "") continue;
    const map = new Map();
    for (const record of raw.split("\0")) {
      const tab = record.indexOf("\t");
      if (tab === -1) continue;
      const meta = record.slice(0, tab).split(" ");
      if (meta.length < 3) continue;
      map.set(record.slice(tab + 1), meta[2]);
    }
    if (map.size > 0) return map;
  }
  return null;
}

/**
 * Blob ids for files on disk, via `git hash-object` so the repo's own filters apply. That matters
 * on Windows: core.autocrlf is true and .gitattributes pins `* text=auto eol=lf` with `eol=crlf`
 * for .ps1/.bat/.cmd, so a .ps1 sits CRLF on disk and LF in the blob. Hashing the raw bytes in
 * node would call every one of those files "DIFFERS from main" — a report that cries wolf on a
 * whole file type is a report nobody reads the day it is right.
 */
function hashOnDisk(absPaths) {
  const out = new Map();
  const CHUNK = 100; // ~20k chars of argv, well inside the 32,767 CreateProcess limit
  for (let i = 0; i < absPaths.length; i += CHUNK) {
    const slice = absPaths.slice(i, i + CHUNK);
    const raw = git(["-C", primaryRoot, "hash-object", "--", ...slice]);
    const lines = raw === null ? [] : raw.split("\n").filter(Boolean);
    if (lines.length === slice.length) {
      slice.forEach((p, k) => out.set(p, lines[k]));
      continue;
    }
    // One unreadable file fails the whole batch. Retry singly rather than let it take 99 innocent
    // files down with it and report them all as unproven.
    for (const p of slice) {
      const one = git(["-C", primaryRoot, "hash-object", "--", p]);
      if (one !== null && one !== "") out.set(p, one.split("\n")[0]);
    }
  }
  return out;
}

/** Sizes for a set of blob ids, so "differs" can say how much. */
function blobSizes(hashes) {
  const out = new Map();
  if (hashes.length === 0) return out;
  const raw = gitTolerant(["-C", primaryRoot, "cat-file", "--batch-check"], {
    input: hashes.join("\n") + "\n",
  });
  if (raw === null) return out;
  for (const line of raw.split("\n")) {
    const parts = line.trim().split(" ");
    if (parts.length === 3 && parts[1] === "blob") out.set(parts[0], Number(parts[2]));
  }
  return out;
}

/** Which of these repo-relative paths this repository's ignore rules would exclude. */
function ignoredPaths(relPaths) {
  const out = new Set();
  if (relPaths.length === 0) return out;
  const CHUNK = 2000;
  for (let i = 0; i < relPaths.length; i += CHUNK) {
    const slice = relPaths.slice(i, i + CHUNK);
    // --no-index so a path that is TRACKED here does not make git refuse the whole batch.
    const raw = gitTolerant(["-C", primaryRoot, "check-ignore", "--no-index", "--stdin"], {
      input: slice.join("\n") + "\n",
    });
    if (raw === null) continue;
    for (const line of raw.split("\n")) {
      const p = line.trim();
      if (p !== "") out.add(p);
    }
  }
  return out;
}

const orphanCandidates = allRows.filter((r) => !r.isRegistered);
const orphanVerdicts = [];
if (orphanCandidates.length > 0) {
  const mainTree = readMainTree();
  for (const r of orphanCandidates) {
    // Cheap pre-test: a proven-empty folder with no .git is a husk, and gathering evidence about
    // it would be gathering evidence about nothing. The classifier re-applies this itself — this
    // only avoids the walk.
    const isHusk = !r.hasGitEntry && r.files === 0 && !r.unreadable;
    const { files, truncated } = isHusk ? { files: [], truncated: false } : comparableFiles(r.dir);

    const onDisk = hashOnDisk(files.map((f) => f.abs));
    const ignored = ignoredPaths(files.map((f) => f.path));
    const wanted = [];
    for (const f of files) {
      const mainHash = mainTree === null ? null : (mainTree.get(f.path) ?? null);
      const hash = onDisk.get(f.abs) ?? null;
      if (mainHash !== null && hash !== null && hash !== mainHash) wanted.push(mainHash);
    }
    const sizes = blobSizes(wanted);

    const newestMtimeMs = files.reduce(
      (a, f) => (f.mtimeMs !== null && f.mtimeMs > a ? f.mtimeMs : a),
      0,
    );

    orphanVerdicts.push(
      classifyOrphanedFolder({
        label: rel(r.dir),
        dir: r.dir,
        isRegistered: r.isRegistered,
        hasGitEntry: r.hasGitEntry,
        totalFiles: r.files,
        unreadable: r.unreadable,
        newestMtimeMs: newestMtimeMs === 0 ? null : newestMtimeMs,
        nowMs: Date.now(),
        mainTreeAvailable: mainTree !== null,
        scannedAll: !truncated,
        listLimit: deep ? Number.POSITIVE_INFINITY : 10,
        files: files.map((f) => {
          const mainHash = mainTree === null ? null : (mainTree.get(f.path) ?? null);
          return {
            path: f.path,
            hash: onDisk.get(f.abs) ?? null,
            mainHash,
            size: f.size,
            mainSize: mainHash === null ? null : (sizes.get(mainHash) ?? null),
            ignored: ignored.has(f.path),
          };
        }),
      }),
    );
  }
}

const orphanLines = orphanedFolderLines(orphanVerdicts);
if (orphanLines.length) {
  for (const line of orphanLines) console.log(line);
  console.log("");
}

// ── Retirable registered worktrees: report the commands, never run them ────────────
const merged = [];
/** Worktrees a PR state kept OUT of the list above, each with the reason. Printed, never silent. */
const heldFromRetirement = [];
/** Worktrees a LIVE SESSION kept out, each with the reason. Its own list, never folded into the
 *  PR one: "the work is still in flight" and "somebody is standing in it" are different facts and
 *  a reader who sees the wrong one draws the wrong conclusion about whether it is safe later. */
const heldByLiveSession = [];
// Read ONCE for the whole machine, not once per worktree: the sweep walks every process on the
// system. Null when it could not run at all, which livenessVerdict answers as "cannot rule out a
// live session" rather than as "nobody is there".
const holderProbe = readHolderProbe();
// Same discipline, for the same reason: once for the machine, null when it could not run.
const referenceProbe = readProcessProbe();
for (const r of live) {
  const branch = git(["-C", r.dir, "rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch || branch === "HEAD" || branch === "main" || branch === "master") continue;

  // BEFORE the PR lookup, which costs a `gh` call per branch: a folder somebody is sitting in is
  // not retirable whatever its PR says. Checked here rather than at the printing step below so
  // there is no path — now or after a later edit — on which a removal command for a held folder
  // reaches the screen at all. The commands ARE the interface: they are meant to be pasted, and on
  // 2026-09-08 they were.
  //
  // TWO signals, because each is blind exactly where the other sees, and the folder taken on
  // 2026-09-08 was the overlap:
  //
  //   - sessionHoldReason reads Claude's own transcripts, so it sees a session that has JUST
  //     CLOSED, inside its grace window. No process sweep can — the process is gone. Its own
  //     header records its blind spot: an `_wt-*` session reports the PRIMARY as its cwd, so its
  //     turns are indistinguishable from any other session's.
  //   - livenessVerdict reads each process's working directory out of its PEB, so it sees a
  //     session OPEN BUT IDLE FOR HOURS — which the transcript reads as dead once its newest turn
  //     ages past the window, and an open session between turns is exactly what both lost folders
  //     had.
  //
  // The two overlap on `.claude/worktrees/*` and NEITHER covers `_wt-*`. Both were measured on this
  // machine: every `claude` process reported a `.claude/worktrees/` cwd and not one reported an
  // `_wt-*` folder, because an `_wt-*` session's cwd is the PRIMARY (AGENTS.md 2.1) — which is also
  // why its transcripts land in the primary's project directory. An `_wt-*` folder does sometimes
  // hold a bash or node child, but only while a command is running, which is exactly not when the
  // folder is idle and at risk. Combining these narrows the IDLE gap, not the `_wt-*` one.
  //
  // It also carries the strip-idle invariant: `sourceIdleMin` is the same measurement --strip-idle
  // already used to refuse a worktree as possibly-mid-edit, and never showed to this gate. Without
  // it one half of a single run refused to drop `_wt-code-strand-guard`'s node_modules while the
  // other half printed `git worktree remove` for the whole folder — measured, same report.
  const liveness = livenessVerdict({
    cacheIdleMin: buildCacheIdleMinutes(r.dir),
    dir: r.dir,
    probe: holderProbe,
    sourceIdleMin: idleMinutes(r.dir),
  });
  const heldBy =
    sessionHoldReason(r.dir) ??
    (liveness.live ? liveness.reason : null) ??
    referenceHoldReason(r.dir, referenceProbe, { baseDirs: [primaryRoot] });
  if (heldBy) {
    heldByLiveSession.push(`${rel(r.dir)} (${branch}) — ${heldBy}`);
    continue;
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
  // 🔴 A SHA MISMATCH IS NOT A CONTENT ANSWER. A session that amends or rebases after its PR merges
  // moves the tip without adding anything, and this gate used to hold such a worktree back for ever
  // with "the branch carries work that PR never saw" — about work that had shipped. So when the tip
  // has moved, ask `git cherry`: it compares by PATCH-ID, which is the only instrument that survives
  // a squash merge leaving the branch tip outside main's history. A `-` line means that exact patch is
  // already upstream; a `+` line means it is not. Measured 2026-09-30: `codex/bump-fast-uri-3-1-7` was
  // held on a mismatch while cherry marked its commit `-`, and `codex/mail-stack-nodemailer-10` was
  // held on the same mismatch while cherry marked its commit `+` — the same symptom, two opposite
  // facts, and only the content check tells them apart.
  //
  // Returns null on ANY failure, which the classifier holds back. Never collapse a failed compare
  // into "nothing unmerged": that is the `?? null` discipline this file keeps everywhere else.
  //
  // 🔴 AND A `+` FROM CHERRY IS NOT THE LAST WORD EITHER (owner, 2026-10-02). A patch-id matches only
  // when something upstream carries the SAME diff — which a roll-up's squash never does, and which a
  // `main` that solved the same problem differently never does. Measured that morning on
  // `codex/next-16-3-8-grpc-1-14-5`: `84cb8dd92` ("next 16.3.8 and a grpc-js floor close two HIGH
  // advisories") was `+`, so the worktree was held and the reason NAMED A HIGH ADVISORY — while the
  // `next` bump was on `main` and the grpc-js override was moot, `main` having removed
  // `@google-cloud/logging`, the only path pulling grpc-js in. Dependabot read zero open alerts.
  //
  // So every `+` is re-asked the question patch-id is a means to: is this delta already applied on
  // `main` (delta-landed.mjs, the instrument `rollup-prs.mjs --settle` uses). Only a commit that fails
  // BOTH tests is reported, and any failure to read answers NOT landed, so the worktree is still held —
  // the conservative side, unchanged.
  const cherryProbe = (atTip) => {
    const out = git(["-C", r.dir, "cherry", "-v", "origin/main", atTip]);
    if (out === null) return null;
    const unmerged = [];
    for (const line of out.split(String.fromCharCode(10))) {
      const m = /^\+\s+([0-9a-f]{7,40})\s*(.*)$/.exec(line.trim());
      if (m && !commitDeltaLandedOnMain({ dir: r.dir, sha: m[1] })) unmerged.push({ sha: m[1], subject: m[2] });
    }
    return { unmerged };
  };
  const verdict = classifyBranchPr(listBranchPrs(branch), tip, cherryProbe);
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

// Same reasoning as the block above, for the other reason a worktree can be held: somebody is in
// it. Printed separately because the two facts expire differently — a PR merges and the folder
// becomes retirable, whereas this one clears when a person closes a window, and a reader who
// cannot tell which is which will either wait forever or remove it anyway.
if (heldByLiveSession.length) {
  console.log(`NOT retirable — a session is HOLDING the folder: ${heldByLiveSession.length}`);
  for (const line of heldByLiveSession) console.log(`  ${line}`);
  console.log(
    "  Close the holder first; a worktree removed under a live session leaves it in a DEREGISTERED " +
      "folder, where bare git commands resolve against the primary checkout on `main`.",
  );
  console.log(
    "  Coverage: a transcript read PLUS a sweep of every process's working directory. Together " +
      "they see both a just-closed session and one open but idle for hours.",
  );
  console.log(
    "  A holder need NOT be a session. A stray background process left with its cwd inside a " +
      "worktree pins it just as hard, with no window anywhere to close — trust the PIDs above " +
      "before hunting for a session. Stopping a background TASK does not clear it either: that " +
      "kills the wrapper shell and leaves the child still holding the folder.",
  );
  console.log(
    "  Reliable for `.claude/worktrees/*`. An `_wt-*` folder may appear above when a child command " +
      "happened to be running in it, but its ABSENCE proves nothing: an `_wt-*` session reports " +
      "the PRIMARY as its cwd, so neither signal sees it while it sits idle — UNKNOWN, not " +
      "proven unattended.",
  );
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
  // Said here as well as in its own section, because this verdict is what a tired reader at 4am
  // scrolls to — and the reading that broke the machine three times in one day was exactly this:
  // "nothing is holding that empty folder, so clear it away".
  if (loadBearing.length) {
    console.log(
      `${loadBearing.length} folder(s) look empty but the PRIMARY's packages resolve THROUGH them — ` +
        "listed under LOAD-BEARING above. --fix will NOT touch them, and deleting one by hand breaks " +
        "every session on this machine.",
    );
  }
  // Said again down here because the verdict is what a tired reader scrolls to, and the one thing
  // that must never be lost between the inventory and the verdict is a folder holding work that is
  // in no git ref. It also states what --fix will not do, so the next line of the report cannot be
  // read as an offer to clear these away.
  const alarmingOrphans = orphanVerdicts.filter((v) => v.orphaned && v.severity === "alarm").length;
  if (alarmingOrphans > 0) {
    console.log(
      `${alarmingOrphans} ORPHANED folder(s) may hold the only copy of real work — see the section above. ` +
        "--fix will NOT touch them; it removes proven ZERO-file husks only.",
    );
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
    const cached = reclaimableEntries(r.dir);
    if (cached === 0) continue; // already stripped, or never installed, or only a link
    const verdict = stripIdleVerdict(r.dir, idleThresholdMin, holderProbe);
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
    // orphan here (this local read, and the origin/main read below, both miss an unmerged branch —
    // correctly). An unreadable file yields "", and every memory then falls through to the
    // pre-2026-08-29 answer — a false orphan, never a false "reachable".
    let agentsText = "";
    try {
      agentsText = fs.readFileSync(path.join(primaryRoot, "AGENTS.md"), "utf8");
    } catch {
      // Left empty on purpose. See above: the safe failure is to under-claim reachability.
    }
    // Module memory names a note exactly as AGENTS.md does (backticked), and loads with its module.
    agentsText += "\n" + readModuleMemoryText(primaryRoot);

    // But the working tree read above can ALSO be stale in the other direction: the PRIMARY sitting
    // behind origin/main (see the footprint section below) means a slug merged there minutes ago is
    // absent from THIS AGENTS.md purely because nobody pulled — not because the relocation never
    // happened. Measured 2026-09-05: `main-is-not-the-primary-checkout` reported ORPHAN against a
    // checkout 29 commits behind, and following the advice below would have written a SECOND index
    // line for a hook already backticked on origin/main — the exact duplicate PR #3298 cleaned up.
    // That is a different case from the comment above (an unmerged branch correctly orphaning its
    // own hook): here the destination already shipped, just not to this disk yet. Resolve against
    // origin/main's copy too — the LOCAL remote-tracking ref, no fetch, same offline-cheap tradeoff
    // the footprint section takes below — and call a memory an orphan only when unreachable from
    // BOTH. This does not touch 2.2's opposite (trimming) rule: that one governs REMOVING a line
    // from the checkout you trim FROM, which must still key on what THAT checkout holds, never on
    // what shipped elsewhere.
    //
    // 🔴 AND THE RESCUE COVERS MODULE MEMORY TOO — added 2026-10-08, because until then it covered
    // AGENTS.md ALONE while module memory had become the PRESCRIBED home for a note (§2.2, since
    // 2026-10-02). Measured that morning on the primary at `31d89debe`, 17 commits behind: the five
    // notes the fold filed in #5455 the night before all read ORPHAN, every one of them backticked
    // in a `.claude/rules/*.md` on origin/main — and the advice line below then told the next
    // session to give each an index line, which §2.2 forbids in as many words. The fold runs three
    // times a day, so on a lagging checkout that list GROWS. Same both-refs rule, same ref, same
    // fail-closed degradation: an unreadable ref or a shallow clone yields "" and every memory
    // falls back to the local-only answer.
    const originAgentsText = readReachabilityTextAtRef(primaryRoot, "origin/main");

    const { relocated, orphans, rescuedByOrigin: rescuedByOriginList } = classifyMemoryReachabilityAcrossRefs({
      files: memoryFiles,
      indexText,
      agentsText,
      originAgentsText,
    });
    // Set form for the `.has()` lookup the --deep AGENTS line below needs.
    const rescuedByOrigin = new Set(rescuedByOriginList);

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

    if (rescuedByOrigin.size > 0) {
      console.log(
        "  " +
          rescuedByOrigin.size +
          " file(s) read as ORPHAN against this checkout but are named on origin/main — in its",
      );
      console.log(
        "  AGENTS.md or in one of its .claude/rules/*.md module files. The checkout is behind, not",
      );
      console.log(
        "  the memory. Pull; do NOT give any of these an index line (AGENTS.md 2.2):",
      );
      console.log("  " + [...rescuedByOrigin].map((f) => f.replace(/\.md$/, "")).sort().join(", "));
    }

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
    if (deep) {
      for (const f of relocated) {
        const note = rescuedByOrigin.has(f)
          ? "  (named on origin/main, not yet this checkout — pull to see it locally)"
          : "  (named in AGENTS.md or its module memory — reachable, not an orphan)";
        console.log("  AGENTS  " + f + note);
      }
    }
    for (const f of broken) console.log("  BROKEN  " + f + "  (pointed at by an index, file does not exist)");

    for (const line of memoryReachabilityLines({ relocated, orphans, broken })) console.log(line);
  }
}

// ── CLOUD MIRROR DRIFT (read-only) ─────────────────────────────────────────────────
//
// WHY THIS EXISTS. A cloud session is an isolated clone that never sees `~/.claude`, so
// `.claude/cloud-context/memory-mirror/` IS its Phoenix memory. It is regenerated by
// `sync-cloud-context.mjs` and committed like any other change, which means it is only as fresh as
// its last MERGED refresh — and until 2026-10-02 nothing measured that at all.
//
// Measured that day, and found by accident while auditing a worktree rather than by any check: five
// of 1,061 mirrored files no longer matched the live memory and three memories were missing from the
// mirror outright. One of the five told a cloud session that a production gap was still open 86
// minutes after it had been fixed and its migration applied. The failure is silent by construction —
// cloud cannot see the live memory, so nothing on its side can ever notice — which is why it gets a
// section rather than a habit.
//
// READ-ONLY, and it never touches the exit code, for the same reason as the sections around it: a
// stale mirror is a backlog item, not a broken repo, and a command that fails is one people stop
// running.
{
  console.log("");
  console.log("CLOUD MIRROR (memory files a cloud session would read stale)");

  const memoryDir = memoryDirFor(primaryRoot);
  const checkoutRoot = git(["rev-parse", "--show-toplevel"]) ?? primaryRoot;
  const mirrorDir = path.join(checkoutRoot, ".claude", "cloud-context", "memory-mirror");

  // 🔴 READ FROM `origin/main`, NOT FROM THIS WORKING TREE. A cloud session clones `main`, so that is
  // the copy deciding what it wakes up knowing; the tree on disk only says what a commit from HERE
  // would ship. Measured 2026-10-02, FOUR times in one afternoon: this section reported "2 files
  // DRIFTED" while both were byte-identical to live memory on `origin/main`, every time because the
  // primary was a commit or two behind — which is this repo's normal state, not an edge case, since
  // `main` moves every few minutes. Each false report cost a round of hand-proving it was spurious,
  // and a check that cries wolf is one people switch off. The working tree is kept only as a labelled
  // fallback (`readCloudMirror`), because a fresh clone or a branch predating the mirror has no ref
  // to read.
  //
  // 🔴 AN ABSENT SOURCE MUST NEVER READ AS "no drift". A cloud session running repo-doctor has no
  // memory directory at all, and neither source may be readable — both are "cannot measure", which is
  // a different sentence from "measured, and it is clean". The under-claiming direction is the safe
  // one here exactly as it is for memory reachability above.
  const mirror = memoryDir === null ? null : readCloudMirror({ root: checkoutRoot, diskDir: mirrorDir });
  if (memoryDir === null) {
    console.log("  SKIPPED — no session memory directory here, so there is nothing to compare against.");
    console.log("  (A cloud session HAS no local memory; this check only means anything on the laptop.)");
  } else if (mirror === null) {
    console.log("  -> COULD NOT READ the mirror at " + mirrorDir + " or on origin/main. Do NOT read this as clean.");
  } else {
    const readMd = (dir) => {
      const out = new Map();
      for (const name of fs.readdirSync(dir)) {
        if (!name.toLowerCase().endsWith(".md")) continue;
        // `.bak` copies are deliberate pre-rewrite snapshots, not memories — the same exclusion the
        // reachability section makes, and for the same reason: every compaction would add noise.
        if (name.includes(".bak")) continue;
        try {
          out.set(name, fs.readFileSync(path.join(dir, name), "utf8"));
        } catch {
          // An unreadable file is left out rather than guessed at; it then reports as missing from
          // whichever side could not be read, which is the visible direction.
        }
      }
      return out;
    };

    // The label says WHICH copy was measured, so a reader is never left guessing — and so a fallback
    // to the working tree announces itself rather than passing as the real answer.
    console.log("  " + mirror.label);
    const drift = cloudMirrorDrift({ live: readMd(memoryDir), mirror: mirror.files });
    for (const line of cloudMirrorDriftReport(drift)) console.log(line);

    // ── THE GLOBAL STANDING RULES A CLOUD SESSION READS ──────────────────────────────────────
    //
    // `global-standing-rules.md` sits BESIDE the memory mirror, not inside it, so none of the work
    // above touches it: `cloudMirrorDrift` compares memory files, and the only assertion that
    // mentions this copy checks that `sync-cloud-context.mjs` writes it through `crlfToLf`. Nothing
    // compared it to the live file.
    //
    // 🔴 WHAT THAT COST, measured 2026-10-09: the copy on `origin/main` was 606 bytes behind
    // `~/.claude/CLAUDE.md` and still carried an archive path (`<ext>\_repos\`) that had been
    // corrected hours earlier that morning — after a session read that very path, found nothing
    // there and reported an archive of 1,666 documents as empty. A cloud session had no way to find
    // out: it cannot see the live file, and this is the only copy it gets.
    //
    // The fail direction is deliberate: when either side cannot be read the line says so. A cloud
    // runner has no `~/.claude` at all, and a silent "in step" there would be the worst answer.
    const RULES_IN_MIRROR = ".claude/cloud-context/global-standing-rules.md";
    const liveRulesPath = process.env.PHX_GLOBAL_RULES || path.join(os.homedir(), ".claude", "CLAUDE.md");
    const readRules = () => {
      // Read it from the SAME place the memory mirror was read from, or the label would lie.
      if (mirror.source === "ref") {
        try {
          return execFileSync("git", ["-C", checkoutRoot, "show", `origin/main:${RULES_IN_MIRROR}`],
            { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
        } catch { return null; }
      }
      try { return fs.readFileSync(path.join(checkoutRoot, RULES_IN_MIRROR)); } catch { return null; }
    };
    const mirroredRules = readRules();
    let liveRules = null;
    try { liveRules = fs.readFileSync(liveRulesPath); } catch { /* no ~/.claude here */ }
    if (liveRules === null) {
      console.log("  standing rules  cannot measure — the live " + liveRulesPath + " is not on this machine");
    } else if (mirroredRules === null) {
      console.log("  standing rules  MISSING from the mirror — a cloud session wakes with no global rules");
    } else {
      const mirrored = crlfToLf(mirroredRules).toString("utf8");
      const live = crlfToLf(liveRules).toString("utf8");
      if (mirrored === live) {
        console.log("  standing rules  in step with the live file");
      } else {
        const delta = live.length - mirrored.length;
        console.log(
          "  standing rules  STALE by " + Math.abs(delta) + " char(s) — the mirror holds " +
          mirrored.length + " against the live " + live.length +
          "; run `node scripts/sync-cloud-context.mjs` and ship the refresh",
        );
      }
    }
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

// ── THE REQUIRED-CHECK LIST AGAINST THE LIVE GATE (read-only) ───────────────────────
//
// `tests/required-check-names.test.ts` holds AGENTS.md §2's declaration against the workflows' job
// names, which is the half that lives in files. It cannot read branch protection: CI has no `gh` auth
// for it, and a REQUIRED check that needs network and auth would have to fail open, which is a worse
// property than the gap it would close. So its green proves the docs and the workflows agree with
// EACH OTHER — never with the gate.
//
// This is where the live half belongs, because this command already pages a live API and is nobody's
// merge gate. The list has rotted four times (4 -> 5 -> 6 -> 4, the last on 2026-09-27 when #4527
// folded `lint`+`typecheck`+`test` into one `checks` job), and each time a file went on stating the
// old answer: nineteen of them that day, including the two skills a session follows in order to
// merge. A session that counted to six sat waiting on three checks that can never report again.
//
// READ-ONLY, and it never touches the exit code — the same reasoning as the sections above. Honours
// `--no-auth`, which is what a reader passes when they are offline or without credentials.
{
  console.log("");
  console.log("REQUIRED CHECKS (AGENTS.md §2's declaration against what branch protection requires)");

  if (skipAuth) {
    console.log("  -> skipped (--no-auth). The declaration is in AGENTS.md §2; this check reads the live gate.");
  } else {
    // The PRIMARY's AGENTS.md, never a worktree's: §2's declaration is one fact for the repository,
    // and a worktree holding a half-finished edit to it must not be read as the repo's answer.
    let agentsSource = null;
    try {
      agentsSource = fs.readFileSync(path.join(primaryRoot, "AGENTS.md"), "utf8");
    } catch {
      agentsSource = null; // absent or unreadable — reported below, never read as clean
    }
    const declared = agentsSource === null ? { error: "AGENTS.md could not be read" } : declaredRequiredChecks(agentsSource);

    if (declared.error) {
      console.log(`  -> COULD NOT READ the declaration: ${declared.error.split("\n")[0]}`);
    } else {
      const live = readProtectionContexts();
      if (live.skipped) {
        // Not clean and not broken: a reading it never obtained. Saying which keeps the next reader
        // off the wrong trail — a 403 here was a real three-hour Pro-entitlement lapse on 2026-09-27.
        console.log(`  ${num(declared.names.length)} declared: ${declared.names.join(", ")}`);
        console.log(`  -> COULD NOT READ the gate (${live.skipped}). Do NOT read this as clean.`);
      } else {
        const verdict = compareToProtection(declared.names, live.contexts);
        console.log(`  gate requires ${num(live.contexts.length)}: ${live.contexts.join(", ")}`);
        console.log(`  AGENTS.md §2 declares ${num(declared.count)}: ${declared.names.join(", ")}`);
        if (verdict.ok && declared.count === declared.names.length) {
          console.log("  -> OK. The declared list matches the live gate.");
        } else {
          for (const name of verdict.documentedButNotRequired) {
            console.log(`  -> DRIFT: the docs state \`${name}\` and the gate does NOT require it — a session waits forever.`);
          }
          for (const name of verdict.requiredButNotDocumented) {
            console.log(`  -> DRIFT: the gate requires \`${name}\` and the docs omit it — a session counts to the wrong total.`);
          }
          if (declared.count !== declared.names.length) {
            console.log(`  -> DRIFT: §2's count says ${num(declared.count)} but it lists ${num(declared.names.length)} names.`);
          }
          console.log("     Fix the DOCS to match protection, and every file that states the list in ONE PR:");
          console.log("     node scripts/check-required-checks.mjs   # the same reading, with the file list");
        }
      }
    }
  }
}

// OPEN DEPENDABOT ALERTS THAT WILL FREEZE CI.
//
// `validate` runs `pnpm audit --audit-level=high --prod`, so a HIGH-or-worse advisory against a
// package in the production tree fails EVERY open pull request the moment the audit feed learns it —
// and by AGENTS.md §2.3 a red check suite on a `main` commit makes Railway mark that production
// deploy SKIPPED for good. Measured 2026-09-30: the same dependency passed that step at 16:11 and
// failed it at 16:29 with nothing in the repository having changed; three consecutive deploys were
// withheld that evening. The alert is readable here hours before the audit feed picks it up, so the
// difference between a deliberate bump and a frozen afternoon is only whether anyone looked.
//
// READ-ONLY, and it never touches the exit code — the same reasoning as every section above. Honours
// `--no-auth`. A zero is NOT reported as clean unless alerts are provably switched on: an empty list
// reads identically whether nothing is vulnerable or nobody is looking.
{
  console.log("");
  console.log("DEPENDABOT ALERTS (open advisories, and which of them will fail validate's audit step)");

  if (skipAuth) {
    console.log("  -> skipped (--no-auth). This check reads the live alerts API.");
  } else {
    const read = readOpenAlerts();
    if (read.skipped) {
      // A reading it never obtained, not a clean bill. Saying which keeps the next reader off the
      // wrong trail, exactly as the required-checks section above does.
      console.log(`  -> COULD NOT READ the alerts (${read.skipped}). Do NOT read this as clean.`);
    } else {
      const verdict = judgeAlerts(read, alertsEnabled(read));
      for (const line of verdict.errors) console.log(`  -> ${line}`);
      for (const line of verdict.notes) console.log(`  ${line}`);
      if (verdict.exitCode !== 0) {
        console.log("     node scripts/check-dependabot-alerts.mjs   # the same reading on its own");
      }
    }
  }
}

// WHETHER THE UNTRACKED SPREADSHEETS EXIST ANYWHERE BUT THIS DISK.
//
// The section above proves a COMMIT exists off this laptop. This one asks the same question of the
// one category of file git was never going to answer for: `.gitignore` matches `*.xlsx`, so the
// working spreadsheets in xlsx/ are in no commit, no branch and no archive ref. On 2026-09-05 an
// unidentified sweep deleted every TRACKED pdf in that folder from all seven checkouts at once;
// those came back from git, and the 103 untracked sheets beside them would not have.
//
// Read-only, like every other section here. --snapshot-xlsx is the only flag in this tool that
// writes outside the repository, and it only ever creates files under the snapshot root.
//
// SILENT BY DEFAULT since 2026-09-09, at the owner's instruction. The hourly snapshot job that
// kept this section honest was retired that night ("Phoenix xlsx Snapshot - Hourly", together with
// its Telegram alert), so the coverage figure can only ever age from here. A staleness warning
// about a backup nobody is taking any more is a standing false alarm, and a report that cries wolf
// on every run is how the sections that DO matter stop being read. It still prints when you ask
// for it: --snapshot-xlsx, because you are taking a copy and need the verdict, and --deep, which
// means tell me everything. Nothing about the classifier changed, so re-arming the job restores
// the old behaviour with no code change.
if (snapshotXlsx || deep) {
  const snapshotRoot = snapshotRootFor();
  const sourceFiles = readSourceFiles(primaryRoot);
  const destinationExists = fs.existsSync(snapshotRoot);
  const snapshots = destinationExists ? readSnapshots(snapshotRoot) : [];
  const verdict = classifyXlsxSnapshot({ destinationExists, sourceFiles, snapshots, now: Date.now() });

  for (const line of xlsxSnapshotLines(verdict, { deep, snapshotRoot })) console.log(line);

  if (snapshotXlsx) {
    if (!destinationExists) {
      // Refuse rather than invent the destination. Creating it would put the only copy of 56 MB
      // somewhere nobody has ever looked, on a machine whose backup drive is not attached.
      console.log(`  -> --snapshot-xlsx REFUSED: ${snapshotRoot} does not exist. Nothing was copied.`);
    } else {
      const result = takeXlsxSnapshot({ repoRoot: primaryRoot, snapshotRoot });
      if (result.dir === null) {
        // A DELTA writes nothing on a quiet day. Say which quiet it is — an empty folder and a
        // fully-covered one are the same output otherwise, and only one of them is good news.
        console.log("  -> --snapshot-xlsx: nothing new to copy; every sheet is already in a snapshot.");
      } else {
        console.log(`  -> snapshot written: ${result.dir}`);
        console.log(
          `     ${result.copied} copied, ${result.verified} verified identical by SHA256` +
            (result.skipped ? `, ${result.skipped} already held by an earlier snapshot` : ""),
        );
        if (result.mismatched.length > 0) {
          // A mismatch means the copy on disk is NOT the file. Loud, and never folded into the
          // success line — a partially-good backup that reads as good is the failure this whole
          // section exists to prevent.
          console.log(`     !! ${result.mismatched.length} FILE(S) DID NOT VERIFY — the snapshot is NOT trustworthy:`);
          for (const name of result.mismatched) console.log(`        ${name}`);
        }
      }
    }
  }
}

// WHICH SUPABASE PROJECT THE LOCAL CLI IS POINTED AT.
//
// The section above proves a commit exists off this laptop. This one proves a COMMAND typed in
// this folder goes where you think it goes. Found 2026-09-04: this checkout had been linked to
// "Future Talents Hub" — a live project in the same organization, nothing to do with this app —
// for nineteen days, and AGENTS.md 8 gives the Supabase CLI no approval prompt to catch it.
//
// It has to live here because it cannot live anywhere else: supabase/.temp/ is gitignored, so no
// required check, no test on a PR and no CI job can ever see the link. Classification lives in
// repo-doctor-supabase-link.mjs so a test can drive every branch without a CLI or a network.
//
// Reads primaryRoot, not cwd: the link belongs to the checkout, and a worktree never has one.
//
// READ-ONLY, and it never touches the exit code — the same reasoning as the sections above. It
// PRINTS the unlink command rather than running it: changing where a database command would land
// is not something a hygiene report should do behind someone's back.
{
  console.log("");
  console.log("SUPABASE CLI LINK (which project a bare `supabase db push` here would write to)");

  const linkDir = path.join(primaryRoot, "supabase", ".temp");
  // Absent and unreadable collapse to null on purpose — the one place in this file where that is
  // correct rather than the trap the other sections warn about: a CLI that cannot read its own
  // link file cannot push either way, so both really are "no link is in effect".
  let projectRef = null;
  let linkedName = null;
  try {
    projectRef = fs.readFileSync(path.join(linkDir, "project-ref"), "utf8");
  } catch {
    projectRef = null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(linkDir, "linked-project.json"), "utf8"));
    linkedName = typeof parsed?.name === "string" ? parsed.name : null;
  } catch {
    linkedName = null;
  }

  const verdict = classifySupabaseLink({ projectRef, linkedName });
  if (verdict.severity === "alarm") console.log("  !! " + verdict.state.toUpperCase());
  else if (verdict.severity === "warn") console.log("  ! " + verdict.state.toUpperCase());
  for (const line of verdict.lines) console.log(line);
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
      // `inRepo` marks the half CI can enforce — these two are tracked, the index is not.
      parts.push({ label, bytes: fs.statSync(path.join(primaryRoot, label)).size, inRepo: true });
    } catch (err) {
      // ENOENT means this checkout does not have the file, which is silence. Anything else means it
      // has one we could not size, which must poison the total rather than shrink it.
      if (err?.code !== "ENOENT") parts.push({ label, bytes: null, inRepo: true });
    }
  }
  if (autoloadedIndexBytes !== null) {
    parts.push({ label: "MEMORY.md", bytes: autoloadedIndexBytes, inRepo: false });
  }

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

// WHETHER GIT'S OWN MAINTENANCE RUNS HERE, AND WHETHER IT MAY DELETE WHAT SESSIONS SHARE.
//
// Found 2026-09-17: `objects/maintenance.lock` had sat in the common git directory since
// 2026-08-10, and while it exists every `git maintenance run` does nothing and exits 0 — the
// automatic one commits start, and one typed by hand. 13,456 loose objects (179 MiB) and 396 loose
// ref files had piled up with no error anywhere. The repair has a trap of its own: git 2.55's
// default automatic run executes `git rerere gc` over the one rerere cache every session shares,
// so the data-deleting tasks are pinned off in config, and this section reads the pin back.
// Classification lives in repo-doctor-git-maintenance.mjs so a test can drive every branch.
//
// Reads the COMMON git directory: the lock, the objects and the config belong to the repository,
// not to whichever worktree runs the report.
//
// READ-ONLY, and it never touches the exit code — the same reasoning as the sections above. It
// PRINTS the removal and config commands rather than running them.
{
  console.log("");
  console.log("GIT MAINTENANCE (whether git's own cleanup runs here, and whether it may delete shared state)");

  const lockPath = path.join(commonDir, "objects", "maintenance.lock");
  let lockMtimeMs = null;
  let lockError = null;
  try {
    lockMtimeMs = fs.statSync(lockPath).mtimeMs;
  } catch (error) {
    // Not found is the healthy answer. Any other failure means we could not look, and must not
    // collapse into "no lock" — that is the stall this section exists to catch.
    if (error?.code !== "ENOENT") lockError = error?.code ?? String(error);
  }
  for (const line of classifyMaintenanceLock({ lockPath, lockMtimeMs, lockError, nowMs: Date.now() }).lines) {
    console.log(line);
  }

  // `--list -z`, never `--get-regexp "^maintenance"`: that one exits 1 when nothing matches, and
  // git() returns null for any non-zero exit, so "no pins at all" (the dangerous default) would be
  // indistinguishable from "git failed". `--list` exits 0 whenever the config is readable.
  const configVerdict = classifyMaintenanceConfig(parseGitConfigList(git(["config", "--list", "-z"])));
  for (const line of configVerdict.lines) console.log(line);

  const looseVerdict = classifyLooseObjects(parseLooseObjectCount(git(["count-objects", "-v"])));
  for (const line of looseVerdict.lines) console.log(line);
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
    // Re-prove the fourth category too, and from a FRESH read of the links rather than from the
    // set computed at inventory time. The race is not theoretical here: a parallel session running
    // `pnpm` in a sibling worktree re-points the primary's 68 top-level links mid-run, and this
    // list was built before that happened. Cheap — it runs once per husk, and a healthy machine has
    // none.
    if (isLoadBearing(r.dir, directoriesLinkedThrough(primaryRoot))) {
      console.log(
        `  SKIPPED ${rel(r.dir)} — the PRIMARY's package links now resolve through it (load-bearing).`,
      );
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
  const modulesRemoved = []; // worktrees whose node_modules was a real folder and is now gone
  for (const r of live) {
    const label = rel(r.dir);
    const cached = reclaimableEntries(r.dir);
    if (cached === 0) {
      continue; // already stripped, never installed, or only the node_modules link, which stays
    }
    // Every check is re-run here rather than reused from the inventory above: that data is
    // seconds to minutes old, and this is the moment where being wrong deletes something.
    //
    // The gates themselves live in stripIdleVerdict, shared with the read-only offer, so the
    // number that was advertised and the number that is deleted cannot drift apart the way they
    // did before that function existed. Re-running them is the point; sharing them is what
    // stops a fourth gate being added to one caller and not the other.
    const verdict = stripIdleVerdict(r.dir, idleThresholdMin, holderProbe);
    if (!verdict.ok) {
      console.log(`  SKIP  ${label.padEnd(52)} ${verdict.reason}`);
      continue;
    }
    const idle = verdict.idleMin;
    try {
      for (const name of ["node_modules", ".next"]) {
        const p = path.join(r.dir, name);
        const entry = fs.lstatSync(p, { throwIfNoEntry: false });
        if (!entry) continue;
        // THE node_modules LINK IS NEVER REMOVED, dangling or not: it frees nothing, and a folder
        // that loses it cannot resolve `next` until somebody re-links it by hand.
        if (entry.isSymbolicLink()) continue;
        if (name === "node_modules") modulesRemoved.push(r.dir);
        fs.rmSync(p, { recursive: true, force: true });
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
        ? modulesRemoved.length > 0
          ? " Restore any of them with `node scripts/new-session.mjs --repair <task>` (a" +
            " .claude/worktrees folder: `node scripts/new-session.mjs --repair --nested`) before" +
            ` working there again — only the ${modulesRemoved.length} that lost a REAL node_modules` +
            " folder need it. NEVER `pnpm install` inside a worktree (AGENTS.md 5)."
          : " Every node_modules link was left in place; .next rebuilds itself on the next dev run or build."
        : ""),
  );
}
