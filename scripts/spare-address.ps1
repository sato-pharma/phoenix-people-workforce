<#
.SYNOPSIS
  Prints the spare laptop's current address on the home network, and FINDS it again when it has moved
  (owner, 2026-11-14: "make the spare scripts find the laptop when its address changes").

  The home router hands the spare its address and it changes: .60 -> .53 on 2026-11-08, .53 -> .60 on
  2026-11-14 at 04:02, while the laptop itself stayed up. The address used to be written into four
  scripts and the SSH shortcut, so each move silently took down the dev server at localhost:3000, the
  tests on the spare and the 10-minute follow task until someone noticed and edited all five.

  Now every spare script asks this one. It answers in two steps:
    1. the last known address (spare-address.txt beside this file), when its SSH port answers and it is
       not one of this laptop's own addresses - a few milliseconds, the normal case;
    2. otherwise it tries port 22 on every address of this laptop's own network (its real size, at most
       a /24 - a phone hotspot is only 14 addresses), and for
       each that answers it signs in with the spare's own key, checking the laptop's identity against
       the "phoenix-spare" entries in ~/.ssh/known_hosts (HostKeyAlias). Only the real spare passes: an
       address proves nothing, the host key does.
  When it finds the spare somewhere new it records the address, trusts that address in known_hosts
  with the SAME keys, and rewrites HostName under "Host phoenix-spare" in ~/.ssh/config, so
  `ssh phoenix-spare` and every script that uses the plain address keep working.

  Prints ONE line, the address. Exit 0: the spare answers there. Exit 1: not found (asleep, off, or on
  another network) - the line is then the last known address, so a caller that goes on fails as before.

  It needs the three "phoenix-spare <type> <key>" lines in ~/.ssh/known_hosts. They are the trust
  anchor, copied once from the entry the owner's laptop already trusted; nothing here ever adds them.
  It looks only inside this laptop's own /24. Log (moves only): ~/.claude/logs/spare-address.log

.EXAMPLE
  $addr = "$(& ~/.claude/scripts/spare-address.ps1 | Select-Object -Last 1)".Trim()
#>
$ErrorActionPreference = 'Continue'
$alias = 'phoenix-spare'
$spareUser = "$(Get-Content -LiteralPath (Join-Path $PSScriptRoot 'spare-user.txt') -ErrorAction SilentlyContinue | Select-Object -First 1)".Trim(); if (-not $spareUser) { $spareUser = 'TransferUser' }   # the spare's user, written by spare-rebuild.ps1 (2026-11-20)
$user = $spareUser
$cacheFile = Join-Path $PSScriptRoot 'spare-address.txt'
$log = Join-Path $env:USERPROFILE '.claude\logs\spare-address.log'
$key = Join-Path $env:USERPROFILE '.ssh\phoenix_spare_ed25519'
$knownHosts = Join-Path $env:USERPROFILE '.ssh\known_hosts'
$sshConfig = Join-Path $env:USERPROFILE '.ssh\config'
$sshExe = "$env:SystemRoot\System32\OpenSSH\ssh.exe"
$ipv4 = '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$'

function Log($m) { Add-Content -LiteralPath $log -Value ('{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) -Encoding utf8 }

# This laptop's own IPv4 addresses on a network that has a gateway (the Wi-Fi; not a virtual switch).
function Get-OwnAddresses {
  foreach ($nic in [Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
    if ($nic.OperationalStatus -ne 'Up' -or $nic.NetworkInterfaceType -eq 'Loopback') { continue }
    $props = $nic.GetIPProperties()
    if (-not ($props.GatewayAddresses | Where-Object { $_.Address.AddressFamily -eq 'InterNetwork' })) { continue }
    foreach ($a in $props.UnicastAddresses) { if ($a.Address.AddressFamily -eq 'InterNetwork') { $a.Address.ToString() } }
  }
}

function Test-Port([string]$ip, [int]$ms) {
  $c = New-Object Net.Sockets.TcpClient
  try { return ($c.ConnectAsync($ip, 22).Wait($ms) -and $c.Connected) } catch { return $false } finally { $c.Dispose() }
}

# The identity check. The host at $ip must present a key recorded under "phoenix-spare" AND accept the
# spare's own key. A new address is never trusted on first sight, and never asked about.
#
# 🔴 A HARD 15-SECOND CAP (owner, 25 Nov 2026: "Stop it and fix"). ConnectTimeout covers only the TCP connect: on
# 25 Nov one check connected at 09:09 and then never answered, and the tunnel loop waited on it for 14 hours with
# localhost:3000 dead. ServerAlive ends a silent session from inside ssh; the wait below ends it from outside, whatever
# ssh is doing, and a check that did not finish in time is "not the spare".
function Test-IsSpare([string]$ip) {
  $sshArgs = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2',
    '-o', 'StrictHostKeyChecking=yes', '-o', "HostKeyAlias=$alias", '-o', 'IdentitiesOnly=yes', '-o', 'LogLevel=QUIET',
    '-i', $key, "$user@$ip", 'hostname')
  $p = $null; $out = [IO.Path]::GetTempFileName(); $err = [IO.Path]::GetTempFileName()
  try {
    $p = Start-Process -FilePath $sshExe -ArgumentList $sshArgs -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
    $null = $p.Handle   # held now, or ExitCode reads empty after WaitForExit(ms) (a known Start-Process quirk)
    if (-not $p.WaitForExit(15000)) { try { $p.Kill() } catch {} ; return $false }
    return ($p.ExitCode -eq 0)
  } catch { return $false } finally {
    if ($p) { $p.Dispose() }
    Remove-Item -LiteralPath $out, $err -Force -ErrorAction SilentlyContinue
  }
}

# The host addresses of each of this laptop's own networks, using the network's REAL size, never wider
# than a /24. A phone hotspot is a /28 (172.20.10.0-15): scanning it as a /24 hit its broadcast address
# .15, which Windows refuses outright ("The requested address is not valid in its context", 2026-11-19),
# and sent the other 240 probes off the network through the phone.
function Get-ScanAddresses {
  $seen = @{}
  foreach ($nic in [Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
    if ($nic.OperationalStatus -ne 'Up' -or $nic.NetworkInterfaceType -eq 'Loopback') { continue }
    $props = $nic.GetIPProperties()
    if (-not ($props.GatewayAddresses | Where-Object { $_.Address.AddressFamily -eq 'InterNetwork' })) { continue }
    foreach ($a in $props.UnicastAddresses) {
      if ($a.Address.AddressFamily -ne 'InterNetwork') { continue }
      $prefix = [int]$a.PrefixLength
      if ($prefix -lt 24 -or $prefix -gt 32) { $prefix = 24 }
      $size = [long][math]::Pow(2, 32 - $prefix)
      if ($size -lt 4) { continue }
      $b = $a.Address.GetAddressBytes()
      $n = ([long]$b[0] -shl 24) + ([long]$b[1] -shl 16) + ([long]$b[2] -shl 8) + [long]$b[3]
      $net = $n - ($n % $size)
      for ($h = $net + 1; $h -le $net + $size - 2; $h++) {   # not ($a..$b): 5.1 ranges are Int32 only
        $ip = '{0}.{1}.{2}.{3}' -f (($h -shr 24) -band 255), (($h -shr 16) -band 255), (($h -shr 8) -band 255), ($h -band 255)
        if (-not $seen.ContainsKey($ip)) { $seen[$ip] = $true; $ip }
      }
    }
  }
}

# Every address of this laptop's own network whose SSH port answers, this laptop's own left out.
function Find-OpenSshHosts([string[]]$own) {
  $probes = foreach ($ip in @(Get-ScanAddresses)) {
    if ($own -contains $ip) { continue }
    $c = New-Object Net.Sockets.TcpClient
    # An address Windows refuses to dial throws at once instead of failing the task: skip it quietly.
    try { [pscustomobject]@{ Ip = $ip; Client = $c; Task = $c.ConnectAsync($ip, 22) } } catch { $c.Dispose() }
  }
  if (-not $probes) { return }
  try { [void][Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($probes | ForEach-Object { $_.Task }), 2500) } catch { }
  foreach ($p in $probes) {
    if ($p.Task.Status -eq 'RanToCompletion' -and $p.Client.Connected) { $p.Ip }
    $p.Client.Dispose()
  }
}

# Give $ip the spare's keys in known_hosts (replacing whatever another device left there), so the
# scripts that connect by plain address pass the host-key check. Called only after Test-IsSpare passed.
function Set-TrustedAddress([string]$ip) {
  $lines = @(Get-Content -LiteralPath $knownHosts -ErrorAction SilentlyContinue)
  $spareKeys = @($lines | Where-Object { $_ -like "$alias *" } | ForEach-Object { $_.Substring($alias.Length + 1).Trim() })
  if (-not $spareKeys) { return }
  $mine = '^' + [regex]::Escape($ip) + '[ ,]'
  $have = @($lines | Where-Object { $_ -match $mine } | ForEach-Object { ($_ -split ' ', 2)[1].Trim() })
  if ((($have | Sort-Object) -join '|') -eq (($spareKeys | Sort-Object) -join '|')) { return }
  $kept = @($lines | Where-Object { $_ -notmatch $mine })
  $new = $kept + @($spareKeys | ForEach-Object { "$ip $_" })
  [IO.File]::WriteAllText($knownHosts, (($new -join "`n") + "`n"), (New-Object Text.ASCIIEncoding))
}

# Keep `ssh phoenix-spare` working: rewrite HostName inside the "Host phoenix-spare" block only.
function Set-ConfigHostName([string]$ip) {
  if (-not (Test-Path -LiteralPath $sshConfig)) { return }
  $text = [IO.File]::ReadAllText($sshConfig)
  $pattern = '(?m)(^Host[ \t]+' + [regex]::Escape($alias) + '[ \t]*\r?\n(?:[ \t]+[^\r\n]*\r?\n)*?[ \t]+HostName[ \t]+)\S+'
  $new = [regex]::Replace($text, $pattern, ('${1}' + $ip))
  if ($new -ne $text) { [IO.File]::WriteAllText($sshConfig, $new, (New-Object Text.UTF8Encoding($false))) }
}

$own = @(Get-OwnAddresses)
$last = "$(Get-Content -LiteralPath $cacheFile -ErrorAction SilentlyContinue | Select-Object -First 1)".Trim()
if ($last -notmatch $ipv4) { $last = '' }

# 1. The normal case: it is where it was. (Its own address is never the spare: after a swap this
#    laptop's own SSH port would answer for it.)
if ($last -and ($own -notcontains $last) -and (Test-Port $last 1500)) { Write-Output $last; exit 0 }

# 2. It moved, or it is off. Look for it, and let the host key decide.
foreach ($ip in @(Find-OpenSshHosts $own)) {
  if (-not (Test-IsSpare $ip)) { continue }
  Set-TrustedAddress $ip
  Set-ConfigHostName $ip
  [IO.File]::WriteAllText($cacheFile, "$ip`n", (New-Object Text.ASCIIEncoding))
  if ($ip -ne $last) { Log "spare laptop found at $ip (was $(if ($last) { $last } else { 'unknown' })); address recorded, known_hosts and the phoenix-spare shortcut updated" }
  Write-Output $ip
  exit 0
}
Write-Output $last
exit 1
