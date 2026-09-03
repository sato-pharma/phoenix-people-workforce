#!/usr/bin/env node
// Worktree backup guard: REPORT ONLY. Acts on nothing, ever.
//
// WHY THIS EXISTS. Worktree sprawl here is not a disk problem, it is a BACKUP problem. A sweep on
// 2026-08-01 found 82 commits across 12 branches that existed only on this laptop — no remote, no
// PR, no CI. Retiring folders was never the bottleneck: new worktrees are created faster than they
// are cleaned up, so the risk regenerates. The value is in NOTICING at the moment the work is about
// to become unreachable.
//
// TWO MODES, because one mode left a hole open for three weeks:
//
//   (default)      SessionEnd. Reports unpushed commits and retirability for the worktree the
//                  session is ending in.
//   --pre-removal  PreToolUse(Bash), invoked by bash-guard.mjs when a command looks like it will
//                  remove a worktree. Runs the same backup check against the TARGET worktree and
//                  logs it BEFORE the directory is deleted. Reads the command text on stdin.
//
// WHY --pre-removal EXISTS (added 2026-08-23). The SessionEnd mode is anchored to the very thing
// being deleted. settings.json launches it as
//   DIR="$(git rev-parse --show-toplevel || pwd)"; node "$DIR/.claude/hooks/worktree-exit-guard.mjs"
// so when a session removes its own worktree and then ends, $DIR no longer resolves, the script
// file itself went with the directory, and node exits MODULE_NOT_FOUND straight into a `|| true`.
// Nothing runs and nothing is logged. Even when the script IS reachable, every git call in a
// deleted cwd returns null and the old code hit `process.exit(0)` on the first line of its logic.
//
// Measured 2026-08-23: `.claude/worktree-exit.log` held ZERO entries that day while three worktree
// sessions ended, and had been frozen since 2026-08-22T02:37. The hook was still registered in
// settings.json and the script was still on disk, so every "is it disabled?" check answered no —
// only the log's silence showed it. The bitter part: the net went missing precisely on the TIDY
// path. A session that merges its PR and cleans up after itself is the one that loses the check,
// while a session that leaves a mess keeps it.
//
// --pre-removal closes that by moving the check to a moment when everything still exists.
//
// WHY IT ONLY REPORTS (changed from auto-push, deliberately). The first version pushed unpushed
// commits itself. That worked, but it quietly contradicted this repo's own settings: permissions.ask
// gates "Bash(git push*)" behind an approval prompt, and HOOKS BYPASS THE PERMISSION SYSTEM
// ENTIRELY — so the hook pushed without asking, which is exactly what that rule exists to prevent.
// A tool that silently does the thing you configured a prompt for is worse than one that tells you
// to do it yourself. The push command is printed ready to paste; running it stays a decision.
//
// WHAT IT DOES NOT DO: push, remove a worktree, delete a branch, commit anything, open/merge a PR,
// or BLOCK a command. --pre-removal never denies — it is a logger, not a gate. Turning it into a
// gate would be a real decision with real friction, not a side effect of a logging fix.
//
// Runs SYNCHRONOUSLY (see .claude/settings.json). Both modes append to
// <primary-repo>/.claude/worktree-exit.log.

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyBranchPr, listBranchPrs } from "../../scripts/branch-pr-state.mjs";

const flags = new Set(process.argv.slice(2).filter((arg) => arg.startsWith("--")));
const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const PRE_REMOVAL = flags.has("--pre-removal");
const cwd = positional[0] || process.cwd();

/** git at an explicit directory, never throwing — a missing ref or deleted cwd yields null. */
function gitAt(at, args, { timeout = 10000 } = {}) {
  try {
    return execFileSync("git", args, { cwd: at, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout }).trim();
  } catch {
    return null;
  }
}
const git = (args, opts) => gitAt(cwd, args, opts);

function gh(args, { timeout = 30000 } = {}) {
  try {
    return execFileSync("gh", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout }).trim();
  } catch {
    return null;
  }
}

const lines = [];
function say(line) {
  lines.push(line);
}

/**
 * Where the log lives. Normally <primary>/.claude/worktree-exit.log, found via --git-common-dir so
 * every worktree's entries land in ONE file. When git resolves nothing (deleted cwd), fall back to
 * this script's own location: it always sits at <root>/.claude/hooks/, so the log is one level up.
 * Without that fallback the deleted-cwd case cannot log the very fact that it IS the deleted-cwd
 * case — which is the bug this file exists to not repeat.
 */
function logFile() {
  const commonDir = git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (commonDir) return join(commonDir, "..", ".claude", "worktree-exit.log");
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "worktree-exit.log");
}

function finish() {
  if (lines.length === 0) process.exit(0);
  const body = lines.join("\n");
  try {
    const file = logFile();
    // Create the directory rather than assuming it: a logger that silently fails because its own
    // folder is missing is the same class of bug as the one this mode was added to fix.
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `\n[${new Date().toISOString()}] ${body}\n`);
  } catch {
    /* logging is a convenience, never a failure mode */
  }
  // systemMessage surfaces it in the UI; stdout keeps it in the transcript. In --pre-removal mode
  // bash-guard.mjs relays this line verbatim as its own hook output.
  process.stdout.write(JSON.stringify({ systemMessage: body }) + "\n");
  process.exit(0);
}

/**
 * Unpushed commits + uncommitted files: the two ways work can be laptop-only.
 *
 * `unpushed` is null when git could not answer. That is NOT the same as zero and must never be
 * rendered as "clean" — an unmeasurable branch is the one you least want to delete.
 *
 * With no upstream the question is not "how far ahead of main" but "what is reachable from NO
 * remote ref at all", which is the test scripts/check-unbacked-branches.ts uses and for its two
 * documented reasons: a branch pushed under a DIFFERENT name is backed up and flagging it is a
 * false alarm, and matching by name over-reports. The old `origin/main..branch` form had a worse
 * failure than either — it returned 0 whenever `origin/main` itself could not be resolved (no
 * remote, never fetched, remote renamed), turning an unmeasured branch into a confident
 * "safe to remove". Caught by this file's own test on 2026-08-23.
 */
function backupState(at, branch) {
  const hasUpstream = gitAt(at, ["rev-parse", "--abbrev-ref", `${branch}@{u}`]) !== null;
  const counted = hasUpstream
    ? gitAt(at, ["rev-list", "--count", "@{u}..HEAD"])
    : gitAt(at, ["rev-list", "--count", branch, "--not", "--remotes"]);
  const unpushed = counted === null ? null : Number(counted);
  const dirty = (gitAt(at, ["status", "--porcelain"]) ?? "").split("\n").filter(Boolean).length;
  return { hasUpstream, unpushed, dirty };
}

/**
 * Every worktree git knows about, as absolute paths. Run from `cwd`, which in --pre-removal mode is
 * a LIVE worktree (the session issuing the removal), so this always resolves.
 */
function registeredWorktrees() {
  const out = git(["worktree", "list", "--porcelain"]);
  if (!out) return [];
  return out
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim())
    .filter(Boolean);
}

const normalise = (path) => path.replace(/\\/g, "/").toLowerCase();

/**
 * Whether `token` appears in `haystack` bounded by separators rather than mid-word, so `_wt-foo`
 * does not match inside `_wt-foobar`. Written without a RegExp on purpose: the tokens are
 * filesystem paths, and building a pattern out of a path means escaping it — which is exactly where
 * a path-matching bug hides.
 */
function tokenAppears(haystack, token) {
  if (!token) return false;
  const bounded = (char) => char === "" || " \t\"'/:;|&()".includes(char);
  let at = haystack.indexOf(token);
  while (at !== -1) {
    const before = at === 0 ? "" : haystack[at - 1];
    const after = haystack[at + token.length] ?? "";
    if (bounded(before) && bounded(after)) return true;
    at = haystack.indexOf(token, at + 1);
  }
  return false;
}

/**
 * Which registered worktrees a command is about to remove. Matches the full path first, then the
 * folder name — `git worktree remove ../_wt-foo` and `rm -rf "F:\...\_wt-foo"` are one intent
 * written two ways. Over-reporting costs a log line; under-reporting costs the commits this file
 * exists to protect, so the match is deliberately generous.
 */
function targetsOf(command, worktrees) {
  const haystack = normalise(command);
  return worktrees.filter((path) => {
    const normalised = normalise(path);
    if (haystack.includes(normalised)) return true;
    return tokenAppears(haystack, normalised.split("/").filter(Boolean).pop());
  });
}

function runPreRemoval() {
  let command = "";
  try {
    command = readFileSync(0, "utf8");
  } catch {
    return; // nothing piped in — an interactive run, not a hook invocation
  }
  if (!command.trim()) return;

  const targets = targetsOf(command, registeredWorktrees());
  if (targets.length === 0) return;

  for (const target of targets) {
    if (!existsSync(target)) {
      say(`Pre-removal check — ${target} is already gone; nothing left to inspect.`);
      continue;
    }
    const branch = gitAt(target, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (!branch) {
      say(`Pre-removal check — ${target} has no resolvable branch (detached or corrupt). Not inspected.`);
      continue;
    }
    const { hasUpstream, unpushed, dirty } = backupState(target, branch);

    if (unpushed === null) {
      say(`PRE-REMOVAL WARNING — ${target} (${branch}): git could not measure unpushed commits. UNVERIFIED, not clean.`);
      say(`  Check by hand before removing: git -C "${target}" log --branches --not --remotes --oneline`);
      continue;
    }
    if (unpushed > 0 || dirty > 0) {
      const parts = [];
      if (unpushed > 0) parts.push(`${unpushed} unpushed commit(s)${hasUpstream ? "" : " and NO upstream at all"}`);
      if (dirty > 0) parts.push(`${dirty} uncommitted file(s)`);
      say(`PRE-REMOVAL WARNING — ${target} (${branch}) still holds ${parts.join(" and ")}. This exists only on this disk.`);
      if (unpushed > 0) say(`  git -C "${target}" push -u origin ${branch}`);
      say(`  Nothing was blocked. If you remove it now, that work is gone.`);
    } else {
      // The clean case is logged too, ON PURPOSE. A log that only speaks up on failure cannot be
      // told apart from a log that is broken — which is the whole reason this mode exists.
      say(`Pre-removal check — ${target} (${branch}): clean, nothing unpushed. Safe to remove.`);
    }
  }
}

// Only a real invocation touches git or the log. Importing this file (a future unit test, a tool
// reading its constants) must never fire a hook as a side effect of the import.
// tests/worktree-exit-guard-pre-removal.test.ts drives the script as a subprocess instead, which
// keeps the test honest about what the hook actually does at runtime.
const INVOKED_DIRECTLY = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (INVOKED_DIRECTLY) {
  if (PRE_REMOVAL) {
    runPreRemoval();
    finish();
  }

  // ── 1. Only linked worktrees, only real feature branches ───────────────────────────────────
  // In a LINKED worktree, --git-dir points inside <primary>/.git/worktrees/<name>; in the primary
  // checkout it is just <primary>/.git. That difference is what distinguishes the two.
  const gitDir = git(["rev-parse", "--path-format=absolute", "--git-dir"]);
  const commonDir = git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);

  if (!gitDir || !commonDir) {
    // git resolves nothing here. If the directory is simply gone, this session removed its own
    // worktree before ending — say so instead of exiting silently, which is what made this failure
    // invisible for three weeks. Anything else (a cwd that is not a repo) is genuinely not our
    // business.
    if (!existsSync(cwd)) {
      say(`Worktree exit — ${cwd} no longer exists; it was removed during this session.`);
      say(`  The backup check for it ran at removal time — see the pre-removal entry above.`);
      say(`  Repo-wide sweep for anything laptop-only: pnpm run check:unbacked`);
      finish();
    }
    process.exit(0);
  }
  if (gitDir === commonDir) process.exit(0); // primary checkout — leave it alone

  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch || branch === "HEAD") process.exit(0); // detached
  if (branch === "main" || branch === "master") process.exit(0); // never auto-push the trunk

  // ── 2. Report anything unpushed — do NOT push it ───────────────────────────────────────────
  const { hasUpstream, unpushed, dirty } = backupState(cwd, branch);

  if (unpushed === null) {
    // Never rendered as clean. The retirable branch below also requires `unpushed === 0`, so an
    // unmeasured worktree can never be called safe to delete.
    say(`Worktree exit — ${branch}: git could not measure unpushed commits. UNVERIFIED, not clean.`);
    say(`  git -C "${cwd}" log --branches --not --remotes --oneline`);
  } else if (unpushed > 0) {
    const where = hasUpstream ? "ahead of its upstream" : "and the branch has NO upstream at all";
    say(`Worktree exit — ${branch} has ${unpushed} commit(s) ${where}. They exist only on this disk.`);
    say(`  git -C "${cwd}" push -u origin ${branch}`);
    // No --no-verify in that suggestion on purpose: the pre-push gate (check:routes,
    // check:migrations) is usually the only validation a never-PR'd branch ever gets.
  }

  // ── 3. Report retirability — never act on it ───────────────────────────────────────────────
  // Squash-aware: merged branches are never ancestors of main here, so `git branch --merged` is
  // always wrong. Ask GitHub whether the work on this head actually merged. Deliberately NOT done
  // in --pre-removal mode: a removal should not wait 30s on the network to learn something it does
  // not need. Retirability is a tidiness question; the backup check is the safety one.
  //
  // The question is asked by scripts/branch-pr-state.mjs, and it is deliberately ONE implementation
  // shared with repo-doctor.mjs — both print `git branch -D`, and a rule that decides an
  // irreversible command must not exist twice. This used to ask `--state merged` and take the first
  // row, which answers "has this branch EVER had a merged PR" rather than "is the work on it NOW
  // merged". Those diverge the moment a worktree outlives its own merge and opens a second PR from
  // the same head, which is the normal shape here — and a reused branch that is momentarily clean
  // and fully pushed to its OPEN pr got the unqualified `git branch -D` line, with nothing
  // downstream to catch it: commits pushed to an open PR are backed up, so the unpushed check has
  // no objection. See that file for the 2026-09-03 case.
  const verdict = classifyBranchPr(
    listBranchPrs(branch, { run: (args) => gh(args) }),
    gitAt(cwd, ["rev-parse", "HEAD"]),
  );

  if (verdict.verdict === "retirable") {
    if (dirty === 0 && unpushed === 0) {
      say(`Worktree is RETIRABLE: PR #${verdict.pr} merged, tree clean, nothing unpushed.`);
      say(`  git worktree remove "${cwd}"`);
      say(`  git branch -D ${branch}    # -D, not -d: a squash merge is never an ancestor of main`);
      say(`  (Nothing was deleted for you — that stays your call.)`);
    } else {
      say(`Worktree has a merged PR #${verdict.pr} but is NOT clean yet: ${dirty} uncommitted file(s). Left as-is.`);
    }
  } else {
    // "held" and "unknown" both keep the branch, and both are SAID. A worktree that quietly stops
    // being called retirable reads as one that was already retired.
    if (verdict.verdict !== "none") {
      say(`Worktree exit — ${branch} is NOT retirable: ${verdict.reason}.`);
    }
    if (dirty > 0) {
      say(`Worktree exit — ${dirty} uncommitted file(s) on ${branch}. Pushing only covers commits; these are still local only.`);
    }
  }

  finish();
}
