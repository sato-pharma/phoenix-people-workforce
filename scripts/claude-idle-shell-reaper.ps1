<#
.SYNOPSIS
  Ends the Claude desktop app's IDLE terminal-panel shells (owner-approved 2026-10-23).

  The app opens one powershell.exe for every Code session you open and keeps it until the app
  quits, even after the session goes idle or is archived (anthropics/claude-code#93151). Ending one
  is what typing `exit` in that session's terminal panel does: the app's own exit handler cleans
  up, and the next time the session is opened it starts a fresh shell (app 2.31226.1 code:
  startShellPty reuses a live shell, and spawns a new one when there is none).

  A shell is ended ONLY when every one of these holds; anything uncertain is left alone:
    1. it is a bare powershell.exe / pwsh.exe whose parent is the app's own NodeService process;
    2. the app log ties it to exactly ONE key, and that key is a session's panel shell
       (local_<uuid>), never an extra terminal tab (local_<uuid>::N);
    3. it is running nothing (no child process other than conhost.exe);
    4. its session is not the focused one and has not been focused for -IdleMinutes;
    5. the shell itself is older than -IdleMinutes.
  It never touches a Claude Code session (claude.exe), an MCP server, a dev server or any other
  process, and never ends a process tree, only that one shell.

.EXAMPLE
  .\claude-idle-shell-reaper.ps1                 # dry run: shows what it would end
  .\claude-idle-shell-reaper.ps1 -Apply          # ends the shells that pass every check
#>
param([int]$IdleMinutes = 60, [switch]$Apply)

$ErrorActionPreference = 'Stop'
$logFile = Join-Path $env:USERPROFILE '.claude\logs\claude-idle-shell-reaper.log'
function Write-Log([string]$msg) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Write-Output $line
  if ($Apply) { Add-Content -LiteralPath $logFile -Value $line -Encoding utf8 }
}

$procs = @(Get-CimInstance Win32_Process)
$main = @($procs | Where-Object {
  $_.Name -eq 'Claude.exe' -and $_.ExecutablePath -like '*\WindowsApps\Claude_*\app\Claude.exe' -and $_.CommandLine -notmatch '--type='
})
if ($main.Count -ne 1) { Write-Log "Claude app main process count is $($main.Count), not 1 - nothing done."; exit 0 }
$main = $main[0]
$hostIds = @($procs | Where-Object {
  $_.ParentProcessId -eq $main.ProcessId -and $_.CommandLine -match '--utility-sub-type=node\.mojom\.NodeService'
} | ForEach-Object { [int]$_.ProcessId })
$shells = @($procs | Where-Object {
  $hostIds -contains [int]$_.ParentProcessId -and $_.Name -match '^(powershell|pwsh)\.exe$' -and
  ($_.CommandLine -match '^\s*"?[^"]*\\(powershell|pwsh)\.exe"?\s*$' -or $_.CommandLine -match '^\s*"?[^"]*\\(powershell|pwsh)\.exe"?\s+-NoProfile -NoExit -Command "try \{ if \(\$ExecutionContext\.SessionState\.LanguageMode')
})
if ($shells.Count -eq 0) { Write-Output 'No app terminal shells are running.'; exit 0 }

# The app log since this app instance started (main1.log too, in case it rotated since).
$logDir = Join-Path $env:LOCALAPPDATA 'Claude\Logs'
$sinceText = $main.CreationDate.AddSeconds(-5).ToString('yyyy-MM-dd HH:mm:ss')
$lines = foreach ($f in 'main1.log', 'main.log') {
  $p = Join-Path $logDir $f
  if (Test-Path -LiteralPath $p) {
    Get-Content -LiteralPath $p | Where-Object { $_.Length -ge 19 -and $_.Substring(0, 19) -ge $sinceText }
  }
}
$starts = New-Object System.Collections.Generic.List[object]
$lastActive = @{}
$focused = $null
foreach ($l in $lines) {
  $m = [regex]::Match($l, '^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}).*LocalSessions\.(startShellPty|setFocusedSession): sessionId=([^,\s]+)')
  if (-not $m.Success) { continue }
  $t = [datetime]::ParseExact($m.Groups[1].Value, 'yyyy-MM-dd HH:mm:ss', $null)
  $key = $m.Groups[3].Value
  if ($m.Groups[2].Value -eq 'setFocusedSession') {
    $focused = if ($key -eq 'null') { $null } else { $key }
    if ($key -ne 'null') { $lastActive[$key] = $t }
  } else {
    $starts.Add([pscustomobject]@{ t = $t; key = $key })
    $lastActive[$key] = $t
  }
}

$now = Get-Date
$ended = 0; $kept = 0; $would = 0
foreach ($s in $shells) {
  $shellPid = [int]$s.ProcessId
  $born = $s.CreationDate
  $near = @($starts | Where-Object { $_.t -ge $born.AddSeconds(-6) -and $_.t -le $born.AddSeconds(2) } |
    ForEach-Object { $_.key } | Select-Object -Unique)
  $key = if ($near.Count -eq 1) { $near[0] } else { $null }
  $name = if ($key) { $key -replace '^local_([0-9a-f]{8})[0-9a-f-]*', 'session $1' } else { 'unmatched' }
  $label = '{0} (shell {1}, {2:N0} MB)' -f $name, $shellPid, ($s.WorkingSetSize / 1MB)
  $idleMin = 0
  $reason = $null
  if (-not $key) { $reason = "not matched to exactly one session ($($near.Count) candidates)" }
  else {
    $kids = @($procs | Where-Object { $_.ParentProcessId -eq $shellPid -and $_.Name -ne 'conhost.exe' })
    if ($lastActive.ContainsKey($key)) { $idleMin = ($now - $lastActive[$key]).TotalMinutes }
    if ($key -notmatch '^local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') { $reason = 'an extra terminal tab, not the panel shell' }
    elseif ($kids.Count -gt 0) { $reason = "running a command ($(($kids | ForEach-Object { $_.Name }) -join ', '))" }
    elseif ($key -eq $focused) { $reason = 'its session is the focused one' }
    elseif ($idleMin -lt $IdleMinutes) { $reason = ('its session was used {0:N0} min ago' -f $idleMin) }
    elseif (($now - $born).TotalMinutes -lt $IdleMinutes) { $reason = 'the shell is younger than the idle limit' }
  }
  if ($reason) { $kept++; Write-Output "keep  $label - $reason"; continue }
  if (-not $Apply) { $would++; Write-Output ("WOULD END {0} - session unused {1:N0} min" -f $label, $idleMin); continue }
  # Re-read the process right before ending it, so a reused PID is never hit.
  $again = Get-CimInstance Win32_Process -Filter "ProcessId=$shellPid" -ErrorAction SilentlyContinue
  if (-not $again -or $again.CreationDate -ne $born -or [int]$again.ParentProcessId -ne [int]$s.ParentProcessId) {
    $kept++; Write-Output "keep  $label - changed since it was read"; continue
  }
  try { Stop-Process -Id $shellPid -Force -ErrorAction Stop; $ended++; Write-Log ("ended idle app shell: {0}, session unused {1:N0} min" -f $label, $idleMin) }
  catch { Write-Log "could not end $label - $($_.Exception.Message)" }
}
Write-Output ("{0} app shells: {1} ended, {2} would end, {3} kept (idle limit {4} min{5})" -f $shells.Count, $ended, $would, $kept, $IdleMinutes, $(if ($Apply) { '' } else { ', DRY RUN' }))

