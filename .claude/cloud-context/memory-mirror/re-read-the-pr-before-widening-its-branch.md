---
name: re-read-the-pr-before-widening-its-branch
description: "Before pushing a second commit to an open PR's branch, re-read the PR's state — he may merge it while you work (he merged #6379 at 20:32 Cairo on 2026-10-23 while an MCQ about widening it was on screen); the rebase then silently drops the merged commit and the push RECREATES the auto-deleted branch, so the widening needs a NEW PR."
metadata:
  node_type: memory
  type: feedback
  originSessionId: 2beeae33-d9ef-4939-a1a9-5009a5477182
  modified: 2026-10-23T17:43:07.684Z
---

On 2026-10-23 the plan was "widen PR 6379 so it stays one merge". While the MCQ asking about the
widening was on screen, the owner's account merged 6379 (20:32:40 Cairo). The next `git rebase
origin/main` quietly dropped the already-squashed commit, and `git push` printed "Create a pull
request for 'codex/crm-cache-heartbeat'" — `delete_branch_on_merge` had removed the remote branch and
the push recreated it. Nothing failed; the only tell was that line and `git log` showing the PR's
squash commit on main.

**Why:** a "one wide PR" plan assumes the PR is still open, and he merges green PRs himself, often
while a session is still working on the branch.

**How to apply:** before pushing more commits onto a PR branch, run `gh pr view <n> --json
state,mergedAt`. If it merged, open a new PR for the new commit (it is not "a second PR for one
module" — the first is already live), and say in one line that the first part shipped on his merge.
Related: [[the-next-step-box-must-not-manufacture-the-next-task]].
