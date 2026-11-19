<#
.SYNOPSIS
  Makes http://localhost:3000 on the main laptop open the dev server running on the spare laptop
  (owner, 2026-11-07: the spare's 8 GB takes the dev server and tests). Forwards local port 3000 to
  the spare's port 3000 over SSH and reconnects whenever the Wi-Fi drops. Started hidden at sign-in
  by the "Phoenix Spare Tunnel" scheduled task.

  If a dev server is already listening on 3000 HERE, the tunnel waits instead of fighting it.
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
Log 'tunnel loop started'
$down = $false
while ($true) {
  $held = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue |
    Where-Object { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName -ne 'ssh' }
  if ($held) { Start-Sleep 60; continue }
  $addr = SpareAddress
  if (-not $addr) {
    if (-not $down) { Log 'spare not answering at its last address and not found on the home network (asleep, off or off the Wi-Fi); checking once a minute'; $down = $true }
    Start-Sleep 60; continue
  }
  if ($down) { Log "spare answering again at $addr; reconnecting"; $down = $false }
  & ssh -N -o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 `
    -o ExitOnForwardFailure=yes -o LogLevel=ERROR -i $key -L 127.0.0.1:3000:127.0.0.1:3000 "TransferUser@$addr"
  Log "ssh ended (exit $LASTEXITCODE); reconnecting in 15 s"
  Start-Sleep 15
}
