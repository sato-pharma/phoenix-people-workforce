---
name: owner-ops-refuses-to-apply-from-a-tree-behind-origin-main
description: "owner-ops --apply refuses from a worktree behind origin/main — after your own PR merges, re-point the worktree at origin/main before running the job."
metadata:
  node_type: memory
  type: project
  originSessionId: 8d9ef456-7d5b-448c-bbe6-0191201d52c5
  modified: 2026-11-26T11:00:07.727Z
---

`scripts/owner-ops.ts … --apply` refuses to run when the tree is behind `origin/main`: *"this tree
is 1 commit(s) BEHIND origin/main"*, because the script recomputes the rule from the code it runs in
and a behind tree would write pre-merge numbers to production. **The branch you just built the job
on becomes "behind" the moment its own PR squash-merges** — the squash commit is a new sha that your
branch does not hold, so the job you wrote is refused from the very tree you wrote it in.

**Why:** 26 Nov 2026, after PR 809 merged as `1a773175d`, the first `lock-rep-tablets --apply`
refused for exactly this reason, which reads at a glance like the job being broken.

**How to apply:** `git fetch origin` then `git checkout -B <new-branch> origin/main` in that
worktree — the content is identical after a squash, so nothing is lost — and run the job again; it
then prints *"tree <sha> holds every commit on origin/main <sha>"*. `PHX_STALE_TREE_OK=1` stands the
guard down for one command and is only for a deliberate pre-merge run, never to get past this.
See [[when-he-says-do-it-claude-does-it-from-the-code]].
