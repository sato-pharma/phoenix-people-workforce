import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import postgres from "postgres";

type CheckResult = {
  detail?: string;
  name: string;
  ok: boolean;
  phase: string;
};

type SafetyInfo = {
  criticalConfiguredCount: number;
  databaseUrlPresent: boolean;
  enterpriseConfiguredCount: number;
  environment: string;
  supabaseHost: string;
};

type LocalEnvLoadInfo = {
  loadedKeys: number;
  path: string;
  skippedExistingKeys: number;
  status: "found" | "not_found";
};

const migrationPath = "supabase/scripts/20260511_phoenix_role_alignment.sql";
const harnessPath = "tests/scripts/phoenix-staging-rls-harness.ts";
const runnerPath = "tests/scripts/phoenix-staging-role-alignment-runner.ts";
const localEnvPath = ".env.staging.rls.local";
const blockedProductionRef = "ozucdzovmcqvepbozvqf";
const mutationsEnabled = process.argv.includes("--mutations");
if (process.argv.includes("--local") && !process.env.PHOENIX_STAGING_ENVIRONMENT) {
  process.env.PHOENIX_STAGING_ENVIRONMENT = "local";
}
const localEnvLoadInfo = loadLocalEnvFile(localEnvPath);
const dryRunEnabled = process.env.PHOENIX_RLS_DRY_RUN === "1" || process.argv.includes("--dry-run");

const criticalSmokeRoles = [
  "Employee",
  "Medical Rep",
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
  "Finance Manager",
  "HR Advisory",
  "HR Operations",
  "CEO",
  "Super Admin",
];

const enterpriseRoles = [
  "Employee",
  "Medical Rep",
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
  "SFE Manager",
  "Training Manager",
  "Marketing Manager",
  "Finance Manager",
  "HR Advisory",
  "HR Operations",
  "Manager",
  "CEO",
  "Super Admin",
];

const expectedHelpers = [
  "current_phoenix_role",
  "current_access_scope",
  "current_access_is_super_admin",
  "current_access_is_hr",
  "current_access_is_finance",
  "current_access_is_company_reader",
  "current_access_can_manage_employees",
  "current_access_can_manage_payroll",
];

function result(phase: string, name: string, ok: boolean, detail?: string): CheckResult {
  return { detail, name, ok, phase };
}

function unquoteEnvValue(value: string) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function loadLocalEnvFile(path: string): LocalEnvLoadInfo {
  if (!existsSync(path)) {
    return {
      loadedKeys: 0,
      path,
      skippedExistingKeys: 0,
      status: "not_found",
    };
  }

  const source = readFileSync(path, "utf8");
  let loadedKeys = 0;
  let skippedExistingKeys = 0;

  for (const rawLine of source.split(/\r?\n/g)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) continue;

    const key = line.slice(0, separatorIndex).trim();
    const value = unquoteEnvValue(line.slice(separatorIndex + 1));
    if (!/^[A-Z0-9_]+$/.test(key)) continue;

    if (Object.prototype.hasOwnProperty.call(process.env, key)) {
      skippedExistingKeys += 1;
      continue;
    }

    process.env[key] = value;
    loadedKeys += 1;
  }

  return {
    loadedKeys,
    path,
    skippedExistingKeys,
    status: "found",
  };
}

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

// This is the allowlist gate, so it carries no baked-in default. It used to fall back to the
// retired oaifhavixhdtwmseshff sandbox, which is no longer on the Supabase account: a missing
// setting therefore surfaced further down as a confusing "not the approved sandbox" refusal
// against a ref nobody recognises, instead of naming the actual problem here.
function approvedStagingRef() {
  const ref = process.env.PHOENIX_APPROVED_STAGING_REF?.trim();
  if (!ref) {
    throw new Error(
      "PHOENIX_APPROVED_STAGING_REF is required. Set it to the approved staging project ref in .env.staging.rls.local.",
    );
  }
  return ref;
}

function validTestUser(users: Record<string, unknown>, role: string) {
  const item = users[role] as { hrId?: string; loginId?: string; password?: string } | undefined;
  return Boolean(item?.hrId && item.loginId && item.password);
}

function assertStagingSafety(): SafetyInfo {
  const confirm = requiredEnv("PHOENIX_CONFIRM_STAGING_RLS_RUN");
  if (confirm !== "YES_STAGING_ONLY") {
    throw new Error('PHOENIX_CONFIRM_STAGING_RLS_RUN must be exactly "YES_STAGING_ONLY".');
  }

  const environment = requiredEnv("PHOENIX_STAGING_ENVIRONMENT").toLowerCase();
  if (environment === "production" || environment === "prod" || environment.includes("production")) {
    throw new Error(`Refusing to run because PHOENIX_STAGING_ENVIRONMENT="${environment}" looks like production.`);
  }
  if (!/(local|staging|stage|preview|dev|test|branch)/i.test(environment)) {
    throw new Error("PHOENIX_STAGING_ENVIRONMENT must clearly identify a non-production environment.");
  }

  const supabaseUrl = requiredEnv("PHOENIX_STAGING_SUPABASE_URL");
  const hostname = new URL(supabaseUrl).hostname.toLowerCase();
  if (/(^|[-.])prod(uction)?([-.]|$)/i.test(supabaseUrl) || hostname.includes("production")) {
    throw new Error(`Refusing to run because PHOENIX_STAGING_SUPABASE_URL="${supabaseUrl}" looks like production.`);
  }
  if (supabaseUrl.includes(blockedProductionRef) || hostname.includes(blockedProductionRef)) {
    throw new Error("Refusing Phoenix HR production project ref.");
  }
  const approvedRef = approvedStagingRef();
  if (hostname !== `${approvedRef}.supabase.co`) {
    throw new Error("Refusing any Supabase URL except the approved Phoenix RLS testing sandbox.");
  }
  requiredEnv("PHOENIX_STAGING_SUPABASE_ANON_KEY");
  const databaseUrl = requiredEnv("PHOENIX_STAGING_DATABASE_URL");
  const databaseHostname = new URL(databaseUrl).hostname.toLowerCase();
  if (databaseUrl.includes(blockedProductionRef) || databaseHostname.includes(blockedProductionRef)) {
    throw new Error("Refusing Phoenix HR production database URL.");
  }
  const isApprovedDirectHost = databaseHostname === `db.${approvedRef}.supabase.co`;
  const isApprovedPoolerHost =
    databaseHostname.endsWith(".pooler.supabase.com") && databaseUrl.includes(`postgres.${approvedRef}`);
  if (!isApprovedDirectHost && !isApprovedPoolerHost) {
    throw new Error("Refusing database URL that does not target the approved Phoenix RLS testing sandbox.");
  }
  requiredEnv("PHOENIX_RLS_TEST_USERS_JSON");

  const users = JSON.parse(requiredEnv("PHOENIX_RLS_TEST_USERS_JSON")) as Record<string, unknown>;
  const missing = criticalSmokeRoles.filter((role) => !validTestUser(users, role));
  if (missing.length) {
    throw new Error(`PHOENIX_RLS_TEST_USERS_JSON is missing required roles: ${missing.join(", ")}`);
  }

  return {
    criticalConfiguredCount: criticalSmokeRoles.filter((role) => validTestUser(users, role)).length,
    databaseUrlPresent: Boolean(databaseUrl),
    enterpriseConfiguredCount: enterpriseRoles.filter((role) => validTestUser(users, role)).length,
    environment,
    supabaseHost: hostname,
  };
}

function createAdminSql() {
  return postgres(requiredEnv("PHOENIX_STAGING_DATABASE_URL"), {
    idle_timeout: 20,
    max: 1,
    ssl: "require",
  });
}

async function runStep(results: CheckResult[], phase: string, name: string, execute: () => Promise<string | void>) {
  try {
    const detail = await execute();
    results.push(result(phase, name, true, detail ?? undefined));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push(result(phase, name, false, detail));
  }
}

async function backup(sql: postgres.Sql) {
  await sql`
    create table if not exists public._backup_20260511_runner_user_access_profiles_role_alignment as
    select
      now() as backed_up_at,
      to_jsonb(uap) as row_data
    from public.user_access_profiles uap
  `;

  await sql`
    create table if not exists public._backup_20260511_runner_app_auth_users_role_alignment as
    select
      now() as backed_up_at,
      to_jsonb(aau) as row_data
    from public.app_auth_users aau
  `;

  await sql`
    create table if not exists public._backup_20260511_runner_rls_policies_role_alignment as
    select
      now() as backed_up_at,
      schemaname,
      tablename,
      policyname,
      permissive,
      roles,
      cmd,
      qual,
      with_check
    from pg_policies
    where schemaname = 'public'
      and tablename in (
        'user_access_profiles',
        'employees',
        'employee_compensation',
        'salary_records',
        'salary_batches',
        'salary_flags',
        'outstation_expenses',
        'outstation_expense_reports',
        'sales_records'
      )
  `;

  await sql`
    create table if not exists public._backup_20260511_runner_helper_functions_role_alignment as
    select
      now() as backed_up_at,
      n.nspname as schema_name,
      p.proname as function_name,
      pg_get_function_identity_arguments(p.oid) as arguments,
      pg_get_functiondef(p.oid) as function_definition
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and (p.proname like 'current_access_%' or p.proname = 'current_phoenix_role')
  `;
}

async function applyMigration(sql: postgres.Sql) {
  const migration = await readFile(migrationPath, "utf8");
  await sql.unsafe(migration);
}

function requireText(text: string, label: string, patterns: string[]) {
  const missing = patterns.filter((pattern) => !text.includes(pattern));
  if (missing.length) throw new Error(`${label} missing: ${missing.join(", ")}`);
}

async function dryRunInspectMigration() {
  const buffer = await readFile(migrationPath);
  const text = buffer.toString("utf8");
  const hash = createHash("sha256").update(buffer).digest("hex");

  // Substring assertions against the 2026-05-11 migration FILE, not live schema. That file
  // predates the 2026-07-13 payroll_expenses -> outstation_expenses rename
  // (20260713120000_rename_payroll_expenses_to_outstation.sql) and still contains that text
  // verbatim, so the two payroll_expense* entries below are CORRECT and must keep the old
  // name. The live-database checks that needed the rename (backup(), validateDangerousPolicies's
  // uncorrelatedExpenses/scopedWrites, and dryRunLocateHarness's harness-content check below) were
  // fixed separately — see the payroll_expenses -> outstation_expenses cleanup PRs.
  const sections: Array<[string, string[]]> = [
    ["phoenix_role column handling", ["add column if not exists phoenix_role", "user_access_profiles_phoenix_role_check"]],
    ["scope_type column handling", ["add column if not exists scope_type", "user_access_profiles_scope_type_check"]],
    ["current_phoenix_role()", ["create or replace function public.current_phoenix_role()"]],
    ["current_access_scope()", ["create or replace function public.current_access_scope()"]],
    ["current_access_is_super_admin()", ["create or replace function public.current_access_is_super_admin()"]],
    ["current_access_is_hr()", ["create or replace function public.current_access_is_hr()"]],
    ["current_access_is_finance()", ["create or replace function public.current_access_is_finance()"]],
    ["current_access_is_company_reader()", ["create or replace function public.current_access_is_company_reader()"]],
    ["current_access_can_manage_employees()", ["create or replace function public.current_access_can_manage_employees()"]],
    ["current_access_can_manage_payroll()", ["create or replace function public.current_access_can_manage_payroll()"]],
    ["grants to authenticated/service_role", ["grant execute on function public.current_phoenix_role() to authenticated, service_role", "grant execute on function public.current_access_can_manage_payroll() to authenticated, service_role"]],
    ["anon/public revoke protection", ["revoke all on function public.current_phoenix_role() from public, anon", "revoke all on function public.current_access_can_manage_payroll() from public, anon"]],
    ["salary_batches_select_access", ["create policy salary_batches_select_access", "where sr.batch_id = salary_batches.id", "public.current_access_can_see_employee(e.hr_id, e.manager_hr_id)"]],
    ["payroll_expense_reports_select_access", ["create policy payroll_expense_reports_select_access", "where pe.report_id = payroll_expense_reports.id", "public.current_access_can_see_employee(e.hr_id, e.manager_hr_id)"]],
    ["payroll_expenses write restrictions", ["create policy payroll_expenses_scoped_update", "using (public.current_access_can_manage_payroll())", "create policy payroll_expenses_scoped_delete"]],
    ["employees master-table write restrictions", ["create policy employees_insert_hr", "create policy employees_update_hr", "with check (public.current_access_can_manage_employees())"]],
  ];

  for (const [label, patterns] of sections) {
    requireText(text, label, patterns);
  }

  return `path=${migrationPath}; size=${buffer.byteLength} bytes; sha256=${hash}`;
}

async function dryRunInspectRunner() {
  const runner = await readFile(runnerPath, "utf8");
  requireText(runner, "backup SQL sections", [
    "_backup_20260511_runner_user_access_profiles_role_alignment",
    "_backup_20260511_runner_rls_policies_role_alignment",
    "_backup_20260511_runner_helper_functions_role_alignment",
  ]);
  requireText(runner, "dangerous policy detector SQL sections", [
    "legacy admin role policy",
    "possibly uncorrelated salary policy",
    "possibly uncorrelated expense policy",
    "scoped payroll write policy",
  ]);
}

async function dryRunLocateHarness() {
  const harness = await readFile(harnessPath, "utf8");
  requireText(harness, "authenticated RLS harness", [
    "signInWithPassword",
    "current_phoenix_role",
    "outstation_expenses",
    "user_access_profiles",
  ]);
  return harnessPath;
}

async function validateSchema(sql: postgres.Sql) {
  const columns = await sql<{ column_name: string }[]>`
    select column_name
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'user_access_profiles'
      and column_name in ('phoenix_role', 'scope_type')
  `;
  const columnNames = new Set(columns.map((row) => row.column_name));
  for (const column of ["phoenix_role", "scope_type"]) {
    if (!columnNames.has(column)) throw new Error(`${column} column is missing.`);
  }

  const constraints = await sql<{ definition: string }[]>`
    select pg_get_constraintdef(oid) as definition
    from pg_constraint
    where conrelid = 'public.user_access_profiles'::regclass
      and conname = 'user_access_profiles_role_check'
  `;
  const definition = constraints[0]?.definition ?? "";
  for (const role of ["employee", "manager", "hr", "finance", "company_reader", "super_admin", "admin"]) {
    if (!definition.includes(role)) throw new Error(`role constraint does not include ${role}.`);
  }
}

async function validateHelpers(sql: postgres.Sql) {
  const helpers = await sql<{ proname: string; security_definer: boolean }[]>`
    select
      p.proname,
      p.prosecdef as security_definer
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ${sql(expectedHelpers)}
  `;
  const found = new Set(helpers.map((helper) => helper.proname));
  const missing = expectedHelpers.filter((helper) => !found.has(helper));
  if (missing.length) throw new Error(`missing helpers: ${missing.join(", ")}`);
  const notSecurityDefiner = helpers.filter((helper) => !helper.security_definer).map((helper) => helper.proname);
  if (notSecurityDefiner.length) throw new Error(`helpers are not security definer: ${notSecurityDefiner.join(", ")}`);
}

async function validateGrants(sql: postgres.Sql) {
  const rows = await sql<{ anon_can_execute: boolean; authenticated_can_execute: boolean; proname: string; service_role_can_execute: boolean }[]>`
    select
      p.proname,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_can_execute,
      has_function_privilege('anon', p.oid, 'EXECUTE') as anon_can_execute,
      has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role_can_execute
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ${sql(expectedHelpers)}
  `;

  const failures = rows.flatMap((row) => {
    const items: string[] = [];
    if (!row.authenticated_can_execute) items.push(`${row.proname}: authenticated missing EXECUTE`);
    if (!row.service_role_can_execute) items.push(`${row.proname}: service_role missing EXECUTE`);
    if (row.anon_can_execute) items.push(`${row.proname}: anon unexpectedly has EXECUTE`);
    return items;
  });
  if (failures.length) throw new Error(failures.join("; "));
}

async function validateRoleMapping(sql: postgres.Sql) {
  const mismatches = await sql`
    select
      login_id,
      phoenix_role,
      role as actual_role,
      scope_type as actual_scope
    from public.user_access_profiles
    where role is distinct from case phoenix_role
        when 'Super Admin' then 'super_admin'
        when 'CEO' then 'company_reader'
        when 'SFE Manager' then 'company_reader'
        when 'Finance Manager' then 'finance'
        when 'HR Advisory' then 'hr'
        when 'HR Operations' then 'hr'
        when 'District Manager' then 'manager'
        when 'Regional Manager' then 'manager'
        when 'National Sales Manager' then 'manager'
        when 'Product Manager' then 'manager'
        when 'Group Product Manager' then 'manager'
        when 'Training Manager' then 'manager'
        when 'Marketing Manager' then 'manager'
        when 'Manager' then 'manager'
        else 'employee'
      end
      or scope_type is distinct from case phoenix_role
        when 'Super Admin' then 'SUPER_ADMIN'
        when 'CEO' then 'COMPANY_READ'
        when 'SFE Manager' then 'COMPANY_READ'
        when 'Finance Manager' then 'FINANCE'
        when 'HR Advisory' then 'HR'
        when 'HR Operations' then 'HR'
        when 'District Manager' then 'TEAM'
        when 'Manager' then 'TEAM'
        when 'Regional Manager' then 'HIERARCHY'
        when 'National Sales Manager' then 'LINE'
        when 'Product Manager' then 'LINE'
        when 'Group Product Manager' then 'LINE'
        when 'Training Manager' then 'LINE'
        when 'Marketing Manager' then 'LINE'
        else 'SELF'
      end
  `;
  if (mismatches.length) throw new Error(`role mapping mismatches: ${JSON.stringify(mismatches.slice(0, 10))}`);
}

async function validateDangerousPolicies(sql: postgres.Sql) {
  const adminPolicies = await sql`
    select schemaname, tablename, policyname, qual, with_check
    from pg_policies
    where schemaname = 'public'
      and (
        qual ilike '%current_access_role()%admin%'
        or with_check ilike '%current_access_role()%admin%'
        or qual ilike '%current_access_role() = ''admin''%'
        or with_check ilike '%current_access_role() = ''admin''%'
      )
  `;

  const uncorrelatedSalary = await sql`
    select schemaname, tablename, policyname, qual, with_check
    from pg_policies
    where schemaname = 'public'
      and (
        qual ilike '%exists%salary_records%'
        or with_check ilike '%exists%salary_records%'
      )
      and coalesce(qual, '') || coalesce(with_check, '') not ilike '%salary_records%hr_id%'
      and coalesce(qual, '') || coalesce(with_check, '') not ilike '%sr.hr_id%'
  `;

  const uncorrelatedExpenses = await sql`
    select schemaname, tablename, policyname, qual, with_check
    from pg_policies
    where schemaname = 'public'
      and (
        qual ilike '%exists%outstation_expenses%'
        or with_check ilike '%exists%outstation_expenses%'
      )
      and coalesce(qual, '') || coalesce(with_check, '') not ilike '%outstation_expenses%hr_id%'
      and coalesce(qual, '') || coalesce(with_check, '') not ilike '%pe.hr_id%'
  `;

  const scopedWrites = await sql`
    select schemaname, tablename, policyname, cmd, qual, with_check
    from pg_policies
    where schemaname = 'public'
      and tablename in (
        'outstation_expenses',
        'outstation_expense_reports',
        'salary_records',
        'salary_batches',
        'salary_flags',
        'employee_compensation'
      )
      and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
      and (
        qual ilike '%TEAM%'
        or qual ilike '%HIERARCHY%'
        or qual ilike '%LINE%'
        or with_check ilike '%TEAM%'
        or with_check ilike '%HIERARCHY%'
        or with_check ilike '%LINE%'
      )
  `;

  const failures = [
    ...adminPolicies.map((row) => `legacy admin role policy: ${row.tablename}.${row.policyname}`),
    ...uncorrelatedSalary.map((row) => `possibly uncorrelated salary policy: ${row.tablename}.${row.policyname}`),
    ...uncorrelatedExpenses.map((row) => `possibly uncorrelated expense policy: ${row.tablename}.${row.policyname}`),
    ...scopedWrites.map((row) => `scoped payroll write policy: ${row.tablename}.${row.policyname}`),
  ];
  if (failures.length) throw new Error(failures.join("; "));
}

async function runHarness() {
  const previousMutationEnv = process.env.PHOENIX_RLS_ALLOW_STAGING_MUTATIONS;
  const previousExitCode = process.exitCode;
  const output: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;

  process.env.PHOENIX_RLS_ALLOW_STAGING_MUTATIONS = mutationsEnabled ? "1" : previousMutationEnv ?? "";
  process.exitCode = undefined;
  console.log = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    output.push(line);
    originalLog(...args);
  };
  console.error = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    output.push(line);
    originalError(...args);
  };

  try {
    const harnessUrl = `${pathToFileURL(resolve(harnessPath)).href}?run=${Date.now()}`;
    await import(harnessUrl);
    if (process.exitCode && process.exitCode !== 0) {
      throw new Error(`authenticated RLS harness exited with code ${process.exitCode}`);
    }
    return output.join("\n").trim();
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exitCode = previousExitCode;
    if (previousMutationEnv === undefined) {
      delete process.env.PHOENIX_RLS_ALLOW_STAGING_MUTATIONS;
    } else {
      process.env.PHOENIX_RLS_ALLOW_STAGING_MUTATIONS = previousMutationEnv;
    }
  }
}

function printReport(results: CheckResult[]) {
  console.log(`\nPhoenix role alignment staging validation report${dryRunEnabled ? " (DRY RUN)" : ""}`);
  console.log("================================================");
  for (const item of results) {
    const status = item.ok ? "PASS" : "FAIL";
    const detail = item.detail ? ` - ${item.detail}` : "";
    console.log(`${status} ${item.phase}: ${item.name}${detail}`);
  }

  const failed = results.filter((item) => !item.ok).length;
  const passed = results.length - failed;
  console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
  if (dryRunEnabled) {
    console.log(failed > 0 ? "Final: DRY RUN FAIL" : "Final: DRY RUN PASS");
  }
  if (failed > 0) process.exitCode = 1;
}

async function main() {
  const results: CheckResult[] = [];
  let sql: postgres.Sql | null = null;
  let safetyInfo: SafetyInfo | null = null;

  if (dryRunEnabled) {
    console.log("DRY RUN MODE enabled");
    console.log("No database connection will be opened.");
    console.log("No migration, backup, authenticated harness, or mutation probe will run.");
  }

  await runStep(results, "Phase 0", "local staging env file lookup", async () => {
    if (localEnvLoadInfo.status === "not_found") {
      return `${localEnvLoadInfo.path} not found; using process environment only`;
    }
    return `${localEnvLoadInfo.path} found; loaded ${localEnvLoadInfo.loadedKeys} keys; kept ${localEnvLoadInfo.skippedExistingKeys} existing process env values`;
  });

  await runStep(results, "Phase 0", "staging safety and environment checks", async () => {
    safetyInfo = assertStagingSafety();
    return `safety gate PASS; host=${safetyInfo.supabaseHost}; environment=${safetyInfo.environment}; database URL present but not used in dry-run=${dryRunEnabled && safetyInfo.databaseUrlPresent}; mutations=${mutationsEnabled ? "enabled" : "disabled"}`;
  });

  if (results.some((item) => !item.ok)) {
    printReport(results);
    return;
  }

  if (dryRunEnabled) {
    await runStep(results, "Dry Run", "detected Supabase URL host", async () => safetyInfo?.supabaseHost ?? "unknown");
    await runStep(results, "Dry Run", "database URL presence", async () => {
      if (!safetyInfo?.databaseUrlPresent) throw new Error("database URL missing");
      return "present but not used";
    });
    await runStep(results, "Dry Run", "critical smoke users configured count", async () => `${safetyInfo?.criticalConfiguredCount ?? 0}/${criticalSmokeRoles.length}`);
    await runStep(results, "Dry Run", "full enterprise users configured count", async () => `${safetyInfo?.enterpriseConfiguredCount ?? 0}/${enterpriseRoles.length}`);
    await runStep(results, "Dry Run", "mutation mode status", async () => mutationsEnabled || process.env.PHOENIX_RLS_ALLOW_STAGING_MUTATIONS === "1" ? "enabled" : "disabled");
    await runStep(results, "Dry Run", "migration file static inspection", dryRunInspectMigration);
    await runStep(results, "Dry Run", "runner backup and dangerous policy sections", dryRunInspectRunner);
    await runStep(results, "Dry Run", "authenticated harness file location", dryRunLocateHarness);
    printReport(results);
    return;
  }

  try {
    sql = createAdminSql();

    await runStep(results, "Phase 0", "admin database connection", async () => {
      await sql!`select 1`;
    });
    await runStep(results, "Phase 0", "backup current role/RLS state", async () => {
      await backup(sql!);
    });
    await runStep(results, "Phase 1", `apply ${migrationPath}`, async () => {
      await applyMigration(sql!);
    });
    await runStep(results, "Phase 2", "schema validation", async () => {
      await validateSchema(sql!);
    });
    await runStep(results, "Phase 2", "helper function validation", async () => {
      await validateHelpers(sql!);
    });
    await runStep(results, "Phase 2", "function grant validation", async () => {
      await validateGrants(sql!);
    });
    await runStep(results, "Phase 3", "role mapping mismatch detection", async () => {
      await validateRoleMapping(sql!);
    });
    await runStep(results, "Phase 4", "dangerous policy detectors", async () => {
      await validateDangerousPolicies(sql!);
    });
    await runStep(results, "Phase 4", "authenticated RLS harness", async () => {
      await runHarness();
    });
  } finally {
    if (sql) await sql.end({ timeout: 5 });
  }

  printReport(results);
}

await main();
