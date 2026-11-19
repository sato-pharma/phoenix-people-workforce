<#
  Runs spare-db-password-refresh.mjs, and removes its own scheduled task once the spare's .env.local holds the
  current production database password and is proven to log in (owner, 19 Nov 2026: "fix the spare laptop's
  database password"). Task "Phoenix Spare Database Password Refresh" runs this every 10 minutes; while the spare
  is off the network it logs one line and tries again. Log: ~/.claude/logs/spare-db-password-refresh.log
#>
$taskName = 'Phoenix Spare Database Password Refresh'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
& $node (Join-Path $PSScriptRoot 'spare-db-password-refresh.mjs') | Out-Null
if ($LASTEXITCODE -eq 0) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  $cairo = [DateTimeOffset]::UtcNow.ToOffset([TimeSpan]::FromHours(2)).ToString('yyyy-MM-dd HH:mm')
  Add-Content -Path (Join-Path $env:USERPROFILE '.claude\logs\spare-db-password-refresh.log') -Value "$cairo Cairo  scheduled task '$taskName' removed" -Encoding utf8
}
exit $LASTEXITCODE
