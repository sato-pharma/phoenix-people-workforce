# ram-cleaner-now.ps1 - the "Clean RAM" desktop icon (owner, 2026-11-19: "make it an icon in desktop").
# Starts the existing ADMIN task "Phoenix RAM Cleaner - Every 5 Min" right now (no admin prompt:
# starting a task is allowed, changing it is not), waits for its log line, and shows the result
# in a small popup that closes itself after 15 seconds. Same rules as every scheduled run:
# Claude sessions are spared above 500 MB free (rule 10), nothing is closed.
$ErrorActionPreference = 'Continue'
$task = 'Phoenix RAM Cleaner - Every 5 Min'
$log  = 'C:\ProgramData\PhoenixRamCleaner\ram-cleaner.log'
$shell = New-Object -ComObject WScript.Shell
$title = 'Clean RAM'
# every popup adds 4096 (system-modal = always on top): it appears ~10 s after the double-click,
# when Windows no longer lets a background script take the front, so without it the result hid behind windows

function Get-AvailMB { [int](Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory).AvailableMBytes }

$before = @(Get-Content -LiteralPath $log -ErrorAction SilentlyContinue).Count
try {
  # if a scheduled run is already going, its line is the answer - starting another is ignored
  if ((Get-ScheduledTask -TaskName $task -ErrorAction Stop).State -ne 'Running') { Start-ScheduledTask -TaskName $task -ErrorAction Stop }
} catch {
  [void]$shell.Popup("Could not start the RAM cleaner:`n$($_.Exception.Message)`n`nTell Claude `"fix the RAM cleaner`".", 30, $title, 4112)
  exit 1
}

$line = $null
$end = (Get-Date).AddSeconds(75)
while ((Get-Date) -lt $end) {
  Start-Sleep -Seconds 2
  $all = @(Get-Content -LiteralPath $log -ErrorAction SilentlyContinue)
  if ($all.Count -gt $before) { $line = ($all | Select-Object -Skip $before | Where-Object { $_ -match '^\[' } | Select-Object -Last 1); if ($line) { break } }
}
if (-not $line) {
  [void]$shell.Popup("The RAM cleaner started but wrote no result within 75 seconds.`n`nTell Claude `"fix the RAM cleaner`".", 30, $title, 4144)
  exit 1
}
if ($line -match '\] FAIL') {
  [void]$shell.Popup("The RAM cleaner hit a problem:`n$($line -replace '^.*PROBLEMS:\s*','')`n`nTell Claude `"fix the RAM cleaner`".", 30, $title, 4112)
  exit 1
}
if ($line -match 'SKIPPED') { [void]$shell.Popup('Another clean was already running - try again in a minute.', 15, $title, 4160); exit 0 }

Start-Sleep -Seconds 5   # let the trimmed pages finish settling before the "after" reading
$now = Get-AvailMB
$msg = 'Free RAM now: {0:N0} MB' -f $now
if ($line -match 'avail ([\d,]+) -> ') { $msg += ('   (was {0} MB)' -f $Matches[1]) }
if ($line -match 'trimmed (\d+) procs \(([\d,]+) MB\)') { $msg += ("`n`nIdle programs trimmed: {0}  ({1} MB moved out)" -f $Matches[1], $Matches[2]) }
if ($line -match 'Claude spared (\d+)') { $msg += ("`nClaude processes left alone: {0}" -f $Matches[1]) }
if ($line -match '\| ([^|]+)$') { $msg += ("`n`n" + $Matches[1].Trim()) }
[void]$shell.Popup($msg, 15, $title, 4160)
