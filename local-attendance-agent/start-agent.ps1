param(
  [switch]$SkipPrereqInstall,
  [ValidateSet("win-x86", "win-x64")]
  [string]$Runtime = "win-x86"
)

$ErrorActionPreference = "Stop"
$AgentRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectPath = Join-Path $AgentRoot "Phoenix.Attendance.Agent.csproj"
$PublishedExe = Join-Path $AgentRoot "publish\$Runtime\Phoenix.Attendance.Agent.exe"
$DotnetHome = Join-Path $AgentRoot ".dotnet-home"
$NuGetRoot = Join-Path $AgentRoot ".nuget"
$AppDataRoot = Join-Path $AgentRoot ".appdata"

Set-Location $AgentRoot
New-Item -ItemType Directory -Path $DotnetHome -Force | Out-Null
New-Item -ItemType Directory -Path $NuGetRoot -Force | Out-Null
New-Item -ItemType Directory -Path $AppDataRoot -Force | Out-Null
$env:DOTNET_CLI_HOME = $DotnetHome
$env:DOTNET_CLI_TELEMETRY_OPTOUT = "1"
$env:NUGET_PACKAGES = Join-Path $NuGetRoot "packages"
$env:NUGET_HTTP_CACHE_PATH = Join-Path $NuGetRoot "http-cache"
$env:NUGET_PLUGINS_CACHE_PATH = Join-Path $NuGetRoot "plugins-cache"
$env:APPDATA = Join-Path $AppDataRoot "Roaming"
$env:LOCALAPPDATA = Join-Path $AppDataRoot "Local"

if (-not $SkipPrereqInstall) {
  & (Join-Path $AgentRoot "install-prereqs.ps1")
}

if (Test-Path $PublishedExe) {
  Write-Host "[attendance-agent] Starting published executable $PublishedExe"
  & $PublishedExe
  exit $LASTEXITCODE
}

Write-Host "[attendance-agent] Starting with dotnet run"
& (Join-Path $AgentRoot "build-agent.ps1")
dotnet run --project $ProjectPath --no-restore
exit $LASTEXITCODE
