<#
.SYNOPSIS
  Keeps the spare laptop's dev server (localhost:3000 here, through the "Phoenix Spare Tunnel") on a
  chosen version. Its database is always production (.env.local).
  GOLDEN RULE (owner, 2026-11-07 05:30 Cairo): "local dev is always always always pointing to production
  never staging" - so -Target production is the default and the scheduled task's argument, and every run
  checks the spare's .env.local names the production project and never the staging one (logged LOUDLY).
    -Target production (default; owner, 2026-11-07 01:44: "POINT DEV TO PRODUCTION") follows production's
        /api/healthz revision.
    -Target main (owner, 03:45 the same night: "RUN LOCAL DEV FROM MAIN"; superseded by the golden rule at
        05:30) follows the newest origin/main - only when he asks for it again in his own words.
  When the dev server's checkout differs, sends only the missing commits and checks that version out
  in D:\Phoenix\phoenix-workforce. If the package lockfile changed, it reinstalls and restarts the dev
  server. Runs every 10 minutes from the "Phoenix Spare Dev Server Follows" scheduled task; a run with
  nothing to do touches nothing. Log: ~/.claude/logs/spare-follow-production.log

  THE REINSTALL CHECKS ITSELF (owner, 2026-11-11: "make the spare reinstall check itself"). On 2026-11-10
  23:06 the Next 16.4.4 reinstall ran while the spare sat in Modern Standby with Defender and Windows Update
  busy; pnpm downloaded the packages, stopped partway through linking them, and because it ran with
  --reporter=silent and its exit code was never read, this script logged "packages reinstalled" and the dev
  server died at once on "'next' is not recognized". It stayed dead all night: the revision matched, so
  nothing ever retried. Now:
    - every run reads the spare's packages: COMPLETE means node_modules\.bin\next.cmd exists AND pnpm's own
      end-of-install copy, node_modules\.pnpm\lock.yaml, is byte-identical to pnpm-lock.yaml. A broken
      install is repaired on the next run even when the revision has not moved.
    - the install's full output goes to D:\Phoenix\last-install.log; its exit code AND the completeness
      check decide success; one retry after 60 s; a final failure is logged as INSTALL FAILED.
#>
param([ValidateSet('main', 'production')][string]$Target = 'production')
$ErrorActionPreference = 'Continue'
$repo = 'F:\Phoenix Workforce\phoenix-workforce'
$key = Join-Path $env:USERPROFILE '.ssh\phoenix_spare_ed25519'
$spareUser = "$(Get-Content -LiteralPath (Join-Path $PSScriptRoot 'spare-user.txt') -ErrorAction SilentlyContinue | Select-Object -First 1)".Trim(); if (-not $spareUser) { $spareUser = 'TransferUser' }   # the spare's user, written by spare-rebuild.ps1 (2026-11-20)
$spare = "$spareUser@" +"$(& "$PSScriptRoot\spare-address.ps1" | Select-Object -Last 1)".Trim()   # found, never written here (2026-11-14)
$sshExe = "$env:SystemRoot\System32\OpenSSH\ssh.exe"; $scpExe = "$env:SystemRoot\System32\OpenSSH\scp.exe"   # Windows OpenSSH even when called from Git Bash
$sshOpts = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'LogLevel=ERROR', '-i', $key)
$log = Join-Path $env:USERPROFILE '.claude\logs\spare-follow-production.log'
function Log($m) { $l = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m; Write-Output $l; Add-Content -LiteralPath $log -Value $l -Encoding utf8 }

# THE DEV SERVER IS STARTED WHEN IT IS NOT RUNNING (2026-11-13). "Phoenix Dev Server" on the spare is on-demand
# only, so after the spare lost power at 06:47 and came back at 13:37 nothing started it, and localhost:3000
# answered nothing while every run here saw the right version and exited. This check runs first, before
# production is asked (this laptop often cannot reach production), and never while a pnpm install is running
# (the reinstall below stops the server on purpose) or while the packages are incomplete (the reinstall
# starts it again when it is done).
$srv = @(& "$PSScriptRoot\spare.ps1" -Command 'if (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue) { "SRV up" } elseif (Get-CimInstance Win32_Process -Filter "Name=''node.exe''" | Where-Object { $_.CommandLine -match "pnpm.*install" }) { "SRV installing" } elseif (-not (Test-Path D:\Phoenix\phoenix-workforce\node_modules\.bin\next.cmd)) { "SRV no-packages" } else { Start-ScheduledTask -TaskName "Phoenix Dev Server"; "SRV started" }' -ConnectTimeout 20)
if ("$srv" -match 'SRV started') { Log 'dev server was not running on the spare (a restart or a power cut) - started it' }

# THE BROWSER GUARD IS KEPT RUNNING ON THE SPARE (owner, 2026-11-14 about 20:00: "Yes, guard it" - browser jobs stop
# on the spare while its memory is low, after the 19:07-19:23 freeze). spare-browser-guard.ps1 beside this file is
# the source; the spare runs its copy D:\Phoenix\browser-guard.ps1 as "Phoenix Spare Browser Guard" (at startup,
# as SYSTEM, restarted if it stops). Every run reads that task's state and the copy's hash; a missing task, a
# stopped one or an old copy is put right here, and only then is anything logged. A spare that does not answer
# returns nothing, so this says nothing (the checks below log that).
$guardSrc = Join-Path $PSScriptRoot 'spare-browser-guard.ps1'
if (Test-Path -LiteralPath $guardSrc) {
  $guardHash = (Get-FileHash -LiteralPath $guardSrc -Algorithm SHA256).Hash
  $guardNow = "$(@(& "$PSScriptRoot\spare.ps1" -Command '$t = Get-ScheduledTask -TaskName "Phoenix Spare Browser Guard" -ErrorAction SilentlyContinue; $h = if (Test-Path D:\Phoenix\browser-guard.ps1) { (Get-FileHash D:\Phoenix\browser-guard.ps1 -Algorithm SHA256).Hash } else { "none" }; "GUARD " + $(if ($t) { $t.State } else { "missing" }) + " " + $h' -ConnectTimeout 20) | Where-Object { "$_" -like 'GUARD *' } | Select-Object -First 1)".Trim()
  if ($guardNow -and $guardNow -ne "GUARD Running $guardHash") {
    $was = ($guardNow -split ' ')[1] + $(if ($guardNow -notmatch [regex]::Escape($guardHash)) { ', old or no copy' } else { '' })
    & $scpExe @sshOpts $guardSrc "${spare}:D:/Phoenix/inbox/browser-guard.ps1"
    if ($LASTEXITCODE) { Log "browser guard on the spare was '$was' and its copy could not be sent" }
    else {
      $guardInstall = @'
$n = 'Phoenix Spare Browser Guard'
Stop-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.ProcessId -ne $PID -and "$($_.CommandLine)" -match 'browser-guard\.ps1' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Move-Item -Force D:\Phoenix\inbox\browser-guard.ps1 D:\Phoenix\browser-guard.ps1
$a = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File D:\Phoenix\browser-guard.ps1'
$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -StartWhenAvailable
$p = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $n -Action $a -Trigger (New-ScheduledTaskTrigger -AtStartup) -Settings $s -Principal $p -Force | Out-Null
Start-ScheduledTask -TaskName $n
Start-Sleep 4
'task ' + (Get-ScheduledTask -TaskName $n).State + '; ' + ((Get-Content D:\Phoenix\browser-guard.log -Tail 1 -ErrorAction SilentlyContinue) -join '')
'@
      $inst = @(& "$PSScriptRoot\spare.ps1" -Command $guardInstall -ConnectTimeout 20)
      Log "browser guard on the spare was '$was' - installed: $(($inst | Where-Object { $_ }) -join ' | ')"
    }
  }
}

# THE DEV SERVER'S RUN SCRIPT IS KEPT CURRENT ON THE SPARE (owner, 2026-11-20: "I want the dev server to be super fast").
# spare-dev-server-run.ps1 beside this file is the source of D:\Phoenix\dev-server-run.ps1, which "Phoenix Dev Server" runs:
# it starts the dev server and then compiles the pages in D:\Phoenix\warm-routes.txt so a first visit is fast. A changed copy
# is sent and takes effect at the next dev server start; nothing is restarted for it.
$runSrc = Join-Path $PSScriptRoot 'spare-dev-server-run.ps1'
if (Test-Path -LiteralPath $runSrc) {
  $runHash = (Get-FileHash -LiteralPath $runSrc -Algorithm SHA256).Hash
  $runNow = "$(@(& "$PSScriptRoot\spare.ps1" -Command '"RUN " + $(if (Test-Path D:\Phoenix\dev-server-run.ps1) { (Get-FileHash D:\Phoenix\dev-server-run.ps1 -Algorithm SHA256).Hash } else { "none" })' -ConnectTimeout 20) | Where-Object { "$_" -like 'RUN *' } | Select-Object -First 1)".Trim()
  if ($runNow -and $runNow -ne "RUN $runHash") {
    & $scpExe @sshOpts $runSrc "${spare}:D:/Phoenix/dev-server-run.ps1"
    Log $(if ($LASTEXITCODE) { "the dev server run script on the spare is old and could not be sent" } else { 'sent the current dev server run script (warm-up) to the spare; it applies at the next dev server start' })
  }
}

if ($Target -eq 'production') {
  # Three tries, 15 s each (2026-11-13): from this home network about one connection in three to production's
  # Railway address (153.52.255.32) never completes - measured 7/20 from this laptop and 8/20 from the spare,
  # while staging (153.52.255.122), GitHub and Google failed 0/20. One try made most runs log "production did
  # not answer"; three fail together about 4% of the time.
  $rev = $null; $err = $null
  foreach ($try in 1..3) {
    try { $rev = (Invoke-RestMethod 'https://phoenix-hr.satopharma.com/api/healthz' -TimeoutSec 15).revision; break }
    catch { $err = $_.Exception.Message; Start-Sleep 2 }
  }
  if (-not $rev) { Log "production did not answer after 3 tries: $err"; exit 1 }
  if ($rev -notmatch '^[0-9a-f]{40}$') { Log "production gave no revision ($rev)"; exit 1 }
} else {
  git -C $repo fetch -q origin main 2>$null
  $rev = (git -C $repo rev-parse origin/main 2>$null | Select-Object -First 1)
  if ($rev -notmatch '^[0-9a-f]{40}$') { Log "could not read origin/main ($rev)"; exit 1 }
}

# The golden rule's other half, read on every run: the dev server's .env.local names the PRODUCTION Supabase
# project (ozucdzovmcqvepbozvqf) and never the staging one (cifwmndunmlxjhyjugxa). Only the verdict crosses the wire.
$answer = @(& "$PSScriptRoot\spare.ps1" -Command '$e = Get-Content D:\Phoenix\phoenix-workforce\.env.local -Raw -ErrorAction SilentlyContinue; if (-not $e) { "ENV missing" } elseif ($e -match "cifwmndunmlxjhyjugxa") { "ENV STAGING" } elseif ($e -match "ozucdzovmcqvepbozvqf") { "ENV production" } else { "ENV unknown" }; Set-Location D:\Phoenix\phoenix-workforce; if ((Test-Path node_modules\.bin\next.cmd) -and (Test-Path node_modules\.pnpm\lock.yaml) -and ((Get-FileHash pnpm-lock.yaml).Hash -eq (Get-FileHash node_modules\.pnpm\lock.yaml).Hash)) { "PKG complete" } else { "PKG broken" }; git rev-parse HEAD' -ConnectTimeout 20)
$envVerdict = "$($answer | Where-Object { "$_" -like 'ENV *' } | Select-Object -First 1)"
if ($envVerdict -and $envVerdict -ne 'ENV production') { Log "GOLDEN RULE BROKEN: the spare's dev server .env.local reads '$($envVerdict.Substring(4))', not production - fix it now" }
$pkgVerdict = "$($answer | Where-Object { "$_" -like 'PKG *' } | Select-Object -First 1)"
$now = ($answer | Select-Object -Last 1)
if (-not $now) { Log 'spare laptop did not answer'; exit 1 }
$now = "$now".Trim()
# Same version AND complete packages: nothing to do. Same version with BROKEN packages falls through, and the
# remote step below reinstalls (the checkout of the same commit is a no-op).
if ($now -eq $rev -and $pkgVerdict -ne 'PKG broken') { exit 0 }

git -C $repo cat-file -e "$rev^{commit}" 2>$null
if ($LASTEXITCODE) { git -C $repo fetch -q origin main 2>$null; git -C $repo cat-file -e "$rev^{commit}" 2>$null }
if ($LASTEXITCODE) { Log "this laptop does not have production's commit $rev yet"; exit 1 }

# Does the spare already hold that commit? If not, send only what lies beyond what it has.
$has = (& "$PSScriptRoot\spare.ps1" -Command "git -C D:\Phoenix\phoenix-workforce cat-file -e '$rev^{commit}' 2>`$null; `$LASTEXITCODE" -ConnectTimeout 20 | Select-Object -Last 1)
if ("$has".Trim() -ne '0') {
  $base = (& "$PSScriptRoot\spare.ps1" -Command 'git -C D:\Phoenix\phoenix-workforce rev-parse --verify -q refs/spare/base; if ($LASTEXITCODE) { git -C D:\Phoenix\phoenix-workforce rev-parse HEAD }' -ConnectTimeout 20 | Select-Object -Last 1).Trim()
  $tmp = Join-Path $env:TEMP "spare-follow-$PID"; New-Item -ItemType Directory -Force $tmp | Out-Null
  git -C $repo update-ref refs/spare-send/production $rev
  git -C $repo bundle create "$tmp\prod.bundle" "$base..refs/spare-send/production" 2>$null | Out-Null
  git -C $repo update-ref -d refs/spare-send/production
  & $scpExe @sshOpts "$tmp\prod.bundle" "${spare}:D:/Phoenix/inbox/prod.bundle"
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  & "$PSScriptRoot\spare.ps1" -Command "git -C D:\Phoenix\phoenix-workforce fetch -q D:\Phoenix\inbox\prod.bundle '+refs/spare-send/production:refs/spare/production' 2>&1 | Out-Null; exit `$LASTEXITCODE" -ConnectTimeout 20
  if ($LASTEXITCODE) { Log "could not send production's commit $rev to the spare"; exit 1 }
}

$remote = @"
`$ErrorActionPreference = 'Continue'
`$env:PATH = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') + ';' + `$env:APPDATA + '\npm'
Set-Location D:\Phoenix\phoenix-workforce
`$lockChanged = [bool](git diff --name-only HEAD $rev -- pnpm-lock.yaml)
git -c core.fsmonitor=false checkout -q -f --detach $rev 2>&1 | Out-Null
if (`$LASTEXITCODE) { 'checkout failed'; exit 1 }
function Test-Packages { (Test-Path node_modules\.bin\next.cmd) -and (Test-Path node_modules\.pnpm\lock.yaml) -and ((Get-FileHash pnpm-lock.yaml).Hash -eq (Get-FileHash node_modules\.pnpm\lock.yaml).Hash) }
`$broken = -not (Test-Packages)
if (`$lockChanged -or `$broken) {
  if (`$broken -and -not `$lockChanged) { 'packages were INCOMPLETE - repairing' }
  Stop-ScheduledTask -TaskName 'Phoenix Dev Server'
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { `$_.CommandLine -match 'dev-server|next' } | ForEach-Object { Stop-Process -Id `$_.ProcessId -Force -ErrorAction SilentlyContinue }
  `$env:CI = 'true'
  `$ok = `$false
  foreach (`$try in 1, 2) {
    # pnpm trusts its own state files: over a half-linked tree it answers "Already up to date" (measured
    # 2026-11-11, pnpm 11.13.1 - the shortcut is .pnpm-workspace-state-v1.json; removing .modules.yaml alone
    # did not stop it). A repair, and every second try, removes all three so pnpm relinks everything from the
    # store already on the spare.
    if (`$try -eq 2 -or (`$broken -and -not `$lockChanged)) { Remove-Item node_modules\.pnpm-workspace-state*.json, node_modules\.modules.yaml, node_modules\.pnpm\lock.yaml -Force -ErrorAction SilentlyContinue; "try `$try relinks from scratch" }
    cmd /c "pnpm.cmd install --frozen-lockfile --reporter=append-only > D:\Phoenix\last-install.log 2>&1"
    `$code = `$LASTEXITCODE
    if (`$code -eq 0 -and (Test-Packages)) { `$ok = `$true; break }
    "install try `$try failed (exit `$code, packages " + `$(if (Test-Packages) { 'complete' } else { 'incomplete' }) + '): ' + ((Get-Content D:\Phoenix\last-install.log -Tail 3 | Where-Object { `$_.Trim() }) -join ' / ')
    if (`$try -eq 1) { Start-Sleep 60 }
  }
  Start-ScheduledTask -TaskName 'Phoenix Dev Server'
  if (`$ok) { 'packages reinstalled and verified complete, dev server restarted' }
  else { 'INSTALL FAILED - packages are incomplete and the dev server will not start; output in D:\Phoenix\last-install.log; the next run retries' }
}
'now at ' + (git log -1 --format='%h %s')
"@
$out = & "$PSScriptRoot\spare.ps1" -Command $remote -ConnectTimeout 20
$verb = if ($now -eq $rev) { 'dev server repaired at {1}' } else { 'dev server moved {0} -> {1}' }
Log (("$verb" + ': {2}') -f $now.Substring(0, 9), $rev.Substring(0, 9), (($out | Where-Object { $_ }) -join ' | '))
