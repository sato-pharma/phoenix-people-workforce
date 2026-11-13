import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import postgres from "postgres";

type Finding = {
  detail: string;
  level: "BLOCKER" | "INFO" | "WARNING";
  name: string;
};

const productionRef = "ozucdzovmcqvepbozvqf";
const sandboxRef = "oaifhavixhdtwmseshff";
const migrationPath = "supabase/scripts/20260511_phoenix_role_alignment.sql";
const readinessReportPath = "docs/security/role-alignment-production-readiness.md";
const localEnvPath = ".env.production.rls.local";

const canonicalRoles = [
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

const affectedTables = [
  "app_auth_users",
  "user_access_profiles",
  "employees",
  "employee_compensation",
  "salary_records",
  "salary_batches",
  "salary_flags",
  "outstation_expenses",
  "outstation_expense_reports",
  "sales_records",
];

const protectedMutationTables = [
  "employees",
  "user_access_profiles",
  "outstation_expenses",
  "outstation_expense_reports",
  "salary_records",
  "salary_batches",
  "salary_flags",
  "employee_compensation",
  "sales_records",
];

const phoenixOwnedTables = [
  ...new Set([
    ...affectedTables,
    "employee_probation",
    "probation_evaluations",
    "probation_history",
    "employee_contracts",
    "contract_renewal_requests",
    "contract_renewal_history",
    "email_notification_policies",
    "notification_outbox",
    "coaching_reports",
    "coaching_score_items",
    "coaching_report_acknowledgments",
    "coaching_report_audit_logs",
  ]),
];

const expectedHelpers = [
  "current_access_hr_id",
  "current_access_role",
  "current_access_scope",
  "current_access_line",
  "current_access_manager_hr_id",
  "current_access_is_super_admin",
  "current_access_is_admin",
  "current_access_is_hr",
  "current_access_is_finance",
  "current_access_is_company_reader",
  "current_access_can_manage_employees",
  "current_access_can_manage_payroll",
  "current_access_can_see_employee",
  "current_phoenix_role",
];

const authenticatedSecurityDefinerExceptions = new Set([
  ...expectedHelpers,
]);

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

function loadLocalEnvFile(path: string) {
  if (!existsSync(path)) return { loaded: 0, skipped: 0, status: "not_found" as const };
  let loaded = 0;
  let skipped = 0;

  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/g)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) continue;
    const key = line.slice(0, separatorIndex).trim();
    const value = unquoteEnvValue(line.slice(separatorIndex + 1));
    if (!/^[A-Z0-9_]+$/.test(key)) continue;
    if (Object.prototype.hasOwnProperty.call(process.env, key)) {
      skipped += 1;
      continue;
    }
    process.env[key] = value;
    loaded += 1;
  }

  return { loaded, skipped, status: "found" as const };
}

function env(name: string) {
  return process.env[name]?.trim() ?? "";
}

function requireEnv(name: string) {
  const value = env(name);
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function assertProductionSafety(findings: Finding[]) {
  const confirm = requireEnv("PHOENIX_PRODUCTION_PREFLIGHT_CONFIRM");
  if (confirm !== "YES_PRODUCTION_PREFLIGHT_READ_ONLY") {
    throw new Error('PHOENIX_PRODUCTION_PREFLIGHT_CONFIRM must be exactly "YES_PRODUCTION_PREFLIGHT_READ_ONLY".');
  }

  const url = requireEnv("PHOENIX_PRODUCTION_SUPABASE_URL").replace(/\/+$/g, "");
  const host = new URL(url).hostname.toLowerCase();
  if (url.includes(sandboxRef) || host.includes(sandboxRef)) {
    throw new Error("Refusing sandbox target for production preflight.");
  }
  if (!url.includes(productionRef) || host !== `${productionRef}.supabase.co`) {
    throw new Error("Production preflight must target Phoenix HR production ref ozucdzovmcqvepbozvqf.");
  }

  const databaseUrl = requireEnv("PHOENIX_PRODUCTION_DATABASE_URL");
  const databaseHost = new URL(databaseUrl).hostname.toLowerCase();
  if (databaseUrl.includes(sandboxRef) || databaseHost.includes(sandboxRef)) {
    throw new Error("Refusing sandbox database URL for production preflight.");
  }
  const directHost = databaseHost === `db.${productionRef}.supabase.co`;
  const poolerHost = databaseHost.endsWith(".pooler.supabase.com") && databaseUrl.includes(`postgres.${productionRef}`);
  if (!directHost && !poolerHost) {
    throw new Error("Database URL must target the Phoenix HR production direct host or pooler user.");
  }

  findings.push({
    detail: `host=${host}; database host validated; secrets not printed`,
    level: "INFO",
    name: "Production target safety",
  });
}

function createSql() {
  return postgres(requireEnv("PHOENIX_PRODUCTION_DATABASE_URL"), {
    idle_timeout: 20,
    max: 1,
    ssl: "require",
  });
}

function roleToCoarseRole(role: string | null) {
  switch (role) {
    case "Super Admin":
      return "super_admin";
    case "CEO":
    case "SFE Manager":
      return "company_reader";
    case "Finance Manager":
      return "finance";
    case "HR Advisory":
    case "HR Operations":
      return "hr";
    case "District Manager":
    case "Regional Manager":
    case "National Sales Manager":
    case "Product Manager":
    case "Group Product Manager":
    case "Training Manager":
    case "Marketing Manager":
    case "Manager":
      return "manager";
    default:
      return "employee";
  }
}

function roleToScope(role: string | null) {
  switch (role) {
    case "Super Admin":
      return "SUPER_ADMIN";
    case "CEO":
    case "SFE Manager":
      return "COMPANY_READ";
    case "Finance Manager":
      return "FINANCE";
    case "HR Advisory":
    case "HR Operations":
      return "HR";
    case "District Manager":
    case "Manager":
      return "TEAM";
    case "Regional Manager":
      return "HIERARCHY";
    case "National Sales Manager":
    case "Product Manager":
    case "Group Product Manager":
    case "Training Manager":
    case "Marketing Manager":
      return "LINE";
    default:
      return "SELF";
  }
}

function addRowsFinding(findings: Finding[], level: Finding["level"], name: string, rows: unknown[], maxRows = 10) {
  findings.push({
    detail: rows.length ? `${rows.length} found; sample=${JSON.stringify(rows.slice(0, maxRows))}` : "none found",
    level,
    name,
  });
}

async function inspectStaticFiles(findings: Finding[]) {
  const [migration, readiness] = await Promise.all([
    readFile(migrationPath, "utf8"),
    readFile(readinessReportPath, "utf8"),
  ]);
  const migrationHash = createHash("sha256").update(migration).digest("hex");

  // These are substring assertions against the 2026-05-11 migration FILE, not against the live
  // database. That file predates the 2026-07-13 rename of payroll_expenses ->
  // outstation_expenses (20260713120000_rename_payroll_expenses_to_outstation.sql), so the two
  // payroll_expenses entries below are CORRECT and must keep the old name — the historical text
  // they match never changes. Renaming them here would make every section "missing" and turn this
  // INFO finding into a permanent BLOCKER. The live-database table lists (affectedTables /
  // protectedMutationTables) are the ones that track the current schema.
  const requiredMigrationSections = [
    "create or replace function public.current_phoenix_role()",
    "create or replace function public.current_access_scope()",
    "create or replace function public.current_access_can_manage_payroll()",
    "grant insert, update, delete on table public.payroll_expenses to authenticated",
    "revoke all on table public.sales_records from anon",
    "create policy payroll_expenses_scoped_insert",
    "create policy user_access_profiles_update_self_or_super_admin",
  ];
  const missingMigrationSections = requiredMigrationSections.filter((section) => !migration.includes(section));
  findings.push({
    detail: missingMigrationSections.length
      ? `missing sections: ${missingMigrationSections.join("; ")}`
      : `migration present; sha256=${migrationHash}`,
    level: missingMigrationSections.length ? "BLOCKER" : "INFO",
    name: "Sandbox-passed migration static comparison",
  });

  const readinessSections = [
    "GO for controlled production rollout",
    "Deferred Security Remediations",
    "reviewed tracked exception",
    "Production Preflight Checklist",
    "Rollback Checklist",
  ];
  const missingReadinessSections = readinessSections.filter((section) => !readiness.includes(section));
  findings.push({
    detail: missingReadinessSections.length
      ? `missing readiness sections: ${missingReadinessSections.join("; ")}`
      : "readiness report contains required controlled rollout gates and tracked exception language",
    level: missingReadinessSections.length ? "BLOCKER" : "INFO",
    name: "Production readiness report comparison",
  });
}

async function inspectRequiredTables(sql: postgres.Sql, findings: Finding[]) {
  const rows = await sql<{ table_name: string }[]>`
    select table_name
    from information_schema.tables
    where table_schema = 'public'
      and table_name in ${sql(affectedTables)}
  `;
  const found = new Set(rows.map((row) => row.table_name));
  const missing = affectedTables.filter((table) => !found.has(table));
  findings.push({
    detail: missing.length ? `missing: ${missing.join(", ")}` : `${affectedTables.length} required tables exist`,
    level: missing.length ? "BLOCKER" : "INFO",
    name: "Required Phoenix tables",
  });
}

async function inspectPhoenixOwnedTableRls(sql: postgres.Sql, findings: Finding[]) {
  const rows = await sql<{ rls_enabled: boolean; table_name: string }[]>`
    select
      c.relname as table_name,
      c.relrowsecurity as rls_enabled
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and c.relname in ${sql(phoenixOwnedTables)}
    order by c.relname
  `;

  const existing = new Set(rows.map((row) => row.table_name));
  const missing = phoenixOwnedTables.filter((table) => !existing.has(table));
  if (missing.length) {
    findings.push({
      detail: `not present in production or not base tables: ${missing.join(", ")}`,
      level: "INFO",
      name: "Phoenix-owned optional table presence",
    });
  }

  const disabled = rows.filter((row) => !row.rls_enabled);
  const employeeProbation = rows.find((row) => row.table_name === "employee_probation");
  if (employeeProbation && !employeeProbation.rls_enabled) {
    findings.push({
      detail: "public.employee_probation has RLS disabled and is accepted as a reviewed tracked exception for role-alignment. Do not auto-remediate in role-alignment; probation RLS remains a separate security workstream.",
      level: "WARNING",
      name: "Reviewed tracked exception: employee_probation RLS disabled",
    });
  }

  const otherDisabled = disabled.filter((row) => row.table_name !== "employee_probation");
  addRowsFinding(
    findings,
    otherDisabled.length ? "WARNING" : "INFO",
    "Other Phoenix-owned public tables with RLS disabled",
    otherDisabled,
  );
}

async function inspectRoleData(sql: postgres.Sql, findings: Finding[]) {
  const unknownRoles = await sql`
    select login_id, role, hr_id, is_active
    from public.app_auth_users
    where coalesce(is_active, false) = true
      and role is not null
      and role not in ${sql(canonicalRoles)}
    order by role, login_id
    limit 50
  `;
  addRowsFinding(findings, unknownRoles.length ? "BLOCKER" : "INFO", "Unknown active app_auth_users roles", unknownRoles);

  const missingHrIds = await sql`
    select login_id, role, hr_id, is_active
    from public.app_auth_users
    where coalesce(is_active, false) = true
      and (
        hr_id is null
        or nullif(trim(hr_id), '') is null
      )
    order by login_id
    limit 50
  `;
  addRowsFinding(findings, missingHrIds.length ? "BLOCKER" : "INFO", "Active app_auth_users missing HR_ID", missingHrIds);

  const missingEmployeeRows = await sql`
    select a.login_id, a.role, a.hr_id
    from public.app_auth_users a
    left join public.employees e on lower(e.hr_id) = lower(a.hr_id)
    where coalesce(a.is_active, false) = true
      and nullif(trim(a.hr_id), '') is not null
      and e.hr_id is null
    order by a.login_id
    limit 50
  `;
  addRowsFinding(findings, missingEmployeeRows.length ? "WARNING" : "INFO", "Active app users without matching employees rows", missingEmployeeRows);
}

async function inspectAccessProfileReadiness(sql: postgres.Sql, findings: Finding[]) {
  const columns = await sql<{ column_name: string }[]>`
    select column_name
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'user_access_profiles'
      and column_name in ('role', 'phoenix_role', 'scope_type', 'hr_id', 'auth_user_id', 'login_id', 'is_active')
  `;
  const foundColumns = new Set(columns.map((row) => row.column_name));
  const missingRequired = ["role", "hr_id", "auth_user_id", "is_active"].filter((column) => !foundColumns.has(column));
  const missingAdditive = ["phoenix_role", "scope_type", "login_id"].filter((column) => !foundColumns.has(column));
  findings.push({
    detail: [
      missingRequired.length ? `missing required: ${missingRequired.join(", ")}` : "required columns present",
      missingAdditive.length ? `migration will add/backfill: ${missingAdditive.join(", ")}` : "role-alignment columns present",
    ].join("; "),
    level: missingRequired.length ? "BLOCKER" : missingAdditive.length ? "WARNING" : "INFO",
    name: "user_access_profiles column readiness",
  });

  if (foundColumns.has("phoenix_role")) {
    const unknownPhoenixRoles = foundColumns.has("scope_type")
      ? await sql`
        select login_id, hr_id, phoenix_role, role, scope_type
        from public.user_access_profiles
        where phoenix_role is not null
          and phoenix_role not in ${sql(canonicalRoles)}
        order by phoenix_role, login_id
        limit 50
      `
      : await sql`
        select login_id, hr_id, phoenix_role, role, null::text as scope_type
        from public.user_access_profiles
        where phoenix_role is not null
          and phoenix_role not in ${sql(canonicalRoles)}
        order by phoenix_role, login_id
        limit 50
      `;
    addRowsFinding(findings, unknownPhoenixRoles.length ? "BLOCKER" : "INFO", "Unknown user_access_profiles phoenix_role values", unknownPhoenixRoles);
  }

  if (foundColumns.has("phoenix_role") && foundColumns.has("scope_type")) {
    const profiles = await sql<{ hr_id: string | null; login_id: string | null; phoenix_role: string | null; role: string | null; scope_type: string | null }[]>`
      select login_id, hr_id, phoenix_role, role, scope_type
      from public.user_access_profiles
      where coalesce(is_active, true) = true
        and phoenix_role is not null
      limit 500
    `;
    const mismatches = profiles
      .filter((profile) => profile.role !== roleToCoarseRole(profile.phoenix_role) || profile.scope_type !== roleToScope(profile.phoenix_role))
      .slice(0, 50);
    addRowsFinding(findings, mismatches.length ? "WARNING" : "INFO", "Existing access-profile role/scope mismatches before migration", mismatches);
  }
}

async function inspectHelpers(sql: postgres.Sql, findings: Finding[]) {
  const helpers = await sql<{ function_definition: string; function_name: string; security_definer: boolean }[]>`
    select
      p.proname as function_name,
      p.prosecdef as security_definer,
      pg_get_functiondef(p.oid) as function_definition
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ${sql(expectedHelpers)}
    order by p.proname
  `;
  const found = new Set(helpers.map((helper) => helper.function_name));
  const missing = expectedHelpers.filter((helper) => !found.has(helper));
  findings.push({
    detail: missing.length
      ? `missing or will be created/replaced by migration: ${missing.join(", ")}`
      : "all expected helper names currently exist",
    level: missing.length ? "WARNING" : "INFO",
    name: "current_access helper presence",
  });

  const missingSearchPath = helpers
    .filter((helper) => helper.security_definer && !helper.function_definition.toLowerCase().includes("set search_path"))
    .map((helper) => helper.function_name);
  findings.push({
    detail: missingSearchPath.length ? missingSearchPath.join(", ") : "none found",
    level: missingSearchPath.length ? "WARNING" : "INFO",
    name: "SECURITY DEFINER helpers missing fixed search_path",
  });

  const authExecutable = await sql<{ anon_can_execute: boolean; authenticated_can_execute: boolean; function_name: string }[]>`
    select
      p.proname as function_name,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_can_execute,
      has_function_privilege('anon', p.oid, 'EXECUTE') as anon_can_execute
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname like 'current_access_%'
    order by p.proname
  `;
  const anonExecutable = authExecutable.filter((row) => row.anon_can_execute);
  const authenticatedExecutable = authExecutable.filter((row) => row.authenticated_can_execute);
  findings.push({
    detail: `authenticated executable helpers=${authenticatedExecutable.length}; anon executable helpers=${anonExecutable.length}`,
    level: anonExecutable.length ? "WARNING" : "INFO",
    name: "current_access helper execute grants",
  });
}

async function inspectPoliciesAndGrants(sql: postgres.Sql, findings: Finding[]) {
  const policies = await sql`
    select schemaname, tablename, policyname, cmd, roles, qual, with_check
    from pg_policies
    where schemaname = 'public'
      and tablename in ${sql(affectedTables)}
    order by tablename, policyname
  `;
  findings.push({
    detail: `${policies.length} affected-table policies currently exist`,
    level: "INFO",
    name: "Existing affected RLS policies",
  });

  const legacyAdminPolicies = policies.filter((policy) => {
    const text = `${policy.qual ?? ""} ${policy.with_check ?? ""}`;
    return text.includes("current_access_role() = 'admin'") || text.includes("current_access_role() = admin");
  });
  addRowsFinding(findings, legacyAdminPolicies.length ? "WARNING" : "INFO", "Existing policies with legacy admin role checks", legacyAdminPolicies);

  const grants = await sql`
    select table_name, grantee, privilege_type
    from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in ${sql(protectedMutationTables)}
      and grantee in ('anon', 'authenticated', 'service_role')
    order by table_name, grantee, privilege_type
  `;
  findings.push({
    detail: `${grants.length} grants found for affected protected tables`,
    level: "INFO",
    name: "Current affected table grants",
  });

  const anonWriteGrants = grants.filter((grant) => grant.grantee === "anon" && ["INSERT", "UPDATE", "DELETE", "TRUNCATE"].includes(String(grant.privilege_type)));
  addRowsFinding(findings, anonWriteGrants.length ? "BLOCKER" : "INFO", "Anon protected-table write grants", anonWriteGrants);
}

async function inspectSecurityDefinerObjects(sql: postgres.Sql, findings: Finding[]) {
  const exceptionTable = await sql<{ exists: boolean }[]>`
    select to_regclass('private.security_definer_function_exceptions') is not null as exists
  `;
  const hasExceptionTable = exceptionTable[0]?.exists ?? false;
  const trackedExceptions = hasExceptionTable
    ? new Set(
      (
        await sql<{ function_signature: string }[]>`
          select function_signature
          from private.security_definer_function_exceptions
        `
      ).map((row) => row.function_signature),
    )
    : new Set<string>();

  const securityDefinerFunctions = await sql<{
    anon_execute: boolean;
    authenticated_execute: boolean;
    config: string;
    function_name: string;
    function_signature: string;
    public_execute: boolean;
    schema_name: string;
  }[]>`
    select
      n.nspname as schema_name,
      p.proname as function_name,
      p.oid::regprocedure::text as function_signature,
      coalesce(array_to_string(p.proconfig, ','), '') as config,
      has_function_privilege('public', p.oid, 'EXECUTE') as public_execute,
      has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef = true
    order by p.proname
  `;
  const riskySecurityDefiners = securityDefinerFunctions.filter((fn) => {
    const hasFixedSearchPath = fn.config.split(",").some((item) => item.startsWith("search_path="));
    const unexpectedAuthenticatedExecute =
      fn.authenticated_execute && !authenticatedSecurityDefinerExceptions.has(fn.function_name);
    return (
      !trackedExceptions.has(fn.function_signature) ||
      !hasFixedSearchPath ||
      fn.public_execute ||
      fn.anon_execute ||
      unexpectedAuthenticatedExecute
    );
  });
  findings.push({
    detail: riskySecurityDefiners.length
      ? `${riskySecurityDefiners.length} risky/untracked of ${securityDefinerFunctions.length}; sample=${JSON.stringify(riskySecurityDefiners.slice(0, 10))}`
      : `${securityDefinerFunctions.length} reviewed functions; fixed search_path; no public/anon execute; authenticated execute limited to RLS helpers`,
    level: riskySecurityDefiners.length ? "WARNING" : "INFO",
    name: "SECURITY DEFINER functions",
  });

  const views = await sql<{ options: string; relkind: string; schema_name: string; view_name: string }[]>`
    select
      n.nspname as schema_name,
      c.relname as view_name,
      c.relkind,
      coalesce(array_to_string(c.reloptions, ','), '') as options
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('v', 'm')
    order by c.relname
  `;
  const definerLikeViews = views.filter((view) => {
    const options = String(view.options);
    return view.relkind === "v" && !/(^|,)security_invoker=(true|on)(,|$)/.test(options);
  });
  findings.push({
    detail: definerLikeViews.length
      ? `${definerLikeViews.length} public views are not marked security_invoker; sample=${JSON.stringify(definerLikeViews.slice(0, 10))}`
      : "all public views are marked security_invoker",
    level: definerLikeViews.length ? "WARNING" : "INFO",
    name: "SECURITY DEFINER-style view review",
  });
}

async function inspectAuthAdvisories(findings: Finding[]) {
  findings.push({
    detail: "Supabase leaked password protection setting is not reliably exposed via read-only SQL; verify in Production Dashboard > Auth before change window.",
    level: "WARNING",
    name: "Leaked password protection advisory",
  });
}

function printReport(findings: Finding[]) {
  const blockers = findings.filter((finding) => finding.level === "BLOCKER");
  const warnings = findings.filter((finding) => finding.level === "WARNING");
  const infos = findings.filter((finding) => finding.level === "INFO");

  console.log("\nPhoenix role-alignment production preflight report");
  console.log("=================================================");
  for (const finding of findings) {
    console.log(`${finding.level} ${finding.name} - ${finding.detail}`);
  }
  console.log(`\nSummary: ${blockers.length} blockers, ${warnings.length} warnings, ${infos.length} info.`);
  console.log(blockers.length ? "Final: PRODUCTION PREFLIGHT FAIL" : "Final: PRODUCTION PREFLIGHT PASS");
  console.log(blockers.length ? "Ready for change-window backup + migration: NO" : "Ready for change-window backup + migration: YES, after warning review and approved change window");
  if (blockers.length) process.exitCode = 1;
}

async function main() {
  const findings: Finding[] = [];
  const loadInfo = loadLocalEnvFile(localEnvPath);
  findings.push({
    detail: loadInfo.status === "found"
      ? `${localEnvPath} found; loaded ${loadInfo.loaded} keys; kept ${loadInfo.skipped} existing process env values`
      : `${localEnvPath} not found; using process environment only`,
    level: "INFO",
    name: "Local production env file lookup",
  });

  assertProductionSafety(findings);
  await inspectStaticFiles(findings);

  const sql = createSql();
  try {
    await sql`select 1`;
    findings.push({ detail: "read-only connection check passed", level: "INFO", name: "Production database connection" });
    await inspectRequiredTables(sql, findings);
    await inspectPhoenixOwnedTableRls(sql, findings);
    await inspectRoleData(sql, findings);
    await inspectAccessProfileReadiness(sql, findings);
    await inspectHelpers(sql, findings);
    await inspectPoliciesAndGrants(sql, findings);
    await inspectSecurityDefinerObjects(sql, findings);
    await inspectAuthAdvisories(findings);
  } finally {
    await sql.end({ timeout: 5 });
  }

  printReport(findings);
}

await main().catch((error) => {
  console.error(`BLOCKER production preflight aborted - ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
