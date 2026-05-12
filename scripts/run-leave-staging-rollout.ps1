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
$script:BackupRows = @()
$script:StagingDbModified = $false
$script:MigrationExecuted = $false
$script:DatabaseUrl = $null
$script:PsqlPath = $null

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

function Initialize-Psql {
  $command = Get-Command psql -ErrorAction SilentlyContinue
  if ($null -eq $command) {
    Stop-Rollout -CheckName "psql availability" -Message "psql is required to run the staging rollout SQL files."
  }

  $script:PsqlPath = $command.Source
  Add-Check -Name "psql availability" -Status "PASS" -Details "psql found."
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

function Invoke-PsqlScalar {
  param(
    [Parameter(Mandatory = $true)][string]$Sql,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $arguments = @("-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", $script:DatabaseUrl, "-c", $Sql)
  return (Invoke-PsqlRaw -Arguments $arguments -Label $Label).Trim()
}

function Invoke-PsqlJson {
  param(
    [Parameter(Mandatory = $true)][string]$Sql,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $raw = Invoke-PsqlScalar -Sql $Sql -Label $Label
  if ([string]::IsNullOrWhiteSpace($raw)) {
    throw "$Label returned no JSON."
  }

  return $raw | ConvertFrom-Json
}

function Invoke-PsqlFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $arguments = @("-X", "-v", "ON_ERROR_STOP=1", $script:DatabaseUrl, "-f", $Path)
  return Invoke-PsqlRaw -Arguments $arguments -Label $Label
}

function Assert-CurrentDatabaseIsSafe {
  $databaseName = Invoke-PsqlScalar -Sql "select current_database();" -Label "current database check"
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

  $result = Invoke-PsqlJson -Sql $sql -Label "required private functions check"
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
  Invoke-PsqlFile -Path $script:BackupSqlPath -Label "leave domain backup" | Out-Null
  $script:StagingDbModified = $true
  Add-Check -Name "Backup SQL execution" -Status "PASS" -Details "Backup SQL completed."

  $schemaExists = Invoke-PsqlScalar -Sql "select exists (select 1 from information_schema.schemata where schema_name = 'backup');" -Label "backup schema check"
  if ($schemaExists -ne "t") {
    Stop-Rollout -CheckName "Backup schema verification" -Message "backup schema does not exist after backup script."
  }
  Add-Check -Name "Backup schema verification" -Status "PASS" -Details "backup schema exists."

  $manifestExists = Invoke-PsqlScalar -Sql "select to_regclass('backup.leave_domain_backup_manifest') is not null;" -Label "backup manifest check"
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

  $result = Invoke-PsqlJson -Sql $sql -Label "backup manifest verification"
  $script:BackupRows = @($result.rows)

  if ($result.all_expected_rows_present -ne $true -or $result.all_rows_valid -ne $true) {
    Stop-Rollout -CheckName "Backup table verification" -Message "Backup manifest validation failed. Migration was not executed."
  }

  Add-Check -Name "Backup table verification" -Status "PASS" -Details "$($result.backed_up_count) tables backed up, $($result.skipped_count) missing tables skipped safely, row counts captured."
}

function Invoke-MigrationAndVerify {
  Invoke-PsqlFile -Path $script:MigrationSqlPath -Label "leave management migration" | Out-Null
  $script:MigrationExecuted = $true
  $script:StagingDbModified = $true
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
  $tables = Invoke-PsqlJson -Sql $requiredTablesSql -Label "leave table verification"
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
  $rls = Invoke-PsqlJson -Sql $rlsSql -Label "RLS verification"
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
  $policies = Invoke-PsqlJson -Sql $policySql -Label "policy verification"
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
  $grants = Invoke-PsqlJson -Sql $grantSql -Label "grant verification"
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
  $policySeed = Invoke-PsqlJson -Sql $policySeedSql -Label "seed leave policy verification"
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
  $typeSeed = Invoke-PsqlJson -Sql $typeSeedSql -Label "seed leave type verification"
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
  $holidaySeed = Invoke-PsqlJson -Sql $holidaySeedSql -Label "public holiday seed verification"
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
  Initialize-Psql
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
