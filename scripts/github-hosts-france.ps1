# Sends the GitHub WEBSITE (github.com) through GitHub's France entry point, with the UK as backup, instead of
# the Frankfurt one, whose route from the home line was losing packets (measured 14 Nov 2026, Cairo).
# Git itself already goes through France via ~/.gitconfig http.curloptResolve; this covers the browser.
#
# Run as Administrator (it edits the Windows hosts file). It checks itself and writes a log beside it.
#   Apply:  Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -NoExit -ExecutionPolicy Bypass -File "C:\Users\satoh\.claude\scripts\github-hosts-france.ps1"'
#   Undo:   the same, with  -Undo  added after the file path.
param(
  [switch]$Undo,
  [string]$HostsPath = "$env:WINDIR\System32\drivers\etc\hosts",
  [switch]$NoCheck
)
$ErrorActionPreference = 'Stop'
$marker  = 'phoenix-github-france'
$entries = @(
  "20.199.39.232 github.com # $marker (France)",
  "20.26.156.215 github.com # $marker (UK backup)"
)
$logPath = Join-Path $PSScriptRoot 'github-hosts-france.log'
$out = New-Object System.Collections.Generic.List[string]
function Say([string]$s) { $out.Add($s); Write-Host $s }

Say ("=== {0}  {1}  file: {2}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $(if ($Undo) { 'UNDO' } else { 'APPLY' }), $HostsPath)
try {
  $lines = @(Get-Content -LiteralPath $HostsPath)
  $kept  = @($lines | Where-Object { $_ -notmatch [regex]::Escape($marker) })
  $new   = if ($Undo) { $kept } else { $kept + $entries }

  $backup = "$HostsPath.before-$marker"
  if (-not (Test-Path -LiteralPath $backup)) { Copy-Item -LiteralPath $HostsPath -Destination $backup; Say "backup of the original: $backup" }

  $item = Get-Item -LiteralPath $HostsPath
  $wasReadOnly = $item.IsReadOnly
  if ($wasReadOnly) { $item.IsReadOnly = $false }
  try { Set-Content -LiteralPath $HostsPath -Value $new -Encoding ASCII }
  finally { if ($wasReadOnly) { (Get-Item -LiteralPath $HostsPath).IsReadOnly = $true } }

  $now = @(Get-Content -LiteralPath $HostsPath | Where-Object { $_ -match [regex]::Escape($marker) })
  Say ("hosts file written: {0} GitHub line(s) present, {1} other line(s) kept unchanged, read-only flag {2}" -f $now.Count, $kept.Count, $(if ($wasReadOnly) { 'restored' } else { 'was not set' }))
} catch {
  Say ("RESULT: FAIL - could not write the hosts file: " + $_.Exception.Message)
  Say "(It needs Administrator: accept the Windows prompt. Nothing was changed if the write itself failed.)"
  Add-Content -LiteralPath $logPath -Value $out; return
}

if ($NoCheck) { Add-Content -LiteralPath $logPath -Value $out; return }

ipconfig /flushdns | Out-Null
$ProgressPreference = 'SilentlyContinue'   # Windows PowerShell's progress bar makes Invoke-WebRequest seconds slower and the timings meaningless
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ips = @([System.Net.Dns]::GetHostAddresses('github.com') | ForEach-Object { $_.IPAddressToString })
Say ("github.com now resolves to: " + ($ips -join ', '))
$loads = foreach ($i in 1..3) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try { $r = Invoke-WebRequest -Uri 'https://github.com/' -UseBasicParsing -TimeoutSec 20; $sw.Stop(); "{0:N1}s ({1})" -f $sw.Elapsed.TotalSeconds, $r.StatusCode }
  catch { "failed after {0:N1}s: {1}" -f $sw.Elapsed.TotalSeconds, $_.Exception.Message }
}
Say ("GitHub home page, 3 loads: " + ($loads -join ' | '))

$france = $ips -contains '20.199.39.232'
$failed = @($loads | Where-Object { $_ -like 'failed*' }).Count
if ($Undo) {
  if (-not $france -and $failed -eq 0) { Say 'RESULT: PASS - the website is back on normal routing.' }
  else { Say 'RESULT: FAIL - still pointing at France, or the page did not load. Close and reopen the browser, then run the undo again.' }
} else {
  if ($france -and $failed -eq 0) { Say 'RESULT: PASS - the GitHub website now goes through France. Reopen any GitHub tab.' }
  else { Say 'RESULT: FAIL - not using France, or the page did not load. Run the same command with -Undo to put everything back.' }
}
Add-Content -LiteralPath $logPath -Value $out
