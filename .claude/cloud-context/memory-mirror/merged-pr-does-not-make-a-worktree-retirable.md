---
name: merged-pr-does-not-make-a-worktree-retirable
description: "A worktree's merged-PR status is keyed to the branch it had AT SCAN TIME. Sessions reuse a worktree for new work on a new branch, so `repo:doctor`'s RETIRABLE list can recommend deleting a directory holding live uncommitted edits. Re-check `git status` at the moment of removal."
metadata:
  node_type: memory
  type: reference
  originSessionId: 55343d83-8cde-4f3d-85d4-cf526b689702
  modified: 2026-08-05T12:47:45.166Z
---

**The trap.** `pnpm run repo:doctor` prints a `RETIRABLE worktrees (PR already merged)` list, and
AGENTS.md §5 says to remove a worktree once `gh pr list --head <branch> --state merged` confirms the
work landed. Both are keyed to **the branch the worktree was on when the scan ran**. A session that
finishes a task frequently **reuses the same worktree directory** for its next task on a *new*
branch. The merged verdict then describes work that has already left the building, while the
directory itself holds fresh, uncommitted edits.

**Confirmed live 2026-08-05.** `repo:doctor` listed `_wt-isolated` as retirable under
`PR #1773 codex/direct-orders-sheet-token-rotation` (genuinely merged). Minutes later at pre-flight:

- branch was now `codex/rotation-confirm-by-use` — not the merged one
- 3 uncommitted files: `M src/lib/direct-orders/sheet-token-rotation.ts`, `M tests/run-tests.ts`,
  `?? tests/direct-orders-rotation-confirmation.test.ts`
- that test file had been written **9 seconds** before the check
- HEAD moved `9bd00b1f` → `a1ca903c` *between two of my own commands*

`git worktree remove` would have refused on the dirty tree — but that is luck, not design, and
`--force` (or a tree that happened to be momentarily clean between saves) removes the safety net
entirely.

**The rule: merged-PR status selects a CANDIDATE; only the live tree state authorizes removal.**
Immediately before removing, in this order:

1. `git -C <p> rev-parse --abbrev-ref HEAD` — is it still the branch whose PR merged?
2. `git -C <p> status --porcelain` — dirty? (check the EXIT CODE, see
   [[failed-git-piped-to-wc-l-reads-as-zero-dirty]])
3. `git -C <p> log --oneline --not --remotes` — anything on no origin ref?
4. newest source-file mtime excluding `node_modules`/`.next`/`.git` — a write in the last minutes
   means a session is mid-edit regardless of what git says

Never act on an inventory more than a few minutes old. In this repo, worktrees changed branch,
appeared, and were deleted by other sessions repeatedly within single 10-minute windows.

Related: [[parallel-session-swarm-hazard]] (two sessions running the same cleanup),
[[worktree-payload-is-the-repo-slowness]] (why the cleanup is worth doing at all).
