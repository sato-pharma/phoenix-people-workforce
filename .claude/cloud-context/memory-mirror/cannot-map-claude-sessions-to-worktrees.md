---
name: cannot-map-claude-sessions-to-worktrees
description: "There is NO reliable way to map a running Claude Code process to its worktree, so 'close the idle sessions' must NEVER be done by killing PIDs (the lock stores ppid not pid, most worktrees have no lock, the process count churns, and the desktop app runs every session as a child of one shared parent with the identical 'Claude' window title). The safe mechanism is mcp__ccd_session_mgmt__archive_session on vetted-safe candidates. Trust the process-count and free-RAM delta, never the archive success message — the isArchived flag often does not stick even though the process really stops."
metadata:
  node_type: memory
  type: project
  originSessionId: 1d7c97a0-5c4a-44b4-8bde-442c58929698
  modified: 2026-09-26T01:56:17.829Z
---

## Never kill PIDs to close sessions — there is nothing reliable to target

A request to "close the idle sessions" **cannot be carried out by killing processes.** Three reasons,
each fatal on its own:

- **`.claude/session.lock` stores `process.ppid`, not the PID** — the number never matches the process
  list, and it is never live-validated, so **a stale lock survives a reboot and can name a totally
  unrelated process** that Windows later reused the PID for. Treat a lock's number as a hint to ask the
  user, never as proof a session is (or isn't) active.
- **Most worktrees have no lock at all** (only a minority hold a `session.lock`, and one of those is the
  session doing the checking).
- **The `claude-code … --output-format stream-json` process count churns** — transient workers appear and
  exit second to second, so `repo:doctor`'s "N sessions are running" is not N human conversations.

**`--resume <uuid>` on the command line is the ONLY dependable identifier**, and it is present on maybe a
third of processes. **Match it against the scratchpad path to identify your OWN session before touching
anything.**

## The desktop app makes it un-targetable by design, not just unreliable

When sessions run under the Windows Claude desktop app (`…\WindowsApps\Claude_*\app\Claude.exe`, not a
CLI/terminal launch), **every `claude.exe` worker is a child of ONE shared parent** and **every one —
parent and all children — shares the identical generic `MainWindowTitle` `"Claude"`.** Window-title
inspection gives zero differentiation: there is nothing to read. These children are the app's internal
per-tab/window session workers (like a browser's per-tab renderer processes), so `Stop-Process` on one
**crashes that session mid-state** rather than shutting it down the way the parent app expects — regardless
of whether you picked an idle one. **Closing tabs/windows in the app's own UI is the only mechanism this
architecture supports; there is no OS-process-level equivalent even with owner approval in hand.**

## The safe mechanism is `archive_session`

`mcp__ccd_session_mgmt__archive_session` (pass a `session_id` from `list_sessions`) is a DIFFERENT, safe
mechanism: it goes through the app's own shutdown path — it stops the session's process and by default
cleans up its worktree — not a raw OS kill. **Do not fall back to a blanket refusal; use it on
confirmed-safe candidates** instead of declining. Note `list_sessions` here is a **conversation-history
list, not a live-process list**, so "close idle sessions" in this tool's frame means archiving stale
conversations, not freeing RAM from running processes.

**Vet each candidate before archiving:**
- Re-verify any session still flagged `prState: OPEN` with `gh pr view <n> --json state,mergedAt` — the
  `prState` on `list_sessions` is a point-in-time cache, not live truth (sessions routinely show OPEN for a
  PR that has since merged).
- Cross-check `git worktree list` and each worktree's `git status`; **surface any dirty tree first.**
  Archiving does NOT delete working-tree files — it loses the conversation.

## 🔴 Trust the RAM/process delta, never the success message

**The `isArchived` flag often does NOT stick, even though the process really stops.** A batch of
`archive_session` calls can each return a clean `Archived session …` success string and genuinely free the
RAM (peer sessions and `claude` process count both drop), yet a re-list minutes later shows only some
carrying `isArchived: true` while the rest reverted to `isArchived: false, isRunning: false` — stopped, but
still listed. The behaviour is not stable across runs. **So trust the process count and the free-RAM delta,
never the success message, and re-list with `include_archived: true` before quoting the owner a number** —
RAM is freed either way; only the list stays cluttered and any count read from the call results will be
wrong.

## Picking the candidates and testing idleness

- **`ListAgents` and `list_sessions` count different things, and the GAP is your candidate list.**
  `ListAgents` counts every session the app still holds a process for; `list_sessions` `isRunning: true`
  counts the ones actually doing something. The ~difference in between is the open-but-idle sessions, each
  holding 100–500 MB — **that gap is what to archive, a far better signal than session age** (the oldest
  are often finished while a 5-minute-old one is mid-task).
- **Test idleness properly:** sample a process's `TotalProcessorTime` twice ~20–25 s apart and compare the
  delta — a genuinely idle process sits near 0.06 s, a working one 0.45–2.17 s. **Do NOT infer idleness
  from start time or memory size.**

**Why this matters:** killing an active session mid-task is the incident class the AGENTS §5 worktree
rules exist to prevent — within a single hour, parallel sessions have provably moved the main checkout's
branch twice, merged a PR, and removed several worktrees; they were demonstrably live, not idle.
See [[merged-pr-does-not-make-a-worktree-retirable]], [[ram-guard-routine-every-30-min]] and
[[laptop-m17r2-ram-soldered-16gb-ceiling]].
