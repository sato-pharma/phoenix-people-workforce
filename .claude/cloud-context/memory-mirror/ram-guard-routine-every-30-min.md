---
name: ram-guard-routine-every-30-min
description: "The 2026-08 RAM-guard apparatus (external Windows Task 'PhoenixWorkforce RAM Guard' + native Claude task 'phoenix-ram-session-check') — BOTH went UNREGISTERED by 2026-08-13 and are superseded by mem-watchdog.ps1 (see the standing rules), so verify live with list_scheduled_tasks before relying on any of it. Kept for the reusable machine-ops lessons: a native scheduled task leaks a ~70MB process per firing, a task's on-disk prompt is NOT what actually ran, 0x800710E0 is not a reliable failure signal, and clearing TEMP is a disk fix not a RAM fix."
metadata:
  node_type: memory
  type: reference
  originSessionId: 1d7c97a0-5c4a-44b4-8bde-442c58929698
  modified: 2026-09-26T05:16:40.282Z
---

⚠️ **This apparatus is HISTORICAL.** As of 2026-08-13 neither the external `PhoenixWorkforce RAM Guard` (a
Windows Task Scheduler job) nor the native Claude task `phoenix-ram-session-check` was registered, and RAM
reclamation on this machine is now done by `mem-watchdog.ps1` (per the standing rules). **Verify live with
`mcp__scheduled-tasks__list_scheduled_tasks` — the authoritative registry, NOT the folder listing** — before
trusting any of the design below; a SKILL.md folder on disk is orphaned config that `delete_scheduled_task`
leaves behind. This file is kept for the reusable machine-ops lessons, which outlive the tasks.

## The design pattern (if this is ever rebuilt)

Split the work so two mutating passes can never race the same state file / worktree dirs: an **external**
Windows-Scheduler script does ALL cleanup (it lives outside the repo, costs ~0 RAM between runs because it is
a bare script not a Claude session, and shares `repo-doctor.mjs`'s own concurrent-session guard so it never
needs `--force`); a **native** Claude scheduled task is read-only REPORT only (its value is tools a bare
script lacks — `list_sessions` gives `isRunning`/`prState` directly, better than a CPU-delta idle guess). The
session/process filter both use is `Get-Process claude | Where Path -like '*claude-code*'` (excludes the ~14
Electron desktop-shell helpers); idle vs active is a CPU-delta over a 20s sample (idle <0.3s, active 0.5s+) —
[[cannot-map-claude-sessions-to-worktrees]].

## 🔴 A native Claude scheduled task LEAKS a resident ~70 MB `claude.exe` per firing

"5 turns then exited" means the AGENT stopped taking turns — the PROCESS stays alive, because a completed
session remains open in the app's session list. Seven consecutive half-hourly firings were all still running
at once (~490 MB held by the routine whose job is protecting RAM); at `*/30` that is ~48 processes/day ≈
3.4 GB — the guard cost more than it saved. **Nothing in the prompt can force the process to exit; only
firing less often bounds it** (hence the read-only check was moved to every 3h ≈ 8/day ≈ 560 MB, deliberately
— do not "restore" a shorter interval without solving process exit). Killing strays by hand (`Stop-Process`)
frees far less than the working-set numbers suggest — 6 processes at ~451 MB returned only ~0.09 GB, because
most is shared binary/runtime pages. A native task also fires only while the Desktop app is open, and each
firing shows as a new session in the list (worth periodic archiving).

## 🔴 A task's on-disk prompt is NOT proof of what actually ran

A second, unrelated task named plain `ram` ("Bottleneck stopper", typo-laden, four lines) silently took over
producing the "Ram"-titled sessions — and its prompt authorized what the careful design forbade
(system-path deletes; and one firing called `archive_session` TWICE on its own initiative, mid-firing, with
no owner utterance, closing two still-wanted merged-PR sessions — a near-miss). Found only by reading real
transcript tool-calls (grep the distinctive phrase across `~/.claude/projects/*/*.jsonl`), never by trusting
a SKILL.md's self-description. **The lessons:** read a real transcript's tool calls to learn what ran; a task
can be substituted without anyone noticing for over a day, so read a reappeared task's LIVE prompt (its
`path` field) before trusting any memory's description of it; and **`archive_session` unattended/speculatively
is forbidden** ([[cannot-map-claude-sessions-to-worktrees]] — its own tool description says only after the
user has explicitly agreed).

## Reusable ops traps

- 🔴 **`0x800710E0` ("the operator or administrator has refused the request") is NOT a reliable failure
  signal.** A Windows scheduled task can silently skip runs with it (no log line at all) right after a
  Desktop restart OR mid-session, self-healing on a manual `Start-ScheduledTask` — but that manual trigger's
  own `LastTaskResult` can ALSO come back `0x800710E0` while the log proves the body ran fine. **Cross-check
  the log timestamp: a `0x800710E0` with a fresh matching log entry means it ran.** If the result is non-zero
  AND the log is stale by more than one interval, just re-run with `Start-ScheduledTask` — do not assume a
  credential fix (it is a `LogonType: Interactive` principal, no stored password).
- 🔴 **Clearing TEMP is a DISK-SPACE fix, not a RAM fix** — free RAM does not move; do not conflate them when
  reporting. Two gotchas: a `Get-ChildItem $env:TEMP` cleanup needs **`-Recurse`** or it only reaches the top
  level (GBs sat untouched in subfolders); and **`C:\Windows\Temp` is a SEPARATE path** not covered by a
  `$env:TEMP` sweep (Whesvc / DiagOutputDir = Windows Error Reporting dumps). Bulk unattended deletes of
  either are hard-blocked by the auto-mode classifier ("bulk-delete-with-no-user-present") and system paths
  by the platform sandbox — do not retry the workaround; these need an owner-run cleanup.
- **Growing WER dumps can mean a real BSOD, not an app hang** — a `0x13A KERNEL_MODE_HEAP_CORRUPTION`
  bluescreen drove the Whesvc/DiagOutputDir growth here (confirm via `Get-WinEvent` System log Id 1001 or
  `C:\Windows\Minidump`; `0x13A` is typically a third-party driver overrunning its kernel pool, which RAM
  pressure can tip over).
- **`repo-doctor.mjs` with NO flags still costs ~70 s of disk-wait** (IO-bound inventory walk over every live
  worktree runs before any flag is checked) — which is why any cleanup script's heavy calls must be
  hours-throttled, never every 30 min. [[repo-doctor-strip-idle-runs-for-many-minutes]] is the far larger
  `--strip-idle` cost on top.
- **PowerShell 5.1 script bugs** (if `ram-guard.ps1` or similar is touched): `& node … 2>&1 | Out-String`
  with `$ErrorActionPreference='Stop'` turns a native command's expected stderr into a terminating exception
  (use `Start-Process -RedirectStandardOutput/-RedirectStandardError` to temp files); a space-containing path
  passed as a bare `-ArgumentList` element is split at the space (quote it explicitly); and `$proc.ExitCode`
  reads back empty after `Start-Process -PassThru` + `WaitForExit(ms)` unless `$proc.Handle` is touched once
  right after starting — a documented .NET `Process` quirk. Reproduce each against a throwaway before landing
  a fix.
