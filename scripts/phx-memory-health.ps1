# phx-memory-health.ps1 - a READ-ONLY memory health check for this laptop.
#
# It reads counters and process lists and prints a verdict. It never kills, trims, re-prioritises,
# writes a setting or needs admin. Safe to run at any time, including while RAM is critically low
# (it takes about 10 seconds and under 100 MB).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.claude\scripts\phx-memory-health.ps1"
#   ... -Json      machine-readable output instead of text
#
# Thresholds come from the 2026-10-28 forensics: below 1,800 MB available the box starts to page
# hard, a dev server needs ~3 GB of headroom, and the Claude window process is restarted by the
# RAM meter at 1,536 MB.
param([switch]$Json)
$ErrorActionPreference = 'SilentlyContinue'

$RedAvailMB        = 1800
$AmberAvailMB      = 3000
$DevServerNeedsMB  = 3000
$RedPageReads      = 3000
$AmberPageReads    = 500
$ClaudeWindowLineMB = 1536

# 1. System memory - three samples, two seconds apart.
$ctr = '\Memory\Available MBytes', '\Memory\Pages Input/sec', '\Memory\Committed Bytes', '\Memory\Commit Limit',
       '\Memory\Pool Nonpaged Bytes', '\Memory\Pool Paged Resident Bytes', '\Memory\Standby Cache Normal Priority Bytes',
       '\Memory\Free & Zero Page List Bytes', '\Memory\Modified Page List Bytes', '\PhysicalDisk(_Total)\% Idle Time',
       '\Processor(_Total)\% Processor Time'
$samples = (Get-Counter $ctr -SampleInterval 2 -MaxSamples 3).CounterSamples
function Avg($leaf) { ($samples | Where-Object { $_.Path -like "*\$leaf" } | Measure-Object CookedValue -Average).Average }
$availMB    = [int](Avg 'available mbytes')
$pageReads  = [int](Avg 'pages input/sec')
$commitMB   = [int]((Avg 'committed bytes') / 1MB)
$limitMB    = [int]((Avg 'commit limit') / 1MB)
$npMB       = [int]((Avg 'pool nonpaged bytes') / 1MB)
$ppMB       = [int]((Avg 'pool paged resident bytes') / 1MB)
$standbyMB  = [int]((Avg 'standby cache normal priority bytes') / 1MB)
$freeMB     = [int]((Avg 'free & zero page list bytes') / 1MB)
$modMB      = [int]((Avg 'modified page list bytes') / 1MB)
$diskIdle   = [int](Avg '% idle time')
$cpuPct     = [int](Avg '% processor time')
$pf = Get-CimInstance Win32_PageFileUsage | Select-Object -First 1
$os = Get-CimInstance Win32_OperatingSystem
$ramMB = [int]($os.TotalVisibleMemorySize / 1KB)
$uptime = (Get-Date) - $os.LastBootUpTime

# 2. Who holds RAM - private working set (what is really in RAM) and commit, grouped by program.
$perf = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $_.Name -notin '_Total', 'Idle' }
$byName = $perf | Group-Object { $_.Name -replace '#\d+$', '' } | ForEach-Object {
  [pscustomobject]@{
    Program  = $_.Name
    Count    = $_.Count
    InRamMB  = [int](($_.Group | Measure-Object WorkingSetPrivate -Sum).Sum / 1MB)
    CommitMB = [int](($_.Group | Measure-Object PrivateBytes -Sum).Sum / 1MB)
    CpuPct   = [int](($_.Group | Measure-Object PercentProcessorTime -Sum).Sum)
  }
} | Sort-Object InRamMB -Descending
$top = $byName | Select-Object -First 10

# 3. Claude app - the window process, the session processes, and how long each has been up.
$perfById = @{}; foreach ($p in $perf) { $perfById[[int]$p.IDProcess] = $p }
$claude = Get-CimInstance Win32_Process -Filter "Name='claude.exe'"
$window = $claude | Where-Object { $_.CommandLine -match '--type=renderer' } |
  Sort-Object { $perfById[[int]$_.ProcessId].WorkingSetPrivate } -Descending | Select-Object -First 1
$windowMB = if ($window) { [int]($perfById[[int]$window.ProcessId].WorkingSetPrivate / 1MB) } else { 0 }
$windowCommitMB = if ($window) { [int]($window.PrivatePageCount / 1MB) } else { 0 }
$sessions = $claude | Where-Object { $_.ExecutablePath -like '*claude-code*' } | ForEach-Object {
  $pp = $perfById[[int]$_.ProcessId]
  [pscustomobject]@{
    Started  = $_.CreationDate.ToString('dd MMM HH:mm')
    InRamMB  = [int]($pp.WorkingSetPrivate / 1MB)
    CommitMB = [int]($_.PrivatePageCount / 1MB)
    CpuPct   = [int]$pp.PercentProcessorTime
  }
} | Sort-Object Started
$sessionRamMB = [int](($sessions | Measure-Object InRamMB -Sum).Sum)

# 4. Dev servers - any node running next, and who listens on 3000-3100.
$nextProcs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'next|dev-server\.mjs' } | ForEach-Object {
  [pscustomobject]@{ Pid = $_.ProcessId; CommitMB = [int]($_.PrivatePageCount / 1MB); Started = $_.CreationDate.ToString('dd MMM HH:mm') }
}
$ports = Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -ge 3000 -and $_.LocalPort -le 3100 } | Select-Object -ExpandProperty LocalPort -Unique

# 5. The watchdog's trim rule over the last 30 minutes - how often it ran and how much it pushed out.
# Deliberately NOT "how much it won back": the watchdog logs available RAM the instant a pass ends,
# before Windows has written the evicted dirty pages out, so that figure undercounts the real gain
# (2026-10-28: logged +8 MB, measured +145 MB two seconds later). Passes every 2 minutes for half an
# hour means RAM has sat under the watchdog's 3,600 MB line the whole time - that is the signal.
$wdLog = "$env:USERPROFILE\.claude\scripts\mem-watchdog.log"
$since = (Get-Date).AddMinutes(-30)
$trims = @(Get-Content $wdLog -Tail 400 | ForEach-Object {
  if ($_ -match '^\[(\S+ \S+) Cairo\] TRIM\s+(\d+) idle processes, freed (\d+)MB working set') {
    $at = [datetime]::ParseExact($Matches[1], 'yyyy-MM-dd HH:mm:ss', $null)
    if ($at -ge $since) { [pscustomobject]@{ Evicted = [int]$Matches[3] } }
  }
})
$trimEvicted = [int](($trims | Measure-Object Evicted -Sum).Sum)

# 6. Verdicts.
function Grade($value, $amber, $red, [switch]$LowIsBad) {
  if ($LowIsBad) { if ($value -lt $red) { 'RED' } elseif ($value -lt $amber) { 'AMBER' } else { 'GREEN' } }
  else { if ($value -gt $red) { 'RED' } elseif ($value -gt $amber) { 'AMBER' } else { 'GREEN' } }
}
$vAvail  = Grade $availMB $AmberAvailMB $RedAvailMB -LowIsBad
$vPaging = Grade $pageReads $AmberPageReads $RedPageReads
$vWindow = if ($windowMB -ge $ClaudeWindowLineMB) { 'AMBER' } else { 'GREEN' }
$vTrim   = if ($trims.Count -ge 10) { 'AMBER' } else { 'GREEN' }   # 10+ passes in 30 min = under the line all along
$devOk   = ($availMB -ge $DevServerNeedsMB) -and (-not $nextProcs)

$result = [ordered]@{
  checkedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + ' (local)'
  uptime = '{0}d {1}h' -f $uptime.Days, $uptime.Hours
  memory = [ordered]@{ installedMB = $ramMB; availableMB = $availMB; standbyMB = $standbyMB; freeMB = $freeMB; modifiedMB = $modMB;
    committedMB = $commitMB; commitLimitMB = $limitMB; pagefileInUseMB = [int]$pf.CurrentUsage; pagefileSizeMB = [int]$pf.AllocatedBaseSize;
    kernelNonpagedMB = $npMB; kernelPagedResidentMB = $ppMB }
  pressure = [ordered]@{ hardPageReadsPerSec = $pageReads; diskIdlePct = $diskIdle; cpuPct = $cpuPct }
  topPrograms = $top
  claude = [ordered]@{ windowInRamMB = $windowMB; windowCommitMB = $windowCommitMB; windowRestartLineMB = $ClaudeWindowLineMB;
    sessionProcesses = @($sessions).Count; sessionsInRamMB = $sessionRamMB; sessions = $sessions }
  devServers = [ordered]@{ nextProcesses = @($nextProcs); listeningPorts3000to3100 = @($ports) }
  watchdogTrimLast30Min = [ordered]@{ passes = $trims.Count; evictedMB = $trimEvicted }
  verdict = [ordered]@{ availableRam = $vAvail; paging = $vPaging; claudeWindow = $vWindow; watchdogTrim = $vTrim; safeToStartDevServer = $devOk }
}

if ($Json) { $result | ConvertTo-Json -Depth 5; return }

"Memory health - {0} (up {1})" -f $result.checkedAt, $result.uptime
""
"VERDICT   available RAM {0} | paging {1} | Claude window {2} | watchdog trim {3} | dev server {4}" -f $vAvail, $vPaging, $vWindow, $vTrim, $(if ($devOk) { 'SAFE to start' } else { 'NOT safe to start' })
""
"RAM        {0:N0} MB available of {1:N0} (standby {2:N0}, free {3:N0}, modified {4:N0})" -f $availMB, $ramMB, $standbyMB, $freeMB, $modMB
"Commit     {0:N0} of {1:N0} MB; pagefile {2:N0} of {3:N0} MB in use" -f $commitMB, $limitMB, $pf.CurrentUsage, $pf.AllocatedBaseSize
"Kernel     nonpaged pool {0:N0} MB, paged pool in RAM {1:N0} MB" -f $npMB, $ppMB
"Pressure   {0:N0} pages/s read back from disk (green under {1}, red over {2}); disk {3}% idle; CPU {4}%" -f $pageReads, $AmberPageReads, $RedPageReads, $diskIdle, $cpuPct
""
"Top programs by RAM actually held (private working set) and by commit:"
$top | Format-Table Program, Count, InRamMB, CommitMB, CpuPct -AutoSize | Out-String -Width 120
"Claude window process: {0:N0} MB in RAM, {1:N0} MB committed (the RAM meter restarts the app at {2:N0} MB when you are away)" -f $windowMB, $windowCommitMB, $ClaudeWindowLineMB
"Claude Code session processes: {0}, together {1:N0} MB in RAM" -f @($sessions).Count, $sessionRamMB
$sessions | Format-Table Started, InRamMB, CommitMB, CpuPct -AutoSize | Out-String -Width 120
if ($nextProcs) { "Dev server processes:"; $nextProcs | Format-Table -AutoSize | Out-String -Width 120 } else { "Dev servers: none running" }
if ($ports) { "Listening on 3000-3100: " + ($ports -join ', ') }
"Watchdog trim, last 30 min: {0} passes pushed {1:N0} MB of idle pages out of RAM (10 or more passes = RAM sat under 3,600 MB the whole half hour)" -f $trims.Count, $trimEvicted
