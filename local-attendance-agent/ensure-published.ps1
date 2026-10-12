param(
  [ValidateSet("win-x86", "win-x64")]
  [string]$Runtime = "win-x86"
)

# REPUBLISH THE AGENT WHEN ITS PUBLISHED FILES ARE MISSING.
#
# `publish\<runtime>\` is gitignored build output, so nothing in git can say it is whole. On
# 2026-10-12 it held only Phoenix.Attendance.Agent.exe and .dll - no runtimeconfig.json, no
# deps.json - and the .exe is a bare apphost that cannot start without them: it died with "The
# library 'hostpolicy.dll' required to execute the application was not found" and every start of the
# agent failed the same way. Both start paths (the logon task and invoke-sync.ps1's recovery) only
# asked whether the .exe EXISTED, so each saw a published agent, launched it, and waited out
# "did not start listening on 127.0.0.1:8787 within 30 seconds". The last good sync was 2026-10-06
# 17:00 Cairo, so about six days of fingerprint punches stayed on the device.
#
# This runs before the agent is launched. Complete -> it does nothing and costs four Test-Path calls.
# Incomplete -> it rebuilds with publish-agent.ps1 (the same script a human would run) and checks
# again. Exit 0 means the folder is whole; exit 1 means it could not be made whole, with the reason.
#
# A named mutex serialises it, because the logon task and the startup shortcut both start the agent
# at logon (start-agent.ps1 documents the race) and a republish begins by DELETING the folder - a
# second publish racing the first would remove files the first had just written. The loser waits,
# then finds the folder whole and does nothing.
$ErrorActionPreference = "Stop"
$AgentRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$PublishDir = Join-Path $AgentRoot "publish\$Runtime"
$LogRoot = Join-Path $AgentRoot "logs"
$LogPath = Join-Path $LogRoot "agent-republish.log"

# The files a framework-dependent apphost needs in order to start at all. Program.cs is the agent;
# the runtimeconfig names the .NET runtime to load and the deps file lists what it loads.
$RequiredFiles = @(
  "Phoenix.Attendance.Agent.exe",
  "Phoenix.Attendance.Agent.dll",
  "Phoenix.Attendance.Agent.runtimeconfig.json",
  "Phoenix.Attendance.Agent.deps.json"
)

function Get-MissingPublishedFiles {
  return @($RequiredFiles | Where-Object { -not (Test-Path -LiteralPath (Join-Path $PublishDir $_)) })
}

function Write-RepublishLog([string]$Message) {
  New-Item -ItemType Directory -Path $LogRoot -Force | Out-Null
  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -Path $LogPath -Value "[$timestamp] $Message"
  Write-Host "[attendance-agent] $Message"
}

if ((Get-MissingPublishedFiles).Count -eq 0) { exit 0 }

$mutex = New-Object System.Threading.Mutex($false, "Global\PhoenixAttendanceAgentRepublish")
$held = $false
try {
  try {
    $held = $mutex.WaitOne([TimeSpan]::FromMinutes(5))
  } catch [System.Threading.AbandonedMutexException] {
    # The previous holder died mid-publish. The folder is re-checked below, so owning it is safe.
    $held = $true
  }

  # Re-read after the wait: whoever held the mutex may have just finished the job.
  $missing = Get-MissingPublishedFiles
  if ($missing.Count -gt 0) {
    Write-RepublishLog "Published agent is incomplete ($PublishDir is missing: $($missing -join ', ')) - republishing $Runtime."
    try {
      & (Join-Path $AgentRoot "publish-agent.ps1") -Runtime $Runtime | Out-Null
    } catch {
      Write-RepublishLog "Republish FAILED: $($_.Exception.Message)"
    }
    $missing = Get-MissingPublishedFiles
    if ($missing.Count -eq 0) {
      Write-RepublishLog "Republish complete - all $($RequiredFiles.Count) published files are present."
    }
  }
} finally {
  if ($held) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}

if ((Get-MissingPublishedFiles).Count -gt 0) {
  Write-RepublishLog "Published agent is STILL incomplete: $((Get-MissingPublishedFiles) -join ', ')."
  exit 1
}
exit 0
