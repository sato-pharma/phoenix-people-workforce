<#
  Removes the two pre-rotation secrets from Phoenix production on Railway once their grace window has ended.

  Owner, 19 Nov 2026 (credentials audit, item 5): "fix all those automated way". The website stops accepting
  CRON_SECRET_PREVIOUS and PHOENIX_AUTH_SECRET_PREVIOUS at 22 Nov 2026 00:00 Cairo (PREVIOUS_SECRET_ACCEPTED_UNTIL in
  src/lib/auth/previous-secret.ts); after that they are dead values, and docs/security/secret-rotation.md says to
  delete them. Scheduled task "Phoenix Retire Old Rotation Secrets" runs this daily at 00:15 from 22 Nov (and as soon
  as the laptop wakes if it was off), and unregisters itself once both are gone from both services.

  Prints and logs NO value: `railway variable list --json` is parsed in memory for key names only.
  -DryRun lists what it would delete and changes nothing.
#>
param([switch]$DryRun)

$ErrorActionPreference = 'Continue'
$log = Join-Path $PSScriptRoot 'retire-previous-secrets.log'
$taskName = 'Phoenix Retire Old Rotation Secrets'
function Write-Log([string]$m) {
  $cairo = [DateTimeOffset]::UtcNow.ToOffset([TimeSpan]::FromHours(2)).ToString('yyyy-MM-dd HH:mm')
  $line = "$cairo Cairo  $m"
  Add-Content -Path $log -Value $line -Encoding utf8
  Write-Output $line
}

$until = [DateTimeOffset]::Parse('2026-11-22T00:00:00+02:00')
if (-not $DryRun -and [DateTimeOffset]::UtcNow -lt $until) { Write-Log 'too early (the grace window ends 22 Nov 00:00 Cairo) - nothing done'; exit 0 }

Set-Location 'F:\Phoenix Workforce\phoenix-workforce'   # the folder linked to the Railway project
$names = @('CRON_SECRET_PREVIOUS', 'PHOENIX_AUTH_SECRET_PREVIOUS')
$services = @('phoenix-people-workforce', 'phoenix-workforce-worker')

function Get-VariableNames([string]$svc) {
  $raw = (& railway variable list --service $svc --environment production --json 2>$null) | Out-String
  if (-not $raw.Trim()) { return $null }
  try { return @(($raw | ConvertFrom-Json).PSObject.Properties.Name) } catch { return $null }
}

$allGone = $true
foreach ($svc in $services) {
  $keys = Get-VariableNames $svc
  if ($null -eq $keys) { Write-Log "${svc}: could not read its variables (Railway sign-in or network) - will retry"; $allGone = $false; continue }
  foreach ($n in $names) {
    if ($keys -contains $n) {
      if ($DryRun) { Write-Log "${svc}: would delete $n"; $allGone = $false; continue }
      & railway variable delete $n --service $svc --environment production --json *> $null
      Write-Log "${svc}: delete $n (exit $LASTEXITCODE)"
    } else { Write-Log "${svc}: $n is not there" }
  }
  if (-not $DryRun) {
    $after = Get-VariableNames $svc
    foreach ($n in $names) { if ($null -eq $after -or $after -contains $n) { $allGone = $false; Write-Log "${svc}: $n STILL PRESENT - will retry" } }
  }
}

if ($DryRun) { Write-Log 'dry run - nothing changed'; exit 0 }
if ($allGone) {
  Write-Log 'DONE: both old secrets are gone from production (website and worker)'
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Log "scheduled task '$taskName' removed"
} else {
  Write-Log 'NOT DONE: the task stays and tries again tomorrow at 00:15'
}
