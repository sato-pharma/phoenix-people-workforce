# Build the Phoenix CRM field day papers every evening, on this laptop.
#
#   powershell -ExecutionPolicy Bypass -File scripts\field-day\install-task.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\field-day\install-task.ps1 -At 21:00
#   powershell -ExecutionPolicy Bypass -File scripts\field-day\install-task.ps1 -Remove
#
# WHY 21:00 CAIRO. The visit day does not close until 02:00, but the field finishes in the late
# afternoon — on the first day the last capture landed at 14:41 and the last call at 14:17. 21:00 is
# late enough that nothing real is still arriving and early enough to be an evening read, which is
# what the owner asked for. It is a parameter because that judgement may not survive contact with a
# Ramadan schedule.
#
# WHY A WINDOWS TASK AND NOT CI OR THE APP. The papers are company documents that land in the owner's
# own `xlsx/` folder beside everything else he keeps, and they read PRODUCTION through the service
# role in `.env.local`, which exists on this machine and is not a CI secret. A GitHub Action would
# need that key copied into GitHub, bill Actions minutes nightly, and leave the PDFs as artefacts
# nobody opens. Nothing here touches production except to read it.
#
# 🔴 IT SENDS NO EMAIL AND TELLS NOBODY. Wiring recipients needs the owner's decision first
# (AGENTS.md §4), and no automation in this repository may fire outbound mail on its own. The task
# writes four files; the owner forwards what he chooses.
#
# WAKE AND CATCH-UP. The laptop is asleep or off most evenings, so the task may wake it and, if it
# missed its slot entirely, runs as soon as it can afterwards. Without both, a closed lid means no
# report and no error — the quietest kind of failure.

[CmdletBinding()]
param(
  [string]$At = "21:00",
  [switch]$Remove
)

$ErrorActionPreference = "Stop"
$TaskName = "Phoenix CRM field day report"

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
# copy of the repo must still schedule the primary's, because the papers belong in the primary's
# xlsx/ (the only one the hourly backup covers) and a worktree is retired without warning.
$scriptRoot = Split-Path -Parent $PSCommandPath
$repoRoot = Split-Path -Parent (Split-Path -Parent $scriptRoot)
$common = (& git -C $repoRoot rev-parse --git-common-dir).Trim()
if (-not [System.IO.Path]::IsPathRooted($common)) { $common = Join-Path $repoRoot $common }
$primary = Split-Path -Parent ([System.IO.Path]::GetFullPath($common))
$printer = Join-Path $primary "scripts\field-day\print-day.mjs"

if (-not (Test-Path $printer)) {
  throw "the printer is not in the primary checkout yet: $printer — merge the branch that adds it first."
}

$node = (Get-Command node).Source
$log = Join-Path $primary "xlsx\field-day-task.log"

# cmd /c, so one line can both run node and append its output to a log. A failure at 21:00 with
# nobody watching is only discoverable if it wrote down why.
$command = "`"$node`" `"$printer`" >> `"$log`" 2>&1"
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c $command" -WorkingDirectory $primary
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet `
  -WakeToRun `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 15) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force -Description @"
Builds the Phoenix CRM field day papers — one per line for the district managers and a one-page
summary for the Chief Executive — into the primary checkout's xlsx folder, reading production live.
Sends no email and notifies nobody. Installed by scripts/field-day/install-task.ps1.
"@ | Out-Null

$task = Get-ScheduledTask -TaskName $TaskName
$info = Get-ScheduledTaskInfo -TaskName $TaskName
"installed: $TaskName"
"  runs      daily at $At  (next: $($info.NextRunTime))"
"  command   $($task.Actions[0].Execute) $($task.Actions[0].Arguments)"
"  log       $log"
"  state     $($task.State)"
