---
name: retiring-your-own-worktree-leaves-an-empty-folder
description: "A session that retires the app worktree it is running in gets 'Permission denied' from git worktree remove, but git has already deleted every file and deregistered the worktree; only the empty folder stays, held as the session's own working directory."
metadata:
  node_type: memory
  type: project
  originSessionId: fb7acb22-dea4-40c6-b1bb-b67f01bff48a
  modified: 2026-11-18T23:51:32.081Z
---

On 19 Nov 2026 about 01:55 Cairo the owner said "retire the worktree" to the session running in
`.claude/worktrees/november-hospital-visits-7e7a53`. `git worktree remove` printed
`error: failed to delete '<folder>': Permission denied`, and a retry with `--force` answered `is not a working tree`.
Both look like failure, but the removal had worked: `git worktree list` no longer named the folder, and 0 entries were
left inside it. Only the empty directory stayed, because the harness resets every Bash call's working directory to
it, so the session's own process holds it open.

**Why:** Windows will not delete a directory that a live process uses as its working directory.

**How to apply:**
- Before retiring, unlink the `node_modules` junction with `cmd //c rmdir` and save aside any ignored file that
  differs from the primary (see [[an-orphaned-app-worktree-has-no-retire-route-but-git]]).
- Run the removal from the primary, then judge it by `git worktree list` and the folder's entry count, not by the
  error text.
- Report the empty folder honestly. It goes when the session closes, and it costs nothing in the meantime. Never
  stop or archive the session to clear it.
