# Runs ON THE SPARE as D:\Phoenix\dev-server-run.ps1, started by its "Phoenix Dev Server" task (source: ~/.claude/scripts/spare-dev-server-run.ps1
# on the main laptop; spare-follow-production.ps1 keeps the copy current). Owner, 2026-11-20: "I want the dev server to be super fast."
# Starts the dev server, and once it answers, WARMS it: signs in through dev-auth and opens each page in D:\Phoenix\warm-routes.txt,
# so webpack compiles them before anyone visits (a first visit was the slow part). Results: D:\Phoenix\warm.log
#
# Group 1 and 2 of the spare list (owner, 2026-11-20 "start group one ... then start group 2"):
#  - it RESTARTS the dev server when it dies on its own (12:46 it died out of memory and stayed down until a session noticed);
#    five deaths inside 20 minutes means something is wrong, so it waits 10 minutes before the next try and logs it.
#    A deliberate stop is Stop-ScheduledTask (ends this loop) THEN killing node; killing node alone is a crash and comes back.
#  - the warm-up is skipped when the spare has under 1 GB free (a warm-up then is what runs it out of memory);
#  - it re-warms whenever /api/healthz startedAt changes (Next restarted its server in place after a memory restart);
#  - every node process of this checkout runs at AboveNormal priority, re-applied each minute because a respawn starts Normal;
#  - libuv gets 8 threads (the i7-1165G7 has 8), and Next keeps 6 compiled pages for 60 minutes (needs PR 666 on main;
#    harmless before it, the switches are simply unread).
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + $env:APPDATA + '\npm'
Set-Location D:\Phoenix\phoenix-workforce
# Lean's own 2,560 MB heap made Next restart its compiler at ~2 GB, which threw away every page the warm-up had just
# compiled (20 Nov 12:40, right after 17 pages). The spare runs nothing else, so it gets 4 GB.
$env:PHOENIX_DEV_HEAP_MB = '4096'
$env:UV_THREADPOOL_SIZE = '8'
$env:PHOENIX_DEV_PAGES_KEPT = '6'
$env:PHOENIX_DEV_PAGE_IDLE_MINUTES = '60'
$warmLog = 'D:\Phoenix\warm.log'
function W($m) { Add-Content $warmLog ('{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) }
function FreeMB { [int]((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1024) }
$routesFile = 'D:\Phoenix\warm-routes.txt'
if (-not (Test-Path $routesFile)) { @('/admin', '/employee-360', '/organogram', '/admin/people-management', '/admin/approvals-hub') | Set-Content $routesFile -Encoding ascii }

function Read-StartedAt {
  try { return (Invoke-RestMethod http://127.0.0.1:3000/api/healthz -TimeoutSec 15).startedAt } catch { return $null }
}

function Invoke-Warm($node, [string]$why) {
  $free = FreeMB
  if ($free -lt 1024) { W "warm ($why): skipped, only $free MB free (a warm-up now would run the spare out of memory)"; return }
  $all = [Diagnostics.Stopwatch]::StartNew()
  # A line is "/path" (warmed as Super Admin) or "/path | <role> | <hrId>" (warmed signed in as that person, owner
  # 2026-11-20: "Warm his pages" for Magdy El Senosey). One dev-auth sign-in per person, reused for all his lines.
  $sessions = @{}
  foreach ($line in (Get-Content $routesFile | Where-Object { $_.Trim() -and $_ -notlike '#*' })) {
    if ($node.HasExited) { break }
    if ((FreeMB) -lt 1024) { W "warm ($why): stopped part-way, under 1 GB free"; break }
    $parts = @($line.Split('|') | ForEach-Object { $_.Trim() })   # @() or a one-part line becomes a string and $parts[0] is "/"
    $path = $parts[0]; $role = 'Super Admin'; $hr = ''
    if ($parts.Count -ge 3) { $role = $parts[1]; $hr = $parts[2] }
    $key = "$role|$hr"
    if (-not $sessions.ContainsKey($key)) {
      $q = 'role=' + [uri]::EscapeDataString($role) + $(if ($hr) { '&hrId=' + [uri]::EscapeDataString($hr) } else { '' })
      $sv = $null
      try { Invoke-WebRequest "http://127.0.0.1:3000/api/dev-auth?$q&next=/api/healthz" -UseBasicParsing -SessionVariable sv -TimeoutSec 300 | Out-Null } catch { W "warm: dev-auth sign-in as $key failed: $($_.Exception.Message)" }
      $sessions[$key] = $sv
    }
    $who = $(if ($hr) { " as $hr" } else { '' })
    $sw = [Diagnostics.Stopwatch]::StartNew()
    try { $c = (Invoke-WebRequest "http://127.0.0.1:3000$path" -UseBasicParsing -WebSession $sessions[$key] -TimeoutSec 300).StatusCode } catch { $c = "failed ($($_.Exception.Message))" }
    W ("warm {0}{1} -> {2} in {3:n1} s" -f $path, $who, $c, $sw.Elapsed.TotalSeconds)
  }
  W ("warm ({0}): all pages compiled in {1:n0} s, {2} MB free" -f $why, $all.Elapsed.TotalSeconds, (FreeMB))
}

function Set-DevPriority {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'phoenix-workforce' -and $_.CommandLine -notmatch 'runs\\' } |
    ForEach-Object { try { $p = Get-Process -Id $_.ProcessId -ErrorAction Stop; if ($p.PriorityClass -ne 'AboveNormal') { $p.PriorityClass = 'AboveNormal' } } catch { } }
}

$deaths = New-Object System.Collections.Generic.List[datetime]
while ($true) {
  $node = Start-Process node -ArgumentList 'scripts\dev-server.mjs', '--port', '3000', '--lean' -NoNewWindow -PassThru -RedirectStandardOutput D:\Phoenix\dev-server.log -RedirectStandardError D:\Phoenix\dev-server.err.log
  $up = $false
  foreach ($i in 1..120) {   # up to 10 minutes for the first answer
    if ($node.HasExited) { break }
    try { if ((Invoke-WebRequest http://127.0.0.1:3000/api/healthz -UseBasicParsing -TimeoutSec 10).StatusCode -eq 200) { $up = $true; break } } catch { }
    Start-Sleep 5
  }
  Set-DevPriority
  $startedAt = $null
  if ($up) { $startedAt = Read-StartedAt; Invoke-Warm $node 'start' } elseif (-not $node.HasExited) { W 'warm: the dev server never answered, nothing warmed' }
  # Watch it: re-warm after an in-place memory restart, keep the priority, notice a death.
  while (-not $node.HasExited) {
    Start-Sleep 60
    if ($node.HasExited) { break }
    Set-DevPriority
    $now = Read-StartedAt
    if ($now -and $startedAt -and $now -ne $startedAt) { W "the server restarted in place (startedAt $startedAt -> $now); warming again"; $startedAt = $now; Invoke-Warm $node 'after a memory restart' }
    elseif ($now -and -not $startedAt) { $startedAt = $now }
  }
  $code = $node.ExitCode
  W "the dev server exited (code $code, $(FreeMB) MB free); starting it again"
  $deaths.Add((Get-Date))
  while ($deaths.Count -and $deaths[0] -lt (Get-Date).AddMinutes(-20)) { $deaths.RemoveAt(0) }
  if ($deaths.Count -ge 5) { W 'five deaths inside 20 minutes - waiting 10 minutes before the next start (read D:\Phoenix\dev-server.err.log)'; Start-Sleep 600; $deaths.Clear() }
  else { Start-Sleep 15 }
}
