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
# 🔴 THE TASK RUNS A COPY OF `run-nightly.mjs` IN ~/.claude/scripts, NOT A FILE IN A CHECKOUT — see
# the note beside the deploy below for the measurement that forced it.
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
# Deploy the launcher OUTSIDE every checkout, beside the machine's other scheduled work.
#
# 🔴 THE TASK MUST NOT NAME A FILE IN A WORKING TREE, and that indirection is the whole point. The
# primary is a shared folder nobody pulls — measured 2026-10-03, minutes after the printer merged, it
# sat 74 commits behind `origin/main` with a live session in it — so a task pointed at a working tree
# runs whatever that tree happens to hold, or on the first night nothing at all, and says so to no
# one. The launcher is tiny, uses node builtins only, and fetches the real printer from `origin/main`
# on every run, so what it builds is always what merged.
$launcherDir = Join-Path ([Environment]::GetFolderPath("UserProfile")) ".claude\scripts"
New-Item -ItemType Directory -Force -Path $launcherDir | Out-Null
$launcher = Join-Path $launcherDir "field-day-nightly.mjs"
Copy-Item -Path (Join-Path $scriptRoot "run-nightly.mjs") -Destination $launcher -Force

$node = (Get-Command node).Source
$log = Join-Path $primary "xlsx\field-day-task.log"

# 🔴 NODE DIRECTLY, NEVER `cmd /c node ... >> log`. Measured 2026-10-03: with cmd in the chain the
# task returned 0x1 the instant it fired and wrote NOTHING at all, because `cmd /c "A" "B" >> "C"`
# strips the outer pair of quotes and mangles the path to node.exe. The launcher writes the log
# itself, so there is no shell to misquote and a failed run still leaves its reason behind — which is
# the only thing anybody will ever read about a 21:00 run.
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$launcher`"" -WorkingDirectory $primary
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
summary for the Chief Executive — into the primary checkout's xlsx folder, reading production live
from origin/main in a throwaway worktree.
Sends no email and notifies nobody. Installed by scripts/field-day/install-task.ps1.
"@ | Out-Null

$task = Get-ScheduledTask -TaskName $TaskName
$info = Get-ScheduledTaskInfo -TaskName $TaskName
"installed: $TaskName"
"  runs      daily at $At  (next: $($info.NextRunTime))"
"  launcher  $launcher"
"  papers    $(Join-Path $primary 'xlsx')"
"  log       $log"
"  state     $($task.State)"
