<#
  The FULL browser test suite (tests/e2e) on the spare, against STAGING, in a sealed network (owner, 2026-11-23:
  "Do 18, 19 and 20" - #19; his choice: on his word only, never on a schedule).
    & ~/.claude/scripts/spare-e2e.ps1 694     # pull request 694 (its difference applied on the live commit)
    & ~/.claude/scripts/spare-e2e.ps1 live    # the live commit as it is
  🔴 ON THE OWNER'S WORD ONLY ("browser tests 694"). The suite WRITES test data, so it never touches production: the
  spare's ~/phoenix/e2e-run.sh (source spare-e2e-run.sh) runs a separate staging test server and the browser inside
  their own network where the live server cannot be reached - see that file. It refuses while a preview runs, waits
  for a unit test run, and needs 3,500 MB free. One test at a time; about 30-60 minutes.
  Result: the summary here, the full output in "F:\Phoenix Workforce\PR Screenshots\PR <n>\browser-tests\".
  A pull request that changes package.json or the lockfile is refused (the run reuses the live checkout's packages).
#>
param([Parameter(Mandatory, Position = 0)][string]$Target)
$ErrorActionPreference = 'Continue'
$ssh = "$env:SystemRoot\System32\OpenSSH\ssh.exe"; $scp = "$env:SystemRoot\System32\OpenSSH\scp.exe"
$repo = 'F:\Phoenix Workforce\phoenix-workforce'; $gh = 'sato-pharma/phoenix-people-workforce'
# 2>&1 and drop the login banner: with 2>$null, Windows PowerShell sometimes lost a one-line answer (23 Nov).
function Spare([string]$script) { ($script -replace "`r", '') | & $ssh -o BatchMode=yes -o ConnectTimeout=20 phoenix-spare "tr -d '\r' | bash -s" 2>&1 | ForEach-Object { "$_" } | Where-Object { $_ -notmatch '^phx-user=' } }
$id = (Get-Date -Format 'yyyyMMdd-HHmmss')
$patchArg = ''
if ($Target -ne 'live') {
  if ($Target -notmatch '^\d+$') { throw "Give a pull request number or 'live' (got '$Target')." }
  $p = gh pr view $Target --repo $gh --json state,headRefOid,title | ConvertFrom-Json
  if ($p.state -ne 'OPEN') { throw "pull request $Target is $($p.state), not open" }
  git -C $repo fetch -q origin "+refs/pull/$Target/head:refs/spare-send/e2e" 2>$null
  $got = (git -C $repo rev-parse refs/spare-send/e2e 2>$null | Select-Object -First 1); git -C $repo update-ref -d refs/spare-send/e2e 2>$null
  if ($got -ne $p.headRefOid) { throw "fetched $got for pull request $Target, but GitHub says its head is $($p.headRefOid)" }
  $base = "$(Spare 'git -C ~/phoenix/phoenix-workforce rev-parse HEAD' | Select-Object -Last 1)".Trim()
  git -C $repo cat-file -e "$base^{commit}" 2>$null; if ($LASTEXITCODE) { git -C $repo fetch -q origin main 2>$null }
  $tmp = Join-Path $env:TEMP "spare-e2e-$PID"; New-Item -ItemType Directory -Force $tmp | Out-Null
  $patch = Join-Path $tmp 'e2e.patch'
  cmd /c "git -C `"$repo`" diff --binary --full-index $base $($p.headRefOid) > `"$patch`""
  & $scp -q -o BatchMode=yes $patch "phoenix-spare:phoenix/inbox/e2e-$id.patch" 2>$null
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  $patchArg = "~/phoenix/inbox/e2e-$id.patch"
  Write-Output "Browser tests for pull request $Target ($($p.title)), commit $($p.headRefOid.Substring(0,9)), against staging"
} else { Write-Output 'Browser tests for the live commit, against staging' }

Get-Content -Raw "$PSScriptRoot\spare-e2e-run.sh" | ForEach-Object { $_ -replace "`r", '' } | & $ssh -o BatchMode=yes phoenix-spare 'cat > ~/phoenix/e2e-run.sh && chmod 755 ~/phoenix/e2e-run.sh' 2>$null
Spare "setsid nohup bash ~/phoenix/e2e-run.sh $id $patchArg </dev/null >/dev/null 2>&1 & echo started" | Write-Output
$out = "/home/phoenix/phoenix/e2e-out/$id"; $t = [Diagnostics.Stopwatch]::StartNew(); $last = ''
while ($t.Elapsed.TotalMinutes -lt 150) {
  Start-Sleep -Seconds 30
  $st = @(Spare "test -f $out/DONE && echo DONE=`$(cat $out/DONE); tail -1 $out/output.txt 2>/dev/null")
  $line = "$($st | Select-Object -Last 1)"
  if ($line -ne $last) { Write-Output ("  [{0:hh\:mm\:ss}] {1}" -f $t.Elapsed, $line); $last = $line }
  if ("$st" -match 'DONE=') { break }
}
$dest = if ($Target -eq 'live') { "F:\Phoenix Workforce\PR Screenshots\live\browser-tests-$id" } else { "F:\Phoenix Workforce\PR Screenshots\PR $Target\browser-tests-$id" }
New-Item -ItemType Directory -Force -Path $dest | Out-Null
& $scp -q -r -o BatchMode=yes "phoenix-spare:$out/*" "$dest" 2>$null   # no \ before the quote: Windows reads \" as a quote
Spare "tail -1 ~/phoenix/e2e.log; rm -f ~/phoenix/inbox/e2e-$id.patch" | Write-Output
Write-Output "Full output: $dest\output.txt$(if (Test-Path "$dest\report\index.html") { " and $dest\report\index.html" })"
