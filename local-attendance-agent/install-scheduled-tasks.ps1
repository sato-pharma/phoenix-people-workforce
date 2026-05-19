param(
  [string]$EveryTwoHoursStart = "08:00",
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

Create-Task @(
  "/Create",
  "/TN", "Phoenix Attendance Sync - Every 2 Hours",
  "/TR", $syncCommand,
  "/SC", "HOURLY",
  "/MO", "2",
  "/ST", $EveryTwoHoursStart,
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
Write-Host "  Phoenix Attendance Sync - Every 2 Hours starting $EveryTwoHoursStart"
Write-Host "  Phoenix Attendance Sync - Required 5 PM"
