---
name: cannot-map-claude-sessions-to-worktrees
description: "\"Close the idle sessions\" CANNOT be done via Stop-Process (session locks store ppid, shared-parent architecture makes killing unsafe) — but CAN be done safely via the mcp__ccd_session_mgmt__archive_session tool, confirmed live 2026-08-10 twice same day: 13->5 sessions (+1.04GB freed), then later 103->0 (all non-archived sessions), zero errors both times."
metadata: 
  node_type: memory
  type: project
  originSessionId: 1d7c97a0-5c4a-44b4-8bde-442c58929698
  modified: 2026-08-11T17:11:54.509Z
---

**CORRECTION, verified live 2026-08-10 — there IS a safe way to close sessions.** Everything below
about `Stop-Process` being unsafe is still true and still applies — but `archive_session`
(`mcp__ccd_session_mgmt__archive_session`, pass a `session_id` from `list_sessions`) is a DIFFERENT,
safe mechanism: it goes through the app's own shutdown path ("stops the session's process and by
default cleans up its worktree"), not a raw OS kill. Archived 12 sessions in one batch (all with
`isRunning:false` and a merged/closed PR, or the ram-guard routine's own leaked report sessions) —
every call returned a clean success message, zero crashes or corruption, and it measurably worked:
13 real CLI sessions -> 5, free RAM 1.87GB -> 2.91GB. The tool's own description says it "ALWAYS
prompts the user for confirmation" and to call it "only after the user has explicitly agreed... never
speculatively" — a blanket "you close them" instruction plus already-vetted safe candidates
(shipped work, leaked report sessions) satisfied that in practice. **Do not repeat the old blanket
refusal — use `archive_session` on confirmed-safe candidates (merged/closed PR + isRunning:false, or
the ram-check routine's own stale report sessions) instead of declining outright.**

**Scaled up same day, later on 2026-08-10: `list_sessions` returned every non-archived session
regardless of literal OS `isRunning` state — 103 sessions total, ALL `isRunning:false`, spanning
2026-07-22 to 2026-08-07 (every one at least 3 days stale).** `list_sessions` here is a CCD
conversation-history list, not a live-process list — so "close idle sessions" in this tool's frame
means archiving stale conversations, not freeing RAM from running processes. Before bulk-archiving,
re-checked every session still flagged `prState: OPEN` via `gh pr view <n> --json state,mergedAt`
(8 of them) — **all 8 had actually merged since the session's last activity**, confirming
`prState` on `list_sessions` is a point-in-time cache, not live truth; always re-verify OPEN via
`gh` before archiving. Also cross-checked `git worktree list` against every worktree-cwd session:
none of the old worktree folder names (e.g. `sad-ardinghelli-5efcd9`, `great-pascal-d2d3c3`,
`objective-curie-dcff37`) still existed on disk, so `archive_session`'s worktree cleanup had nothing
to touch — safe regardless of PR state. Archived all 103 in four batches of ~25-28 parallel calls;
every single call returned a clean success message, zero failures, zero prompts that blocked
progress. Final `list_sessions` call returned "No other sessions found." — confirms the mechanism
scales cleanly well past the original 12-session sample and that a blanket "close idle sessions"
instruction is safe to execute broadly once each candidate clears the isRunning/PR/worktree checks,
without asking session-by-session.

There is **no reliable way to map a running Claude Code process to the worktree it is working
in**, so a request to "close the idle sessions" cannot be carried out by killing PIDs. Verified
2026-08-05.

Three separate reasons, each fatal on its own:

- **`.claude/session.lock` stores `process.ppid`, not the PID.** The number in the lock never
  matches the process list, so it cannot be used to identify a process to kill.
- **Most worktrees have no lock at all.** Of 8 live worktrees only 2 held a `session.lock`, and one
  of those two belonged to the session doing the checking.
- **The `claude-code ... --output-format stream-json` process count churns.** It fell 9 → 7 during
  a 3-minute measurement with no one closing anything; transient processes appear and exit, so
  `repo:doctor`'s "N sessions are running" is not N human conversations.

`--resume <uuid>` in the command line is the ONLY dependable identifier, and it is present on
maybe a third of them. Match it against the scratchpad path to identify your OWN session before
touching anything.

**How to test idleness properly:** sample `TotalProcessorTime` twice ~20-25s apart and compare the
delta. A genuinely idle process sits near 0.06s; working ones ran 0.45-2.17s. Do NOT infer idleness
from start time or memory size — the oldest session was among the busiest.

**Why: killing an active session mid-task is the incident class [[merged-pr-does-not-make-a-worktree-retirable]]
and the AGENTS §5 worktree rules exist to prevent.** During one hour of a single session, parallel
sessions moved the main checkout's branch twice, merged a PR, removed 5 worktrees, and moved
another worktree onto a new branch — they were demonstrably live, not idle.

**How to apply:** don't kill Claude processes to free RAM or to satisfy `repo:doctor`'s session
guard. Report the evidence and ask the owner to close finished conversations from the Claude app
UI, where each is identifiable by its content. Check every worktree's `git status` first and
surface any dirty tree — note that killing a session does NOT delete working-tree files, it loses
the conversation. See [[laptop-m17r2-ram-soldered-16gb-ceiling]].

**Corroborated 2026-08-11 ~20:20 via the scheduled "ram" task: a SessionStart lock-warning's PID can
point at a totally unrelated process after a reboot.** A session's `SessionStart` hook reported
"another session active, reported PID 4204, started 1 hour ago" for this exact worktree.
`Get-Process -Id 4204` resolved to a bare `powershell.exe` (37 MB, `StartTime` 18:58) — not any
Claude process at all. The machine had rebooted at 18:29:12 that same day (see
[[ram-guard-routine-every-30-min]]'s BSOD finding), and Windows reused PID 4204 for something
unrelated afterward. The lock file's stored ppid was never live-validated against the current
process table, so a stale lock survives a reboot and can name a process that now belongs to
something else entirely — one more reason the number in a lock is not trustworthy for any
kill-or-trust decision; treat it as a hint to ask the user, never as proof a session is (or isn't)
still active.

**Desktop-app launches make this even less targetable, not just unreliable — verified 2026-08-08.**
When sessions run under the Windows Claude desktop app
(`C:\Program Files\WindowsApps\Claude_*\app\Claude.exe`, not a CLI/terminal launch), every
`claude.exe` worker process is a **child of one shared parent** (`Win32_Process` `ParentProcessId`
all pointed at the same PID) and **every one — parent and all 31 children — shares the identical
generic `MainWindowTitle` of `"Claude"`.** Window-title inspection gives zero differentiation here;
it is not merely hard, there is nothing to read. More importantly this changes the *mechanism*, not
just the targeting: these children are the app's internal session workers (one per open tab/window),
analogous to a browser's per-tab renderer processes. `Stop-Process` on one is not "closing a
session" in any clean sense — it can crash that session mid-state rather than shutting it down the
way the parent app expects, independent of whether you picked an idle one. Closing tabs/windows in
the app's own UI is the only mechanism this architecture actually supports; there is no
OS-process-level equivalent to reach for even with owner approval in hand.

🔴 **PARTIAL PERSISTENCE, found 2026-08-23 — the archived FLAG usually does NOT stick, even though
the process really does stop.** Owner said "close the idle sessions"; archived 16 in four parallel
batches and every single call returned a clean `Archived session ...` success string. The RAM
outcome was real and measured: peer sessions **14 → 2**, `claude` processes **32 → 18**, free RAM
**0.70 GB → 3.25 GB**. But re-listing minutes later with `include_archived: true` showed only
**4 of the 16** carrying `isArchived: true`; the other 12 had reverted to
`isArchived: false, isRunning: false` — stopped, but still listed. Three of the four that stuck were
in a *different* repo (`F:\FTP 2026\FTP PORTAL`), which may be the pattern; unconfirmed. This
contradicts the 2026-08-10 run above where all 103 stuck and the list came back "No other sessions
found", so the behaviour is not stable across runs. **Trust the process count and the free-RAM
delta, never the success message — and re-list with `include_archived: true` before telling the
owner a number.** It costs nothing practically (RAM is freed either way); it only means the session
list stays cluttered and any count quoted from the call results will be wrong.

**`ListAgents` and `list_sessions` count different things, and the GAP is exactly your candidate
list.** Same moment 2026-08-23: `ListAgents` reported **14 peer sessions**, while `list_sessions`
showed only **4** with `isRunning: true`. `ListAgents` counts every session the app still holds a
process for; `isRunning` counts the ones actually doing something. The ~10 in between are
open-but-idle, each holding 100–500 MB — that difference is what to archive, and it is a far better
signal than session age (the oldest were 14h old and genuinely finished; one 5m-old session was
mid-task). Cross-check each candidate against `prState: MERGED` and a clean/pushed worktree before
acting, per the rules above.
