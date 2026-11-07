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
& "$env:SystemRoot\System32\OpenSSH\ssh.exe" -o BatchMode=yes -o ConnectTimeout=$ConnectTimeout -o LogLevel=ERROR -i $key TransferUser@192.168.1.60 "powershell -NoProfile -NonInteractive -OutputFormat Text -ExecutionPolicy Bypass -EncodedCommand $b64"
exit $LASTEXITCODE
