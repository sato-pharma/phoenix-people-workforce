<#
Phoenix RAM CLEANER -- the periodic, never-kills-anything-you-use RAM janitor.
===========================================================================
Owner ask, 2026-11-19 02:00 Cairo: "put hilarious big effort to clean ram on a periodic basis".
Runs every 5 minutes from Task Scheduler ("Phoenix RAM Cleaner - Every 5 Min"), hidden.

WHY: on this 16 GB laptop the RAM is held by things that must NOT be killed -- 14+ Claude Code
sessions, the desktop app, the owner's Edge, Excel. ram-reclaim.ps1 (2026-09-08) could trim
them safely but NOTHING ever ran it; mem-watchdog.ps1 only kills, and only node jobs.

WHAT IT DOES, every run:
  1. COLD TRIM (always). A process whose CPU time has NOT MOVED since the previous run (5 min
     ago) is asleep. Its resident pages are handed back to Windows with EmptyWorkingSet:
     clean pages go to the standby list (instantly "available"), dirty ones to the pagefile.
     The process keeps running with all its state; Windows faults back only what it touches.
     Idleness across a whole 5-minute cycle (not a 1-second glance) is what stops a
     busy process being trimmed and immediately faulting everything back in.
  2. PRESSURE TRIM (only under the floor, default 1,800 MB available). Also trims anything
     idle across a 2-second sample, down to 25 MB working sets.
  3. ORPHAN SWEEP. Ends ONLY a leftover of a session that has already ended: parent process
     dead, a test / typecheck / lint / build node job or a headless test browser by its
     command line, older than 30 minutes, and idle for a full cycle. Never a session, a
     shell, an MCP server, a dev server, or anything with a live parent.

WHAT IT NEVER DOES: close or stop a Claude session, the Claude app, a dev server (anything
listening on 3000-3010 is exempt from trim AND kill), the foreground window's app, explorer,
the compositor or Defender. It never deletes a file.

USAGE:
  powershell -NoProfile -ExecutionPolicy Bypass -File ram-cleaner.ps1           # dry run
  powershell -NoProfile -ExecutionPolicy Bypass -File ram-cleaner.ps1 -Apply    # do it
Log: ~\.claude\logs\ram-cleaner.log (one line per run, last 3,000 kept).
#>
param(
  [switch]$Apply,
  [int]$FloorMB        = 1800,  # under this "available", pressure mode
  [int]$MinWsMB        = 40,    # cold trim ignores working sets smaller than this
  [int]$PressureMinWsMB = 25,
  [double]$ColdCpuSec  = 0.5,   # CPU-seconds across a whole cycle that still counts as asleep
  [double]$WarmCpuSec  = 0.02,  # CPU-seconds across the 2 s sample (pressure mode)
  [int]$OrphanMinAgeMin = 30,
  # SOFT tier (2026-11-19 fix): between the floor and this, BIG sleepers idle across the 2 s
  # sample are trimmed too - the cold-for-a-whole-cycle test alone caught only 1-3 per run.
  [int]$SoftFloorMB    = 3000,
  [int]$SoftMinWsMB    = 150,
  # ANTI-THRASH (owner, 2026-11-19 03:20 Cairo): a process trimmed in the last -ReTrimMinutes is
  # left alone unless it has grown back by -RegrowMB. Measured first: the 03:14 run read 10,117 MB
  # back from disk in 5 min (33.7 MB/s vs a 9.4 MB/s all-day average) - the same idle sessions
  # were trimmed, faulted 1.5 GB back, and trimmed again every 5 minutes.
  [int]$ReTrimMinutes  = 15,
  [int]$RegrowMB       = 100,
  # ...except under this much available RAM, where a freeze costs more than any disk read
  # (measured 472 MB available at 03:19 the same night) - every idle process is fair game again.
  [int]$SevereMB       = 800,
  # CLAUDE FIRST - the owner's rule 10 (2026-09-12 23:40, mem-watchdog.ps1): Claude's processes are
  # NEVER trimmed - a session waiting on the model looks idle, and trimming it makes the reply fault
  # back from disk, which IS "Claude is slow". The one exception is the crash floor below.
  # This cleaner broke that rule from 01:52 to the fix on 19 Nov; same family definition and the
  # same 500 MB floor as the watchdog, on purpose.
  [int]$CritRamMB      = 500,
  # The ELEVATED task passes C:\ProgramData\PhoenixRamCleaner for both: an admin process must
  # never load its dll from (or write into) a folder a normal process can change.
  [string]$WorkDir = (Join-Path $env:USERPROFILE '.claude\scripts\ram-cleaner'),
  [string]$LogFile = (Join-Path $env:USERPROFILE '.claude\logs\ram-cleaner.log')
)

$ErrorActionPreference = 'Continue'
$workDir  = $WorkDir
$logFile  = $LogFile
$stateFile = Join-Path $workDir 'state.json'
if (-not (Test-Path -LiteralPath $workDir)) { New-Item -ItemType Directory -Path $workDir -Force | Out-Null }

# --- one run at a time -------------------------------------------------------------------------
$mutex = New-Object System.Threading.Mutex($false, 'Global\PhoenixRamCleaner')
if (-not $mutex.WaitOne(0)) {
  # Never skip silently (03:19 on 19 Nov left no trace when a hand-run test held the lock).
  if ($Apply) {
    try { Add-Content -LiteralPath $LogFile -Value ('[{0}] OK SKIPPED - another RAM cleaner run held the lock (a hand run or a test); nothing trimmed this time' -f (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss')) -Encoding ascii } catch {}
  }
  exit 0
}

try {
# --- native helpers, compiled ONCE to a dll so a run never pays for csc.exe again -------------
$dll = Join-Path $workDir 'PhxRam.v1.dll'
$src = @'
using System;
using System.Runtime.InteropServices;
public static class PhxRam {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool K32EmptyWorkingSet(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [StructLayout(LayoutKind.Sequential)]
  public class MemStat {
    public uint dwLength = 64; public uint dwMemoryLoad;
    public ulong ullTotalPhys; public ulong ullAvailPhys; public ulong ullTotalPageFile; public ulong ullAvailPageFile;
    public ulong ullTotalVirtual; public ulong ullAvailVirtual; public ulong ullAvailExtendedVirtual;
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GlobalMemoryStatusEx([In, Out] MemStat m);
  public static long AvailMB() { MemStat m = new MemStat(); GlobalMemoryStatusEx(m); return (long)(m.ullAvailPhys / 1048576UL); }
  public static uint ForegroundPid() { uint p = 0; GetWindowThreadProcessId(GetForegroundWindow(), out p); return p; }
  // 1 = trimmed, 0 = call failed, -1 = could not open (protected / elevated)
  public static int Trim(uint pid) {
    IntPtr h = OpenProcess(0x1000 | 0x0100, false, pid); // QUERY_LIMITED_INFORMATION | SET_QUOTA
    if (h == IntPtr.Zero) return -1;
    try { return K32EmptyWorkingSet(h) ? 1 : 0; } finally { CloseHandle(h); }
  }
}
'@
if (-not ('PhxRam' -as [type])) {
  if (-not (Test-Path -LiteralPath $dll)) { Add-Type -TypeDefinition $src -OutputAssembly $dll -OutputType Library }
  Add-Type -Path $dll
}

$NeverTrim = @(
  'System','Idle','Registry','Memory Compression','Secure System','csrss','wininit','winlogon',
  'services','lsass','smss','svchost','dwm','fontdrvhost','MsMpEng','SecurityHealthService',
  'LsaIso','WUDFHost','audiodg','ctfmon','TextInputHost','ShellExperienceHost',
  'StartMenuExperienceHost','SearchHost','explorer','RamMeter','conhost','sihost',
  'ApplicationFrameHost','ShellHost','dllhost'
) | ForEach-Object { $_.ToLowerInvariant() }

function Get-Snapshot {
  $map = @{}
  foreach ($p in @(Get-CimInstance Win32_Process -EA SilentlyContinue)) {
    $map[[int]$p.ProcessId] = [pscustomobject]@{
      Id = [int]$p.ProcessId; Parent = [int]$p.ParentProcessId
      Name = ([string]$p.Name -replace '\.exe$','')
      Cmd = [string]$p.CommandLine; Created = $p.CreationDate
      Cpu = ([double]$p.KernelModeTime + [double]$p.UserModeTime) / 1e7
      WsMB = [double]$p.WorkingSetSize / 1MB
      Key = '{0}|{1}' -f $p.ProcessId, ($(if ($p.CreationDate) { $p.CreationDate.Ticks } else { 0 }))
    }
  }
  return $map
}

$now = Get-Date
$availBefore = [PhxRam]::AvailMB()
$pressure = $availBefore -lt $FloorMB
$snap = Get-Snapshot

# --- previous run's CPU readings (the whole-cycle idle test) -----------------------------------
$prev = @{}; $prevAgeMin = [double]::MaxValue; $recent = @{}; $prevPagesIn = $null
if (Test-Path -LiteralPath $stateFile) {
  try {
    $st = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
    $prevAgeMin = ($now - [datetime]$st.at).TotalMinutes
    foreach ($prop in $st.cpu.PSObject.Properties) { $prev[$prop.Name] = [double]$prop.Value }
    if ($null -ne $st.pagesIn) { $prevPagesIn = [double]$st.pagesIn }
    if ($st.trim) {
      foreach ($prop in $st.trim.PSObject.Properties) {
        try { $recent[$prop.Name] = @{ at = [datetime]$prop.Value.at; ws = [double]$prop.Value.ws } } catch {}
      }
    }
  } catch { $prev = @{} }
}
# a state older than 30 min (sleep, reboot, a skipped run) proves nothing about idleness
$cycleValid = $prevAgeMin -ge 2 -and $prevAgeMin -le 30

# --- exemptions -------------------------------------------------------------------------------
$exempt = New-Object 'System.Collections.Generic.HashSet[int]'
[void]$exempt.Add($PID)
# my own ancestors (when run by hand from a session, never trim the session running me)
$cur = $snap[$PID]; $guard = 0
while ($cur -and $guard -lt 20) { [void]$exempt.Add($cur.Id); $cur = $snap[$cur.Parent]; $guard++ }
# the window the owner is looking at, and its own helper processes (renderers, GPU)
$fg = [int][PhxRam]::ForegroundPid()
if ($fg -gt 0 -and $snap.ContainsKey($fg)) {
  [void]$exempt.Add($fg)
  # Electron helpers only (--type=); a Claude Code session is NOT the app's helper and stays trimmable
  foreach ($p in $snap.Values) { if ($p.Parent -eq $fg -and $p.Name -eq $snap[$fg].Name -and $p.Cmd -match '--type=') { [void]$exempt.Add($p.Id) } }
}
# dev servers: anything listening on 3000-3010, plus a dev-server command line (owner exemption)
try {
  foreach ($c in @(Get-NetTCPConnection -State Listen -EA SilentlyContinue | Where-Object { $_.LocalPort -ge 3000 -and $_.LocalPort -le 3010 })) {
    [void]$exempt.Add([int]$c.OwningProcess)
  }
} catch {}
foreach ($p in $snap.Values) { if ($p.Cmd -match 'next(\.js)?["'' ]+dev|dev-server\.mjs|next-server') { [void]$exempt.Add($p.Id) } }

# Claude family (rule 10): every claude.exe (the app AND the session engines share the name), plus
# any shell whose parent chain (6 deep) reaches one - mem-watchdog.ps1 Get-ClaudeFamilyPids, verbatim.
$claudeSkip = New-Object 'System.Collections.Generic.HashSet[int]'
if ($availBefore -ge $CritRamMB) {
  $shellNames = @('powershell','pwsh','bash','sh','conhost','cmd','OpenConsole')
  foreach ($p in $snap.Values) {
    if ($p.Name -eq 'claude') { [void]$claudeSkip.Add($p.Id); continue }
    if ($shellNames -notcontains $p.Name) { continue }
    $cur = $p
    for ($d = 0; $d -lt 6; $d++) {
      $par = $snap[$cur.Parent]
      if (-not $par -or $par.Id -eq $cur.Id) { break }
      if ($par.Name -eq 'claude') { [void]$claudeSkip.Add($p.Id); break }
      $cur = $par
    }
  }
}

function Test-Cold($p) {
  if (-not $cycleValid -or -not $prev.ContainsKey($p.Key)) { return $false }
  return ($p.Cpu - $prev[$p.Key]) -le $ColdCpuSec
}

# --- pressure mode: a 2-second CPU sample for processes not yet proven cold -------------------
$warm = @{}
$soft = (-not $pressure) -and ($availBefore -lt $SoftFloorMB)
if ($pressure -or $soft) {
  Start-Sleep -Milliseconds 2000
  $snap2 = Get-Snapshot
  foreach ($k in $snap.Keys) {
    $a = $snap[$k]; $b = $snap2[$k]
    if ($b -and $b.Key -eq $a.Key -and ($b.Cpu - $a.Cpu) -le $WarmCpuSec) { $warm[$a.Key] = $true }
  }
}

# --- 1+2. trim ---------------------------------------------------------------------------------
$trimmed = 0; $freedMB = 0.0; $denied = 0; $byName = @{}; $planned = @(); $held = 0
$minWs = if ($pressure) { $PressureMinWsMB } else { $MinWsMB }
foreach ($p in ($snap.Values | Sort-Object WsMB -Descending)) {
  if ($p.Id -le 4 -or $exempt.Contains($p.Id)) { continue }
  if ($claudeSkip.Contains($p.Id)) { continue }
  if ($NeverTrim -contains $p.Name.ToLowerInvariant()) { continue }
  if ($p.WsMB -lt $minWs) { continue }
  $cold = Test-Cold $p
  $warmOk = $warm.ContainsKey($p.Key) -and ($pressure -or ($soft -and $p.WsMB -ge $SoftMinWsMB))
  if (-not $cold -and -not $warmOk) { continue }
  if ($availBefore -ge $SevereMB -and $recent.ContainsKey($p.Key)) {
    $r0 = $recent[$p.Key]
    if (($now - $r0.at).TotalMinutes -lt $ReTrimMinutes -and $p.WsMB -lt ($r0.ws + $RegrowMB)) { $held++; continue }
  }
  if (-not $Apply) { $planned += ('{0}({1}) {2:N0}MB {3}' -f $p.Name, $p.Id, $p.WsMB, $(if ($cold) { 'cold' } else { 'warm-idle' })); $freedMB += $p.WsMB; $trimmed++; continue }
  $r = [PhxRam]::Trim([uint32]$p.Id)
  if ($r -lt 0) { $denied++; continue }
  if ($r -eq 0) { continue }
  $after = 0.0
  try { $after = [System.Diagnostics.Process]::GetProcessById($p.Id).WorkingSet64 / 1MB } catch {}
  $f = [math]::Max(0, $p.WsMB - $after)
  $trimmed++; $freedMB += $f
  $recent[$p.Key] = @{ at = $now; ws = $after }
  if (-not $byName.ContainsKey($p.Name)) { $byName[$p.Name] = 0.0 }
  $byName[$p.Name] += $f
}

# --- 3. orphan sweep ---------------------------------------------------------------------------
$orphanPattern = @(
  '(?i)\btsc(\.js)?\b', '(?i)vitest', '(?i)\beslint\b', '(?i)tests[\\/]run-tests', '(?i)run-tests\.ts',
  '(?i)next(\.js)?["'' ]+build', '(?i)\bjest\b', '(?i)playwright', '(?i)check-contracts', '(?i)alias-loader\.mjs'
)
$killed = @()
foreach ($p in $snap.Values) {
  if ($exempt.Contains($p.Id)) { continue }
  $isNode = $p.Name -eq 'node'
  $isHeadless = ($p.Name -in @('msedge','chrome','chrome-headless-shell','chromium')) -and
                ($p.Cmd -match '(?i)--headless|ms-playwright|playwright_chromiumdev_profile|--remote-debugging-pipe')
  if (-not ($isNode -or $isHeadless)) { continue }
  if ($isNode) { $hit = $false; foreach ($rx in $orphanPattern) { if ($p.Cmd -match $rx) { $hit = $true; break } }; if (-not $hit) { continue } }
  # the parent must be gone (or its PID reused by a younger process)
  $par = $snap[$p.Parent]
  $parentDead = (-not $par) -or ($par.Created -and $p.Created -and $par.Created -gt $p.Created)
  if (-not $parentDead) { continue }
  # a headless browser's helper keeps its (live) browser parent, so only the browser root lands here
  if (-not $p.Created -or ($now - $p.Created).TotalMinutes -lt $OrphanMinAgeMin) { continue }
  if (-not (Test-Cold $p)) { continue }
  $label = '{0}({1}) {2:N0}MB' -f $p.Name, $p.Id, $p.WsMB
  if (-not $Apply) { $killed += "WOULD END $label"; continue }
  # end it and everything under it
  $tree = New-Object System.Collections.Generic.List[int]; $tree.Add($p.Id); $i = 0
  while ($i -lt $tree.Count) { $pp = $tree[$i]; foreach ($c in $snap.Values) { if ($c.Parent -eq $pp -and -not $tree.Contains($c.Id)) { $tree.Add($c.Id) } }; $i++ }
  for ($j = $tree.Count - 1; $j -ge 0; $j--) { try { Stop-Process -Id $tree[$j] -Force -EA Stop } catch {} }
  $killed += $label
}

# --- save this run's CPU readings for the next run's idle test ---------------------------------
$cpuOut = [ordered]@{}
foreach ($p in $snap.Values) { $cpuOut[$p.Key] = [math]::Round($p.Cpu, 2) }
# COST METER: pages Windows read back from disk since the last run (cumulative raw counter).
# It counts ALL hard page-ins (trimmed pages faulting back, plus ordinary file reads), so it is
# the ceiling on what trimming cost - if it climbs run after run, trimming is too aggressive.
$pagesIn = $null
try { $pagesIn = [double](Get-CimInstance Win32_PerfRawData_PerfOS_Memory -EA Stop).PagesInputPersec } catch {}
$reloadMB = $null
if ($null -ne $pagesIn -and $null -ne $prevPagesIn -and $cycleValid -and $pagesIn -ge $prevPagesIn) { $reloadMB = ($pagesIn - $prevPagesIn) * 4 / 1024 }
# recent trims still inside the anti-thrash window, for processes still alive
$trimOut = [ordered]@{}
foreach ($k in $recent.Keys) {
  $r0 = $recent[$k]
  if ($cpuOut.Contains($k) -and ($now - $r0.at).TotalMinutes -lt $ReTrimMinutes) { $trimOut[$k] = @{ at = $r0.at.ToString('o'); ws = [math]::Round($r0.ws, 1) } }
}
if ($Apply) { [pscustomobject]@{ at = $now.ToString('o'); pagesIn = $pagesIn; trim = $trimOut; cpu = $cpuOut } | ConvertTo-Json -Compress -Depth 4 | Set-Content -LiteralPath $stateFile -Encoding ascii }

Start-Sleep -Milliseconds 800
$availAfter = [PhxRam]::AvailMB()

# --- report ------------------------------------------------------------------------------------
$quips = @(
  'the pages have been asked to leave politely',
  'Marie Kondo would weep with joy',
  'nobody was harmed in the making of this RAM',
  'idle processes tucked in and told a bedtime story',
  'swept under the pagefile, where it belongs',
  'the RAM gremlins have been evicted, again',
  'your sessions are napping on disk, not dead',
  'free RAM: now with 0% session casualties',
  'compressed, folded, put in the drawer',
  'the janitor came, the janitor saw, the janitor trimmed'
)
$quip = $quips[([int][math]::Floor($now.Minute / 5) + $now.Hour) % $quips.Count]
$top = ($byName.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 4 | ForEach-Object { '{0} {1:N0}' -f $_.Key, $_.Value }) -join ', '
$mode = if ($pressure) { 'PRESSURE' } elseif ($soft) { 'SOFT' } elseif (-not $cycleValid) { 'FIRST-LOOK' } else { 'normal' }
$verb = if ($Apply) { 'trimmed' } else { 'WOULD trim' }
$reloadTxt = if ($null -ne $reloadMB) { '{0:N0} MB' -f $reloadMB } else { '-' }
# "[time] OK ..." / "[time] FAIL ..." - the shape worktree-snapshot-watch.ps1 (the Telegram alert)
# reads. EVERY line must carry it: the watcher judges the last [time] line, so a FAIL followed by
# un-bracketed OK lines would be an alarm forever.
$line = '[{0}] OK avail {1:N0} -> {2:N0} MB ({3:+#,##0;-#,##0;0}) | {4} | {5} {6} procs ({7:N0} MB) | held back {13} (trimmed under {14} min ago) | Claude spared {15} (rule 10) | denied {8} | orphans {9} | disk page-ins since last run {10} | top: {11} | {12}' -f `
  $now.ToString('yyyy-MM-ddTHH:mm:ss'), $availBefore, $availAfter, ($availAfter - $availBefore), $mode, $verb, $trimmed, $freedMB, $denied, $killed.Count, $reloadTxt, $(if ($top) { $top } else { '-' }), $quip, $held, $ReTrimMinutes, $claudeSkip.Count

if ($Apply) {
  Add-Content -LiteralPath $logFile -Value $line -Encoding ascii
  foreach ($k in $killed) { Add-Content -LiteralPath $logFile -Value ('    orphan ended: ' + $k) -Encoding ascii }
  try {
    $all = @(Get-Content -LiteralPath $logFile)
    if ($all.Count -gt 3200) { $all | Select-Object -Last 3000 | Set-Content -LiteralPath $logFile -Encoding ascii }
  } catch {}
}
Write-Output $line
if (-not $Apply) { $planned | Select-Object -First 40 | ForEach-Object { '  ' + $_ }; $killed | ForEach-Object { '  ' + $_ } }

} catch {
  $failed = $true
  $msg = ($_.Exception.Message -replace '\s+', ' ')
  if ($Apply) {
    try { Add-Content -LiteralPath $logFile -Value ('[{0}] FAIL ram-cleaner PROBLEMS: {1}' -f (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss'), $msg) -Encoding ascii } catch {}
  }
  Write-Output ('FAIL: ' + $msg)
} finally {
  $mutex.ReleaseMutex(); $mutex.Dispose()
}
if ($failed) { exit 1 }
