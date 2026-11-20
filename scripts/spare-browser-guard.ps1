throw 'WINDOWS-ONLY-RETIRED: the spare runs Ubuntu Server since 20 Nov 2026 (owner: "put Ubuntu Server on the spare"). This script drove its Windows and must not run against Linux. Use spare.ps1 (bash), spare-test.ps1, spare-follow-production.ps1.'
<#
.SYNOPSIS
  THE SPARE'S BROWSER GUARD. Runs ON THE SPARE LAPTOP (ASUS Vivobook "Gawish", 8 GB) and stops automated
  browser jobs while the spare is low on memory. Owner, 2026-11-14 about 20:00 Cairo: "Yes, guard it", to
  the question "Once the spare is back, should browser jobs stop running on it while memory is low?".

  WHY: on 2026-11-14 the dev server plus browser jobs sent from the main laptop left the spare with
  244 MB free (17:47, the dev server died of heap exhaustion) and 303 MB free (19:07). At 19:13 it reset
  every SSH connection at the door, at 19:23 it left the network, and afterwards it restarted at the
  logo on every start.

  WHAT IT DOES: every 2 s it reads free memory. Under -StopBelowMb (1,200 MB of 7,883) on two readings in
  a row, it stops every AUTOMATED browser - a chrome / msedge / chromium / headless-shell process started
  with --remote-debugging-pipe, which is how Playwright launches one (a browser a person opens never has
  it) - together with the node script that launched it, and writes one line to D:\Phoenix\browser-guard.log.
  It never stops the dev server, pnpm, a test run, or any other process.

  HOW IT GETS THERE: spare-follow-production.ps1 (the main laptop's 10-minute "Phoenix Spare Dev Server
  Follows" task) copies THIS file to D:\Phoenix\browser-guard.ps1 and keeps the spare's "Phoenix Spare
  Browser Guard" task (at startup, as SYSTEM, restarted if it stops) running it. The source of truth is
  ~/.claude/scripts/spare-browser-guard.ps1 on the main laptop: edit it there, never on the spare - the
  next follow run sees the changed hash and replaces the spare's copy. Keep this file ASCII (PS 5.1 reads
  a BOM-less file as ANSI).

.EXAMPLE
  powershell -NoProfile -File spare-browser-guard.ps1 -DryRun -Once -StopBelowMb 999999
    reads once, prints what it WOULD stop, stops nothing, writes no log.
#>
param(
  [int]$StopBelowMb = 1200,
  [int]$PollSeconds = 2,
  [string]$Log = 'D:\Phoenix\browser-guard.log',
  [switch]$DryRun,
  [switch]$Once
)
$ErrorActionPreference = 'Continue'

$mutex = New-Object System.Threading.Mutex($false, 'Global\PhoenixSpareBrowserGuard')
if (-not $Once -and -not $mutex.WaitOne(0)) { exit 0 }   # one guard at a time

$browserNames = @('chrome.exe', 'msedge.exe', 'chromium.exe', 'headless_shell.exe', 'chrome-headless-shell.exe')
# A runner whose command line matches this is never stopped, even when a browser hangs off it.
$keepRunner = 'next dev|dev-server\.mjs|next\\dist\\bin\\next|start-server\.js|pnpm'

function Write-GuardLog([string]$message) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
  Write-Output $line
  if ($DryRun) { return }
  try {
    Add-Content -LiteralPath $Log -Value $line -Encoding utf8
    $all = @(Get-Content -LiteralPath $Log)
    if ($all.Count -gt 1000) { $all | Select-Object -Last 400 | Set-Content -LiteralPath $Log -Encoding utf8 }
  } catch {}
}

function Get-FreeMb {
  [int][math]::Round((Get-CimInstance Win32_OperatingSystem -Property FreePhysicalMemory).FreePhysicalMemory / 1024)
}

function Get-ScriptName([string]$commandLine) {
  $hit = [regex]::Matches("$commandLine", '[\w.-]+\.(mjs|cjs|js|ts)\b') | ForEach-Object { $_.Value } | Where-Object { $_ -notmatch 'loader' } | Select-Object -First 1
  if ($hit) { $hit } else { 'node' }
}

# Each automated browser, and the node script that launched it when that script may be stopped.
function Find-BrowserJobs {
  $procs = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, CommandLine)
  $byId = @{}
  foreach ($p in $procs) { $byId[[int]$p.ProcessId] = $p }
  foreach ($p in $procs) {
    if ($browserNames -notcontains "$($p.Name)".ToLower()) { continue }
    if ("$($p.CommandLine)" -notmatch '--remote-debugging-pipe') { continue }
    $runner = $byId[[int]$p.ParentProcessId]
    $stopRunner = $runner -and "$($runner.Name)" -eq 'node.exe' -and "$($runner.CommandLine)" -notmatch $keepRunner
    [pscustomobject]@{ Browser = $p; Runner = $(if ($stopRunner) { $runner } else { $null }) }
  }
}

function Stop-Tree([int]$id) { & "$env:SystemRoot\System32\taskkill.exe" /PID $id /T /F 2>&1 | Out-Null }

if (-not $DryRun -and -not $Once) { Write-GuardLog "guard started: stops automated browsers when free memory stays under $StopBelowMb MB" }

$low = 0
while ($true) {
  $free = Get-FreeMb
  if ($free -lt $StopBelowMb) { $low++ } else { $low = 0 }

  if ($DryRun) {
    $jobs = @(Find-BrowserJobs)
    Write-Output ("free {0} MB, stops under {1} MB; automated browsers: {2}" -f $free, $StopBelowMb, $jobs.Count)
    foreach ($j in $jobs) {
      $runner = if ($j.Runner) { "runner {0} pid {1} would be stopped" -f (Get-ScriptName $j.Runner.CommandLine), $j.Runner.ProcessId } else { 'runner kept' }
      Write-Output ("  {0} pid {1}; {2}" -f $j.Browser.Name, $j.Browser.ProcessId, $runner)
    }
  }
  elseif ($low -ge 2 -or ($Once -and $low -ge 1)) {
    $jobs = @(Find-BrowserJobs)
    if ($jobs.Count) {
      $runners = @($jobs | Where-Object { $_.Runner } | ForEach-Object { $_.Runner } | Sort-Object ProcessId -Unique)
      foreach ($r in $runners) { Stop-Tree ([int]$r.ProcessId) }
      foreach ($j in $jobs) {
        if (Get-Process -Id ([int]$j.Browser.ProcessId) -ErrorAction SilentlyContinue) { Stop-Tree ([int]$j.Browser.ProcessId) }
      }
      $what = if ($runners.Count) { ($runners | ForEach-Object { Get-ScriptName $_.CommandLine }) -join ', ' } else { 'no runner' }
      Start-Sleep -Seconds 2
      Write-GuardLog ("stopped {0} automated browser(s) at {1} MB free (under {2}); runner(s) stopped: {3}; free now {4} MB" -f $jobs.Count, $free, $StopBelowMb, $what, (Get-FreeMb))
    }
  }

  if ($Once) { break }
  Start-Sleep -Seconds $PollSeconds
}
