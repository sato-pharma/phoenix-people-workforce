# Phoenix spare laptop - lets the main laptop run the dev server and tests here (owner, 2026-11-07).
# Paste into Windows PowerShell opened with "Run as administrator" ON THE SPARE LAPTOP. Safe to run again.
# Key-only login, from this home network only; passwords are switched off for remote login.
# v2: stops at the first error and names the step (v1 printed DONE even when a step had failed).
# Served to him on the private page https://claude.ai/artifact/4SS7iLMwM1R3qxQktqfBFR - keep the two identical.
$ErrorActionPreference = 'Stop'; $step = 'start'
try {
  $key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHRUP2u1kNY17hiznTPskfqstItmOgeyd/In33RPxOLj phoenix-main-to-spare'
  # v3 (00:59 Cairo): Add-WindowsCapability hung on the spare laptop (Windows Update download), so winget installs it.
  $step = 'installing the remote-login feature (about 1 minute)'
  if (-not (Get-Service sshd -ErrorAction SilentlyContinue)) {
    Write-Host 'Installing remote login - about 1 minute...' -ForegroundColor Cyan
    winget install --id Microsoft.OpenSSH.Preview -e --silent --accept-source-agreements --accept-package-agreements | Out-Null
    if (-not (Get-Service sshd -ErrorAction SilentlyContinue)) { throw 'the remote-login feature did not install' }
  }
  $step = 'starting the remote-login service'
  Set-Service sshd -StartupType Automatic; Start-Service sshd
  $step = 'writing the remote-login settings'
  $cfg = "$env:ProgramData\ssh\sshd_config"
  $c = @('PasswordAuthentication no', 'Banner __PROGRAMDATA__/ssh/phx-banner.txt') + @(Get-Content $cfg | Where-Object { $_ -notmatch '^\s*#?\s*(PasswordAuthentication|Banner)\b' })
  Set-Content $cfg $c -Encoding ascii
  "phx-user=$env:USERNAME" | Set-Content "$env:ProgramData\ssh\phx-banner.txt" -Encoding ascii
  $step = 'adding the main laptop key'
  $ak = "$env:ProgramData\ssh\administrators_authorized_keys"; Set-Content $ak $key -Encoding ascii
  icacls $ak /inheritance:r /grant "*S-1-5-32-544:F" /grant "SYSTEM:F" | Out-Null
  New-Item -ItemType Directory -Force "$env:USERPROFILE\.ssh" | Out-Null; Set-Content "$env:USERPROFILE\.ssh\authorized_keys" $key -Encoding ascii
  New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -PropertyType String -Force | Out-Null
  $step = 'opening the firewall for the home network'
  Get-NetFirewallRule -Name 'PhoenixSpareSSH' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -Name 'PhoenixSpareSSH' -DisplayName 'Phoenix main laptop remote login' -Protocol TCP -LocalPort 22 -Direction Inbound -Action Allow -RemoteAddress LocalSubnet -Profile Any | Out-Null
  $step = 'restarting the remote-login service'
  Restart-Service sshd; Start-Sleep 2
  $listen = Get-NetTCPConnection -LocalPort 22 -State Listen -ErrorAction SilentlyContinue
  if ($listen) { Write-Host "OK - remote login is ON for $env:USERNAME. Tell Claude: spare laptop is ready" -ForegroundColor Green }
  else { Write-Host "NOT OK - the service started but is not listening. Take a photo of this window." -ForegroundColor Red }
} catch { Write-Host "NOT OK - it stopped while $step." -ForegroundColor Red; Write-Host $_.Exception.Message -ForegroundColor Red; Write-Host "Take a photo of this window." -ForegroundColor Red }
