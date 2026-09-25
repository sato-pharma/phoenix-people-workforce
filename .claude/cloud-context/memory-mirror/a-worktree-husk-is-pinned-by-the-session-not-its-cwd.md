---
name: a-worktree-husk-is-pinned-by-the-session-not-its-cwd
description: "A husk folder that will not delete is held by a PROCESS whose current directory sits inside it - and moving the owning session's cwd does NOT move its already-running child processes, so the folder stays held. The holder IS nameable with scripts/find-worktree-holder.ps1 (it reads each PEB). MSYS /proc sees only MSYS processes, so a bash-only scan reads 'no holder' while claude/node/powershell hold it. Delete is accepted as PENDING and completes later; rename succeeds while delete fails, so rename is not a test for a handle."
metadata: 
  node_type: memory
  type: project
  originSessionId: 97697fb0-93b9-4be4-bd0d-d1f3e600ff82
  modified: 2026-09-21T02:27:39.925Z
---

Measured 2026-09-21, 04:27-05:40 Cairo, across five husks under `F:\Phoenix Workforce`.

**Two wrong conclusions I reported to the owner before measuring properly, both corrected here.**

1. *"The husks are held by each session's current directory, so moving that session frees it."*
   Session `a15b5e6b` changed cwd out of `_wt-classifier-permission` at 01:30:43Z and the folder
   stayed held for another ten minutes. **A session's logical cwd is not what holds the folder -
   an already-running child PROCESS whose own current directory is inside it does.** Moving the
   session does not move a `powershell.exe` or `node.exe` it started earlier; those keep their own
   current directory until they exit.
2. *"Without Sysinternals `handle64.exe` the holder cannot be named."* **Wrong - this repo ships
   `scripts/find-worktree-holder.ps1`**, which reads each process's PEB directly and prints
   pid, name, kernel CPU and cwd. Verified: it read 202 processes and named every holder,
   including a `claude` process flagged `KERNEL-STUCK?`. Run it before saying a folder cannot be
   attributed.

**Why my own scan said "no holder".** I enumerated `/proc/<pid>/cwd` under MSYS, saw only `bash`
and `sleep`, and concluded nothing held the folders. **MSYS `/proc` exposes ONLY MSYS processes.**
`claude`, `node.exe` and `powershell.exe` are invisible there - and they were the actual holders.
A clean result from `/proc` is not evidence about a Windows process.

Two mechanics that make the outcome easy to misread:

- **`[IO.Directory]::Delete` is ACCEPTED and left PENDING.** Windows marks the directory for
  deletion and removes it once the last handle closes, so a folder you "failed" to delete can be
  gone minutes later with no further command. **Re-measure `Test-Path` after the call; never
  report either outcome from the call's own success or exception alone.**
- **Rename SUCCEEDS while delete fails.** `Rename-Item` on a held husk works, which makes it look
  like no handle exists. It is not a test for one.

**How to apply:** run `powershell -NoProfile -File scripts/find-worktree-holder.ps1` first and
name the holder. The cluster hook at `docs/agents-session-traps-clusters.md` (**Worktrees**)
already covers what to do with it - a holder is released by ARCHIVING the owning session, a
session can never clear its own husk, and `--fix` clears only a zero-file husk. Never remove a
folder that still has entries in it.

Related: [[main-is-not-the-primary-checkout]] and
[[claude-project-dir-is-the-sessions-own-worktree]].
