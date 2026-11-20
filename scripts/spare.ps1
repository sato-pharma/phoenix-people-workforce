<#
.SYNOPSIS
  Runs a PowerShell command on the spare laptop (ASUS Vivobook "Gawish", user TransferUser, 8 GB) over SSH.
  Owner, 2026-11-07: the spare laptop takes the dev server and test runs off the 16 GB main laptop.

  The command is sent base64-encoded (-EncodedCommand), so quotes, braces and $ survive the trip
  intact - a plain `ssh host '<command>'` strips the double quotes and the remote parser fails.

.EXAMPLE
  & ~/.claude/scripts/spare.ps1 'Get-Process node'
  & ~/.claude/scripts/spare.ps1 -File .\remote-job.ps1
#>
param([Parameter(Position = 0)][string]$Command, [string]$File, [int]$ConnectTimeout = 10)
$ErrorActionPreference = 'Stop'
if ($File) { $Command = Get-Content -LiteralPath $File -Raw }
if (-not $Command) { throw 'Give a command or -File.' }
$ErrorActionPreference = 'Continue'   # the remote side's stderr must not abort the caller (PS 5.1)
$b64 = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes("`$ProgressPreference='SilentlyContinue'`n" + $Command))
$key = Join-Path $env:USERPROFILE '.ssh\phoenix_spare_ed25519'
# The address is never written here (owner, 2026-11-14): the router moves the spare, and spare-address.ps1
# finds it again by its host key. When it is not found, this is the last known address and ssh fails as before.
$addr = "$(& "$PSScriptRoot\spare-address.ps1" | Select-Object -Last 1)".Trim()
$spareUser = "$(Get-Content -LiteralPath (Join-Path $PSScriptRoot 'spare-user.txt') -ErrorAction SilentlyContinue | Select-Object -First 1)".Trim(); if (-not $spareUser) { $spareUser = 'TransferUser' }   # the spare's user, written by spare-rebuild.ps1 (2026-11-20)
& "$env:SystemRoot\System32\OpenSSH\ssh.exe" -o BatchMode=yes -o ConnectTimeout=$ConnectTimeout -o LogLevel=ERROR -i $key "$spareUser@$addr" "powershell -NoProfile -NonInteractive -OutputFormat Text -ExecutionPolicy Bypass -EncodedCommand $b64"
exit $LASTEXITCODE
