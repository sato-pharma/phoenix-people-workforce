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

# ONE AGENT AT A TIME - EXIT QUIETLY IF SOMETHING ALREADY HOLDS THE PORT.
#
# Two things start this script at logon: the "Phoenix Attendance Agent - Run At Logon" scheduled
# task and the startup shortcut. Both fired, both reached Start-Process, the first won the
# 127.0.0.1:8787 bind and the second died on it - an unhandled managed exception, LastTaskResult
# 3762504530 (0xE0434352), logged as an Application Error against the exe with no explanation.
# Measured on the 2026-08-26 15:14 reboot: task at 15:15:07, winning agent at 15:15:16 (which then
# served every sync all day), crash at 15:15:21. The crash was always the LOSER of a race, never a
# sick agent - which is why "attendance is broken" was the wrong reading of it every time.
#
# This is checked before the prereq install and before the log rotation below, deliberately, because
# a redundant launch does real damage on its way to failing: install-prereqs.ps1 copies
# ATTENDANCE_AGENT_TOKEN out of the repo .env.local over this agent's .env (that overwrote a working
# production token on 2026-08-30), and the rotation moves agent.log aside and truncates it while the
# WINNING instance is still writing to it - destroying the one record that explains a death.
#
# A raw TCP connect is the right probe, not GET /health. A healthy-but-degraded agent answers 503
# when the fingerprint device is off the network, which is most of the night, so anything that reads
# a non-2xx as "not running" would launch the duplicate this guard exists to prevent. Port-bound is
# the exact question being asked. If something OTHER than the agent holds 8787 then the agent could
# not bind either, so declining to start is the correct outcome - and it now says so and exits 0
# instead of crashing.
#
# Residual, accepted: two launches less than the probe apart can still both see a free port. That is
# a sub-second window against the ~9 seconds actually observed, and the failure mode is unchanged
# from today. It is not closed with a mutex on purpose - a mutex that misfires would stop the agent
# starting at all, which is far worse than the duplicate it would prevent.
$AgentPortInUse = $false
try {
  $probe = New-Object System.Net.Sockets.TcpClient
  $AgentPortInUse = $probe.ConnectAsync("127.0.0.1", 8787).Wait(2000) -and $probe.Connected
} catch {
  $AgentPortInUse = $false
} finally {
  if ($probe) { $probe.Dispose() }
}
if ($AgentPortInUse) {
  Write-Host "[attendance-agent] Something is already listening on 127.0.0.1:8787 - leaving it alone and exiting."
  exit 0
}

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
