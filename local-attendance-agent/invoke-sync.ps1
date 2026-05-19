param(
  [int]$TimeoutSeconds = 650
)

$ErrorActionPreference = "Stop"
$AgentRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$EnvPath = Join-Path $AgentRoot ".env"
$StartScript = Join-Path $AgentRoot "start-agent.ps1"
$LogRoot = Join-Path $AgentRoot "logs"
$LogPath = Join-Path $LogRoot "scheduled-sync.log"

New-Item -ItemType Directory -Path $LogRoot -Force | Out-Null

function Write-Log([string]$Message) {
  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -Path $LogPath -Value "[$timestamp] $Message"
}

function Read-EnvValue([string]$Name) {
  if (-not (Test-Path $EnvPath)) { return $null }
  $line = Get-Content -Path $EnvPath | Where-Object { $_ -match "^$Name=" } | Select-Object -First 1
  if (-not $line) { return $null }
  return $line.Substring($Name.Length + 1).Trim().Trim('"')
}

function Ensure-Agent {
  try {
    Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:8787/health" -TimeoutSec 5 | Out-Null
    return
  } catch {
    Write-Log "Agent not reachable; starting local agent."
  }

  Start-Process powershell.exe `
    -WindowStyle Hidden `
    -WorkingDirectory $AgentRoot `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $StartScript, "-SkipPrereqInstall") | Out-Null

  $deadline = (Get-Date).AddSeconds(30)
  do {
    Start-Sleep -Seconds 2
    try {
      Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:8787/health" -TimeoutSec 5 | Out-Null
      Write-Log "Agent started."
      return
    } catch {
      if ((Get-Date) -gt $deadline) { throw "Agent did not become reachable within 30 seconds." }
    }
  } while ($true)
}

$token = Read-EnvValue "ATTENDANCE_AGENT_TOKEN"
if ([string]::IsNullOrWhiteSpace($token)) {
  throw "ATTENDANCE_AGENT_TOKEN is missing in $EnvPath"
}

try {
  Ensure-Agent
  Write-Log "Scheduled sync started."
  $response = Invoke-RestMethod `
    -Method Post `
    -Uri "http://127.0.0.1:8787/sync-now" `
    -Headers @{ Authorization = "Bearer $token" } `
    -ContentType "application/json" `
    -Body "{}" `
    -TimeoutSec $TimeoutSeconds
  Write-Log "Scheduled sync completed: $($response | ConvertTo-Json -Compress -Depth 8)"
} catch {
  Write-Log "Scheduled sync failed: $($_.Exception.Message)"
  throw
}
