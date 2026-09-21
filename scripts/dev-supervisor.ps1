# Dev-server supervisor.
#
# WHY THIS EXISTS
#   The local dev server shuts itself down cleanly after roughly ten minutes. Measured
#   2026-09-07: started 14:02:38 Cairo, served /admin 200, badge-counts 200 and
#   notifications 200 the whole time it lived, then ended on a bare `[?25h` with no crash
#   and nothing in the Windows event log. An earlier session lost seven servers the same way
#   and three diagnoses were all WRONG - it is not the memory watchdog (that hard-kills with
#   Stop-Process and logs every kill; its log is silent across every death), not the
#   controlling shell (a detached child died identically), and not the console group (a
#   WMI-created process with its own console died identically). Whatever asks it to stop asks
#   politely, and nobody has identified it.
#
#   So this does not try to PREVENT the death. It makes the death survivable. Measured
#   recovery from kill to serving: about 65 seconds.
#
# WHY IT IS A TRACKED SCRIPT AND NOT A SCRATCH FILE
#   The previous supervisor lived in a Claude session's temp folder. It outlived its session
#   by six hours and kept restarting a dev server inside a worktree that was being retired,
#   fighting the removal. Nothing in git, `list_sessions` or the worktree registry could see
#   it - it was only found by walking the process tree. Keep this one findable.
#
# RUN IT   (from the repo root; node/pnpm are not involved)
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev-supervisor.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev-supervisor.ps1 -Port 3001
#
# STOP IT  (stopping the supervisor does NOT stop the dev server)
#   Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
#     Where-Object { $_.CommandLine -like '*-File*dev-supervisor.ps1*' -and $_.ProcessId -ne $PID } |
#     ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
#
#   Then kill the server itself by PORT, never by task - stopping a background task kills the
#   wrapper shell and leaves `next dev` holding the port:
#   Get-NetTCPConnection -LocalPort 3000 -State Listen |
#     ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }

param(
  [int]$Port = 3000,
  [string]$RepoRoot = (Split-Path $PSScriptRoot -Parent)
)

# Logs live BESIDE the repo, never inside it: they would otherwise need a .gitignore entry and
# would land in the working tree of every worktree that shares this script.
$LogDir    = Split-Path $RepoRoot -Parent
$DevLog    = Join-Path $LogDir ("dev-{0}.log" -f $Port)
$SupLog    = Join-Path $LogDir ("dev-supervisor-{0}.log" -f $Port)
$Heartbeat = Join-Path $LogDir ("dev-supervisor-{0}.heartbeat" -f $Port)

function Write-Sup($msg) {
  $line = '[{0} Cairo] {1}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $msg
  try { Add-Content -Path $SupLog -Value $line -Encoding utf8 } catch {}
}

# --- refuse to stack a second supervisor -------------------------------------------------
# Guard on the HEARTBEAT FILE, never the process list. A CommandLine filter matches the
# process running it AND anything that merely NAMES the script - the shell that launched it,
# or an agent's own tool call. The first version of this guard excluded $PID correctly and
# still refused to start, because a PowerShell one-liner that only mentioned the path counted
# as a supervisor. A fresh heartbeat plus a live PID is the only thing that proves one is up.
if (Test-Path $Heartbeat) {
  $age = (Get-Date) - (Get-Item $Heartbeat).LastWriteTime
  if ($age.TotalSeconds -lt 90) {
    $hbPid = $null
    try { $hbPid = [int](((Get-Content $Heartbeat -Raw) -split 'pid=')[1].Trim()) } catch {}
    if ($hbPid -and (Get-Process -Id $hbPid -ErrorAction SilentlyContinue)) {
      Write-Sup ("REFUSING TO START - supervisor pid {0} is live (heartbeat {1:N0}s old)" -f $hbPid, $age.TotalSeconds)
      exit 1
    }
  }
}

function Test-DevUp {
  # A live probe is the only thing that settles this, in BOTH directions: a listener can be
  # held by a process that no longer serves, and a background task can report failure while
  # the port still answers 200. The timeout is generous because a cold compile of a heavy
  # route (/admin measured 41s) starves the event loop.
  try {
    $r = Invoke-WebRequest -Uri "http://localhost:$Port/api/healthz" -TimeoutSec 45 -UseBasicParsing -ErrorAction Stop
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

function Start-Dev {
  # Through the launcher, never a raw `next dev`: scripts/dev-server.mjs picks --webpack on Windows
  # (three consecutive turbopack servers wedged solid holding 3.2-5.8 GB each while webpack served
  # in 11s, and turbopack rejects the junctioned node_modules), caps the server's heap at 4 GB where
  # Next alone would allow half of RAM, and refuses to start a second dev server. That refusal lands
  # in the dev log and this loop simply tries again next round.
  # Invoke node directly - `pnpm run`/`pnpm exec` in a worktree purges the node_modules
  # junction before Next ever starts, and reports success while the port stays dead.
  $cmd = 'cmd.exe /c node scripts\dev-server.mjs --port ' + $Port + ' >> "' + $DevLog + '" 2>&1'
  return Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = $cmd; CurrentDirectory = $RepoRoot
  }
}

Write-Sup "SUPERVISOR START pid=$PID port=$Port repo=$RepoRoot"

$misses = 0
$starts = 0

while ($true) {
  # A heartbeat file, not the process state: a scheduled task can read Running with a
  # successful last run while the process has been dead for minutes. Only a heartbeat plus a
  # live process check answers "is this actually alive".
  try {
    Set-Content -Path $Heartbeat -Encoding utf8 -Value ((Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + " Cairo pid=$PID")
  } catch {}

  if (Test-DevUp) {
    if ($misses -gt 0) { Write-Sup "recovered - healthz answering again after $misses miss(es)" }
    $misses = 0
  } else {
    $misses++
    # Three consecutive misses, not one: a cold compile can time out a single probe on a
    # loaded box, and restarting on that would kill a server that was merely busy.
    if ($misses -ge 3) {
      $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
      if ($listener) {
        # Guard on the LISTENER, never a PID. This is what makes it impossible to stack two
        # servers on one port - the failure mode that actually costs time.
        Write-Sup ("port {0} still has a listener (pid {1}) but healthz is dead - leaving it alone this round" -f $Port, $listener[0].OwningProcess)
      } else {
        $starts++
        $r = Start-Dev
        Write-Sup ("RESTART #{0} - dev server was down, started pid={1} rv={2}" -f $starts, $r.ProcessId, $r.ReturnValue)
        Start-Sleep -Seconds 45
        $misses = 0
      }
    }
  }

  Start-Sleep -Seconds 30
}
