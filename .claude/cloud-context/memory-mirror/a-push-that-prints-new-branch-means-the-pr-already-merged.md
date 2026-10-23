---
name: a-push-that-prints-new-branch-means-the-pr-already-merged
description: "git push printing \"[new branch]\" on a branch you have pushed all along means the PR merged and GitHub deleted the remote ref — check the PR state, then delete the ref you just recreated; a CI-monitor conflict event can cite a SHA that is no longer the head."
metadata:
  node_type: memory
  type: project
  originSessionId: f1479c36-700b-425f-a493-804d277da62c
  modified: 2026-10-23T07:14:15.645Z
---

`git push origin <branch>` printing **`* [new branch]`** for a branch you have been pushing to all
along means **the remote ref was gone when you pushed** — and on this repo that almost always means
the PR merged and `delete_branch_on_merge` deleted it. Your push silently **recreates** a branch
GitHub had retired.

What happened on 2026-10-23 with [#6307](https://github.com/Gawish-1997/phoenix-people-workforce/pull/6307):
merged at 07:04 UTC as squash `36eb9dbcd` while the session was merging `main` in again; the next
push reported `[new branch]`, and `gh pr view` then read `MERGED` with head still the pre-merge sha.

**How to read it, in order:**

1. `gh pr view <n> --json state,mergedAt,mergeCommit` — the PR, by NUMBER. `MERGED` explains it.
2. `git diff --stat <squash-sha> <your-pushed-sha>` — **empty means the trees are identical**, so the
   recreated branch adds nothing and your work is fully on `main`. Prove it by content, because a
   squash merge legitimately leaves your commits off `main` ([[git-branch-d-is-not-a-safety-gate-after-a-squash-merge]]).
3. `git push origin --delete <branch>` — remove the ref **you** just recreated. That restores what
   GitHub did on merge; it is not deleting the owner's branch.

**Two things that mislead at the same moment:**

- The desktop app's **Auto-fix CI event can cite a SHA that is no longer the head** — on that day it
  reported "merge conflicts … for head `2b2c15eb6d`" and `0b98e22fbc`, both earlier commits of the
  branch, while the GitHub API said the real head was `MERGEABLE`. **Read the live PR before acting
  on an event's SHA**; the fix for a stale event is nothing.
- A worktree can be **pruned out from under you mid-flight** by another session's cleanup. It shows
  as `prunable` in `git worktree list`, then the folder and the local branch vanish on their own.
  Verify the work is on `main` by content before worrying about it — see
  [[a-worktree-husk-is-pinned-by-the-session-not-its-cwd]].
