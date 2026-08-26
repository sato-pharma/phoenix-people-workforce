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
  # KEEP THE AGENT'S OWN OUTPUT.
  #
  # The logon task runs this script with -WindowStyle Hidden, so everything the agent logged went
  # to a console nobody could ever see. When the agent died between the 16:31 boot and 17:00 on
  # 2026-08-26 there was no record at all of why - only the silence of a task that had exited 0.
  # Its structured JSON log is the one thing that can answer that, so it goes to a file.
  #
  # Start-Process is used rather than a Tee-Object pipeline on purpose: this script runs under
  # $ErrorActionPreference = "Stop", and merging a NATIVE command's stderr in Windows PowerShell
  # wraps each line in a NativeCommandError that would abort the launch on the agent's first
  # warning. Redirection files are truncated on open, so the previous run is rotated aside first -
  # one boot back is exactly the window needed to explain a death at the next boot.
  $LogRoot = Join-Path $AgentRoot "logs"
  New-Item -ItemType Directory -Path $LogRoot -Force | Out-Null
  $AgentLog = Join-Path $LogRoot "agent.log"
  $AgentErrLog = Join-Path $LogRoot "agent.err.log"
  foreach ($pair in @(@($AgentLog, "$AgentLog.prev"), @($AgentErrLog, "$AgentErrLog.prev"))) {
    if (Test-Path $pair[0]) { Move-Item -LiteralPath $pair[0] -Destination $pair[1] -Force }
  }

  Write-Host "[attendance-agent] Starting published executable $PublishedExe"
  Write-Host "[attendance-agent] Agent log: $AgentLog"
  $agent = Start-Process -FilePath $PublishedExe `
    -WorkingDirectory $AgentRoot `
    -NoNewWindow `
    -PassThru `
    -RedirectStandardOutput $AgentLog `
    -RedirectStandardError $AgentErrLog
  $agent.WaitForExit()
  exit $agent.ExitCode
}

Write-Host "[attendance-agent] Starting with dotnet run"
& (Join-Path $AgentRoot "build-agent.ps1")
dotnet run --project $ProjectPath --no-restore
exit $LASTEXITCODE
