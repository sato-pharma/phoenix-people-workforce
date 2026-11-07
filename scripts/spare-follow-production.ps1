<#
.SYNOPSIS
  Keeps the spare laptop's dev server (localhost:3000 here, through the "Phoenix Spare Tunnel") on a
  chosen version. Its database is always production (.env.local).
    -Target main (default; owner, 2026-11-07 03:45: "RUN LOCAL DEV FROM MAIN", chose "Spare runs main")
        follows the newest origin/main.
    -Target production (owner, 2026-11-07 01:44: "POINT DEV TO PRODUCTION") follows production's
        /api/healthz revision.
  When the dev server's checkout differs, sends only the missing commits and checks that version out
  in D:\Phoenix\phoenix-workforce. If the package lockfile changed, it reinstalls and restarts the dev
  server. Runs every 10 minutes from the "Phoenix Spare Dev Server Follows" scheduled task; a run with
  nothing to do touches nothing. Log: ~/.claude/logs/spare-follow-production.log
#>
param([ValidateSet('main', 'production')][string]$Target = 'main')
$ErrorActionPreference = 'Continue'
$repo = 'F:\Phoenix Workforce\phoenix-workforce'
$key = Join-Path $env:USERPROFILE '.ssh\phoenix_spare_ed25519'
$spare = 'TransferUser@192.168.1.60'
$sshExe = "$env:SystemRoot\System32\OpenSSH\ssh.exe"; $scpExe = "$env:SystemRoot\System32\OpenSSH\scp.exe"   # Windows OpenSSH even when called from Git Bash
$sshOpts = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'LogLevel=ERROR', '-i', $key)
$log = Join-Path $env:USERPROFILE '.claude\logs\spare-follow-production.log'
function Log($m) { $l = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m; Write-Output $l; Add-Content -LiteralPath $log -Value $l -Encoding utf8 }

if ($Target -eq 'production') {
  try { $rev = (Invoke-RestMethod 'https://phoenix-hr.satopharma.com/api/healthz' -TimeoutSec 30).revision } catch { Log "production did not answer: $($_.Exception.Message)"; exit 1 }
  if ($rev -notmatch '^[0-9a-f]{40}$') { Log "production gave no revision ($rev)"; exit 1 }
} else {
  git -C $repo fetch -q origin main 2>$null
  $rev = (git -C $repo rev-parse origin/main 2>$null | Select-Object -First 1)
  if ($rev -notmatch '^[0-9a-f]{40}$') { Log "could not read origin/main ($rev)"; exit 1 }
}

$now = (& "$PSScriptRoot\spare.ps1" -Command 'git -C D:\Phoenix\phoenix-workforce rev-parse HEAD' -ConnectTimeout 20 | Select-Object -Last 1)
if (-not $now) { Log 'spare laptop did not answer'; exit 1 }
$now = $now.Trim()
if ($now -eq $rev) { exit 0 }

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
if (`$lockChanged) {
  Stop-ScheduledTask -TaskName 'Phoenix Dev Server'
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { `$_.CommandLine -match 'dev-server|next' } | ForEach-Object { Stop-Process -Id `$_.ProcessId -Force -ErrorAction SilentlyContinue }
  `$env:CI = 'true'; pnpm.cmd install --frozen-lockfile --reporter=silent 2>&1 | Select-Object -Last 3
  Start-ScheduledTask -TaskName 'Phoenix Dev Server'
  'packages reinstalled, dev server restarted'
}
'now at ' + (git log -1 --format='%h %s')
"@
$out = & "$PSScriptRoot\spare.ps1" -Command $remote -ConnectTimeout 20
Log ("dev server moved {0} -> {1}: {2}" -f $now.Substring(0, 9), $rev.Substring(0, 9), (($out | Where-Object { $_ }) -join ' | '))
