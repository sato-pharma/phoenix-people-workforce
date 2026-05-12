# Phoenix Leave Management Engine staging rollout.
# This script is intentionally staging-only and fails closed before any database
# change when the staging guard variables or database safety checks are missing.

[CmdletBinding()]
param(
  [string]$RepositoryRoot = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) {
  $scriptDirectory = if (-not [string]::IsNullOrWhiteSpace($PSScriptRoot)) {
    $PSScriptRoot
  } else {
    Split-Path -Parent $MyInvocation.MyCommand.Path
  }
  $RepositoryRoot = (Resolve-Path (Join-Path $scriptDirectory "..")).Path
}

$script:StartedAt = Get-Date
$script:Checks = [System.Collections.Generic.List[object]]::new()
$script:CommandResults = [ordered]@{}
$script:Warnings = [System.Collections.Generic.List[string]]::new()
$script:FailureDetails = [System.Collections.Generic.List[object]]::new()
$script:BackupRows = @()
$script:StagingDbModified = $false
$script:MigrationExecuted = $false
$script:DatabaseUrl = $null
$script:SqlExecutor = "uninitialized"
$script:PsqlPath = $null
$script:DbmatePath = $null
$script:NodePath = $null
$script:DbmateMigrationsDir = $null
$script:NodeScriptsDir = $null
$script:DbmateMigrationTable = "phoenix_leave_staging_rollout_migrations"
$script:DbmateRunVersion = (Get-Date).ToString("yyyyMMddHHmmss")

$script:BackupSqlPath = Join-Path $RepositoryRoot "supabase\20260512_backup_leave_domain_before_rebuild.sql"
$script:MigrationSqlPath = Join-Path $RepositoryRoot "supabase\20260512_leave_management_engine.sql"
$script:ReportPath = Join-Path $RepositoryRoot "docs\leave-rollout-report.md"

$script:Warnings.Add("Staging only: never run this script with production database URLs or production credentials.") | Out-Null
$script:Warnings.Add("The leave migration drops and rebuilds old leave/vacation domain tables after the backup verification passes.") | Out-Null

function Add-Check {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][ValidateSet("PASS", "FAIL", "SKIP", "WARN")][string]$Status,
    [string]$Details = ""
  )

  $script:Checks.Add([pscustomobject]@{
    Name = $Name
    Status = $Status
    Details = $Details
    At = (Get-Date).ToString("s")
  }) | Out-Null
}

function Convert-ToReportText {
  param([AllowNull()]$Value)

  if ($null -eq $Value) {
    return ""
  }

  return ("$Value" -replace "\r?\n", " " -replace "\|", "\|").Trim()
}

function Get-OutputExcerpt {
  param([AllowNull()][string]$Text)

  if ([string]::IsNullOrWhiteSpace($Text)) {
    return ""
  }

  $normalized = $Text.Trim()
  if ($normalized.Length -le 4000) {
    return $normalized
  }

  return $normalized.Substring($normalized.Length - 4000)
}

function Add-FailureDetail {
  param(
    [Parameter(Mandatory = $true)][string]$Step,
    [Parameter(Mandatory = $true)][string]$Kind,
    [AllowNull()][object]$ExitCode,
    [AllowNull()][string]$ScriptPath,
    [AllowNull()][string]$Stdout,
    [AllowNull()][string]$Stderr,
    [AllowNull()][string]$Message
  )

  $script:FailureDetails.Add([pscustomobject]@{
    Step = $Step
    Kind = $Kind
    ExitCode = $ExitCode
    ScriptPath = $ScriptPath
    Stdout = if ($null -eq $Stdout) { "" } else { $Stdout }
    Stderr = if ($null -eq $Stderr) { "" } else { $Stderr }
    Message = if ($null -eq $Message) { "" } else { $Message }
    At = (Get-Date).ToString("s")
  }) | Out-Null
}

function Format-NodeFailureDetail {
  param(
    [Parameter(Mandatory = $true)][string]$Step,
    [Parameter(Mandatory = $true)][int]$ExitCode,
    [Parameter(Mandatory = $true)][string]$ScriptPath,
    [AllowNull()][string]$Stdout,
    [AllowNull()][string]$Stderr
  )

  return @"
Node/Postgres verification step failed.
Step: $Step
Exit code: $ExitCode
Temporary JS file: $ScriptPath

STDOUT:
$Stdout

STDERR:
$Stderr
"@
}

function Add-MarkdownCodeBlock {
  param(
    [Parameter(Mandatory = $true)][System.Collections.Generic.List[string]]$Lines,
    [AllowNull()][string]$Text
  )

  $safeText = if ([string]::IsNullOrEmpty($Text)) { "" } else { $Text -replace '```', '````' }
  $Lines.Add('````text') | Out-Null
  $Lines.Add($safeText) | Out-Null
  $Lines.Add('````') | Out-Null
}

function Get-ArrayCount {
  param([AllowNull()]$Value)

  if ($null -eq $Value) {
    return 0
  }

  if ($Value -is [array]) {
    return $Value.Count
  }

  return 1
}

function Write-RolloutReport {
  param([Parameter(Mandatory = $true)][ValidateSet("SAFE", "FAILED")][string]$FinalStatus)

  $reportDirectory = Split-Path -Parent $script:ReportPath
  if (-not (Test-Path -LiteralPath $reportDirectory)) {
    New-Item -ItemType Directory -Path $reportDirectory | Out-Null
  }

  $failedChecks = @($script:Checks | Where-Object { $_.Status -eq "FAIL" })
  $backupTableRows = @($script:BackupRows | Where-Object { $_.status -eq "backed_up" })
  $rollbackPossible = if ($backupTableRows.Count -gt 0) { "Yes, for backed-up tables listed in this report." } else { "No backup tables were created during this run." }
  $stagingDbModifiedText = if ($script:StagingDbModified) { "Yes" } else { "No" }
  $migrationStatus = if ($script:MigrationExecuted) { "Executed" } else { "Not executed" }

  $lines = [System.Collections.Generic.List[string]]::new()
  $lines.Add("# Phoenix Leave Management Staging Rollout Report") | Out-Null
  $lines.Add("") | Out-Null
  $lines.Add("- Generated at: $((Get-Date).ToString("yyyy-MM-dd HH:mm:ss zzz"))") | Out-Null
  $lines.Add("- Started at: $($script:StartedAt.ToString("yyyy-MM-dd HH:mm:ss zzz"))") | Out-Null
  $lines.Add("- Final status: $FinalStatus") | Out-Null
  $lines.Add("- Staging DB modified: $stagingDbModifiedText") | Out-Null
  $lines.Add("- Migration status: $migrationStatus") | Out-Null
  $lines.Add("- SQL executor: $($script:SqlExecutor)") | Out-Null
  $lines.Add("- Rollback possible: $rollbackPossible") | Out-Null
  $lines.Add("") | Out-Null

  $lines.Add("## Backup Results") | Out-Null
  if ($script:BackupRows.Count -eq 0) {
    $lines.Add("No backup manifest rows were captured during this run.") | Out-Null
  } else {
    $lines.Add("| Source table | Status | Backup table | Row count | Notes |") | Out-Null
    $lines.Add("| --- | --- | --- | ---: | --- |") | Out-Null
    foreach ($row in $script:BackupRows) {
      $lines.Add("| $(Convert-ToReportText $row.source_table) | $(Convert-ToReportText $row.status) | $(Convert-ToReportText $row.backup_table) | $(Convert-ToReportText $row.row_count) | $(Convert-ToReportText $row.notes) |") | Out-Null
    }
  }
  $lines.Add("") | Out-Null

  $lines.Add("## Validation Results") | Out-Null
  $lines.Add("| Check | Status | Details |") | Out-Null
  $lines.Add("| --- | --- | --- |") | Out-Null
  foreach ($check in $script:Checks) {
    $lines.Add("| $(Convert-ToReportText $check.Name) | $(Convert-ToReportText $check.Status) | $(Convert-ToReportText $check.Details) |") | Out-Null
  }
  $lines.Add("") | Out-Null

  $lines.Add("## Test Results") | Out-Null
  if ($script:CommandResults.Count -eq 0) {
    $lines.Add("App validation commands were not reached during this run.") | Out-Null
  } else {
    $lines.Add("| Command | Status | Duration seconds | Details |") | Out-Null
    $lines.Add("| --- | --- | ---: | --- |") | Out-Null
    foreach ($name in $script:CommandResults.Keys) {
      $result = $script:CommandResults[$name]
      $detail = if ($result.ExitCode -eq 0) { "exit 0" } else { Get-OutputExcerpt $result.Output }
      $lines.Add("| $(Convert-ToReportText $name) | $(Convert-ToReportText $result.Status) | $(Convert-ToReportText $result.DurationSeconds) | $(Convert-ToReportText $detail) |") | Out-Null
    }
  }
  $lines.Add("") | Out-Null

  $lines.Add("## Detailed Failures") | Out-Null
  if ($script:FailureDetails.Count -eq 0) {
    $lines.Add("- None") | Out-Null
  } else {
    foreach ($failure in $script:FailureDetails) {
      $lines.Add("### $($failure.Step)") | Out-Null
      $lines.Add("") | Out-Null
      $lines.Add("- Kind: $($failure.Kind)") | Out-Null
      $lines.Add("- Exit code: $($failure.ExitCode)") | Out-Null
      $lines.Add("- Temporary JS file: $($failure.ScriptPath)") | Out-Null
      if (-not [string]::IsNullOrWhiteSpace($failure.Message)) {
        $lines.Add("- Message: $($failure.Message)") | Out-Null
      }
      $lines.Add("") | Out-Null
      $lines.Add("Stdout:") | Out-Null
      Add-MarkdownCodeBlock -Lines $lines -Text $failure.Stdout
      $lines.Add("") | Out-Null
      $lines.Add("Stderr:") | Out-Null
      Add-MarkdownCodeBlock -Lines $lines -Text $failure.Stderr
      $lines.Add("") | Out-Null
    }
  }
  $lines.Add("") | Out-Null

  $lines.Add("## Warnings") | Out-Null
  foreach ($warning in $script:Warnings) {
    $lines.Add("- $warning") | Out-Null
  }
  if ($script:Warnings.Count -eq 0) {
    $lines.Add("- None") | Out-Null
  }
  $lines.Add("") | Out-Null

  $lines.Add("## Failed Checks") | Out-Null
  if ($failedChecks.Count -eq 0) {
    $lines.Add("- None") | Out-Null
  } else {
    foreach ($check in $failedChecks) {
      $lines.Add("- $($check.Name): $($check.Details)") | Out-Null
    }
  }
  $lines.Add("") | Out-Null

  $lines.Add("## Production Blockers") | Out-Null
  $lines.Add("- This script must never be pointed at production.") | Out-Null
  $lines.Add("- Run and review the staging report successfully before planning any production rollout.") | Out-Null
  $lines.Add("- Production needs a separate approved backup, rollout, monitoring, and rollback plan.") | Out-Null

  Set-Content -LiteralPath $script:ReportPath -Value $lines -Encoding UTF8
}

function Stop-Rollout {
  param(
    [Parameter(Mandatory = $true)][string]$CheckName,
    [Parameter(Mandatory = $true)][string]$Message
  )

  Add-Check -Name $CheckName -Status "FAIL" -Details $Message
  throw $Message
}

function Test-ProductionLikeText {
  param(
    [AllowNull()][string]$Value,
    [Parameter(Mandatory = $true)][string]$Label
  )

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return
  }

  $lower = $Value.ToLowerInvariant()
  $productionPattern = "(production|(^|[^a-z0-9])prod([^a-z0-9]|$)|(^|[^a-z0-9])prd([^a-z0-9]|$)|(^|[^a-z0-9])live([^a-z0-9]|$))"
  if ($lower -match $productionPattern) {
    Stop-Rollout -CheckName "Production URL/database guard" -Message "$Label contains production-like text. Refusing to continue."
  }
}

function Get-DatabaseNameFromConnectionString {
  param([Parameter(Mandatory = $true)][string]$ConnectionString)

  if ($ConnectionString -match "^(?i:postgres|postgresql)://") {
    try {
      $uri = [System.Uri]$ConnectionString
      $path = $uri.AbsolutePath.TrimStart("/")
      if (-not [string]::IsNullOrWhiteSpace($path)) {
        return [System.Uri]::UnescapeDataString(($path -split "\?")[0])
      }
    } catch {
      Stop-Rollout -CheckName "Staging database URL parse" -Message "PHOENIX_STAGING_DATABASE_URL is not a valid PostgreSQL URL."
    }
  }

  $match = [regex]::Match($ConnectionString, "(^|;)\s*dbname\s*=\s*([^;]+)", [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
  if ($match.Success) {
    return $match.Groups[2].Value.Trim()
  }

  return ""
}

function Assert-RequiredFile {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    Stop-Rollout -CheckName "Required file exists" -Message "Missing required file: $Path"
  }
}

function Assert-StagingEnvironment {
  $confirm = $env:PHOENIX_CONFIRM_STAGING_RLS_RUN
  $environment = $env:PHOENIX_STAGING_ENVIRONMENT
  $databaseUrl = $env:PHOENIX_STAGING_DATABASE_URL
  $guardErrors = @()

  if ($confirm -ne "YES_STAGING_ONLY") {
    $guardErrors += "PHOENIX_CONFIRM_STAGING_RLS_RUN must equal YES_STAGING_ONLY."
  }

  if ($environment -ne "staging") {
    $guardErrors += "PHOENIX_STAGING_ENVIRONMENT must equal staging."
  }

  if ([string]::IsNullOrWhiteSpace($databaseUrl)) {
    $guardErrors += "PHOENIX_STAGING_DATABASE_URL is required."
  }

  if ($guardErrors.Count -gt 0) {
    Stop-Rollout -CheckName "Staging environment guards" -Message ($guardErrors -join " ")
  }

  Test-ProductionLikeText -Value $databaseUrl -Label "PHOENIX_STAGING_DATABASE_URL"

  $databaseName = Get-DatabaseNameFromConnectionString -ConnectionString $databaseUrl
  if (-not [string]::IsNullOrWhiteSpace($databaseName)) {
    Test-ProductionLikeText -Value $databaseName -Label "Database name"
  }

  $script:DatabaseUrl = $databaseUrl
  Add-Check -Name "Staging environment guards" -Status "PASS" -Details "Required staging guard variables are present and production-like URL text was not detected."
}

function Initialize-SqlExecutor {
  $psqlCommand = Get-Command psql -ErrorAction SilentlyContinue
  if ($null -ne $psqlCommand) {
    $script:PsqlPath = $psqlCommand.Source
    $script:SqlExecutor = "psql"
    Add-Check -Name "SQL executor" -Status "PASS" -Details "psql found and will be used for SQL files and verification queries."
    return
  }

  Add-Check -Name "psql availability" -Status "WARN" -Details "psql was not found; checking dbmate fallback."
  $script:Warnings.Add("psql was not found. The runner will use dbmate for SQL file execution when dbmate is available.") | Out-Null

  $dbmateCommand = Get-Command dbmate -ErrorAction SilentlyContinue
  if ($null -eq $dbmateCommand) {
    Stop-Rollout -CheckName "dbmate availability" -Message "Neither psql nor dbmate is available. Install psql or dbmate before running the staging rollout."
  }

  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if ($null -eq $nodeCommand) {
    Stop-Rollout -CheckName "Node/Postgres verification runner" -Message "dbmate can run SQL files, but node is required for verification queries when psql is unavailable."
  }

  $script:DbmatePath = $dbmateCommand.Source
  $script:NodePath = $nodeCommand.Source
  $script:SqlExecutor = "dbmate + node-postgres verification"

  $dbmateVersionOutput = & $script:DbmatePath --version 2>&1
  $dbmateVersion = (($dbmateVersionOutput | ForEach-Object { "$_" }) -join " ").Trim()
  try {
    $preflightResult = Test-NodePostgresPreflight
  } catch {
    Stop-Rollout -CheckName "Node/Postgres verification runner" -Message $_.Exception.Message
  }

  Add-Check -Name "dbmate availability" -Status "PASS" -Details "Using dbmate fallback. $dbmateVersion"
  Add-Check -Name "Node/Postgres verification runner" -Status "PASS" -Details "node found and postgres package import/use preflight passed. Temporary JS file: $($preflightResult.ScriptPath)"
}

function Invoke-PsqlRaw {
  param(
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $output = & $script:PsqlPath @Arguments 2>&1
  $exitCode = $LASTEXITCODE
  $text = ($output | ForEach-Object { "$_" }) -join "`n"

  if ($exitCode -ne 0) {
    throw "$Label failed with exit code $exitCode.`n$(Get-OutputExcerpt $text)"
  }

  return $text
}

function Initialize-NodeScriptsDir {
  if (-not [string]::IsNullOrWhiteSpace($script:NodeScriptsDir)) {
    return
  }

  $safeRoot = Join-Path ([System.IO.Path]::GetTempPath()) "phoenix-leave-staging-rollout-node"
  if (-not (Test-Path -LiteralPath $safeRoot)) {
    New-Item -ItemType Directory -Path $safeRoot | Out-Null
  }

  $script:NodeScriptsDir = Join-Path $safeRoot $script:DbmateRunVersion
  New-Item -ItemType Directory -Path $script:NodeScriptsDir -Force | Out-Null
}

function New-NodeScriptFile {
  param(
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][string]$Source
  )

  Initialize-NodeScriptsDir

  $safeName = [regex]::Replace($Label.ToLowerInvariant(), "[^a-z0-9]+", "-").Trim("-")
  if ([string]::IsNullOrWhiteSpace($safeName)) {
    $safeName = "node-verification"
  }

  $scriptPath = Join-Path $script:NodeScriptsDir "$safeName-$([System.Guid]::NewGuid().ToString("N")).mjs"
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($scriptPath, $Source, $utf8NoBom)
  return $scriptPath
}

function Invoke-NodeScript {
  param(
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][string]$ScriptPath,
    [hashtable]$Environment = @{}
  )

  $stdoutPath = Join-Path ([System.IO.Path]::GetTempPath()) "phoenix-node-$([System.Guid]::NewGuid().ToString("N")).stdout.log"
  $stderrPath = Join-Path ([System.IO.Path]::GetTempPath()) "phoenix-node-$([System.Guid]::NewGuid().ToString("N")).stderr.log"
  $previousEnvironment = @{}

  foreach ($key in $Environment.Keys) {
    $previousEnvironment[$key] = [System.Environment]::GetEnvironmentVariable($key, "Process")
    [System.Environment]::SetEnvironmentVariable($key, [string]$Environment[$key], "Process")
  }

  try {
    Push-Location $RepositoryRoot
    try {
      & $script:NodePath $ScriptPath > $stdoutPath 2> $stderrPath
      $exitCode = $LASTEXITCODE
    } finally {
      Pop-Location
    }
  } finally {
    foreach ($key in $Environment.Keys) {
      [System.Environment]::SetEnvironmentVariable($key, $previousEnvironment[$key], "Process")
    }
  }

  $stdout = if (Test-Path -LiteralPath $stdoutPath) { Get-Content -LiteralPath $stdoutPath -Raw } else { "" }
  $stderr = if (Test-Path -LiteralPath $stderrPath) { Get-Content -LiteralPath $stderrPath -Raw } else { "" }

  if ($exitCode -ne 0) {
    $message = Format-NodeFailureDetail -Step $Label -ExitCode $exitCode -ScriptPath $ScriptPath -Stdout $stdout -Stderr $stderr
    Add-FailureDetail -Step $Label -Kind "node-postgres-verification" -ExitCode $exitCode -ScriptPath $ScriptPath -Stdout $stdout -Stderr $stderr -Message "Node verification command failed."
    throw $message
  }

  return [pscustomobject]@{
    Step = $Label
    ExitCode = $exitCode
    ScriptPath = $ScriptPath
    Stdout = $stdout
    Stderr = $stderr
  }
}

function Test-NodePostgresPreflight {
  $preflightSource = @"
const postgresModule = await import('postgres');
const postgres = postgresModule.default;

if (typeof postgres !== 'function') {
  throw new Error('postgres default export is not a function');
}

const databaseUrl = process.env.PHOENIX_ROLLOUT_DATABASE_URL;
if (!databaseUrl) {
  throw new Error('PHOENIX_ROLLOUT_DATABASE_URL is missing');
}

const sql = postgres(databaseUrl, { max: 1 });
await sql.end({ timeout: 1 });
console.log('postgres package import/use OK');
"@

  $scriptPath = New-NodeScriptFile -Label "node-postgres-preflight" -Source $preflightSource
  return Invoke-NodeScript -Label "Node/Postgres preflight" -ScriptPath $scriptPath -Environment @{
    PHOENIX_ROLLOUT_DATABASE_URL = $script:DatabaseUrl
  }
}

function Invoke-NodePostgresScalar {
  param(
    [Parameter(Mandatory = $true)][string]$Sql,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $bridge = @"
const postgresModule = await import('postgres');
const postgres = postgresModule.default;
const databaseUrl = process.env.PHOENIX_ROLLOUT_DATABASE_URL;
const query = process.env.PHOENIX_ROLLOUT_QUERY;

if (!databaseUrl || !query) {
  console.error('Missing PHOENIX_ROLLOUT_DATABASE_URL or PHOENIX_ROLLOUT_QUERY.');
  process.exit(2);
}

const sql = postgres(databaseUrl, { max: 1 });

try {
  const rows = await sql.unsafe(query);
  if (!rows.length) {
    process.exit(3);
  }

  const first = rows[0];
  const key = Object.keys(first)[0];
  const value = first[key];

  if (value === null || value === undefined) {
    console.log('');
  } else if (typeof value === 'boolean') {
    console.log(value ? 't' : 'f');
  } else if (typeof value === 'object') {
    console.log(JSON.stringify(value));
  } else {
    console.log(String(value));
  }
} finally {
  await sql.end({ timeout: 5 });
}
"@
  $scriptPath = New-NodeScriptFile -Label $Label -Source $bridge
  $result = Invoke-NodeScript -Label $Label -ScriptPath $scriptPath -Environment @{
    PHOENIX_ROLLOUT_DATABASE_URL = $script:DatabaseUrl
    PHOENIX_ROLLOUT_QUERY = $Sql
  }

  return $result.Stdout.Trim()
}

function Invoke-DatabaseScalar {
  param(
    [Parameter(Mandatory = $true)][string]$Sql,
    [Parameter(Mandatory = $true)][string]$Label
  )

  if ($script:SqlExecutor -eq "psql") {
    $arguments = @("-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", $script:DatabaseUrl, "-c", $Sql)
    return (Invoke-PsqlRaw -Arguments $arguments -Label $Label).Trim()
  }

  return Invoke-NodePostgresScalar -Sql $Sql -Label $Label
}

function Invoke-DatabaseJson {
  param(
    [Parameter(Mandatory = $true)][string]$Sql,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $raw = Invoke-DatabaseScalar -Sql $Sql -Label $Label
  if ([string]::IsNullOrWhiteSpace($raw)) {
    throw "$Label returned no JSON."
  }

  return $raw | ConvertFrom-Json
}

function Initialize-DbmateMigrationsDir {
  if (-not [string]::IsNullOrWhiteSpace($script:DbmateMigrationsDir)) {
    return
  }

  $safeRoot = Join-Path ([System.IO.Path]::GetTempPath()) "phoenix-leave-staging-rollout"
  if (-not (Test-Path -LiteralPath $safeRoot)) {
    New-Item -ItemType Directory -Path $safeRoot | Out-Null
  }

  $script:DbmateMigrationsDir = Join-Path $safeRoot $script:DbmateRunVersion
  New-Item -ItemType Directory -Path $script:DbmateMigrationsDir -Force | Out-Null
}

function New-DbmateMigrationWrapper {
  param(
    [Parameter(Mandatory = $true)][string]$SourcePath,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Ordinal
  )

  Initialize-DbmateMigrationsDir

  $sourceSql = Get-Content -LiteralPath $SourcePath -Raw
  $migrationFile = Join-Path $script:DbmateMigrationsDir "$($script:DbmateRunVersion)$($Ordinal)_$Name.sql"
  $wrappedSql = @"
-- migrate:up transaction:false

$sourceSql

-- migrate:down

select 1;
"@

  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($migrationFile, $wrappedSql, $utf8NoBom)
  return $migrationFile
}

function Invoke-DbmateUp {
  param(
    [Parameter(Mandatory = $true)][string]$Label
  )

  $previousDatabaseUrl = $env:DATABASE_URL

  try {
    $env:DATABASE_URL = $script:DatabaseUrl
    $arguments = @(
      "--migrations-dir", $script:DbmateMigrationsDir,
      "--migrations-table", $script:DbmateMigrationTable,
      "--no-dump-schema",
      "up"
    )
    $output = & $script:DbmatePath @arguments 2>&1
    $exitCode = $LASTEXITCODE
  } finally {
    if ($null -eq $previousDatabaseUrl) {
      Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
    } else {
      $env:DATABASE_URL = $previousDatabaseUrl
    }
  }

  $text = ($output | ForEach-Object { "$_" }) -join "`n"
  if ($exitCode -ne 0) {
    throw "$Label failed through dbmate with exit code $exitCode.`n$(Get-OutputExcerpt $text)"
  }

  return $text
}

function Invoke-DatabaseFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][string]$DbmateName,
    [Parameter(Mandatory = $true)][string]$DbmateOrdinal
  )

  if ($script:SqlExecutor -eq "psql") {
    $arguments = @("-X", "-v", "ON_ERROR_STOP=1", $script:DatabaseUrl, "-f", $Path)
    return Invoke-PsqlRaw -Arguments $arguments -Label $Label
  }

  New-DbmateMigrationWrapper -SourcePath $Path -Name $DbmateName -Ordinal $DbmateOrdinal | Out-Null
  return Invoke-DbmateUp -Label $Label
}

function Assert-CurrentDatabaseIsSafe {
  $databaseName = Invoke-DatabaseScalar -Sql "select current_database();" -Label "current database check"
  Test-ProductionLikeText -Value $databaseName -Label "Connected database name"
  Add-Check -Name "Connected database guard" -Status "PASS" -Details "Connected database name passed production-like guard."
}

function Assert-RequiredPrivateFunctions {
  $sql = @"
select jsonb_build_object(
  'private.phx_current_hr_id()', to_regprocedure('private.phx_current_hr_id()') is not null,
  'private.phx_current_role()', to_regprocedure('private.phx_current_role()') is not null,
  'private.phx_current_scope()', to_regprocedure('private.phx_current_scope()') is not null,
  'private.phx_can_access_employee(text)', to_regprocedure('private.phx_can_access_employee(text)') is not null
)::text;
"@

  $result = Invoke-DatabaseJson -Sql $sql -Label "required private functions check"
  $missing = @()
  foreach ($property in $result.PSObject.Properties) {
    if ($property.Value -ne $true) {
      $missing += $property.Name
    }
  }

  if ($missing.Count -gt 0) {
    Stop-Rollout -CheckName "Required private functions" -Message "Missing required private functions: $($missing -join ', ')"
  }

  Add-Check -Name "Required private functions" -Status "PASS" -Details "All required Phoenix private auth/access functions exist."
}

function Invoke-BackupAndVerify {
  $script:StagingDbModified = $true
  Invoke-DatabaseFile -Path $script:BackupSqlPath -Label "leave domain backup" -DbmateName "backup_leave_domain_before_rebuild" -DbmateOrdinal "01" | Out-Null
  Add-Check -Name "Backup SQL execution" -Status "PASS" -Details "Backup SQL completed."

  $schemaExists = Invoke-DatabaseScalar -Sql "select exists (select 1 from information_schema.schemata where schema_name = 'backup');" -Label "backup schema check"
  if ($schemaExists -ne "t") {
    Stop-Rollout -CheckName "Backup schema verification" -Message "backup schema does not exist after backup script."
  }
  Add-Check -Name "Backup schema verification" -Status "PASS" -Details "backup schema exists."

  $manifestExists = Invoke-DatabaseScalar -Sql "select to_regclass('backup.leave_domain_backup_manifest') is not null;" -Label "backup manifest check"
  if ($manifestExists -ne "t") {
    Stop-Rollout -CheckName "Backup manifest verification" -Message "backup.leave_domain_backup_manifest does not exist after backup script."
  }
  Add-Check -Name "Backup manifest verification" -Status "PASS" -Details "backup.leave_domain_backup_manifest exists."

  $sql = @"
with recent as (
  select id, source_table, backup_table, row_count, status, notes, created_at
  from backup.leave_domain_backup_manifest
  order by id desc
  limit 13
),
checked as (
  select
    *,
    case
      when status = 'skipped' then true
      when status = 'backed_up'
        and backup_table is not null
        and row_count is not null
        and to_regclass(format('backup.%I', backup_table)) is not null
        then true
      else false
    end as row_ok
  from recent
)
select jsonb_build_object(
  'manifest_rows_checked', (select count(*) from checked),
  'all_expected_rows_present', (select count(*) = 13 from checked),
  'all_rows_valid', (select coalesce(bool_and(row_ok), false) from checked),
  'backed_up_count', (select count(*) from checked where status = 'backed_up'),
  'skipped_count', (select count(*) from checked where status = 'skipped'),
  'rows', coalesce((
    select jsonb_agg(jsonb_build_object(
      'source_table', source_table,
      'backup_table', backup_table,
      'row_count', row_count,
      'status', status,
      'notes', notes,
      'created_at', created_at
    ) order by id)
    from checked
  ), '[]'::jsonb)
)::text;
"@

  $result = Invoke-DatabaseJson -Sql $sql -Label "backup manifest verification"
  $script:BackupRows = @($result.rows)

  if ($result.all_expected_rows_present -ne $true -or $result.all_rows_valid -ne $true) {
    Stop-Rollout -CheckName "Backup table verification" -Message "Backup manifest validation failed. Migration was not executed."
  }

  Add-Check -Name "Backup table verification" -Status "PASS" -Details "$($result.backed_up_count) tables backed up, $($result.skipped_count) missing tables skipped safely, row counts captured."
}

function Invoke-MigrationAndVerify {
  $script:StagingDbModified = $true
  Invoke-DatabaseFile -Path $script:MigrationSqlPath -Label "leave management migration" -DbmateName "leave_management_engine" -DbmateOrdinal "02" | Out-Null
  $script:MigrationExecuted = $true
  Add-Check -Name "Leave migration execution" -Status "PASS" -Details "Migration SQL completed."

  $requiredTablesSql = @"
with required(table_name) as (
  values
    ('leave_types'),
    ('leave_policies'),
    ('employee_leave_balances'),
    ('leave_requests'),
    ('leave_transactions'),
    ('leave_approvals'),
    ('public_holidays')
)
select jsonb_build_object(
  'missing_tables', coalesce(jsonb_agg(r.table_name) filter (where t.table_name is null), '[]'::jsonb),
  'table_count', count(t.table_name)
)
from required r
left join information_schema.tables t
  on t.table_schema = 'public'
 and t.table_name = r.table_name;
"@
  $tables = Invoke-DatabaseJson -Sql $requiredTablesSql -Label "leave table verification"
  if ((Get-ArrayCount $tables.missing_tables) -gt 0) {
    Stop-Rollout -CheckName "Leave table verification" -Message "Missing leave tables: $($tables.missing_tables -join ', ')"
  }
  Add-Check -Name "Leave table verification" -Status "PASS" -Details "All new leave tables exist."

  $rlsSql = @"
with required(table_name) as (
  values
    ('leave_types'),
    ('leave_policies'),
    ('employee_leave_balances'),
    ('leave_requests'),
    ('leave_transactions'),
    ('leave_approvals'),
    ('public_holidays')
)
select jsonb_build_object(
  'rls_disabled_tables', coalesce(jsonb_agg(r.table_name) filter (where c.relrowsecurity is not true), '[]'::jsonb),
  'checked_count', count(*)
)
from required r
join pg_class c on c.relname = r.table_name
join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public';
"@
  $rls = Invoke-DatabaseJson -Sql $rlsSql -Label "RLS verification"
  if ((Get-ArrayCount $rls.rls_disabled_tables) -gt 0) {
    Stop-Rollout -CheckName "RLS verification" -Message "RLS is disabled on: $($rls.rls_disabled_tables -join ', ')"
  }
  Add-Check -Name "RLS verification" -Status "PASS" -Details "RLS is enabled on all leave tables."

  $policySql = @"
with required(table_name) as (
  values
    ('leave_types'),
    ('leave_policies'),
    ('employee_leave_balances'),
    ('leave_requests'),
    ('leave_transactions'),
    ('leave_approvals'),
    ('public_holidays')
),
policy_counts as (
  select r.table_name, count(p.policyname) as policy_count
  from required r
  left join pg_policies p
    on p.schemaname = 'public'
   and p.tablename = r.table_name
  group by r.table_name
)
select jsonb_build_object(
  'tables_without_policies', coalesce(jsonb_agg(table_name) filter (where policy_count = 0), '[]'::jsonb),
  'total_policies', sum(policy_count)
)
from policy_counts;
"@
  $policies = Invoke-DatabaseJson -Sql $policySql -Label "policy verification"
  if ((Get-ArrayCount $policies.tables_without_policies) -gt 0) {
    Stop-Rollout -CheckName "Policy verification" -Message "No policies found on: $($policies.tables_without_policies -join ', ')"
  }
  Add-Check -Name "Policy verification" -Status "PASS" -Details "$($policies.total_policies) leave table policies found."

  $grantSql = @"
select jsonb_build_object(
  'authenticated_select_leave_requests', has_table_privilege('authenticated', 'public.leave_requests', 'select'),
  'authenticated_insert_leave_requests', has_table_privilege('authenticated', 'public.leave_requests', 'insert'),
  'authenticated_select_leave_balances', has_table_privilege('authenticated', 'public.employee_leave_balances', 'select'),
  'authenticated_select_leave_transactions', has_table_privilege('authenticated', 'public.leave_transactions', 'select'),
  'authenticated_select_leave_approvals', has_table_privilege('authenticated', 'public.leave_approvals', 'select'),
  'authenticated_select_leave_settings', has_table_privilege('authenticated', 'public.leave_types', 'select')
    and has_table_privilege('authenticated', 'public.leave_policies', 'select')
    and has_table_privilege('authenticated', 'public.public_holidays', 'select'),
  'service_role_all_leave_requests',
    has_table_privilege('service_role', 'public.leave_requests', 'select')
    and has_table_privilege('service_role', 'public.leave_requests', 'insert')
    and has_table_privilege('service_role', 'public.leave_requests', 'update')
    and has_table_privilege('service_role', 'public.leave_requests', 'delete'),
  'service_role_all_leave_settings',
    has_table_privilege('service_role', 'public.leave_types', 'select')
    and has_table_privilege('service_role', 'public.leave_types', 'insert')
    and has_table_privilege('service_role', 'public.leave_types', 'update')
    and has_table_privilege('service_role', 'public.leave_types', 'delete')
    and has_table_privilege('service_role', 'public.leave_policies', 'select')
    and has_table_privilege('service_role', 'public.leave_policies', 'insert')
    and has_table_privilege('service_role', 'public.leave_policies', 'update')
    and has_table_privilege('service_role', 'public.leave_policies', 'delete')
    and has_table_privilege('service_role', 'public.public_holidays', 'select')
    and has_table_privilege('service_role', 'public.public_holidays', 'insert')
    and has_table_privilege('service_role', 'public.public_holidays', 'update')
    and has_table_privilege('service_role', 'public.public_holidays', 'delete')
)::text;
"@
  $grants = Invoke-DatabaseJson -Sql $grantSql -Label "grant verification"
  $badGrants = @()
  foreach ($property in $grants.PSObject.Properties) {
    if ($property.Value -ne $true) {
      $badGrants += $property.Name
    }
  }
  if ($badGrants.Count -gt 0) {
    Stop-Rollout -CheckName "Grant verification" -Message "Missing expected grants: $($badGrants -join ', ')"
  }
  Add-Check -Name "Grant verification" -Status "PASS" -Details "Expected authenticated and service_role grants are present."

  $policySeedSql = @"
select jsonb_build_object(
  'exists', exists (
    select 1
    from public.leave_policies
    where name = 'Egypt Annual Leave Policy'
      and country = 'EG'
      and annual_days_first_year = 15
      and annual_days_after_first_year = 21
      and annual_days_senior = 30
      and annual_days_disability = 45
      and senior_after_years = 10
      and senior_after_age = 50
      and accrual_method = 'prorated'
      and accrual_frequency = 'monthly'
      and weekend_days = array[5, 6]
      and is_default is true
      and is_active is true
  )
)::text;
"@
  $policySeed = Invoke-DatabaseJson -Sql $policySeedSql -Label "seed leave policy verification"
  if ($policySeed.exists -ne $true) {
    Stop-Rollout -CheckName "Seed leave policy verification" -Message "Egypt Annual Leave Policy seed row was not found with expected values."
  }
  Add-Check -Name "Seed leave policy verification" -Status "PASS" -Details "Egypt Annual Leave Policy exists with expected values."

  $typeSeedSql = @"
with required(code) as (
  values
    ('annual_leave'),
    ('sick_leave'),
    ('casual_leave'),
    ('unpaid_leave'),
    ('emergency_leave'),
    ('other')
)
select jsonb_build_object(
  'missing_types', coalesce(jsonb_agg(r.code) filter (where lt.code is null), '[]'::jsonb),
  'seeded_count', count(lt.code)
)
from required r
left join public.leave_types lt on lt.code = r.code and lt.is_active is true;
"@
  $typeSeed = Invoke-DatabaseJson -Sql $typeSeedSql -Label "seed leave type verification"
  if ((Get-ArrayCount $typeSeed.missing_types) -gt 0) {
    Stop-Rollout -CheckName "Seed leave type verification" -Message "Missing seed leave types: $($typeSeed.missing_types -join ', ')"
  }
  Add-Check -Name "Seed leave type verification" -Status "PASS" -Details "$($typeSeed.seeded_count) active leave types found."

  $holidaySeedSql = @"
select jsonb_build_object(
  'active_eg_2026_count', count(*),
  'has_seed_rows', count(*) > 0
)
from public.public_holidays
where country = 'EG'
  and year = 2026
  and is_active is true;
"@
  $holidaySeed = Invoke-DatabaseJson -Sql $holidaySeedSql -Label "public holiday seed verification"
  if ($holidaySeed.has_seed_rows -ne $true) {
    Stop-Rollout -CheckName "Public holiday seed verification" -Message "No active EG 2026 public holidays were found."
  }
  Add-Check -Name "Public holiday seed verification" -Status "PASS" -Details "$($holidaySeed.active_eg_2026_count) active EG public holidays found."
}

function Invoke-AppValidation {
  Invoke-LocalCommand -Name "npm run test" -FilePath "npm" -Arguments @("run", "test")
  Invoke-LocalCommand -Name "npm run typecheck" -FilePath "npm" -Arguments @("run", "typecheck")
  Invoke-LocalCommand -Name "npm run lint" -FilePath "npm" -Arguments @("run", "lint")
  Invoke-LocalCommand -Name "npm run build" -FilePath "npm" -Arguments @("run", "build")
}

function Invoke-LocalCommand {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )

  $command = Get-Command $FilePath -ErrorAction SilentlyContinue
  if ($null -eq $command) {
    $script:CommandResults[$Name] = [pscustomobject]@{
      Status = "FAIL"
      ExitCode = -1
      DurationSeconds = 0
      Output = "$FilePath was not found."
    }
    Stop-Rollout -CheckName $Name -Message "$FilePath was not found."
  }

  $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  Push-Location $RepositoryRoot
  try {
    $output = & $command.Source @Arguments 2>&1
    $exitCode = $LASTEXITCODE
  } finally {
    Pop-Location
    $stopwatch.Stop()
  }

  $text = ($output | ForEach-Object { "$_" }) -join "`n"
  $status = if ($exitCode -eq 0) { "PASS" } else { "FAIL" }
  $script:CommandResults[$Name] = [pscustomobject]@{
    Status = $status
    ExitCode = $exitCode
    DurationSeconds = [Math]::Round($stopwatch.Elapsed.TotalSeconds, 2)
    Output = $text
  }

  Add-Check -Name $Name -Status $status -Details "exit $exitCode"
  if ($exitCode -ne 0) {
    throw "$Name failed with exit code $exitCode.`n$(Get-OutputExcerpt $text)"
  }
}

function Invoke-SmokeChecks {
  $routes = @(
    @{ Name = "/employee-portals/leave"; Path = "app\employee-portals\leave\page.tsx" },
    @{ Name = "/employee-portals/leave-approvals"; Path = "app\employee-portals\leave-approvals\page.tsx" },
    @{ Name = "/admin/leave"; Path = "app\admin\leave\page.tsx" }
  )

  foreach ($route in $routes) {
    $routePath = Join-Path $RepositoryRoot $route.Path
    if (-not (Test-Path -LiteralPath $routePath -PathType Leaf)) {
      Stop-Rollout -CheckName "Smoke route $($route.Name)" -Message "Route file missing: $($route.Path)"
    }
    Add-Check -Name "Smoke route $($route.Name)" -Status "PASS" -Details "Route file exists."
  }

  $legacyApiPath = Join-Path $RepositoryRoot "app\api\vacation"
  if (Test-Path -LiteralPath $legacyApiPath) {
    Stop-Rollout -CheckName "Legacy vacation API directory" -Message "app/api/vacation still exists."
  }
  Add-Check -Name "Legacy vacation API directory" -Status "PASS" -Details "app/api/vacation is absent."

  $searchRoots = @("app", "src", "supabase") | ForEach-Object { Join-Path $RepositoryRoot $_ } | Where-Object { Test-Path -LiteralPath $_ }
  $legacyMatches = @()
  foreach ($root in $searchRoots) {
    $legacyMatches += Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction SilentlyContinue |
      Select-String -Pattern "/api/vacation", "admin/vacation", "@/lib/vacation", "@/components/vacation" -SimpleMatch
  }

  if ($legacyMatches.Count -gt 0) {
    $sample = ($legacyMatches | Select-Object -First 10 | ForEach-Object { "$($_.Path):$($_.LineNumber)" }) -join ", "
    Stop-Rollout -CheckName "Legacy vacation references" -Message "Legacy vacation references remain: $sample"
  }
  Add-Check -Name "Legacy vacation references" -Status "PASS" -Details "No legacy vacation references found in app, src, or supabase."
}

try {
  Assert-RequiredFile -Path $script:BackupSqlPath
  Assert-RequiredFile -Path $script:MigrationSqlPath
  Add-Check -Name "Required rollout files" -Status "PASS" -Details "Backup and migration SQL files exist."

  Assert-StagingEnvironment
  Initialize-SqlExecutor
  Assert-CurrentDatabaseIsSafe
  Assert-RequiredPrivateFunctions
  Invoke-BackupAndVerify
  Invoke-MigrationAndVerify
  Invoke-SmokeChecks
  Invoke-AppValidation

  Add-Check -Name "Rollout complete" -Status "PASS" -Details "Backup, migration, verification, smoke checks, and app validation completed."
  Write-RolloutReport -FinalStatus "SAFE"
  Write-Host "Leave staging rollout completed safely. Report: $script:ReportPath"
  exit 0
} catch {
  $message = $_.Exception.Message
  if (-not ($script:Checks | Where-Object { $_.Status -eq "FAIL" })) {
    Add-Check -Name "Unhandled rollout failure" -Status "FAIL" -Details $message
  }
  Write-RolloutReport -FinalStatus "FAILED"
  Write-Error "Leave staging rollout failed safely: $message`nReport: $script:ReportPath"
  exit 1
}
