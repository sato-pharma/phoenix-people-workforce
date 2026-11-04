# fix-task-windows-elevated.ps1
#
# WHY THIS EXISTS. Windows 11 makes Windows Terminal the default terminal host.
# A scheduled task that launches a console program (powershell.exe, cmd.exe,
# node.exe) therefore gets a real Windows Terminal WINDOW on screen, and
# "-WindowStyle Hidden" does NOT suppress it: that flag hides PowerShell's own
# host window, not the separate WindowsTerminal.exe process that draws the frame.
# Under the old conhost host the same task only flashed; now it sits there, and
# for a task whose script runs forever (the xlsx tripwire) the window never goes.
#
# THE FIX is the form the "Claude Scratchpad Archive - Hourly" task has always
# used and which has never popped a window: run the program through
#     conhost.exe --headless <program> <original arguments>
# conhost --headless attaches a console with no window at all. Nothing about the
# script, its schedule, its account or its output changes - only the host.
#
# Eight tasks were converted on 2026-09-21 from a normal session. The four below
# refused with "Access is denied" because they were registered elevated, so they
# can only be changed from an elevated PowerShell. That is all this script does.
#
# It is IDEMPOTENT: a task already running through conhost is left alone.
# Original definitions are backed up at
#     C:\Users\satoh\.claude\backups\scheduled-tasks-2026-09-21\*.xml
# and restored with:  schtasks /create /tn "<name>" /xml "<file>" /f

#Requires -RunAsAdministrator

$ErrorActionPreference = 'Stop'

$targets = @(
  @{ Path = '\'; Name = 'PhoenixWorkforce Memory Watchdog' },
  @{ Path = '\'; Name = 'Phoenix Attendance Agent - Run At Logon' },
  @{ Path = '\'; Name = 'Phoenix Attendance Sync - Every 2 Hours' },
  @{ Path = '\'; Name = 'Phoenix Attendance Sync - Required 5 PM' }
)

# Changing a task's action does NOT start it. The attendance agent keeps running
# as it is until its next natural trigger, so no sync fires because of this.
foreach ($t in $targets) {
  $task = Get-ScheduledTask -TaskPath $t.Path -TaskName $t.Name -ErrorAction SilentlyContinue
  if (-not $task) { Write-Host "SKIP  $($t.Name) - not found"; continue }

  $action = $task.Actions[0]
  if ($action.Execute -match 'conhost') { Write-Host "SKIP  $($t.Name) - already windowless"; continue }

  $argument = '--headless ' + $action.Execute
  if ($action.Arguments) { $argument += ' ' + $action.Arguments }

  $params = @{ Execute = 'conhost.exe'; Argument = $argument }
  if ($action.WorkingDirectory) { $params['WorkingDirectory'] = $action.WorkingDirectory }

  try {
    Set-ScheduledTask -TaskPath $t.Path -TaskName $t.Name -Action (New-ScheduledTaskAction @params) | Out-Null
    Write-Host "OK    $($t.Name)"
  } catch {
    Write-Host "FAIL  $($t.Name) - $($_.Exception.Message)"
  }
}

Write-Host ''
Write-Host '--- final state of every task that can draw a window ---'
$all = @(
  'Phoenix xlsx Tripwire - At Logon', 'Phoenix xlsx Snapshot - Hourly',
  'Phoenix xlsx Snapshot - Fetch', 'Phoenix xlsx Snapshot - Failure Alert',
  'Memory Watchdog Keepalive', 'ClaudeCode Hygiene - Weekly',
  'Claude Scratchpad Archive - Hourly', 'PhoenixWorkforce Memory Watchdog',
  'PhoenixWorkforce RAM Guard', 'Phoenix Attendance Agent - Run At Logon',
  'Phoenix Attendance Sync - Every 2 Hours', 'Phoenix Attendance Sync - Required 5 PM'
)
foreach ($n in $all) {
  $task = Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue
  if (-not $task) { continue }
  $state = if ($task.Actions[0].Execute -match 'conhost') { 'windowless' } else { 'STILL POPS A WINDOW' }
  '{0,-42} {1}' -f $n, $state
}
