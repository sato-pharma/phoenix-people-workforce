---
name: githubs-conflicting-flag-goes-stale-when-main-moves
description: "GitHub's `mergeable: CONFLICTING` / `mergeStateStatus: DIRTY` is a cached computation that lags whenever main moves — settle it with `git merge-tree --write-tree`, which writes no refs and needs no checkout"
metadata:
  node_type: memory
  type: project
  originSessionId: dd8bfcde-b7de-4cc2-9390-5e9a641ada7d
  modified: 2026-10-23T07:57:45.286Z
---

Measured 2026-10-23 on #6302: `mergeable` read `CONFLICTING` and `mergeStateStatus` `DIRTY`, and a merge
waiter treated that as final and exited. `git merge-tree --write-tree origin/main FETCH_HEAD` returned
**exit 0 with zero `CONFLICT` lines** on the same pair, and minutes later GitHub itself re-read as
`MERGEABLE` with no new push in between.

**Why:** GitHub recomputes mergeability asynchronously after the base moves, and in a busy merge window
(10 merges in 45 minutes that day) the cached answer is routinely behind. Treating it as final sends a
session hunting a conflict that does not exist — or, worse, editing another session's branch to "fix" it.

**How to apply:** never let `DIRTY` end a wait or trigger a conflict resolution. Probe with
`git fetch origin <branch>` then `git merge-tree --write-tree origin/main FETCH_HEAD` — it is read-only
apart from loose objects, needs no worktree, and so never risks the shared primary (unlike a no-commit
merge probe). `BLOCKED` beside `MERGEABLE` means checks unfinished, which is the same lesson from the other
direction: [[an-autofix-conflict-event-can-name-a-stale-head]].
