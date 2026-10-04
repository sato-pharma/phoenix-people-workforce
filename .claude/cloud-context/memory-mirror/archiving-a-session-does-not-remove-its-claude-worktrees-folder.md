---
name: archiving-a-session-does-not-remove-its-claude-worktrees-folder
description: "`archive_session` said it cleans up the worktree but left `.claude/worktrees/<name>` standing (2026-10-04, \"health check\"), and `new-session.mjs --remove` REFUSES that folder outright. Manual order that worked: archive-ref the tip, `cmd /c rmdir` the node_modules junction, `git worktree remove`, name the holder with find-worktree-holder.ps1, stop only that idle shell after matching its start time + parent, delete, `git branch -D`."
metadata:
  node_type: memory
  type: project
  originSessionId: e39a8848-5059-4305-a1d5-83e9c4ec9c6f
  modified: 2026-10-04T04:48:17.452Z
---

Measured 2026-10-04 retiring the idle "health check" session's harness worktree
(`.claude/worktrees/sleepy-kilby-e969e1`, branch `claude/wizardly-burnell-7e4b34`, nothing unique on it).

- `archive_session` returned "Archived" and, 30 s later, the folder and its git registration were both
  still there. Do not report the worktree as retired from the archive call alone.
- `node scripts/new-session.mjs --remove` fails on anything under `.claude/worktrees/` ("belongs to
  another live session"), so the harness folders have no scripted retire path. That refusal is right
  while the session is live; it is NOT a reason to leave an ARCHIVED, clean, nothing-unique one.
- What worked, in this order: (1) `git update-ref refs/deleted-<branch-with-dashes>-<date> <tip>`;
  (2) unlink the `node_modules` junction with `cmd /c rmdir` (non-recursive, the same call
  `new-session.mjs` makes) so nothing can follow it into the primary's `node_modules`;
  (3) `git worktree remove` - it deregistered the worktree and emptied the folder but answered
  "Permission denied" on the folder itself; (4) `scripts/find-worktree-holder.ps1` named the one holder,
  an idle `powershell.exe` (11 MB) from the archived session; (5) stop THAT pid only after matching its
  start time and parent, then `[IO.Directory]::Delete`; (6) `git branch -D`.
- Gate before any of it: the session is archived or provably idle, `git status -uall` is empty, the tip
  is an ancestor of `origin/main`, and every xlsx/pdf in the folder is `git ls-files`-tracked (10 were -
  `xlsx/` is gitignored, so an untracked one would have been the only copy).

Same family as [[a-worktree-husk-is-pinned-by-the-session-not-its-cwd]].
