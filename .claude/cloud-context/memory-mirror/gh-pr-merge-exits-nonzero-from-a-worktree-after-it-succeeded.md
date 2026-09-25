---
name: gh-pr-merge-exits-nonzero-from-a-worktree-after-it-succeeded
description: "From a secondary worktree, `gh pr merge --delete-branch` prints \"fatal: 'main' is already used by worktree\" and exits non-zero AFTER the remote merge already succeeded — read the PR state, never retry the merge."
metadata: 
  node_type: memory
  type: project
  originSessionId: 0cf70abf-2f97-4d4c-9b96-c0e3929ca595
  modified: 2026-09-16T12:05:11.939Z
---

Every session here works in a `_wt-*` worktree while `main` stays checked out in the primary
checkout, so **`gh pr merge --squash --delete-branch` always exits non-zero** with:

```
failed to run git: fatal: 'main' is already used by worktree at 'F:/Phoenix Workforce/phoenix-workforce'
```

**The merge still happened.** `gh` merges on the remote first, then tries to switch the LOCAL
checkout to the base branch and delete the local branch — and only that last, purely cosmetic step
fails. Confirmed 2026-09-03 on PR #2998: the command "failed", yet the PR was `MERGED` at
04:18:15 UTC as `9f31ac376` with the remote branch already deleted.

**Why:** the error text names `main` and says `fatal:`, which reads exactly like a merge that did
not happen. Retrying gets a "not mergeable" error on an already-merged PR, which reads like a
second, worse failure — and the tempting "fix" (checking `main` out here, or re-merging) is real
damage in response to a no-op.

**How to apply:** treat a non-zero exit from `gh pr merge` in a worktree as UNKNOWN, not failed.
Settle it with the PR itself before doing anything else:

```
gh pr view <n> --json state,mergedAt,mergeCommit --jq '{state:.state,mergedAt:.mergedAt,sha:.mergeCommit.oid}'
```

`state: MERGED` means done — the only leftover is the local branch, which `git branch -D <branch>`
clears from the worktree. Note `gh pr view` has **no `merged` JSON field** (it is `state`); asking
for one errors out and lists the valid fields.

**A cleaner path that avoided the error entirely:** run the merge from a NON-git directory (the
session scratchpad), with `--repo Gawish-1997/phoenix-people-workforce`, no `--delete-branch`
(`delete_branch_on_merge` deletes the remote branch anyway), and `--match-head-commit <CI-green sha>`
so it can only merge the commit that passed. `gh` then has no local checkout to touch and exits 0.
Confirmed 2026-09-16 on PR #3880 (exit 0, then `state: MERGED`). Still read the PR state afterwards.
