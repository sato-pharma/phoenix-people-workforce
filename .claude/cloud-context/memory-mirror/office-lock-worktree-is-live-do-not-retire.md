---
name: office-lock-worktree-is-live-do-not-retire
description: "CLOSED 2026-08-13 — _wt-office-lock is gone from disk and its 16 uncommitted files were committed and pushed as f2192ed6 on branch wip/office-differentiation. Nothing to protect any more; the general lesson (git status before retiring any worktree) still stands."
metadata: 
  node_type: memory
  type: project
  originSessionId: a48b9591-8fac-4f77-9c69-34f06c7622a4
  modified: 2026-08-13T02:26:30.833Z
---

**CLOSED — verified live 2026-08-13. The folder no longer exists and the work is safe in git.**
`F:\Phoenix Workforce\_wt-office-lock` is absent from disk and from `git worktree list` (38
worktrees registered in the main repo, none of them this one). The 16 uncommitted files it used to
hold were committed and pushed before it was removed:

- commit `f2192ed6` — *"wip(closing): preserve unfinished office-differentiation work"*,
  2026-08-12 20:07 Cairo
- branch **`wip/office-differentiation`**, not the old `codex/office-golden-rule-lock`
- local and `origin` are level (`git rev-list --left-right --count` = `0 0`)
- 23 files, 1,469 insertions vs `main` — includes `tests/office-golden-rule-lock.test.ts`

**Do not go looking for this worktree, and do not re-raise it as data loss.** If the
office-differentiation work needs picking up again, check out `wip/office-differentiation` rather
than trying to recreate the folder.

**The general lesson is what survives, and it is still correct:** "PR merged" answers *did the
branch land*, not *is the folder finished*. Always `git status --porcelain` a worktree before
retiring it and stop on any output — uncommitted files exist only on disk and `git worktree remove`
destroys them silently. That is also why `repo-doctor --fix` refuses to run while several Claude
sessions are live; do not pass `--force` to get past that guard.

Related: [[merged-pr-does-not-make-a-worktree-retirable]],
[[office-golden-rule-is-mechanically-locked]], [[owner-office-allocation-rule-value-share]].
