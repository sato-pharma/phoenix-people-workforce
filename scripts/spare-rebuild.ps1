throw 'WINDOWS-ONLY-RETIRED: the spare runs Ubuntu Server since 20 Nov 2026 (owner: "put Ubuntu Server on the spare"). This script drove its Windows and must not run against Linux. Use spare.ps1 (bash), spare-test.ps1, spare-follow-production.ps1.'
<#
.SYNOPSIS
  Finishes rebuilding the spare laptop after a fresh Windows, from the main laptop, with no hands (owner, 2026-11-20:
  "I reinstalled its Windows ... I hate manual work. Automate.").

  The owner pastes spare-bootstrap.ps1 ONCE on the spare (remote login, Git, Node.js 24, pnpm, awake on the charger,
  restart). The "Phoenix Spare Rebuild" scheduled task runs THIS every 5 minutes until the spare's dev server answers,
  then removes itself. Each run picks up where the last one stopped:
    1. FIND - a fresh Windows has a NEW host key, so spare-address.ps1's known_hosts anchor cannot recognise it. This
       looks for an open SSH port on the home network whose pre-sign-in banner carries "phx-spare=" (bootstrap v4 writes
       it), reads the user name from the same banner, signs in with the spare's own key, and only then trusts the new
       host key: it replaces the three "phoenix-spare" anchor lines (old file kept as known_hosts.bak-20261120-rebuild).
       Trusted on first sight on the home network - the same trust the first setup on 2026-11-07 had.
    2. RECORD - spare-address.txt, spare-user.txt and HostName/User under "Host phoenix-spare" in ~/.ssh/config, so
       every spare script and `ssh phoenix-spare` work again.
    3. CODE - keeps D:\Phoenix\phoenix-workforce if it survived the reinstall; otherwise sends production's version as
       a git bundle (only with 2.5 GB free here) and checks it out. Copies this laptop's .env.local when the spare has
       none or one that is not production (GOLDEN RULE: local dev always points to production).
    4. DEV SERVER TASK - registers "Phoenix Dev Server" on the spare (at startup, as the spare's user, no password stored).
    5. HAND-OVER - starts "Phoenix Spare Dev Server Follows", which installs the packages, moves the code to production's
       version, starts the dev server and installs the browser guard. When http://127.0.0.1:3000/api/healthz answers on
       the spare, this logs DONE and unregisters its own task.
  Log: ~/.claude/logs/spare-rebuild.log
#>
$ErrorActionPreference = 'Continue'
$S = $PSScriptRoot
$taskName = 'Phoenix Spare Rebuild'
$log = Join-Path $env:USERPROFILE '.claude\logs\spare-rebuild.log'
$key = Join-Path $env:USERPROFILE '.ssh\phoenix_spare_ed25519'
$kh = Join-Path $env:USERPROFILE '.ssh\known_hosts'
$cfg = Join-Path $env:USERPROFILE '.ssh\config'
$ssh = "$env:SystemRoot\System32\OpenSSH\ssh.exe"; $scp = "$env:SystemRoot\System32\OpenSSH\scp.exe"; $keyscan = "$env:SystemRoot\System32\OpenSSH\ssh-keyscan.exe"
$primary = 'F:\Phoenix Workforce\phoenix-workforce'
# Write-Host, never Write-Output: a Log call inside a function must not become part of its return value (the first live run,
# 2026-11-20 11:55, returned a log line from Find-NewSpare as "the spare" and wrote blank entries into the SSH files).
function Log($m) { $l = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m; Write-Host $l; Add-Content -LiteralPath $log -Value $l -Encoding utf8 }
function Spare([string]$cmd) { @(& "$S\spare.ps1" -Command $cmd -ConnectTimeout 20) }
function SpareUser { $u = "$(Get-Content -LiteralPath "$S\spare-user.txt" -ErrorAction SilentlyContinue | Select-Object -First 1)".Trim(); if ($u) { $u } else { 'TransferUser' } }

# ---------- 1. FIND ----------
function Get-ScanAddresses {
  foreach ($nic in [Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
    if ($nic.OperationalStatus -ne 'Up' -or $nic.NetworkInterfaceType -eq 'Loopback') { continue }
    $p = $nic.GetIPProperties()
    if (-not ($p.GatewayAddresses | Where-Object { $_.Address.AddressFamily -eq 'InterNetwork' })) { continue }
    foreach ($a in $p.UnicastAddresses) {
      if ($a.Address.AddressFamily -ne 'InterNetwork') { continue }
      $prefix = [int]$a.PrefixLength; if ($prefix -lt 24 -or $prefix -gt 30) { $prefix = 24 }
      $size = [long][math]::Pow(2, 32 - $prefix); $b = $a.Address.GetAddressBytes()
      $n = ([long]$b[0] -shl 24) + ([long]$b[1] -shl 16) + ([long]$b[2] -shl 8) + [long]$b[3]; $net = $n - ($n % $size)
      for ($h = $net + 1; $h -le $net + $size - 2; $h++) {
        $ip = '{0}.{1}.{2}.{3}' -f (($h -shr 24) -band 255), (($h -shr 16) -band 255), (($h -shr 8) -band 255), ($h -band 255)
        if ($ip -ne $a.Address.ToString()) { $ip }
      }
    }
  }
}
function Find-NewSpare {
  $probes = foreach ($ip in @(Get-ScanAddresses | Select-Object -Unique)) {
    $c = New-Object Net.Sockets.TcpClient
    try { [pscustomobject]@{ Ip = $ip; C = $c; T = $c.ConnectAsync($ip, 22) } } catch { $c.Dispose() }
  }
  try { [void][Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($probes | ForEach-Object { $_.T }), 3000) } catch { }
  $open = @($probes | Where-Object { $_.T.Status -eq 'RanToCompletion' -and $_.C.Connected } | ForEach-Object { $_.Ip })
  $probes | ForEach-Object { $_.C.Dispose() }
  foreach ($ip in $open) {
    # The banner arrives before any sign-in; "none" asks for nothing, so no key is offered to a stranger.
    $banner = "$(& $ssh -o BatchMode=yes -o ConnectTimeout=6 -o StrictHostKeyChecking=no -o UserKnownHostsFile=NUL -o PreferredAuthentications=none -o LogLevel=INFO "phx-probe@$ip" exit 2>&1)"
    if ($banner -notmatch 'phx-spare=\d+' -or $banner -notmatch 'phx-user=(\S+)') { continue }
    $user = $Matches[1]
    # Windows ssh-keyscan returns NOTHING (measured 2026-11-20), so the host key is taken the way ssh takes it on a first
    # visit: accept-new into a private file, together with the key sign-in that proves our key is installed there.
    $tmp = Join-Path $env:TEMP "spare-rebuild-kh-$PID"; Remove-Item $tmp -ErrorAction SilentlyContinue
    & $ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -o "UserKnownHostsFile=$tmp" -o IdentitiesOnly=yes -o LogLevel=QUIET -i $key "$user@$ip" hostname 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $tmp)) { Log "found the spare's banner at $ip (user $user) but the key sign-in failed - is the bootstrap's key step done?"; Remove-Item $tmp -ErrorAction SilentlyContinue; continue }
    $keys = @(Get-Content -LiteralPath $tmp | ForEach-Object { ($_ -split ' ', 2)[1].Trim() } | Where-Object { $_ })
    Remove-Item $tmp -ErrorAction SilentlyContinue
    if (-not $keys) { continue }
    return [pscustomobject]@{ Ip = $ip; User = $user; Keys = $keys }
  }
}
function Save-Spare($f) {
  if ("$($f.Ip)" -notmatch '^\d{1,3}(\.\d{1,3}){3}$' -or -not "$($f.User)".Trim() -or -not $f.Keys) { Log "refused to record a half-found spare ($($f.Ip) / $($f.User))"; exit 1 }
  $bak = "$kh.bak-20261120-rebuild"; if (-not (Test-Path $bak)) { Copy-Item -LiteralPath $kh $bak }
  $mine = '^' + [regex]::Escape($f.Ip) + '[ ,]'
  $kept = @(Get-Content -LiteralPath $kh | Where-Object { $_ -notlike 'phoenix-spare *' -and $_ -notmatch $mine })
  $new = $kept + @($f.Keys | ForEach-Object { "phoenix-spare $_" }) + @($f.Keys | ForEach-Object { "$($f.Ip) $_" })
  [IO.File]::WriteAllText($kh, (($new -join "`n") + "`n"), (New-Object Text.ASCIIEncoding))
  [IO.File]::WriteAllText("$S\spare-address.txt", "$($f.Ip)`n", (New-Object Text.ASCIIEncoding))
  [IO.File]::WriteAllText("$S\spare-user.txt", "$($f.User)`n", (New-Object Text.ASCIIEncoding))
  $text = [IO.File]::ReadAllText($cfg)
  foreach ($kv in @(@('HostName', $f.Ip), @('User', $f.User))) {
    $pattern = '(?m)(^Host[ \t]+phoenix-spare[ \t]*\r?\n(?:[ \t]+[^\r\n]*\r?\n)*?[ \t]+' + $kv[0] + '[ \t]+)\S+'
    $text = [regex]::Replace($text, $pattern, ('${1}' + $kv[1]))
  }
  [IO.File]::WriteAllText($cfg, $text, (New-Object Text.UTF8Encoding($false)))
}

$addr = "$(& "$S\spare-address.ps1" | Select-Object -Last 1)".Trim()
$known = ($LASTEXITCODE -eq 0) -and ("$(Spare 'hostname')".Trim() -ne '')
if (-not $known) {
  $f = Find-NewSpare
  if (-not $f) { Add-Content -LiteralPath $log -Value ('{0} waiting - no spare with the new setup on the home network yet' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -Encoding utf8; exit 1 }
  Save-Spare $f
  Log "FOUND the rebuilt spare at $($f.Ip), user $($f.User); its new host key now anchors known_hosts (old file kept as known_hosts.bak-20261120-rebuild), ssh config and the spare scripts point at it"
}

# ---------- 2. TOOLS (the bootstrap's restart puts them on the remote-login PATH) ----------
$t = Spare '$env:Path += ";$env:APPDATA\npm"; $o = foreach ($c in "git","node","pnpm") { if (Get-Command $c -ErrorAction SilentlyContinue) { $c } }; "TOOLS " + ($o -join ","); "NODE " + (node -v); "DRIVE " + (Test-Path D:\Phoenix); "REPO " + [bool](git -C D:\Phoenix\phoenix-workforce rev-parse --verify -q HEAD 2>$null); "SETUP " + (Get-Content $env:ProgramData\ssh\phx-setup-ok.txt -ErrorAction SilentlyContinue)'
$tools = "$($t | Where-Object { "$_" -like 'TOOLS *' })"
if ($tools -ne 'TOOLS git,node,pnpm') { Log "spare answers but its tools are not all on the PATH yet ('$tools'; $(($t | Where-Object { "$_" -like 'SETUP *' }) -join '')) - waiting for the bootstrap's restart"; exit 1 }
if ("$($t | Where-Object { "$_" -like 'DRIVE *' })" -ne 'DRIVE True') { Log 'spare has no D:\Phoenix yet - waiting for the bootstrap'; exit 1 }

# ---------- 3. CODE ----------
if ("$($t | Where-Object { "$_" -like 'REPO *' })" -ne 'REPO True') {
  $free = [math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1024)
  if ($free -lt 2500) { Log "the spare needs the code, but only $free MB is free here (a bundle needs 2,500) - next run"; exit 1 }
  $rev = $null; foreach ($try in 1..3) { try { $rev = (Invoke-RestMethod 'https://phoenix-hr.satopharma.com/api/healthz' -TimeoutSec 15).revision; break } catch { Start-Sleep 2 } }
  if ($rev -notmatch '^[0-9a-f]{40}$') { git -C $primary fetch -q origin main 2>$null; $rev = "$(git -C $primary rev-parse origin/main)".Trim() }
  git -C $primary cat-file -e "$rev^{commit}" 2>$null
  if ($LASTEXITCODE) { git -C $primary fetch -q origin main 2>$null; git -C $primary cat-file -e "$rev^{commit}" 2>$null }
  if ($LASTEXITCODE) { Log "this laptop does not have production's commit $rev yet - next run"; exit 1 }
  $tmp = Join-Path $env:TEMP "spare-rebuild-$PID"; New-Item -ItemType Directory -Force $tmp | Out-Null
  git -C $primary update-ref refs/spare-send/production $rev
  git -C $primary -c pack.threads=1 -c pack.windowMemory=256m bundle create "$tmp\full.bundle" refs/spare-send/production 2>$null | Out-Null
  git -C $primary update-ref -d refs/spare-send/production
  $mb = if (Test-Path "$tmp\full.bundle") { [math]::Round((Get-Item "$tmp\full.bundle").Length / 1MB) } else { 0 }
  if (-not $mb) { Log 'could not make the code bundle here - next run'; Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue; exit 1 }
  & $scp -o BatchMode=yes -o ConnectTimeout=20 -o LogLevel=ERROR -i $key "$tmp\full.bundle" "phoenix-spare:D:/Phoenix/inbox/full.bundle"
  $sent = $LASTEXITCODE
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  if ($sent) { Log "could not send the $mb MB code bundle to the spare - next run"; exit 1 }
  $r = Spare @"
`$ErrorActionPreference = 'Continue'
if (Test-Path D:\Phoenix\phoenix-workforce) { Rename-Item D:\Phoenix\phoenix-workforce ('phoenix-workforce-broken-' + (Get-Date -Format yyyyMMddHHmm)) }
git init -q D:\Phoenix\phoenix-workforce
Set-Location D:\Phoenix\phoenix-workforce
git config core.longpaths true; git config core.fsmonitor false
git fetch -q D:\Phoenix\inbox\full.bundle '+refs/spare-send/production:refs/spare/production' 2>&1 | Out-Null
git -c core.fsmonitor=false checkout -q -f --detach $rev 2>&1 | Out-Null
git update-ref refs/spare/base $rev
if ((git rev-parse HEAD) -eq '$rev') { Remove-Item D:\Phoenix\inbox\full.bundle -Force; 'CODE ok' } else { 'CODE failed' }
"@
  if ("$r" -notmatch 'CODE ok') { Log "the code bundle reached the spare but did not check out: $(($r | Where-Object { $_ }) -join ' | ') - next run"; exit 1 }
  Log "code sent to the spare ($mb MB, production's $($rev.Substring(0, 9))) and checked out at D:\Phoenix\phoenix-workforce"
}

$envNow = "$(Spare '$e = Get-Content D:\Phoenix\phoenix-workforce\.env.local -Raw -ErrorAction SilentlyContinue; if (-not $e) { "ENV missing" } elseif ($e -match "cifwmndunmlxjhyjugxa") { "ENV STAGING" } elseif ($e -match "ozucdzovmcqvepbozvqf") { "ENV production" } else { "ENV unknown" }' | Where-Object { "$_" -like 'ENV *' } | Select-Object -First 1)"
if ($envNow -ne 'ENV production') {
  & $scp -o BatchMode=yes -o ConnectTimeout=20 -o LogLevel=ERROR -i $key "$primary\.env.local" "phoenix-spare:D:/Phoenix/phoenix-workforce/.env.local"
  if ($LASTEXITCODE) { Log "the spare's .env.local was '$envNow' and this laptop's could not be sent - next run"; exit 1 }
  Log "the spare's .env.local was '$envNow' - this laptop's production .env.local sent"
}

# ---------- 4. DEV SERVER TASK ----------
$task = "$(Spare '$t = Get-ScheduledTask -TaskName "Phoenix Dev Server" -ErrorAction SilentlyContinue; "TASK " + $(if ($t) { $t.State } else { "missing" })' | Where-Object { "$_" -like 'TASK *' })"
if ($task -eq 'TASK missing') {
  $r = Spare @'
$run = @"
`$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') + ';' + `$env:APPDATA + '\npm'
Set-Location D:\Phoenix\phoenix-workforce
node scripts\dev-server.mjs --port 3000 *> D:\Phoenix\dev-server.log
"@
Set-Content D:\Phoenix\dev-server-run.ps1 $run -Encoding utf8
$a = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File D:\Phoenix\dev-server-run.ps1' -WorkingDirectory 'D:\Phoenix\phoenix-workforce'
$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
$p = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Limited
Register-ScheduledTask -TaskName 'Phoenix Dev Server' -Action $a -Trigger (New-ScheduledTaskTrigger -AtStartup) -Settings $s -Principal $p -Force | Out-Null
'TASK ' + (Get-ScheduledTask -TaskName 'Phoenix Dev Server').State
'@
  if ("$r" -notmatch 'TASK (Ready|Running)') { Log "could not register 'Phoenix Dev Server' on the spare: $(($r | Where-Object { $_ }) -join ' | ') - next run"; exit 1 }
  Log "registered 'Phoenix Dev Server' on the spare (at startup, as $(SpareUser), no password stored)"
}

# ---------- 5. HAND-OVER, and the proof ----------
$hz = "$(Spare 'try { "HZ " + (Invoke-WebRequest http://127.0.0.1:3000/api/healthz -UseBasicParsing -TimeoutSec 20).StatusCode } catch { "HZ down" }' | Where-Object { "$_" -like 'HZ *' })"
if ($hz -eq 'HZ 200') {
  # The tunnel holds its script in memory, so it is restarted to pick up the new user name; it then reconnects within a minute.
  Stop-ScheduledTask -TaskName 'Phoenix Spare Tunnel' -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { "$($_.CommandLine)" -match 'spare-tunnel\.ps1' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-ScheduledTask -TaskName 'Phoenix Spare Tunnel' -ErrorAction SilentlyContinue
  $head = "$(Spare 'git -C D:\Phoenix\phoenix-workforce log -1 --format="%h %s"' | Select-Object -Last 1)".Trim()
  Log "DONE - the rebuilt spare's dev server answers /api/healthz 200 at $head; localhost:3000 here reaches it through the tunnel. Task '$taskName' removed."
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  exit 0
}
$follow = Get-ScheduledTask -TaskName 'Phoenix Spare Dev Server Follows' -ErrorAction SilentlyContinue
if ($follow -and $follow.State -ne 'Running') { Start-ScheduledTask -TaskName 'Phoenix Spare Dev Server Follows' }
$last = "$(Get-Content "$env:USERPROFILE\.claude\logs\spare-follow-production.log" -Tail 1 -ErrorAction SilentlyContinue)"
Log "spare set up; the dev server is not answering yet ($hz) - the follow task installs the packages and starts it (its last line: $last)"
exit 1
