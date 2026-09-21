param(
  # THE 2-HOURLY SYNC ONLY RUNS INSIDE OFFICE HOURS, and that is deliberate.
  #
  # It reaches the ZKTeco device over the OFFICE LAN (192.168.100.52:4370). When the laptop is
  # anywhere else the sync cannot work, the agent answers 503 with
  # "Device TCP port is not reachable at 192.168.100.52:4370", and the task exits 1. Measured from
  # logs/scheduled-sync.log on 2026-09-21 over the preceding fortnight, with the old around-the-clock
  # schedule: the 00:00, 02:00, 04:00, 06:00, 20:00 and 22:00 fires produced 0 successes in 69
  # attempts, while 10:00-18:00 produced 41. So those runs cost only a red task that means nothing -
  # and a task nobody believes is worse than no task.
  #
  # Nothing is lost by skipping them: each successful run reads the device's WHOLE buffer (5,869
  # punches read, 30 new inserted on 2026-09-20 14:00), not just what arrived since last time, so one
  # good run catches up the day. "Required 5 PM" is the backstop.
  #
  # The window is start + duration, repeating every 2 hours: 10:30 for 7 hours fires 10:30, 12:30,
  # 14:30 and 16:30, and closes at 17:30. Owner's hours, set 2026-09-21.
  [string]$SyncWindowStart = "10:30",
  [int]$SyncWindowHours = 7,
  [string]$DailyRequiredSyncTime = "17:00"
)

$ErrorActionPreference = "Stop"
$AgentRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$StartScript = Join-Path $AgentRoot "start-agent.ps1"
$SyncScript = Join-Path $AgentRoot "invoke-sync.ps1"

if (-not (Test-Path $StartScript)) { throw "Missing $StartScript" }
if (-not (Test-Path $SyncScript)) { throw "Missing $SyncScript" }

function Task-Command([string]$ScriptPath) {
  $quotedScriptPath = '\"' + $ScriptPath + '\"'
  return "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $quotedScriptPath"
}

function Create-Task([string[]]$TaskArgs) {
  & schtasks.exe @TaskArgs
  if ($LASTEXITCODE -ne 0) {
    throw "schtasks.exe failed with exit code $LASTEXITCODE"
  }
}

$startCommand = "$(Task-Command $StartScript) -SkipPrereqInstall"
$syncCommand = Task-Command $SyncScript

Create-Task @(
  "/Create",
  "/TN", "Phoenix Attendance Agent - Run At Logon",
  "/TR", $startCommand,
  "/SC", "ONLOGON",
  "/RU", $env:USERNAME,
  "/RL", "LIMITED",
  "/F"
)

# DAILY + /RI + /DU, not HOURLY /MO 2.
#
# "/SC HOURLY /MO 2" repeats forever from its start time, which is exactly the around-the-clock
# schedule this replaces - HOURLY has no window to give it. A daily trigger with a repetition
# interval and a duration does, and Windows renders it as one MSFT_TaskDailyTrigger with
# Repetition Interval PT2H, Duration PT7H. Verified on 2026-09-21 by registering this exact
# argument list under a throwaway name and reading the trigger back.
#
# /DU is HHHH:MM, so the hours are formatted with a leading zero and ":00".
$syncWindowDuration = "{0:00}:00" -f $SyncWindowHours

Create-Task @(
  "/Create",
  "/TN", "Phoenix Attendance Sync - Every 2 Hours",
  "/TR", $syncCommand,
  "/SC", "DAILY",
  "/ST", $SyncWindowStart,
  "/RI", "120",
  "/DU", $syncWindowDuration,
  "/RU", $env:USERNAME,
  "/RL", "LIMITED",
  "/F"
)

Create-Task @(
  "/Create",
  "/TN", "Phoenix Attendance Sync - Required 5 PM",
  "/TR", $syncCommand,
  "/SC", "DAILY",
  "/ST", $DailyRequiredSyncTime,
  "/RU", $env:USERNAME,
  "/RL", "LIMITED",
  "/F"
)

Write-Host "[attendance-agent] Installed scheduled tasks:"
Write-Host "  Phoenix Attendance Agent - Run At Logon"
Write-Host "  Phoenix Attendance Sync - Every 2 Hours, every 2h inside $SyncWindowStart +$SyncWindowHours h (office hours only)"
Write-Host "  Phoenix Attendance Sync - Required 5 PM"
