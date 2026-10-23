# Run the weekly dependency refresh on this laptop.
#
#   powershell -ExecutionPolicy Bypass -File scripts\deps-refresh\install-task.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\deps-refresh\install-task.ps1 -Day Sunday -At 10:00
#   powershell -ExecutionPolicy Bypass -File scripts\deps-refresh\install-task.ps1 -Remove
#
# WHY (owner, 2026-10-23: "schedule the recurring pnpm update the fast-uri note says is due"). The account
# is in docs/dependency-refresh.md and in refresh.mjs's header.
#
# WHY A WINDOWS TASK AND NOT A WORKFLOW CRON. The PR has to be opened by a person's `gh`: a pull request a
# workflow opens with its GITHUB_TOKEN starts no CI, so its required `validate` and `checks` would never
# report and it could never merge. The heavy part — pnpm resolving the whole graph — still runs on GitHub,
# in lockfile.yml; this laptop only pushes a branch, waits and opens the PR.
#
# WHY SUNDAY 10:00 CAIRO. The first working morning of the week here, so the PR is waiting when the week's
# merges start, and clear of the memory fold's 09:00 slot. Dependabot's own weekly run is Monday.
#
# Everything about the task itself copies the memory fold's installer, for the reasons written there:
# node runs DIRECTLY (a `cmd /c ... >> log` wrapper returns 0x1 and writes nothing), the launcher is copied
# OUTSIDE every checkout, a shut lid wakes the machine or the run catches up afterwards, and a slow run is
# never overlapped by the next one.

[CmdletBinding()]
param(
  [string]$Day = "Sunday",
  [string]$At = "10:00",
  [switch]$Remove
)

$ErrorActionPreference = "Stop"
$TaskName = "Phoenix weekly dependency refresh"

if ($Remove) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    "removed: $TaskName"
  } else {
    "not installed: $TaskName"
  }
  return
}

# The PRIMARY checkout, resolved from this script rather than from the caller's folder, so a worktree's
# copy still schedules the primary's.
$scriptRoot = Split-Path -Parent $PSCommandPath
$repoRoot = Split-Path -Parent (Split-Path -Parent $scriptRoot)
$common = (& git -C $repoRoot rev-parse --git-common-dir).Trim()
if (-not [System.IO.Path]::IsPathRooted($common)) { $common = Join-Path $repoRoot $common }
$primary = Split-Path -Parent ([System.IO.Path]::GetFullPath($common))

$launcherDir = Join-Path ([Environment]::GetFolderPath("UserProfile")) ".claude\scripts"
New-Item -ItemType Directory -Force -Path $launcherDir | Out-Null
$launcher = Join-Path $launcherDir "deps-refresh-run.mjs"
Copy-Item -Path (Join-Path $scriptRoot "run-refresh.mjs") -Destination $launcher -Force

$node = (Get-Command node).Source
$log = Join-Path $launcherDir "deps-refresh-task.log"

$action = New-ScheduledTaskAction -Execute $node -Argument "`"$launcher`"" -WorkingDirectory $primary
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $Day -At $At

# 45 minutes: the launcher waits up to 30 for lockfile.yml, plus the fetch, the worktree and the PR.
$settings = New-ScheduledTaskSettingsSet `
  -WakeToRun `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 45) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force -Description @"
Re-resolves every dependency to the newest version its range allows, on GitHub (lockfile.yml,
mode=refresh), and opens ONE pull request when anything moved. Runs refresh.mjs from origin/main in a
throwaway worktree. Opens nothing while an earlier refresh PR is still open, or when nothing moved.
Sends no email and merges nothing. Installed by scripts/deps-refresh/install-task.ps1.
"@ | Out-Null

$task = Get-ScheduledTask -TaskName $TaskName
$info = Get-ScheduledTaskInfo -TaskName $TaskName
"installed: $TaskName"
"  runs      $Day $At Cairo, weekly  (next: $($info.NextRunTime))"
"  launcher  $launcher"
"  log       $log"
"  state     $($task.State)"
