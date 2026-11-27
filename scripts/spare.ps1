<#
.SYNOPSIS
  Runs a BASH command on the spare laptop (ASUS VivoBook, Ubuntu Server 26.04 since 20 Nov 2026, user phoenix, 8 GB) over SSH.
  Owner, 2026-11-07: the spare laptop takes the dev server and test runs off the 16 GB main laptop.
  Owner, 2026-11-20: "put Ubuntu Server on the spare" - Windows is gone from it, so commands are bash now, not PowerShell.
  The Windows version is kept beside this file as spare.ps1.bak-20261120-windows.

  The command is sent base64-encoded and decoded on the spare, so quotes, braces and $ survive the trip intact.
  Layout on the spare: ~/phoenix/phoenix-workforce (the dev server's checkout, production's version), ~/phoenix/*.log,
  the dev server is the systemd service phoenix-dev; D: CHAOS is /mnt/chaos, E: /mnt/scripts, F: /mnt/2025, Sato Pharma /mnt/sato-pharma.
  The phoenix user has passwordless sudo.

.EXAMPLE
  & ~/.claude/scripts/spare.ps1 'systemctl status phoenix-dev --no-pager'
  & ~/.claude/scripts/spare.ps1 -File .\remote-job.sh
#>
param([Parameter(Position = 0)][string]$Command, [string]$File, [int]$ConnectTimeout = 10)
$ErrorActionPreference = 'Stop'
if ($File) { $Command = Get-Content -LiteralPath $File -Raw }
if (-not $Command) { throw 'Give a command or -File.' }
$ErrorActionPreference = 'Continue'   # the remote side's stderr must not abort the caller (PS 5.1)
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Command.Replace("`r`n", "`n")))
$key = Join-Path $env:USERPROFILE '.ssh\phoenix_spare_ed25519'
# The address is never written here (owner, 2026-11-14): the router moves the spare, and spare-address.ps1
# finds it again by its host key. When it is not found, this is the last known address and ssh fails as before.
$addr = "$(& "$PSScriptRoot\spare-address.ps1" | Select-Object -Last 1)".Trim()
$spareUser = "$(Get-Content -LiteralPath (Join-Path $PSScriptRoot 'spare-user.txt') -ErrorAction SilentlyContinue | Select-Object -First 1)".Trim(); if (-not $spareUser) { $spareUser = 'phoenix' }
& "$env:SystemRoot\System32\OpenSSH\ssh.exe" -o BatchMode=yes -o ConnectTimeout=$ConnectTimeout -o LogLevel=ERROR -i $key "$spareUser@$addr" "f=`$(mktemp); echo $b64 | base64 -d > `$f; bash `$f < /dev/null; c=`$?; rm -f `$f; exit `$c"   # a file, not stdin: a command that reads input must never swallow the rest of the script
exit $LASTEXITCODE
