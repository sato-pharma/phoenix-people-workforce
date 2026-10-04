---
name: get-scheduledtaskinfo-without-taskpath-can-return-null-and-read-as-healthy
description: "Get-ScheduledTaskInfo -TaskName '<name>' without -TaskPath '\\' intermittently throws ERROR_INVALID_NAME (0x8007007B, \"The filename, directory name, or volume label syntax is incorrect\") for a perfectly healthy task — and with -ErrorAction SilentlyContinue that becomes $null, [int64]$null is 0, so a watchdog reads a DEAD task as \"last result 0, healthy\"; always pass -TaskPath, fall back to without, and treat unreadable as a fault, never as all clear."
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
