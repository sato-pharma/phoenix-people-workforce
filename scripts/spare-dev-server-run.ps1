# Runs ON THE SPARE as D:\Phoenix\dev-server-run.ps1, started by its "Phoenix Dev Server" task (source: ~/.claude/scripts/spare-dev-server-run.ps1
# on the main laptop; spare-follow-production.ps1 keeps the copy current). Owner, 2026-11-20: "I want the dev server to be super fast."
# Starts the dev server, and once it answers, WARMS it: signs in through dev-auth as Super Admin and opens each page in
# D:\Phoenix\warm-routes.txt, so webpack compiles them before anyone visits (a first visit was the slow part). Results: D:\Phoenix\warm.log
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + $env:APPDATA + '\npm'
Set-Location D:\Phoenix\phoenix-workforce
$node = Start-Process node -ArgumentList 'scripts\dev-server.mjs', '--port', '3000', '--lean' -NoNewWindow -PassThru -RedirectStandardOutput D:\Phoenix\dev-server.log -RedirectStandardError D:\Phoenix\dev-server.err.log
$warmLog = 'D:\Phoenix\warm.log'
function W($m) { Add-Content $warmLog ('{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) }
$routesFile = 'D:\Phoenix\warm-routes.txt'
if (-not (Test-Path $routesFile)) { @('/admin', '/employee-360', '/organogram', '/admin/people-management', '/admin/approvals-hub') | Set-Content $routesFile -Encoding ascii }
$up = $false
foreach ($i in 1..120) {   # up to 10 minutes for the first answer
  if ($node.HasExited) { break }
  try { if ((Invoke-WebRequest http://127.0.0.1:3000/api/healthz -UseBasicParsing -TimeoutSec 10).StatusCode -eq 200) { $up = $true; break } } catch { }
  Start-Sleep 5
}
if ($up) {
  $all = [Diagnostics.Stopwatch]::StartNew(); $s = $null
  try { Invoke-WebRequest 'http://127.0.0.1:3000/api/dev-auth?role=Super%20Admin' -UseBasicParsing -SessionVariable s -TimeoutSec 300 | Out-Null } catch { W "warm: dev-auth sign-in failed: $($_.Exception.Message)" }
  foreach ($r in (Get-Content $routesFile | Where-Object { $_.Trim() -and $_ -notlike '#*' })) {
    if ($node.HasExited) { break }
    $sw = [Diagnostics.Stopwatch]::StartNew()
    try { $c = (Invoke-WebRequest "http://127.0.0.1:3000$($r.Trim())" -UseBasicParsing -WebSession $s -TimeoutSec 300).StatusCode } catch { $c = "failed ($($_.Exception.Message))" }
    W ("warm {0} -> {1} in {2:n1} s" -f $r.Trim(), $c, $sw.Elapsed.TotalSeconds)
  }
  W ("warm: all pages compiled in {0:n0} s" -f $all.Elapsed.TotalSeconds)
} else { W 'warm: the dev server never answered, nothing warmed' }
$node.WaitForExit()
exit $node.ExitCode
