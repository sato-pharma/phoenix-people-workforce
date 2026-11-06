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
Log 'tunnel loop started'
while ($true) {
  $held = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue |
    Where-Object { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName -ne 'ssh' }
  if ($held) { Start-Sleep 60; continue }
  & ssh -N -o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 `
    -o ExitOnForwardFailure=yes -o LogLevel=ERROR -i $key -L 127.0.0.1:3000:127.0.0.1:3000 TransferUser@192.168.1.60
  Log "ssh ended (exit $LASTEXITCODE); reconnecting in 15 s"
  Start-Sleep 15
}
