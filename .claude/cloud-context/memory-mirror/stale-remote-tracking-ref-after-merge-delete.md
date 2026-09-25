---
name: stale-remote-tracking-ref-after-merge-delete
description: "git fetch does NOT prune, so origin/<branch> still resolves after delete_branch_on_merge removed it — pushing to that branch recreates it on a merged PR instead of updating it"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: e267bf0f-f0f3-4fab-a70c-09700ca8e415
  modified: 2026-08-01T17:38:24.159Z
---

Hit this for real on 2026-08-01 while trying to add a commit to PR #1594.

## What happened

PR #1594 was `OPEN` when the session started. It was squash-merged mid-session (16:58 UTC), and
`delete_branch_on_merge` removed the remote branch `codex/termination-truth`. I then:

1. ran `git fetch origin` — **which does not prune**, so the stale `origin/codex/termination-truth`
   ref survived locally;
2. "verified" the push was a safe fast-forward with `git rev-parse origin/codex/termination-truth`,
   which happily returned the old SHA;
3. pushed — and git printed `* [new branch]`, because it **recreated a deleted branch** rather than
   updating the PR. The merged PR did not pick up the commit, and the repo was left with a branch
   that made a merged PR look unmerged.

Nothing was lost (main untouched, PR merged normally), but the recovery cost a full extra cycle:
cherry-pick onto latest `origin/main`, re-run `check:harden` on the new base, open a fresh PR
(#1599), and delete the stray ref.

## The rules

🔴 **`git rev-parse origin/<branch>` proves nothing about the remote.** It reads a local cache.
Only `git ls-remote --heads origin <branch>` asks the server. **Empty output = the branch is gone.**

🔴 **`* [new branch]` in push output is a RED FLAG** when you intended to update an existing one.
Read the push output; do not assume success from exit code 0.

🔴 **Before adding a commit to an open PR, re-check `gh pr view <n> --json state` immediately
before pushing.** Sessions here run for hours and the owner merges constantly (~30 commits/day) —
a PR that was open when you started is routinely merged by the time you finish. This is the same
class of error as [[compaction-replay-mistaken-for-live-state]]: acting on remembered state.

⚠️ The signal was available and I read past it — my very first `git ls-remote --heads origin
codex/termination-truth` returned empty output with exit 0. **Empty ls-remote output is a finding,
not a null result.**

## Why: fetch does not prune

`git fetch origin` alone never deletes stale remote-tracking refs. Use `git fetch --prune` (or
`git remote prune origin`) when the remote may have deleted branches — which, with
`delete_branch_on_merge` on, is after *every* merge in this repo.

## The right recovery when the base PR already merged

Do NOT try to resurrect the branch. The merge was a squash, so the pre-merge commit is not an
ancestor of `main` ([[stale-checkout-verify-against-origin-main]] — `git branch --merged` is always
wrong here; use `gh pr list --head <branch> --state merged`). Create a branch off latest
`origin/main`, `git cherry-pick` your commit, **re-run `check:harden` on the new base** (main had
moved 4 commits, including a test-harness change), and open a normal PR.

Related: [[git-push-to-origin-hangs-retry-immediately]],
[[portal-launch-readiness-tour-2026-07-30]] (a missing branch = `delete_branch_on_merge`, not lost
work), [[parallel-session-pr-collision-1506-1508]].
