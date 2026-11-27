<#
.SYNOPSIS
  Makes http://localhost:3000 on the main laptop open the dev server running on the spare laptop
  (owner, 2026-11-07: the spare's 8 GB takes the dev server and tests). Forwards local port 3000 to
  the spare's port 3000 over SSH and reconnects whenever the Wi-Fi drops. Started hidden at sign-in
  by the "Phoenix Spare Tunnel" scheduled task.

  If a dev server is already listening on 3000 HERE, the tunnel waits instead of fighting it.
  It checks itself once a minute and restarts a dead forward on its own (2026-11-22).
#>
$ErrorActionPreference = 'Continue'
$key = Join-Path $env:USERPROFILE '.ssh\phoenix_spare_ed25519'
$log = Join-Path $env:USERPROFILE '.claude\logs\spare-tunnel.log'
function Log($m) { Add-Content -LiteralPath $log -Value ('{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) -Encoding utf8 }
function SpareAddress {
  # Where the spare is NOW, or nothing when it does not answer. The address is never written here (owner,
  # 2026-11-14): the router moved the spare twice and each move left this loop knocking on the old address
  # until someone edited it. spare-address.ps1 probes the last known address (a quiet check, so an asleep/off
  # spare still costs one look a minute and one log line - 2026-11-13: 500+ lines overnight), and when that
  # is silent it looks for the spare on the home network and lets its host key decide.
  $a = "$(& "$PSScriptRoot\spare-address.ps1" | Select-Object -Last 1)".Trim()
  if ($LASTEXITCODE -eq 0 -and $a) { return $a }
}
$spareUser = "$(Get-Content -LiteralPath (Join-Path $PSScriptRoot 'spare-user.txt') -ErrorAction SilentlyContinue | Select-Object -First 1)".Trim(); if (-not $spareUser) { $spareUser = 'TransferUser' }   # the spare's user, written by spare-rebuild.ps1 (2026-11-20)
# TELEGRAM WHEN THE SPARE STOPS ANSWERING (owner, 2026-11-22: "Do 3 and 6"). After 10 minutes without an answer, one
# message; when it answers again, one more with how long it was gone. Never while THIS laptop is the one offline (its
# router does not answer): then the spare is not the problem and Telegram could not be reached anyway.
# Test knobs (never set in the scheduled task): PHX_SPARE_ALERT_MIN, PHX_SPARE_FAKE_DOWN=<a file: down while it exists>, PHX_SPARE_ALERT_DRY=1, PHX_SPARE_TUNNEL_LOG.
. "$PSScriptRoot\spare-telegram.ps1"
if ($env:PHX_SPARE_TUNNEL_LOG) { $log = $env:PHX_SPARE_TUNNEL_LOG }
$alertMin = if ($env:PHX_SPARE_ALERT_MIN) { [double]$env:PHX_SPARE_ALERT_MIN } else { 10 }
function Alert([string]$text) {
  $r = Send-SpareTelegram -Text $text -DryRun:($env:PHX_SPARE_ALERT_DRY -eq '1')
  Log "Telegram: $r"
  return ($r -eq 'sent' -or $r -like 'dry-run ok*')
}
function Cairo([datetime]$t) { $t.ToString('HH:mm, dd MMM') }
# ONE COPY ONLY (23 Nov 2026): a second loop left running beside the real one tried to start ssh every 15 s for an hour
# and logged 2,199 failures (Windows 0xC0000142). A second start now sees the first one's lock and exits at once.
$one = New-Object System.Threading.Mutex($false, 'LocalPhoenixSpareTunnelLoop')
$mine = $false; try { $mine = $one.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $mine = $true }
if (-not $mine) { Log 'another tunnel loop is already running; this copy exits'; exit 0 }
Log 'tunnel loop started'
$down = $false; $downSince = $null; $alerted = $false
while ($true) {
  $held = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue |
    Where-Object { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName -ne 'ssh' }
  if ($held) { Start-Sleep 60; continue }
  $addr = if ($env:PHX_SPARE_FAKE_DOWN -and (Test-Path -LiteralPath $env:PHX_SPARE_FAKE_DOWN)) { $null } else { SpareAddress }
  if (-not $addr) {
    if (-not $down) { Log 'spare not answering at its last address and not found on the home network (asleep, off or off the Wi-Fi); checking once a minute'; $down = $true; $downSince = Get-Date }
    if (-not $alerted -and ((Get-Date) - $downSince).TotalMinutes -ge $alertMin) {
      if (Test-Connection -ComputerName 192.168.1.1 -Count 2 -Quiet -ErrorAction SilentlyContinue) {
        $alerted = Alert "Spare laptop: not answering since $(Cairo $downSince). localhost:3000 is down until it is back on the home Wi-Fi. If it is off, press its power button; it starts the dev server by itself."
      } else { $downSince = Get-Date }   # this laptop is off its own network - start counting again once it is back
    }
    Start-Sleep 60; continue
  }
  if ($down) {
    Log "spare answering again at $addr; reconnecting"
    if ($alerted) { [void](Alert "Spare laptop: answering again since $(Cairo (Get-Date)), after $([int]((Get-Date) - $downSince).TotalMinutes) minutes away. localhost:3000 returns in about 2 minutes.") }
    $down = $false; $downSince = $null; $alerted = $false
  }
  # THE TUNNEL REPAIRS ITSELF (owner, 2026-11-22: "Do the top 6"). ssh can stay alive while the forward is dead (20 Nov
  # 18:45: localhost:3000 stopped answering, nothing logged, a hand restart fixed it). Once a minute localhost:3000 is
  # asked for /api/healthz; after 3 misses in a row the spare is asked the same question itself. If the spare answers,
  # the tunnel is the broken part and is restarted; if the spare does not, its dev server is restarting (04:00, an
  # update, a preview starting) and the tunnel is left alone.
  # localhost:3001 = a pull request preview beside the live version (owner, 2026-11-23: side by side), forwarded only
  # when nothing on this laptop already listens there, so a local dev server on 3001 is never fought.
  $fwd = @('-L', '127.0.0.1:3000:127.0.0.1:3000')
  if (-not (Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue)) { $fwd += @('-L', '127.0.0.1:3001:127.0.0.1:3001') }
  $p = Start-Process -FilePath 'ssh' -NoNewWindow -PassThru -ArgumentList (@('-N', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'ExitOnForwardFailure=yes', '-o', 'LogLevel=ERROR',
    '-i', "`"$key`"") + $fwd + @("$spareUser@$addr"))
  $null = $p.Handle   # keep the handle, so ExitCode is readable once ssh ends
  $miss = 0; $healed = $false
  while (-not $p.WaitForExit(60000)) {
    try { Invoke-WebRequest 'http://127.0.0.1:3000/api/healthz' -UseBasicParsing -TimeoutSec 20 | Out-Null; $miss = 0; continue } catch { $miss++ }
    if ($miss -lt 3) { continue }
    $self = & ssh -o BatchMode=yes -o ConnectTimeout=15 -o LogLevel=ERROR -i $key "$spareUser@$addr" 'curl -s -o /dev/null -m 20 -w "%{http_code}" http://127.0.0.1:3000/api/healthz' 2>$null
    if ("$self".Trim() -eq '200') {
      Log 'localhost:3000 missed 3 checks while the spare itself answers - the tunnel was broken; restarting it'
      Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue; $healed = $true; break
    }
    $miss = 0   # the spare's own dev server is down or restarting - not the tunnel's fault
  }
  $p.WaitForExit()
  Log $(if ($healed) { 'tunnel restarted by its own check; reconnecting in 15 s' } else { "ssh ended (exit $($p.ExitCode)); reconnecting in 15 s" })
  Start-Sleep 15
}
