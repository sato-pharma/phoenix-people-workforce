---
name: ram-guard-routine-every-30-min
description: "TWO parallel every-30-min mechanisms for RAM/session management — external Windows Task Scheduler job \"PhoenixWorkforce RAM Guard\" (does the actual cleanup) and native Claude scheduled task \"phoenix-ram-session-check\" (read-only status report, visible inside the Desktop app). Neither ever kills a process or session."
metadata:
  node_type: memory
  type: reference
  originSessionId: 1d7c97a0-5c4a-44b4-8bde-442c58929698
  modified: 2026-08-13T02:43:23.783Z
---

🔴 **The external "PhoenixWorkforce RAM Guard" task can silently fail with
`0x800710E0` ("the operator or administrator has refused the request") right after a Claude
Desktop app restart/relogon, and it fails SILENTLY — no log line at all, not even an error one.**
Found 2026-08-11 via the scheduled "ram" task: `Get-ScheduledTaskInfo` showed `LastTaskResult`
non-zero at 07:47:47, but `ram-guard.log`'s last entry was 01:09:33 — roughly 13 half-hourly firings
(01:39 through 07:47) produced zero log output. All Claude Desktop helper processes (`Claude.exe`
under `WindowsApps\Claude_...`) had `StartTime` clustered at 07:45:40–07:46:20, i.e. the app/session
had just restarted seconds before the failed 07:47:47 run — the task's `LogonType: Interactive`
principal likely fired before the interactive session was fully re-established. **Self-heals**:
manually firing `Start-ScheduledTask -TaskName "PhoenixWorkforce RAM Guard"` ~3 min later succeeded
immediately (logged a normal report line, no ALERT, state file's throttle timestamps left alone
since within their windows). No credential/password involved (`LogonType: Interactive`, not a
stored-password logon), so nothing needed fixing by hand beyond the one manual re-trigger. **If this
task's `LastTaskResult` is ever non-zero and the log's last line is stale by more than one firing
interval, just re-run it with `Start-ScheduledTask` — don't assume it needs a credential fix.**

Built 2026-08-08 in response to a live near-OOM (1.17 GB free, 18 processes matching `claude.exe`
but only 7-9 real CLI sessions once Electron desktop-shell helpers were filtered out). Owner's
first ask was answered with the external script alone; owner then clarified mid-build that they
specifically wanted a routine visible **inside the Claude Desktop app**, then clarified again to
run BOTH in parallel rather than replace one with the other. Final shape is two mechanisms with a
deliberately non-overlapping division of labor so they cannot race each other:

**1. External — does the actual cleanup.** `C:\Users\satoh\.claude\scripts\ram-guard.ps1`,
registered in Windows Task Scheduler as **"PhoenixWorkforce RAM Guard"**, every 30 min,
indefinitely. Lives **outside** the phoenix-workforce repo entirely — its job is machine-wide, not
repo-specific, and this sidesteps any concurrent-session repo-edit risk. Costs ~0 RAM between runs
since it's a bare script, not a Claude session — a live Claude Code session kept around purely to
loop every 30 min would itself be one more process holding RAM all day, directly counter to the
goal.

**What the external script does each run:** snapshots free RAM and total/idle/active session
counts via the same `Get-Process claude | Where Path -like '*claude-code*'` filter
`scripts/repo-doctor.mjs` and `~/.claude/hooks/memory-guard.mjs` both already use (excludes the
Electron desktop shell's own ~14 helper processes). Classifies idle vs active by CPU-delta over a
20s sample (same heuristic as [[cannot-map-claude-sessions-to-worktrees]], now actually implemented
rather than just documented) — idle sat under 0.3s CPU used, active ran 0.5s+, matching that
memory's historical numbers exactly. Deletes `$env:TEMP` files older than 3 days. Calls
`node scripts/repo-doctor.mjs --fix` (throttled to once/3h) and `--strip-idle` (throttled to
once/20h) — both share `repo-doctor.mjs`'s own concurrent-session guard, so this script never needs
`--force` and never overrides a refusal. Alerts (log line + best-effort toast, debounced to
once/hour) when RAM < 2.5 GB or sessions > 4 (same thresholds as `memory-guard.mjs`, deliberately
not a second number) AND idle sessions exist — naming PIDs so the owner closes tabs by hand.
Log: `ram-guard.log` (trimmed to last 500 lines). State: `ram-guard-state.json` (throttle +
alert-debounce timestamps), both alongside the script.

**2. Native — read-only status report, paired deliberately.** Claude scheduled task
**`phoenix-ram-session-check`** (`C:\Users\satoh\.claude\scheduled-tasks\phoenix-ram-session-check\SKILL.md`),
🔴 **Cron is `0 */3 * * *` (every 3h) since 2026-08-09 — NOT `*/30`. Do not "restore" the shorter
interval.** Same day it was briefly disabled entirely, then re-enabled at 3h: the owner weighed zero
leak against the in-app report and chose to keep the report at the cheaper cadence. The 3h figure is
the whole point — it caps the leak below at ~8 firings/day (~560 MB) instead of 48 (~3.4 GB).
The external "PhoenixWorkforce RAM Guard" Task Scheduler job runs independently every 30 min and does
ALL actual cleanup (verified live 2026-08-09: state=Ready, lastResult=0), so disabling this native
half never affects machine-wide cleanup — it only costs the in-app report and its
`list_sessions`-based `isRunning`/`prState` accuracy, which the external script's CPU-delta guess
cannot match.

🔴 **EACH FIRING LEAKS A RESIDENT ~70 MB `claude.exe`.** "5 turns, then exited" below meant the
AGENT stopped taking turns — the PROCESS stays alive, because a completed session remains open in
the app's session list. Measured 2026-08-09: seven consecutive half-hourly firings (10:31, 11:01,
11:31, 12:01, 12:31, 13:01, 13:31) were **all still running at once**, ~490 MB held by the routine
whose entire job is protecting RAM. At `*/30` that is 48 processes/day ≈ 3.4 GB — the guard cost
more than it saved. **Nothing in the prompt can force the process to exit**; only firing less often
bounds it, hence 3h (8/day ≈ 560 MB). Do NOT restore a shorter interval without solving process
exit. The prompt now also counts its own prior firings so the report surfaces this cost. If zero
leak is ever needed, disable this native half outright — the external script does all the actual
cleanup at ~0 RAM; the only loss is the in-app visibility the owner asked for. Killing the strays by
hand works (`Stop-Process`) but frees far less than the working-set numbers suggest: 6 processes at
~451 MB total returned only ~0.09 GB of free RAM, since most of it is shared binary/runtime pages.

Each firing spins up a **fresh** Claude session on
this machine (confirmed live via `mcp__ccd_session_mgmt__list_events`: it called PowerShell for
RAM + `mcp__ccd_session_mgmt__list_sessions` for the real session list, 5 turns, then exited — not
a resident loop). Its whole value is using tools a bare script cannot: `list_sessions` gives
`isRunning` + `prState` directly, strictly better than the external script's CPU-delta idle guess.
Its prompt explicitly forbids running repo-doctor, deleting anything, or closing any session — it
only reads the external script's own log tail for context, never acts on it.

**Why the split, not one mechanism doing everything:** two mutating cleanup passes racing on the
same state file and worktree directories was the identified risk of overlapping them, so exactly
one of the two (the external one) is ever allowed to mutate anything. The native task is pure
report.

**Verified test-fire (2026-08-08, one-shot `fireAt` before converting to recurring — always test a
new scheduled task this way, since there is no "run now" tool to trigger one on demand otherwise):**
correctly reported 4.07 GB/15.79 GB free, 18 sessions (4 running/14 idle), named the same 7
already-shipped-but-still-open sessions a manual check had found roughly an hour earlier, surfaced
the external log's ALERT and a 3.36 GB stray `node` process, and attempted no mutating action.

**Caveats worth knowing:** scheduled tasks run **only while the Desktop app is open** — if closed,
a task fires on next launch instead, per the tool's own description, so this native half is not a
true 24/7 guarantee the way the external script is. Each firing shows up as a new, separate session
in the session list (e.g. "Phoenix ram session check") — 48/day will accumulate and may be worth
periodically archiving. `notifyOnCompletion: true` means a notification fires every 30 min
indefinitely; turn off via `update_scheduled_task` if it becomes noisy.

**Three real bugs found and fixed in the external script by actually running it repeatedly, not
just reading it once** — worth knowing if `ram-guard.ps1` is ever touched again:
1. `& node script.mjs --fix 2>&1 | Out-String` with `$ErrorActionPreference = 'Stop'` turns a
   native command's stderr (repo-doctor's own expected `console.error` refusal message) into a
   PowerShell terminating exception in Windows PowerShell 5.1. That skipped `Save-GuardState`, so
   the throttle timestamps never persisted and every run would have retried both heavy calls
   forever. Fixed with `Start-Process -RedirectStandardOutput/-RedirectStandardError` to temp files
   instead of stream-merging.
2. A repo path containing a space ("F:\Phoenix Workforce\...") passed as a bare `-ArgumentList`
   element gets split at the space — `Start-Process` does not auto-quote array elements. Node then
   fails with `Cannot find module 'F:\Phoenix'`. Fixed by manually wrapping the path in literal
   quotes before adding it to the argument array.
3. `$proc.ExitCode` reads back as an empty string after `Start-Process -PassThru` (no `-Wait`) +
   `$proc.WaitForExit(ms)`, unless `$proc.Handle` is touched once right after starting the process
   — a documented .NET `Process` quirk. All three verified by reproducing them against a throwaway
   script before landing the fix, then re-running the real script end-to-end.

Also found live: report-mode `repo-doctor.mjs` with **no flags at all** still costs ~70s of
disk-wait (measured `real 1m10.936s` / `user 0.121s` / `sys 0.076s` — almost entirely IO-wait, not
CPU) because the inventory walk over every live worktree runs unconditionally before any flag is
even checked. This is why both throttled calls in the external script are hours-spaced rather than
running every 30 min. See [[repo-doctor-strip-idle-runs-for-many-minutes]] for the much larger
`--strip-idle` cost on top of this baseline.

**Recurred 2026-08-11 11:39 via the scheduled "ram" task — same `0x800710E0` silent-skip, this time
mid-session (not right after a Desktop restart) and NOT accompanied by a Desktop app relogon:**
`NumberOfMissedRuns` was 5 (log showed firings every 30 min from 07:50 through 09:09, then nothing
until manually re-triggered at 11:39 — 09:39/10:09/10:39/11:09/11:39 all silently skipped).
`Start-ScheduledTask` self-heal ran immediately and worked as documented: log gained a real new
entry at 11:40:54, `NumberOfMissedRuns` reset to 0, `NextRunTime` advanced correctly to 12:09.
**New wrinkle: the manual trigger's own `LastTaskResult` also came back `2147946720` (=
`0x800710E0`, the same "operator or administrator has refused" code) even though the log proves the
script body ran and completed successfully.** So this code is not a reliable failure signal by
itself — cross-check the log timestamp before concluding a firing was skipped; a `0x800710E0`
result with a fresh matching log entry means it actually ran fine. TEMP was already clean this run
(0.2 GB, 0 stale files) — the 2026-08-10 `-Recurse` fix is holding, no repeat cleanup needed.

**Bug found 2026-08-10 via the scheduled "ram" task, FIXED same day: the script's own TEMP cleanup
(line ~148, `Get-ChildItem -Path $env:TEMP -File ...`) was NOT recursive — no `-Recurse` flag.** It
only ever deleted files sitting directly in `$env:TEMP`'s top level, never inside subfolders.
Measured live: `$env:TEMP` held 4.59 GB total, of which **2.95 GB across 274,804 files, all older
than 3 days, sat in subdirectories the script had never once reached** despite running every 30 min
since 2026-08-08. This is disk space, not RAM (deleting it doesn't move the free-RAM number) — a
real gap in "clears temp files" as advertised, not the guard's main job. An unattended attempt to
recursively purge the backlog was **blocked by the Claude Code auto-mode classifier**
(bulk-delete-with-no-user-present) — that 2.95 GB backlog is still sitting there and needs an
owner-run one-off cleanup (or the owner can approve a session to run it). **Owner requested the fix
directly on 2026-08-10** — `-Recurse` added to the `Get-ChildItem` call, so going forward the
script actually reaches subfolders. **Owner then had the backlog cleared by hand the same day**
(two passes, since a 274K-file walk exceeded a single 3-min foreground timeout): reclaimed ~3.6 GB,
`$env:TEMP` went 4.59 GB → ~1.0 GB, old-file count 274,804 → 3 stragglers (locked/in-use, harmless).
Confirms the `-Recurse` fix works end-to-end, not just by reading the diff. **Reminder for next
time this comes up: clearing TEMP is a disk-space fix, not a RAM fix** — free RAM did not move
(stayed ~2 GB) from this cleanup; don't conflate the two when reporting results.

**New location found 2026-08-11 13:xx via the scheduled "ram" task: `C:\Windows\Temp` (NOT
`$env:TEMP`, a different path) is not covered by the guard at all and held ~2.1 GB — `Whesvc`
(1.46 GB) + `DiagOutputDir` (647 MB), Windows Error Reporting hang-trace dumps, last written same
day (12:08 PM), likely from OOM-adjacent app hangs.** An unattended delete attempt was **blocked by
the Claude Code auto-mode classifier** (same "bulk-delete-with-no-user-present" refusal as the
2026-08-10 `$env:TEMP` backlog above) — do not retry the workaround, it's a hard stop by design.
This is disk space, not RAM, low priority, and needs an owner-approved session or manual run
(`Remove-Item "$env:SystemRoot\Temp\Whesvc","$env:SystemRoot\Temp\DiagOutputDir" -Recurse -Force`)
rather than something this task should keep re-attempting every firing.

**2026-08-11 ~19:00 firing: `Whesvc` is not a static backlog — it is ACTIVELY GROWING.** Last write
time on the folder was 19:00:14, same run, vs 12:08 PM on 2026-08-11's earlier check — it grew from
~1.46 GB to 1.38 GB (some rotation) while `DiagOutputDir` sat unchanged at ~783 MB since 2026-08-10.
Windows Error Reporting is still actively capturing hang traces today, meaning some app on this
machine (most likely one of the Claude Desktop/`claude.exe` helpers or Electron shell, given how
many are running — 16 counted this run) is still repeatedly hanging, not just a one-time historical
event. Worth a look next time the owner is present — `Get-WinEvent` on the Application log filtered
to Windows Error Reporting source, or `Get-ChildItem Whesvc -Recurse | Sort LastWriteTime -Desc`,
would name the actual offending process. RAM itself was healthy this run (4.14/15.79 GB free, 26%),
guard task healthy (`LastTaskResult=0`, 0 missed runs), `env:TEMP` clean (0.31 GB) — no RAM action
needed or taken.

**ROOT CAUSE FOUND 2026-08-11 ~20:20 via the scheduled "ram" task: it was never an app hanging —
the machine had an actual BSOD.** `Get-WinEvent` on the Application log (`ProviderName='Windows
Error Reporting'`) showed a `BlueScreen` event with bug-check code **`P1: 13a`
(`KERNEL_MODE_HEAP_CORRUPTION`)**, minidump `C:\WINDOWS\Minidump\081126-16812-01.dmp`.
`(Get-CimInstance Win32_OperatingSystem).LastBootUpTime` = **2026-08-11 18:29:12 Cairo** — a real
reboot, not a hang-and-recover. `0x13A` is typically a third-party driver writing past its
allocated kernel pool allocation, not a RAM-pressure symptom by itself, though pressure can be what
tips a marginal driver over. This is the mechanism behind the `Whesvc`/`DiagOutputDir` growth this
memory has been tracking since 2026-08-10 — worth the owner running `Get-WinEvent
-FilterHashtable @{LogName='System'; Id=1001}` or checking `C:\Windows\Minidump` with WinDbg to name
the offending driver if it recurs; one occurrence isn't yet a pattern. Still disk space not RAM
(`Whesvc` 1.36 GB / `DiagOutputDir` 0.77 GB at check time), still classifier-blocked to delete
unattended for the same "bulk-delete-with-no-user-present" reason as before — needs an
owner-approved or owner-run cleanup, not a retry from this task.

🔴 **CORRECTION, found 2026-08-13: at some point after 2026-08-09 the documented `phoenix-ram-session-check`
task (read-only, careful, described above) stopped being what was actually firing — a SECOND,
unrelated scheduled task named plain `ram` (folder `~/.claude/scheduled-tasks/ram/`, created
2026-08-10 11:31, frontmatter `description: Bottleneck stopper`) took over producing the
"Ram"-titled sessions this memory tracks.** Its prompt is a different document entirely, four lines,
typo-laden ("annd", "mcuh"), and explicitly authorizes what the careful design forbids: *"Clear
unnecessary memory caches and free up RAM... Optimize disk I/O and clear temporary files if safe to
do so... fix as much as u can and enhance as much as u can."* This was found by reading the actual
tool-call history out of 9 archived "Ram" session transcripts (grep the distinctive phrase
`Bottleneck stopper` across `~/.claude/projects/*/*.jsonl` to find them), not by trusting either
SKILL.md's description of itself — **the lesson: a task's frontmatter/prompt on disk is not proof of
what actually ran; read a real transcript's tool calls.**

**What it actually did, verified from the transcripts, two firings out of nine went further than
read-only:**
- One firing ran `Remove-Item "$env:SystemRoot\Temp\Whesvc" -Recurse -Force -Confirm:$false` (and
  the same for `DiagOutputDir`, and a loose `.etl`/`.log` sweep). **Blocked by the platform sandbox**
  ("Remove-Item on system path ... is blocked. This path is protected from removal.") — this is the
  same blocked attempt this memory already logged under "2026-08-11 ~20:20" above, now confirmed to
  have come from the `ram` task, not `phoenix-ram-session-check`. No data was actually lost.
- One firing called `mcp__ccd_session_mgmt__list_sessions` then `archive_session` **twice, on its
  own initiative, mid-firing, with no owner utterance in that transcript** — closed
  `local_a89ff02d...` ("Direct Order module UX/UI redesign", PR #2020 merged) and
  `local_40b7bc93...` ("Weekly sales dashboard filtering", PR #2027 merged). The first of those two
  was later resumed and was running again by 2026-08-13 (confirmed live in `list_sessions`), so no
  lasting harm — but this is exactly the unattended, no-explicit-agreement close that
  [[cannot-map-claude-sessions-to-worktrees]] says `archive_session`'s own tool description forbids
  ("only after the user has explicitly agreed... never speculatively"). A background task closing a
  session that turned out to still be wanted is a near-miss, not a non-event.

**Current state, verified 2026-08-13 via `mcp__scheduled-tasks__list_scheduled_tasks` (the
authoritative live registry, not the folder listing):** neither `phoenix-ram-session-check` nor
`ram` is currently registered — the tool returns only two unrelated one-time tasks, both already
fired. Both SKILL.md folders still exist on disk (orphaned config, matching exactly what
`delete_scheduled_task`'s own description says it leaves behind: "removes the task from the
scheduler... SKILL.md file is left on disk"). Corroborated independently by firing history: the last
"Ram"-titled session was `lastActivityAt: 2026-08-11T21:35:31`, and zero new ones appeared through
2026-08-13 despite the documented 3h cadence implying roughly a dozen missed windows — it had
already gone quiet on its own before this correction was even written. **Do not assume "the
scheduled task is disabled" means someone disabled it — here it means it's simply no longer
registered, for reasons this session could not determine.** If a `ram`-named or
`phoenix-ram-session-check`-named task ever reappears in `list_scheduled_tasks`, read its live
prompt via the `path` field before trusting this memory's description of either one — the substitution
happened once already without anyone noticing for over a day.
