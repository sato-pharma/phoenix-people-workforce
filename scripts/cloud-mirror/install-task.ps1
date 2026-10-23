# Run the nightly cloud-mirror refresh on this laptop.
#
#   powershell -ExecutionPolicy Bypass -File scripts\cloud-mirror\install-task.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\cloud-mirror\install-task.ps1 -At 04:07
#   powershell -ExecutionPolicy Bypass -File scripts\cloud-mirror\install-task.ps1 -Remove
#
# WHY (owner, 2026-10-23: "widen 6337 with an automatic nightly mirror refresh"). The account is in
# docs/cloud-mirror-refresh.md and in refresh.mjs's header.
#
# WHY A WINDOWS TASK AND NOT A WORKFLOW CRON — two reasons, either one enough. The source is
# ~/.claude/projects/<slug>/memory/, which lives only on this laptop and is in no repository; and a pull
# request a workflow opens with its GITHUB_TOKEN starts no CI, so its required validate and checks would
# never report and it could never merge.
#
# WHY 04:07 CAIRO, DAILY. Clear of every other scheduled job here - the memory fold's 09:00/15:00/21:00,
# the CRM field day's 21:00, the weekly dependency refresh's Sunday 10:00 and the 06:36 Needs You digest -
# and the quietest hour on a box where free RAM is what binds. Daily on purpose, Sunday included: a cloud
# session started on a Sunday reads the same mirror as any other day.
#
# Everything about the task itself copies the memory fold's installer, for the reasons written there:
# node runs DIRECTLY (a `cmd /c ... >> log` wrapper returns 0x1 and writes nothing), the launcher is
# copied OUTSIDE every checkout, a shut lid wakes the machine or the run catches up afterwards, and a
# slow run is never overlapped by the next one.

[CmdletBinding()]
param(
  [string]$At = "04:07",
  [switch]$Remove
)

$ErrorActionPreference = "Stop"
$TaskName = "Phoenix nightly cloud mirror refresh"

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
$launcher = Join-Path $launcherDir "cloud-mirror-run.mjs"
Copy-Item -Path (Join-Path $scriptRoot "run-refresh.mjs") -Destination $launcher -Force

$node = (Get-Command node).Source
$log = Join-Path $launcherDir "cloud-mirror-task.log"

$action = New-ScheduledTaskAction -Execute $node -Argument "`"$launcher`"" -WorkingDirectory $primary
$trigger = New-ScheduledTaskTrigger -Daily -At $At

# 20 minutes: a fetch, a throwaway worktree, the mirror copy and one PR call. Nothing here waits on a
# workflow, so a run this long has hung.
$settings = New-ScheduledTaskSettingsSet `
  -WakeToRun `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 20) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force -Description @"
Mirrors the laptop's live memory and standing rules into .claude/cloud-context/ so a cloud session, which
never sees ~/.claude, reads current facts. Runs refresh.mjs from origin/main in a throwaway worktree.
Pushes onto the refresh PR already open rather than opening a second, opens nothing when the mirror did
not move or module memory is unhealthy, refuses a refresh carrying key material, and merges nothing.
Installed by scripts/cloud-mirror/install-task.ps1.
"@ | Out-Null

$task = Get-ScheduledTask -TaskName $TaskName
$info = Get-ScheduledTaskInfo -TaskName $TaskName
"installed: $TaskName"
"  runs      $At Cairo, daily  (next: $($info.NextRunTime))"
"  launcher  $launcher"
"  log       $log"
"  state     $($task.State)"
