#!/usr/bin/env node
// IS THIS COMMIT'S CHANGE ALREADY ON `main`, WHEN PATCH-ID SAYS NO?
//
// `git cherry` compares by patch-id, and that is the right first question: it survives a squash merge
// leaving a branch tip outside `main`'s history, which is the whole reason repo-doctor asks it. But a
// patch-id only matches when SOMETHING UPSTREAM HAS THE SAME DIFF, and there are two ordinary ways for
// a change to be on `main` without that being true:
//
//   1. A ROLL-UP SQUASHED IT WITH OTHERS. The carrier's diff is strictly larger than any one member's,
//      so no patch-id matches. Measured 2026-10-01 on #5096: its own patch-id was
//      `828169aa16aa0b5f9940dc89c67558b4e5a5ad1d`, equal to the roll-up's slice for its two files and
//      to nothing in `main`'s history. That is what `rollup-prs.mjs --settle` was fixed for.
//   2. `main` SOLVED THE SAME PROBLEM DIFFERENTLY, so the commit's change is MOOT rather than applied.
//      Measured 2026-10-02 on `codex/next-16-3-8-grpc-1-14-5`: repo-doctor held that worktree because
//      `84cb8dd92` ("next 16.3.8 and a grpc-js floor close two HIGH advisories") was `+` to cherry. The
//      `next` bump was on `main`; the `grpc-js` override was not, because `main` had REMOVED
//      `@google-cloud/logging`, the only path pulling grpc-js in. Dependabot read zero open alerts.
//      Nothing was stranded, and the warning named a HIGH advisory, which is the worst kind to cry wolf
//      about.
//
// So this asks the question patch-id is a means to — IS THIS DELTA ALREADY APPLIED — with
// `git apply --check --reverse` against `main`'s tree. It succeeds only when every line the delta adds
// is present and every line it removes is gone.
//
// FAILING CLOSED IS THE WHOLE SAFETY STORY, and here it means HOLDING A WORKTREE BACK. Any unreadable
// read, any error, any patch that will not apply: NOT landed, and the caller keeps the worktree. The
// cost of being wrong that way is a folder that stays a day longer; the other way deletes the only copy
// of somebody's work.
'use strict';

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * The verdict, kept pure so it is testable with no repository at all.
 *
 * @param {{ hasDelta?: boolean, reverseApplies?: boolean }} r
 * @returns {boolean} true only when the commit HAS a delta and that delta is already applied.
 */
export function deltaLandedVerdict(r) {
  // A commit with no readable delta proves nothing — an empty commit, or a read that failed. Either
  // way the caller must not retire anything on it.
  if (r?.hasDelta !== true) return false;
  return r?.reverseApplies === true;
}

function run(argv, { cwd, env, input } = {}) {
  try {
    return execFileSync('git', argv, {
      cwd,
      encoding: 'utf8',
      env: env ? { ...process.env, ...env } : process.env,
      input,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      timeout: 120000,
    });
  } catch {
    return null;
  }
}

/**
 * Whether one commit's own change is already applied on `origin/main`, in the repository at `dir`.
 *
 * The diff is the commit against its FIRST PARENT — the commit's own work, not a cumulative branch
 * diff — and it is reverse-applied with `--cached --check` against a THROWAWAY INDEX loaded from
 * `origin/main`. No file and no real index is touched, so this is safe to run inside a live worktree.
 *
 * A merge commit answers false: `git show` gives it no single-parent diff, and a merge was never the
 * thing cherry flagged anyway.
 *
 * `upstream` exists because `countUnpushedCommits` takes one as a parameter: hardcoding `origin/main`
 * there would have made this answer a different question from the one it was asked.
 *
 * @param {{ dir?: string, sha: string, upstream?: string }} input
 * @returns {boolean}
 */
export function commitDeltaLandedOnMain({ dir, sha, upstream = 'origin/main' }) {
  if (!sha) return false;
  const patch = run(['show', '--binary', '--format=', sha], { cwd: dir });
  if (!patch || !patch.trim()) return deltaLandedVerdict({ hasDelta: false });
  const indexFile = join(mkdtempSync(join(tmpdir(), 'phx-delta-')), 'index');
  try {
    if (run(['read-tree', upstream], { cwd: dir, env: { GIT_INDEX_FILE: indexFile } }) === null) {
      return deltaLandedVerdict({ hasDelta: true, reverseApplies: false });
    }
    const applied = run(['apply', '--cached', '--check', '--reverse', '-'], {
      cwd: dir,
      env: { GIT_INDEX_FILE: indexFile },
      input: patch,
    });
    return deltaLandedVerdict({ hasDelta: true, reverseApplies: applied !== null });
  } finally {
    rmSync(dirname(indexFile), { force: true, recursive: true });
  }
}
