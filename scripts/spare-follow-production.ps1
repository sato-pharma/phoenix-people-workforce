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

  THE SPARE RUNS UBUNTU SINCE 20 NOV 2026 (owner: "put Ubuntu Server on the spare"). The Windows version is kept
  beside this file as spare-follow-production.ps1.bak-20261120-windows. On the spare:
    ~/phoenix/phoenix-workforce   the dev server's checkout (ext4), detached at production's revision
    ~/phoenix/dev-server-run.sh   copy of spare-dev-server-run.sh beside this file, run by the systemd service phoenix-dev
    ~/phoenix/last-install.log    the last package install's full output
  When the checkout differs, sends only the missing commits (a git bundle), checks that version out, and, if the
  package lockfile changed or the packages are incomplete, reinstalls and restarts the dev server. Runs every 10
  minutes from the "Phoenix Spare Dev Server Follows" scheduled task; a run with nothing to do touches nothing.
  Log: ~/.claude/logs/spare-follow-production.log

  THE REINSTALL CHECKS ITSELF (owner, 2026-11-11: "make the spare reinstall check itself"): COMPLETE means
  node_modules/.bin/next exists AND pnpm's own end-of-install copy node_modules/.pnpm/lock.yaml is byte-identical to
  pnpm-lock.yaml. A broken install is repaired on the next run even when the revision has not moved; one retry after
  60 s; a final failure is logged as INSTALL FAILED.
#>
param([ValidateSet('main', 'production')][string]$Target = 'production')
$ErrorActionPreference = 'Continue'
$repo = 'F:\Phoenix Workforce\phoenix-workforce'
$key = Join-Path $env:USERPROFILE '.ssh\phoenix_spare_ed25519'
$spareUser = "$(Get-Content -LiteralPath (Join-Path $PSScriptRoot 'spare-user.txt') -ErrorAction SilentlyContinue | Select-Object -First 1)".Trim(); if (-not $spareUser) { $spareUser = 'phoenix' }
$spare = "$spareUser@" + "$(& "$PSScriptRoot\spare-address.ps1" | Select-Object -Last 1)".Trim()   # found, never written here (2026-11-14)
$scpExe = "$env:SystemRoot\System32\OpenSSH\scp.exe"   # Windows OpenSSH even when called from Git Bash
$sshOpts = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'LogLevel=ERROR', '-i', $key)
$log = Join-Path $env:USERPROFILE '.claude\logs\spare-follow-production.log'
function Log($m) { $l = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m; Write-Output $l; Add-Content -LiteralPath $log -Value $l -Encoding utf8 }
function Spare([string]$cmd) { & "$PSScriptRoot\spare.ps1" -Command $cmd -ConnectTimeout 20 }

# THE DEV SERVER'S RUN SCRIPT IS KEPT CURRENT ON THE SPARE (owner, 2026-11-20: "I want the dev server to be super fast").
# A changed copy is sent and takes effect at the next dev server start; nothing is restarted for it.
$runSrc = Join-Path $PSScriptRoot 'spare-dev-server-run.sh'
if (Test-Path -LiteralPath $runSrc) {
  $runHash = (Get-FileHash -LiteralPath $runSrc -Algorithm SHA256).Hash.ToLower()
  $runNow = "$(@(Spare 'echo "RUN $(sha256sum ~/phoenix/dev-server-run.sh 2>/dev/null | cut -d" " -f1)"') | Where-Object { "$_" -like 'RUN*' } | Select-Object -First 1)".Trim()
  if ($runNow -and $runNow -ne "RUN $runHash") {
    & $scpExe @sshOpts $runSrc "${spare}:phoenix/dev-server-run.sh"
    if (-not $LASTEXITCODE) { Spare 'sed -i "s/\r$//" ~/phoenix/dev-server-run.sh; chmod 755 ~/phoenix/dev-server-run.sh' | Out-Null }
    Log $(if ($LASTEXITCODE) { 'the dev server run script on the spare is old and could not be sent' } else { 'sent the current dev server run script (warm-up) to the spare; it applies at the next dev server start' })
  }
}

# THE DEV SERVER IS STARTED WHEN IT IS NOT RUNNING (2026-11-13), never while an install is running or the packages are incomplete,
# (a pull request preview runs BESIDE it on localhost:3001 since 2026-11-23, so it never holds the live server back).
$srv = @(Spare 'cd ~/phoenix/phoenix-workforce; if systemctl is-active -q phoenix-dev; then echo "SRV up"; elif pgrep -f "pnpm.*install" >/dev/null; then echo "SRV installing"; elif [ ! -e node_modules/.bin/next ]; then echo "SRV no-packages"; else sudo systemctl start phoenix-dev; echo "SRV started"; fi')
if ("$srv" -match 'SRV started') { Log 'dev server was not running on the spare (a restart or a power cut) - started it' }

if ($Target -eq 'production') {
  # Three tries, 15 s each (2026-11-13): from this home network about one connection in three to production never completes.
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

# The golden rule's other half, read on every run. Only the verdict crosses the wire.
$answer = @(Spare 'cd ~/phoenix/phoenix-workforce; if [ ! -f .env.local ]; then echo "ENV missing"; elif grep -q cifwmndunmlxjhyjugxa .env.local; then echo "ENV STAGING"; elif grep -q ozucdzovmcqvepbozvqf .env.local; then echo "ENV production"; else echo "ENV unknown"; fi; if [ -e node_modules/.bin/next ] && cmp -s pnpm-lock.yaml node_modules/.pnpm/lock.yaml; then echo "PKG complete"; else echo "PKG broken"; fi; git rev-parse HEAD')
$envVerdict = "$($answer | Where-Object { "$_" -like 'ENV *' } | Select-Object -First 1)"
if ($envVerdict -and $envVerdict -ne 'ENV production') { Log "GOLDEN RULE BROKEN: the spare's dev server .env.local reads '$($envVerdict.Substring(4))', not production - fix it now" }
$pkgVerdict = "$($answer | Where-Object { "$_" -like 'PKG *' } | Select-Object -First 1)"
$now = "$($answer | Select-Object -Last 1)".Trim()
if ($now -notmatch '^[0-9a-f]{40}$') { Log 'spare laptop did not answer'; exit 1 }
if ($now -eq $rev -and $pkgVerdict -ne 'PKG broken') { exit 0 }

git -C $repo cat-file -e "$rev^{commit}" 2>$null
if ($LASTEXITCODE) { git -C $repo fetch -q origin main 2>$null; git -C $repo cat-file -e "$rev^{commit}" 2>$null }
if ($LASTEXITCODE) { Log "this laptop does not have production's commit $rev yet"; exit 1 }

# Does the spare already hold that commit? If not, send only what lies beyond what it has.
$has = "$(Spare "git -C ~/phoenix/phoenix-workforce cat-file -e '$rev^{commit}' 2>/dev/null; echo `$?" | Select-Object -Last 1)".Trim()
if ($has -ne '0') {
  $base = "$(Spare 'git -C ~/phoenix/phoenix-workforce rev-parse HEAD' | Select-Object -Last 1)".Trim()
  $tmp = Join-Path $env:TEMP "spare-follow-$PID"; New-Item -ItemType Directory -Force $tmp | Out-Null
  git -C $repo update-ref refs/spare-send/production $rev
  git -C $repo bundle create "$tmp\prod.bundle" "$base..refs/spare-send/production" 2>$null | Out-Null
  git -C $repo update-ref -d refs/spare-send/production
  & $scpExe @sshOpts "$tmp\prod.bundle" "${spare}:phoenix/inbox/prod.bundle"
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  Spare "git -C ~/phoenix/phoenix-workforce fetch -q ~/phoenix/inbox/prod.bundle '+refs/spare-send/production:refs/spare/production' >/dev/null 2>&1; c=`$?; rm -f ~/phoenix/inbox/prod.bundle; exit `$c" | Out-Null
  if ($LASTEXITCODE) { Log "could not send production's commit $rev to the spare"; exit 1 }
}

$remote = @"
cd ~/phoenix/phoenix-workforce || exit 1
lock_changed=`$(git diff --name-only HEAD $rev -- pnpm-lock.yaml)
git checkout -q -f --detach $rev >/dev/null 2>&1 || { echo 'checkout failed'; exit 1; }
pkg_ok() { [ -e node_modules/.bin/next ] && cmp -s pnpm-lock.yaml node_modules/.pnpm/lock.yaml; }
broken=0; pkg_ok || broken=1
if [ -n "`$lock_changed" ] || [ `$broken = 1 ]; then
  [ `$broken = 1 ] && [ -z "`$lock_changed" ] && echo 'packages were INCOMPLETE - repairing'
  sudo systemctl stop phoenix-dev
  export CI=true
  ok=0
  for try in 1 2; do
    # pnpm trusts its own state files: over a half-linked tree it answers "Already up to date" (2026-11-11), so a repair
    # and every second try removes them and pnpm relinks everything from the store already on the spare.
    if [ `$try = 2 ] || { [ `$broken = 1 ] && [ -z "`$lock_changed" ]; }; then rm -f node_modules/.pnpm-workspace-state*.json node_modules/.modules.yaml node_modules/.pnpm/lock.yaml; echo "try `$try relinks from scratch"; fi
    pnpm install --frozen-lockfile --reporter=append-only > ~/phoenix/last-install.log 2>&1; code=`$?
    if [ `$code = 0 ] && pkg_ok; then ok=1; break; fi
    echo "install try `$try failed (exit `$code): `$(tail -n 3 ~/phoenix/last-install.log | tr '\n' '/')"
    [ `$try = 1 ] && sleep 60
  done
  sudo systemctl start phoenix-dev   # a pull request preview runs BESIDE it on 3001 since 2026-11-23, so the live one always comes back
  if [ `$ok = 1 ]; then echo 'packages reinstalled and verified complete, dev server restarted'; else echo 'INSTALL FAILED - packages are incomplete and the dev server will not start; output in ~/phoenix/last-install.log; the next run retries'; fi
fi
echo "now at `$(git log -1 --format='%h %s')"
"@
$out = Spare $remote
$verb = if ($now -eq $rev) { 'dev server repaired at {1}' } else { 'dev server moved {0} -> {1}' }
Log (("$verb" + ': {2}') -f $now.Substring(0, 9), $rev.Substring(0, 9), (($out | Where-Object { $_ }) -join ' | '))
