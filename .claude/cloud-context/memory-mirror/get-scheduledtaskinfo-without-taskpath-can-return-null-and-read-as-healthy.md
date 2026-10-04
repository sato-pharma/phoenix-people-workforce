---
name: get-scheduledtaskinfo-without-taskpath-can-return-null-and-read-as-healthy
description: "A 0x0 from the Windows scheduler proves nothing, in TWO different ways: Get-ScheduledTaskInfo -TaskName without -TaskPath '\\' intermittently throws ERROR_INVALID_NAME (0x8007007B) for a healthy task and [int64]$null coerces to 0; and the scheduler ZEROES LastTaskResult when a task starts, so a read taken as the state leaves Running is the start-zero, not the verdict - an exit code does reach it (cmd exit 7 reads 0x7, node exit 3 reads 0x3), so wait, re-read, and corroborate with schtasks /query /v before believing a 0x0. A genuine reading always has a LastRunTime beside it."
metadata:
  node_type: memory
  type: project
  originSessionId: 1baaa0f5-9436-457f-8907-da9439516d28
  modified: 2026-10-04T04:42:44.819Z
---

Measured 2026-10-04, minutes after registering `Phoenix Worktree Snapshot - Failure Alert`:

```
Get-ScheduledTaskInfo -TaskName 'Phoenix Worktree Snapshot - Failure Alert'
  → The filename, directory name, or volume label syntax is incorrect.
    CimException, HRESULT 0x8007007B        (ERROR_INVALID_NAME)

Get-ScheduledTaskInfo -TaskName 'Phoenix Worktree Snapshot - Failure Alert' -TaskPath '\'
  → LastRunTime 10/4/2026 7:38:58 AM   LastTaskResult 0   NextRunTime 7:50:00 AM

schtasks /query /tn '<same name>' /fo LIST /v
  → Status Ready   Last Result 0   Next Run Time 7:50:00 AM
```

**Same task, same second, three reads: two correct and one fatal.** `Get-ScheduledTask` (the task
object) answered fine throughout; only `Get-ScheduledTaskInfo` (the run history) refused. The same
unqualified call worked for `Phoenix Worktree Snapshot - Hourly` and for a throwaway task in the
same session, so it is **intermittent, not a property of the name** — don't go hunting the
characters in the title.

🔴 **IT FAILS IN THE DIRECTION THAT LOOKS RIGHT, WHICH IS WHY IT MATTERS.** A watchdog writes
`-ErrorAction SilentlyContinue`, so the throw becomes `$null`; `[int64]$null` is **0**; and `0` is
the Windows scheduler's code for *success*. So the verdict prints

> last result 0x0 — healthy

for a task that may have been killed. In this session the printed line `result = 0x0` was pure
`[int64]$null` and I nearly believed it, having just registered the task. **Count the companion
fields: a real reading has a `LastRunTime`.** A blank run time beside a confident `0x0` is the
tell.

**The shape to write, every time:**

```powershell
$i = Get-ScheduledTaskInfo -TaskName $Name -TaskPath '\' -ErrorAction SilentlyContinue
if (-not $i) { $i = Get-ScheduledTaskInfo -TaskName $Name -ErrorAction SilentlyContinue }
if (-not $i) { return @{ Reason = '… exists but Windows would not say how its last run went …'
                         Signature = 'unreadable' } }
```

The third line is the point: **the task existing and its history being unreadable is UNKNOWN, and
unknown is not healthy.** `return $null` there — which is what both watchers shipped with — makes a
blind watchdog indistinguishable from a quiet one.

**Fixed in both**, 2026-10-04: `~/.claude/scripts/worktree-snapshot-watch.ps1` (new, so it never
shipped the hole) and `~/.claude/scripts/xlsx-snapshot-watch.ps1`, which had carried it since
2026-09-09 and guards the hourly `xlsx/` backup. The `unreadable` branch is the one branch of either
watcher that **could not be induced to fire** — the fault stopped reproducing within two minutes —
so it is reasoned-and-reviewed, not break-and-watched. Said plainly rather than claimed.

Related: [[uncommitted-worktree-work-is-snapshotted-hourly]] ·
[[a-break-that-passes-may-be-rescued-not-correct]] — a seventh shape for that list: an assertion
satisfied by a **coerced null**, where `[int64]$null → 0` collides with 0 meaning success.

## The second shape: a `0x0` read too soon

An exit code **does** reach `LastTaskResult`. Re-measured 2026-10-04 from two independent readers,
with the task registered the way the real ones are (satoh / Interactive / Limited):

```
cmd.exe  /c exit 7     → CIM 0x7   schtasks "Last Result: 7"
node -e process.exit(3) → CIM 0x3   schtasks "Last Result: 3"
node -e process.exit(0) → CIM 0x0   schtasks "Last Result: 0"
```

🔴 **BUT AN EARLIER PROBE THE SAME MORNING REPORTED `0x0` FOR AN EXIT 3, THREE TIMES OVER, AND I
ALMOST RECORDED THAT AS FACT.** The scheduler **zeroes** `LastTaskResult` when a task starts and
writes the real code as it finishes, so a read taken the moment the state leaves `Running` can still
be the start-zero. That probe read 2 seconds after, and registered its task with **no `-Principal`**,
so it was not the shape that actually runs here. **Wait, re-read, and corroborate with
`schtasks /query /tn <name> /fo LIST /v` before believing a `0x0`** — which is the same discipline
as the first shape above, from the other direction: there a `0x0` was `$null`, here it was premature.

Caught by noticing that an unrelated hourly task's `LastRunTime` matched the probe's to the second,
which looked like the probe having started the wrong task. It had not — the transcript showed it
used its own name — but checking that is what prompted the re-measurement.

**So the task result is a sound primary signal, and the log branch is still not redundant:** a bare
exit code cannot say WHAT went wrong, and a later clean run resets the result while the same fault
is still standing. Both reasons were already in the watchers' comments; the headers' claim that the
result "catches a kill, a crash and a clean non-zero exit alike" is correct and was restored after
being wrongly corrected away on the strength of that bad probe.

**And read the last ENTRY of the backup's log, not the last LINE.** The worktree snapshot writes one
line per run, but the `~/.claude` backup's `FAIL` carries git's own multi-line error underneath it —
so the last line of a failed run is `error: failed to push some refs`, which matched nothing and
read as **healthy**. Scan upwards to the last line that opens with `[<timestamp>] `. Both watchers
also read that log with `-Encoding UTF8` now: an em-dash read as ANSI arrived mojibake in the
message *and* could never match the state file written as utf8, so the de-duplication would have
re-sent the same fault every hour.

Related: [[the-claude-scripts-live-off-machine-on-a-never-merge-branch]]
