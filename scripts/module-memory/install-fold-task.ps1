# Run the memory fold three times a day on this laptop, as the owner's rules already say it does.
#
#   powershell -ExecutionPolicy Bypass -File scripts\module-memory\install-fold-task.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\module-memory\install-fold-task.ps1 -At 09:00,15:00,21:00
#   powershell -ExecutionPolicy Bypass -File scripts\module-memory\install-fold-task.ps1 -Remove
#
# 🔴 WHY THIS EXISTS. `AGENTS.md` §2.2 and the owner's standing rules have said since 2026-10-03
# that the fold runs at 09:00, 15:00 and 21:00 Cairo. Measured 2026-10-06 it was scheduled NOWHERE:
# no Windows task, no Claude scheduled task, no workflow cron. The only 21:00 task on the box is the
# CRM field day report, which names `fold.mjs` in a comment and does not run it. So the cadence was
# a description of something nobody had installed, and every new memory note sat in the `MEMORY.md`
# inbox — re-charging every request in every session — until somebody ran the fold by hand.
#
# WHY NOT SUNDAYS. The owner's instruction of 2026-10-03 is three runs a day, not on Sundays, so the
# triggers are weekly over Monday-Saturday rather than daily. A `-Daily` trigger would fire on
# Sunday and there is no "except" on a daily trigger.
#
# WHY THESE THREE TIMES. His own choice, and the reasoning is in `docs/module-memory.md`: a run with
# nothing new opens NO PR and only one fold PR is ever open at a time, so three runs cost no extra
# CI — they shorten the wait before a note reaches its module from a week to about eight hours.
#
# WHY A WINDOWS TASK AND NOT A WORKFLOW. The fold reads the LAPTOP's memory directory
# (`~/.claude/projects/<slug>/memory/`), which is not in git and never reaches GitHub. A cloud runner
# has nothing to fold. This has to run where the notes are written.
#
# WAKE AND CATCH-UP. The lid is shut for most of these slots, so the task may wake the machine and,
# when it missed a slot entirely, runs as soon as it can afterwards. Without both, a closed lid means
# no fold and no error — the quietest kind of failure. `IgnoreNew` keeps a slow run from being
# overlapped by the next slot, because two folds at once would both try to open the one fold PR.

[CmdletBinding()]
param(
  [string[]]$At = @("09:00", "15:00", "21:00"),
  [switch]$Remove
)

$ErrorActionPreference = "Stop"
$TaskName = "Phoenix memory fold"

if ($Remove) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    "removed: $TaskName"
  } else {
    "not installed: $TaskName"
  }
  return
}

# The PRIMARY checkout, resolved from this script rather than from the caller's folder: a worktree's
# copy must still schedule the primary's, because a worktree is retired without warning and the
# launcher needs a checkout that will still be there in the morning.
$scriptRoot = Split-Path -Parent $PSCommandPath
$repoRoot = Split-Path -Parent (Split-Path -Parent $scriptRoot)
$common = (& git -C $repoRoot rev-parse --git-common-dir).Trim()
if (-not [System.IO.Path]::IsPathRooted($common)) { $common = Join-Path $repoRoot $common }
$primary = Split-Path -Parent ([System.IO.Path]::GetFullPath($common))

# Deploy the launcher OUTSIDE every checkout, beside the machine's other scheduled work. The task
# must not name a file in a working tree: the primary is shared and nobody pulls it, so a task
# pointed there runs whatever that tree holds. The launcher fetches the real fold from `origin/main`
# on every run, so what it files is always what merged.
$launcherDir = Join-Path ([Environment]::GetFolderPath("UserProfile")) ".claude\scripts"
New-Item -ItemType Directory -Force -Path $launcherDir | Out-Null
$launcher = Join-Path $launcherDir "memory-fold-run.mjs"
Copy-Item -Path (Join-Path $scriptRoot "run-fold.mjs") -Destination $launcher -Force

$node = (Get-Command node).Source
$log = Join-Path $launcherDir "memory-fold-task.log"

# 🔴 NODE DIRECTLY, NEVER `cmd /c node ... >> log`. Measured 2026-10-03 on the field-day task: with
# cmd in the chain the task returned 0x1 the instant it fired and wrote NOTHING, because
# `cmd /c "A" "B" >> "C"` strips the outer pair of quotes and mangles the path to node.exe. The
# launcher writes its own log, so there is no shell to misquote and a failed run still leaves its
# reason behind — the only thing anybody will ever read about a 09:00 run.
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$launcher`"" -WorkingDirectory $primary

$weekdays = @("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday")
$triggers = foreach ($time in $At) { New-ScheduledTaskTrigger -Weekly -DaysOfWeek $weekdays -At $time }

$settings = New-ScheduledTaskSettingsSet `
  -WakeToRun `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 20) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Settings $settings -Force -Description @"
Files every new memory note under its module and opens ONE fold PR, three times a day
(Monday-Saturday). Runs the fold from origin/main in a throwaway worktree, so it never executes a
stale copy out of a shared checkout. A run with nothing new to file opens no PR.
Sends no email and notifies nobody. Installed by scripts/module-memory/install-fold-task.ps1.
"@ | Out-Null

$task = Get-ScheduledTask -TaskName $TaskName
$info = Get-ScheduledTaskInfo -TaskName $TaskName
"installed: $TaskName"
"  runs      $($At -join ', ') Cairo, Monday-Saturday  (next: $($info.NextRunTime))"
"  launcher  $launcher"
"  log       $log"
"  state     $($task.State)"
