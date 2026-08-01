#!/usr/bin/env node
// SessionEnd guard for git worktrees: back up, then REPORT. Never deletes anything.
//
// WHY THIS EXISTS. Worktree sprawl here is not a disk problem, it is a BACKUP problem. A sweep on
// 2026-08-01 found 82 commits across 12 branches that existed only on this laptop — no remote, no
// PR, no CI. Retiring folders was never the bottleneck: new worktrees are created faster than they
// are cleaned up, so the risk regenerates. The durable fix is to close the backup gap at the moment
// a session ends, which is the one point where "this worktree is done for now" is actually known.
//
// WHAT IT DOES, in order:
//   1. Bails unless this is a LINKED worktree on a real feature branch. The primary checkout and
//      main/master are never auto-pushed — publishing whatever state the main working copy happens
//      to be in is a different decision, and the owner's to make.
//   2. Pushes the branch if it has unpushed commits (or no upstream at all). Non-destructive, and
//      it does NOT pass --no-verify: the pre-push gate is the first validation these branches ever
//      get, so it is worth paying.
//   3. Reports whether the worktree is now retirable — merged PR + clean tree + nothing unpushed —
//      and prints the exact commands.
//
// WHAT IT DOES NOT DO: remove a worktree, delete a branch, commit anything, or open/merge a PR.
// AGENTS.md is explicit that a worktree or branch is removed only with approval, so this stops at
// telling you it is safe. Deleting on your behalf would trade a recoverable mess for an
// unrecoverable one.
//
// Runs async (see .claude/settings.json) so session exit is never blocked by the pre-push gate,
// which takes minutes. Output also lands in <primary-repo>/.claude/worktree-exit.log.

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const cwd = process.argv[2] || process.cwd();

/** git, never throwing — returns null instead so a missing ref can't take the session down. */
function git(args, { timeout = 15000 } = {}) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout }).trim();
  } catch {
    return null;
  }
}

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

function finish() {
  if (lines.length === 0) process.exit(0);
  const body = lines.join("\n");
  // Best-effort log in the PRIMARY repo, so every worktree's exit lands in one place.
  const commonDir = git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (commonDir) {
    try {
      appendFileSync(join(commonDir, "..", ".claude", "worktree-exit.log"), `\n[${new Date().toISOString()}] ${body}\n`);
    } catch {
      /* logging is a convenience, never a failure mode */
    }
  }
  // systemMessage surfaces it in the UI; stdout keeps it in the transcript.
  process.stdout.write(JSON.stringify({ systemMessage: body }) + "\n");
  process.exit(0);
}

// ── 1. Only linked worktrees, only real feature branches ─────────────────────────────────────
// In a LINKED worktree, --git-dir points inside <primary>/.git/worktrees/<name>; in the primary
// checkout it is just <primary>/.git. That difference is what distinguishes the two.
const gitDir = git(["rev-parse", "--path-format=absolute", "--git-dir"]);
const commonDir = git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
if (!gitDir || !commonDir || gitDir === commonDir) process.exit(0); // primary checkout — leave it alone

const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
if (!branch || branch === "HEAD") process.exit(0); // detached
if (branch === "main" || branch === "master") process.exit(0); // never auto-push the trunk

// ── 2. Back up anything unpushed ─────────────────────────────────────────────────────────────
const hasUpstream = git(["rev-parse", "--abbrev-ref", `${branch}@{u}`]) !== null;
const unpushed = hasUpstream ? Number(git(["rev-list", "--count", "@{u}..HEAD"]) ?? "0") : Number(git(["rev-list", "--count", `origin/main..${branch}`]) ?? "0");

let pushed = false;
if (unpushed > 0) {
  // The pre-push gate (check:routes + check:migrations) runs here and takes a couple of minutes.
  // Deliberately NOT bypassed with --no-verify: for a branch that has never seen CI, this is the
  // only validation it gets, and AGENTS.md forbids skipping hooks without explicit approval.
  try {
    execFileSync("git", ["push", "-u", "origin", branch], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600000 });
    pushed = true;
    say(`Worktree exit — pushed ${unpushed} unpushed commit(s) on ${branch} to origin (they existed only on this disk).`);
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error).split("\n").slice(0, 3).join(" ");
    say(`Worktree exit — COULD NOT push ${branch} (${unpushed} commit(s) still local only): ${detail}`);
    say(`  Retry with:  git -C "${cwd}" push -u origin ${branch}`);
  }
}

// ── 3. Report retirability — never act on it ────────────────────────────────────────────────
const dirty = (git(["status", "--porcelain"]) ?? "").split("\n").filter(Boolean).length;
// Squash-aware: merged branches are never ancestors of main here, so `git branch --merged` is
// always wrong. Ask GitHub whether a PR for this head actually merged.
const mergedPr = gh(["pr", "list", "--head", branch, "--state", "merged", "--json", "number", "--jq", ".[0].number"]);

if (mergedPr) {
  if (dirty === 0 && (pushed || unpushed === 0)) {
    say(`Worktree is RETIRABLE: PR #${mergedPr} merged, tree clean, nothing unpushed.`);
    say(`  git worktree remove "${cwd}"`);
    say(`  git branch -D ${branch}    # -D, not -d: a squash merge is never an ancestor of main`);
    say(`  (Nothing was deleted for you — that stays your call.)`);
  } else {
    say(`Worktree has a merged PR #${mergedPr} but is NOT clean yet: ${dirty} uncommitted file(s). Left as-is.`);
  }
} else if (dirty > 0) {
  say(`Worktree exit — ${dirty} uncommitted file(s) on ${branch}. Pushing only covers commits; these are still local only.`);
}

finish();
