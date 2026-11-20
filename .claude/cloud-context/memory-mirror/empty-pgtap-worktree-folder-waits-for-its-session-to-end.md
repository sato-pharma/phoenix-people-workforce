---
name: empty-pgtap-worktree-folder-waits-for-its-session-to-end
description: "The empty folder .claude/worktrees/serena-repo-evaluation-4479ec (pgTAP work, PR 654) is left on purpose until its own session ends, then deleted — owner's choice \"Delete it later\", 20 Nov 2026"
metadata:
  node_type: memory
  type: project
  originSessionId: f6610e74-f2a7-45d2-a979-38f517ecab1c
  modified: 2026-11-20T10:27:39.939Z
---

The pgTAP access-tests worktree `.claude/worktrees/serena-repo-evaluation-4479ec` was retired on 20 Nov 2026
(git deregistered, node_modules junction unlinked, branches `claude/pgtap-access-tests` and
`claude/postgres-tools-eval-245934` deleted, tips kept under `refs/deleted-branches/*-20261120`). Its FOLDER is
still on disk, empty, because the session that ran in it (claude.exe + its shells) keeps it open, and
`[IO.Directory]::Delete` answers "being used by another process".

**Why:** the owner chose "Delete it later" over a hidden waiter process (the classifier had refused the waiter).

**How to apply:** once that session has ended, delete the folder if it is still EMPTY —
`[IO.Directory]::Delete('F:\Phoenix Workforce\phoenix-workforce\.claude\worktrees\serena-repo-evaluation-4479ec')`
(non-recursive, so it refuses if anything is inside). If it is held, `scripts/find-worktree-holder.ps1` names
the holder; never stop a live session to free it. Related: [[archiving-a-session-does-not-remove-its-claude-worktrees-folder]].
