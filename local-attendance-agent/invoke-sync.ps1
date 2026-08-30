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

# Reads /health WITHOUT throwing on a non-2xx status.
#
# This exists because Invoke-RestMethod throws on any error status, and the old catch block wrote
# "Agent not reachable" for every failure. That is wrong for the most important case: the agent
# answers on 8787 with HTTP 503 and a body naming exactly what is broken, e.g.
#   {"status":"degraded","checks":{...,"deviceTcpReachable":false},
#    "errors":["Device 192.168.100.52:4370 is not reachable."]}
# Throwing that away turned a precise, actionable diagnosis into "not reachable", then spawned a
# second agent that could never help, and timed out. Punch ingestion was dead from 2026-07-30 to
# 2026-08-08 and every one of the ~100 log lines said the wrong thing.
#
# Returns: @{ Responded = $true|$false; Status = <http status or 0>; Body = <parsed or $null> }
function Get-AgentHealth {
  $result = @{ Body = $null; Responded = $false; Status = 0 }
  try {
    $req = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:8787/health")
    # 20s, not 5s. /health probes the fingerprint device and Phoenix before it answers, so it is
    # slow BY DESIGN when the device is off the network - and a timeout here is not read as "slow",
    # it is read as "nothing is listening", which makes this script launch a second agent on top of
    # a healthy one. That is the duplicate that crashed at every boot. The probes now run
    # concurrently agent-side (~0.3s when the device answers, ~3s when it does not); this budget is
    # the second half of the same fix, so a loaded machine cannot turn slow into dead.
    $req.Timeout = 20000
    $resp = $req.GetResponse()
  } catch [System.Net.WebException] {
    # A WebException with a Response means the agent ANSWERED (e.g. 503) — it is running.
    # No Response means nothing is listening — the agent really is down.
    $resp = $_.Exception.Response
    if (-not $resp) { return $result }
  } catch {
    return $result
  }

  $result.Responded = $true
  $result.Status = [int]$resp.StatusCode
  try {
    $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
    $raw = $reader.ReadToEnd()
    $reader.Close()
    if ($raw) { $result.Body = $raw | ConvertFrom-Json }
  } catch {
    # Body unreadable/not JSON — the status alone is still useful.
  }
  return $result
}

function Format-AgentHealthProblem {
  param($Health)
  if ($Health.Body) {
    # The agent nests its errors under `checks`, not at the top level:
    #   {"status":"degraded","checks":{...,"errors":["Device 192.168.100.52:4370 is not reachable."]}}
    # Both paths are read so a future payload shape change cannot silently drop the reason and
    # send us back to a generic message — which is the whole failure this function exists to end.
    $errors = $null
    if ($Health.Body.checks -and $Health.Body.checks.errors) { $errors = $Health.Body.checks.errors }
    elseif ($Health.Body.errors) { $errors = $Health.Body.errors }
    if ($errors -and @($errors).Count -gt 0) { return (@($errors) -join "; ") }

    # No errors array: name the failed checks themselves, so "degraded" is never the whole story.
    if ($Health.Body.checks) {
      $failed = @()
      foreach ($p in $Health.Body.checks.PSObject.Properties) {
        if ($p.Value -is [bool] -and -not $p.Value) { $failed += $p.Name }
      }
      if ($failed.Count -gt 0) { return "failed checks: " + ($failed -join ", ") }
    }
    if ($Health.Body.status) { return "agent reports status '$($Health.Body.status)'" }
  }
  return "agent returned HTTP $($Health.Status)"
}

function Ensure-Agent {
  $health = Get-AgentHealth
  if ($health.Responded -and $health.Status -ge 200 -and $health.Status -lt 300) { return }

  if ($health.Responded) {
    # The agent IS running and is telling us what is wrong. Starting another copy cannot fix a
    # device that is off the network, so report the real reason and stop.
    $problem = Format-AgentHealthProblem -Health $health
    Write-Log "Agent is RUNNING but not healthy: $problem"
    throw "Agent is running but unhealthy: $problem"
  }

  Write-Log "Agent not listening on 127.0.0.1:8787; starting local agent."
  # QUOTE THE SCRIPT PATH.
  #
  # This checkout lives under "F:\Phoenix Workforce\", and the ARRAY form of -ArgumentList joins its
  # elements with a space WITHOUT quoting any of them. powershell.exe therefore received
  # `-File F:\Phoenix Workforce\...\start-agent.ps1` as several arguments, took the first one, and
  # exited immediately with "Processing -File 'F:\Phoenix' failed because the file does not have a
  # '.ps1' extension". The agent never started, and this function then waited out its full 30
  # seconds and reported "Agent did not start listening on 127.0.0.1:8787 within 30 seconds" — a
  # message about the AGENT for a fault that was entirely in the LAUNCHER. That is the whole reason
  # the recovery path was dead: whenever the agent was down, the one piece of code whose job is to
  # bring it back could never run, so every sync failed until a human started it by hand.
  #
  # Measured both ways on 2026-08-30 against a probe script under a path containing a space: the
  # array form failed with the message above; the quoted single string ran the script. The installed
  # scheduled tasks and install-startup-shortcut.ps1 have always quoted this path, which is why the
  # tasks themselves ran fine and only this in-script recovery was broken — do not "simplify" it
  # back to the array form to match some other call site.
  Start-Process powershell.exe `
    -WindowStyle Hidden `
    -WorkingDirectory $AgentRoot `
    -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$StartScript`" -SkipPrereqInstall" | Out-Null

  $deadline = (Get-Date).AddSeconds(30)
  do {
    Start-Sleep -Seconds 2
    $health = Get-AgentHealth
    if ($health.Responded -and $health.Status -ge 200 -and $health.Status -lt 300) {
      Write-Log "Agent started."
      return
    }
    if ((Get-Date) -gt $deadline) {
      if ($health.Responded) {
        $problem = Format-AgentHealthProblem -Health $health
        Write-Log "Agent started but is unhealthy: $problem"
        throw "Agent started but is unhealthy: $problem"
      }
      throw "Agent did not start listening on 127.0.0.1:8787 within 30 seconds."
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
  # Log the RESPONSE BODY, not just "(500) Internal Server Error".
  #
  # Invoke-RestMethod throws on a non-2xx and discards the body, so a failing sync recorded only
  # the status line — which says nothing about WHY. The agent returns a JSON error describing the
  # actual fault (device/SDK/upload), and without it the operator is left guessing at a 500 exactly
  # as they were left guessing at "Agent not reachable" while the device sat off the network for
  # nine days.
  $detail = $_.Exception.Message
  $resp = $null
  if ($_.Exception -is [System.Net.WebException]) { $resp = $_.Exception.Response }
  elseif ($_.Exception.PSObject.Properties.Name -contains "Response") { $resp = $_.Exception.Response }
  if ($resp) {
    try {
      $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
      $bodyText = $reader.ReadToEnd()
      $reader.Close()
      if ($bodyText) { $detail = "$detail | agent said: $bodyText" }
    } catch {
      # Body unreadable — the status line above is still logged.
    }
  }
  Write-Log "Scheduled sync failed: $detail"
  throw
}
