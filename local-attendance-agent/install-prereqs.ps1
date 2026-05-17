param([switch]$SkipDotnetInstall)

$ErrorActionPreference = "Stop"
$AgentRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $AgentRoot
$EnvPath = Join-Path $AgentRoot ".env"
$EnvExamplePath = Join-Path $AgentRoot ".env.example"
$PhoenixEnvPath = Join-Path $RepoRoot ".env.local"

function Write-Step { param([string]$Message) Write-Host "[attendance-agent] $Message" }

function Get-Dotnet8Sdk {
  try { return @(dotnet --list-sdks 2>$null | Where-Object { $_ -match '^8\.' }) } catch { return @() }
}

function Set-EnvValue {
  param([string]$Path, [string]$Name, [string]$Value)
  $lines = Get-Content -Path $Path
  $found = $false
  $updated = foreach ($line in $lines) {
    if ($line -match "^$([regex]::Escape($Name))=") {
      $found = $true
      "$Name=$Value"
    } else {
      $line
    }
  }
  if (-not $found) { $updated += "$Name=$Value" }
  Set-Content -Path $Path -Value $updated -Encoding UTF8
}

Write-Step "Checking .NET 8 SDK"
$sdks = Get-Dotnet8Sdk
if ($sdks.Count -eq 0) {
  if ($SkipDotnetInstall) { throw ".NET 8 SDK is not installed." }
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $winget) { throw ".NET 8 SDK is missing and winget is not available." }
  Write-Step "Installing Microsoft.DotNet.SDK.8 with winget"
  winget install --id Microsoft.DotNet.SDK.8 --exact --source winget --accept-package-agreements --accept-source-agreements --silent
  if ($LASTEXITCODE -ne 0) { throw "winget failed while installing Microsoft.DotNet.SDK.8." }
} else {
  Write-Step "Found .NET SDK: $($sdks[0])"
}

if (-not (Test-Path $EnvPath)) {
  Write-Step "Creating .env from .env.example"
  Copy-Item -Path $EnvExamplePath -Destination $EnvPath
}

if (Test-Path $PhoenixEnvPath) {
  $tokenLine = Get-Content -Path $PhoenixEnvPath | Where-Object { $_ -match '^ATTENDANCE_AGENT_TOKEN=' } | Select-Object -First 1
  if ($tokenLine) {
    $token = $tokenLine.Substring("ATTENDANCE_AGENT_TOKEN=".Length).Trim().Trim('"')
    if ($token) {
      Set-EnvValue -Path $EnvPath -Name "ATTENDANCE_AGENT_TOKEN" -Value $token
      Write-Step "Copied ATTENDANCE_AGENT_TOKEN from Phoenix .env.local without printing it"
    }
  }
}

Write-Step "Checking ZKTeco COM SDK registration"
$zkType = [type]::GetTypeFromProgID("zkemkeeper.CZKEM")
if ($null -eq $zkType) { $zkType = [type]::GetTypeFromProgID("zkemkeeper.ZKEM") }
if ($null -eq $zkType) {
  Write-Warning "ZKTeco SDK is not registered as zkemkeeper.CZKEM or zkemkeeper.ZKEM. Register zkemkeeper.dll with regsvr32."
} else {
  Write-Step "ZKTeco COM SDK is registered"
}

Write-Step "Prerequisite check complete"
