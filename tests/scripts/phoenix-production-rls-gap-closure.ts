import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import postgres from "postgres";

type FindingLevel = "BLOCKER" | "INFO" | "WARNING";

type Finding = {
  detail: string;
  level: FindingLevel;
  name: string;
};

const productionRef = "ozucdzovmcqvepbozvqf";
const sandboxRef = "oaifhavixhdtwmseshff";
const localEnvPath = ".env.production.rls.local";
const migrationPath = "supabase/scripts/20260511_rls_gap_closure.sql";

const targetTables = [
  "employee_probation",
  "brick_reference_imports",
  "brick_reference_rows",
  "employee_locations",
  "geo_locations",
  "outstation_expense_requests",
  "outstation_location_audit_logs",
  "outstation_policy_rules",
  "password_setup_tokens",
];

const requiredColumns: Record<string, string[]> = {
  app_auth_users: ["hr_id", "is_active", "role", "updated_at"],
  brick_reference_imports: ["line"],
  brick_reference_rows: ["dsm_hr_id", "line"],
  employee_locations: [
    "created_at",
    "employee_hr_id",
    "geocode_status",
    "id",
    "residence_address",
    "residence_area",
    "residence_city",
    "residence_latitude",
    "residence_longitude",
    "updated_at",
  ],
  employees: ["department_id", "employment_status", "hr_id", "line_id", "manager_hr_id"],
  geo_locations: ["line"],
  lines: ["id", "name"],
  outstation_expense_requests: ["employee_hr_id", "status"],
  outstation_location_audit_logs: ["employee_hr_id"],
  user_access_profiles: ["auth_user_id", "hr_id", "is_active", "role", "updated_at"],
};

const allowedScopes = [
  "SELF",
  "TEAM",
  "HIERARCHY",
  "LINE",
  "DEPARTMENT",
  "COMPANY_READ",
  "FINANCE",
  "HR",
  "SUPER_ADMIN",
];

const fkChecks = [
  {
    childColumn: "employee_hr_id",
    childTable: "employee_locations",
    constraint: "employee_locations_employee_hr_id_fkey",
  },
  {
    childColumn: "employee_hr_id",
    childTable: "employee_probation",
    constraint: "employee_probation_employee_hr_id_fkey",
  },
  {
    childColumn: "employee_hr_id",
    childTable: "outstation_expense_requests",
    constraint: "outstation_expense_requests_employee_hr_id_fkey",
  },
];

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

function add(findings: Finding[], level: FindingLevel, name: string, detail: string) {
  findings.push({ detail, level, name });
}

function assertProductionSafety(findings: Finding[]) {
  const url = requireEnv("PHOENIX_PRODUCTION_SUPABASE_URL").replace(/\/+$/g, "");
  const host = new URL(url).hostname.toLowerCase();
  if (url.includes(sandboxRef) || host.includes(sandboxRef)) {
    throw new Error("Refusing sandbox target for production RLS gap closure.");
  }
  if (!url.includes(productionRef) || host !== `${productionRef}.supabase.co`) {
    throw new Error("Production URL must target Phoenix HR production ref ozucdzovmcqvepbozvqf.");
  }

  const databaseUrl = requireEnv("PHOENIX_PRODUCTION_DATABASE_URL");
  const databaseHost = new URL(databaseUrl).hostname.toLowerCase();
  if (databaseUrl.includes(sandboxRef) || databaseHost.includes(sandboxRef)) {
    throw new Error("Refusing sandbox database URL.");
  }
  const directHost = databaseHost === `db.${productionRef}.supabase.co`;
  const poolerHost = databaseHost.endsWith(".pooler.supabase.com") && databaseUrl.includes(`postgres.${productionRef}`);
  if (!directHost && !poolerHost) {
    throw new Error("Database URL must target the Phoenix HR production direct host or pooler user.");
  }

  add(findings, "INFO", "Production target safety", `host=${host}; database host validated; secrets not printed`);
}

function createSql() {
  return postgres(requireEnv("PHOENIX_PRODUCTION_DATABASE_URL"), {
    idle_timeout: 20,
    max: 1,
    ssl: "require",
  });
}

async function inspectMigration(findings: Finding[]) {
  const buffer = await readFile(migrationPath);
  const source = buffer.toString("utf8");
  const requiredSections = [
    "create extension if not exists supabase_vault cascade",
    "alter table if exists public.employee_probation enable row level security",
    "create or replace function private.phx_can_access_employee(target_hr_id text)",
    "private.phx_current_scope() in ('DEPARTMENT', 'HR', 'SUPER_ADMIN')",
    "create table if not exists public.sensitive_data_access_audit",
    "create or replace view public.v_employee_locations_masked",
    "private.log_sensitive_data_access_event",
    "alter view public.v_hr_id_orphan_audit set (security_invoker = true)",
    "employee_locations_employee_hr_id_fkey",
    "on delete cascade",
    "on delete set null",
    "on delete restrict",
  ];
  const missing = requiredSections.filter((section) => !source.includes(section));
  add(
    findings,
    missing.length ? "BLOCKER" : "INFO",
    "Migration static safety",
    missing.length
      ? `missing required sections: ${missing.join("; ")}`
      : `migration present; sha256=${createHash("sha256").update(buffer).digest("hex")}`,
  );
}

async function inspectProductionShape(sql: postgres.Sql, findings: Finding[]) {
  const expectedTables = Array.from(new Set([...targetTables, ...Object.keys(requiredColumns)]));
  const tableRows = await sql<{ table_name: string }[]>`
    select table_name
    from information_schema.tables
    where table_schema = 'public'
      and table_name in ${sql(expectedTables)}
      and table_type = 'BASE TABLE'
  `;
  const foundTables = new Set(tableRows.map((row) => row.table_name));
  const missingTargets = targetTables.filter((table) => !foundTables.has(table));
  add(
    findings,
    missingTargets.length ? "BLOCKER" : "INFO",
    "Target table presence",
    missingTargets.length ? `missing target tables: ${missingTargets.join(", ")}` : `${targetTables.length} target tables exist`,
  );

  const allColumnTables = Object.keys(requiredColumns).filter((table) => foundTables.has(table));
  const columnRows = await sql<{ column_name: string; table_name: string }[]>`
    select table_name, column_name
    from information_schema.columns
    where table_schema = 'public'
      and table_name in ${sql(allColumnTables)}
  `;
  const present = new Set(columnRows.map((row) => `${row.table_name}.${row.column_name}`));
  const missingColumns = Object.entries(requiredColumns).flatMap(([table, columns]) =>
    columns.filter((column) => !present.has(`${table}.${column}`)).map((column) => `${table}.${column}`),
  );
  add(
    findings,
    missingColumns.length ? "BLOCKER" : "INFO",
    "Required column presence",
    missingColumns.length ? `missing columns: ${missingColumns.join(", ")}` : "all migration-referenced columns exist",
  );

  const hrIdUnique = await sql<{ conname: string }[]>`
    select c.conname
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'employees'
      and c.contype in ('p', 'u')
      and (
        select array_agg(a.attname::text order by u.ordinality)
        from unnest(c.conkey) with ordinality as u(attnum, ordinality)
        join pg_attribute a on a.attrelid = t.oid and a.attnum = u.attnum
      ) = array['hr_id']
  `;
  add(
    findings,
    hrIdUnique.length ? "INFO" : "BLOCKER",
    "employees.hr_id FK target",
    hrIdUnique.length ? `unique/primary constraint=${hrIdUnique[0]?.conname}` : "employees.hr_id lacks a unique/primary constraint",
  );

  const scopeRows = present.has("user_access_profiles.scope_type")
    ? await sql<{ scope_type: string }[]>`
      select distinct scope_type
      from public.user_access_profiles
      where scope_type is not null
        and scope_type not in ${sql(allowedScopes)}
      order by scope_type
    `
    : [];
  add(
    findings,
    scopeRows.length ? "BLOCKER" : "INFO",
    "Existing scope_type values",
    scopeRows.length ? `unsupported values: ${scopeRows.map((row) => row.scope_type).join(", ")}` : "no unsupported scope values",
  );
}

async function createMetadataBackups(sql: postgres.Sql, findings: Finding[]) {
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const policiesTable = `private.rls_gap_closure_backup_policies_${stamp}`;
  const grantsTable = `private.rls_gap_closure_backup_grants_${stamp}`;
  const constraintsTable = `private.rls_gap_closure_backup_constraints_${stamp}`;

  await sql`create schema if not exists private`;
  await sql.unsafe(`
    create table ${policiesTable} as
    select now() as backed_up_at, *
    from pg_policies
    where schemaname = 'public'
      and tablename in (${targetTables.map((table) => `'${table.replace(/'/g, "''")}'`).join(", ")})
  `);
  await sql.unsafe(`
    create table ${grantsTable} as
    select now() as backed_up_at, *
    from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in (${targetTables.map((table) => `'${table.replace(/'/g, "''")}'`).join(", ")})
  `);
  await sql.unsafe(`
    create table ${constraintsTable} as
    select
      now() as backed_up_at,
      conrelid::regclass::text as table_name,
      conname,
      contype,
      pg_get_constraintdef(oid) as constraint_definition
    from pg_constraint
    where conrelid::regclass::text = any (array[
      ${targetTables.map((table) => `'public.${table.replace(/'/g, "''")}'`).join(", ")}
    ])
  `);

  add(
    findings,
    "INFO",
    "Production metadata backup",
    `created ${policiesTable}, ${grantsTable}, ${constraintsTable}`,
  );
}

async function applyMigration(sql: postgres.Sql, findings: Finding[]) {
  const source = await readFile(migrationPath, "utf8");
  await sql.unsafe(source);
  add(findings, "INFO", "Migration application", `${migrationPath} applied`);
}

async function validateForeignKeys(sql: postgres.Sql, findings: Finding[]) {
  const orphanSummaries: string[] = [];

  for (const fk of fkChecks) {
    const rows = await sql.unsafe<{ orphan_count: string }[]>(`
      select count(*)::text as orphan_count
      from public.${fk.childTable} child
      left join public.employees parent on parent.hr_id = child.${fk.childColumn}
      where child.${fk.childColumn} is not null
        and parent.hr_id is null
    `);
    const orphanCount = Number(rows[0]?.orphan_count ?? "0");
    if (orphanCount > 0) {
      orphanSummaries.push(`${fk.childTable}.${fk.childColumn}=${orphanCount}`);
    }
  }

  if (orphanSummaries.length) {
    add(findings, "BLOCKER", "Foreign key data validation", `orphan rows found: ${orphanSummaries.join(", ")}`);
    return;
  }

  for (const fk of fkChecks) {
    await sql.unsafe(`alter table public.${fk.childTable} validate constraint ${fk.constraint}`);
  }
  add(findings, "INFO", "Foreign key data validation", "all expected FKs validated; no orphan rows found");
}

async function validatePostApply(sql: postgres.Sql, findings: Finding[]) {
  const rlsRows = await sql<{
    fk_count: number;
    policy_count: number;
    rls_enabled: boolean;
    table_name: string;
  }[]>`
    with target(table_name) as (
      select unnest(${targetTables}::text[])
    ),
    policies as (
      select tablename as table_name, count(*)::int as policy_count
      from pg_policies
      where schemaname = 'public'
      group by tablename
    ),
    fks as (
      select conrelid::regclass::text as table_name, count(*)::int as fk_count
      from pg_constraint
      where contype = 'f'
      group by conrelid::regclass::text
    )
    select
      target.table_name,
      c.relrowsecurity as rls_enabled,
      coalesce(policies.policy_count, 0)::int as policy_count,
      coalesce(fks.fk_count, 0)::int as fk_count
    from target
    join pg_class c on c.relname = target.table_name
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    left join policies on policies.table_name = target.table_name
    left join fks on fks.table_name = 'public.' || target.table_name
    order by target.table_name
  `;

  const badRls = rlsRows.filter((row) => !row.rls_enabled);
  const noPolicies = rlsRows.filter((row) => row.policy_count === 0);
  add(
    findings,
    badRls.length || noPolicies.length ? "BLOCKER" : "INFO",
    "RLS and policy validation",
    badRls.length || noPolicies.length
      ? `rls disabled=${badRls.map((row) => row.table_name).join(", ") || "none"}; no policies=${noPolicies.map((row) => row.table_name).join(", ") || "none"}`
      : "all 11 target tables have RLS enabled and at least one policy",
  );

  const authenticatedTokenGrants = await sql`
    select privilege_type
    from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name = 'password_setup_tokens'
      and grantee = 'authenticated'
  `;
  add(
    findings,
    authenticatedTokenGrants.length ? "BLOCKER" : "INFO",
    "Password token exposure",
    authenticatedTokenGrants.length ? "authenticated still has password_setup_tokens grants" : "password_setup_tokens remains service-role only",
  );

  const expectedConstraints = [
    "employee_locations_employee_hr_id_fkey",
    "employee_probation_employee_hr_id_fkey",
    "geo_bricks_employee_hr_id_fkey",
    "outstation_expense_requests_employee_hr_id_fkey",
  ];
  const constraints = await sql<{ conname: string; convalidated: boolean }[]>`
    select conname, convalidated
    from pg_constraint
    where conname in ${sql(expectedConstraints)}
  `;
  const presentConstraints = new Set(constraints.map((row) => row.conname));
  const missingConstraints = expectedConstraints.filter((name) => !presentConstraints.has(name));
  const unvalidatedConstraints = constraints.filter((row) => !row.convalidated).map((row) => row.conname);
  add(
    findings,
    missingConstraints.length || unvalidatedConstraints.length ? "BLOCKER" : "INFO",
    "Foreign key validation",
    missingConstraints.length || unvalidatedConstraints.length
      ? `missing constraints: ${missingConstraints.join(", ") || "none"}; unvalidated constraints: ${unvalidatedConstraints.join(", ") || "none"}`
      : "all expected FKs exist and are validated",
  );

  const auditRows = await sql<{ relrowsecurity: boolean }[]>`
    select c.relrowsecurity
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'sensitive_data_access_audit'
  `;
  add(
    findings,
    auditRows[0]?.relrowsecurity ? "INFO" : "BLOCKER",
    "Sensitive access audit",
    auditRows[0]?.relrowsecurity ? "audit table exists with RLS enabled" : "audit table missing or RLS disabled",
  );

  const maskedView = await sql<{ options: string }[]>`
    select coalesce(array_to_string(c.reloptions, ','), '') as options
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'v_employee_locations_masked'
      and c.relkind = 'v'
  `;
  add(
    findings,
    maskedView[0]?.options.includes("security_invoker=true") ? "INFO" : "BLOCKER",
    "Masked location view",
    maskedView[0]?.options.includes("security_invoker=true")
      ? "v_employee_locations_masked exists with security_invoker"
      : "masked view missing or not security_invoker",
  );

  const vaultAvailable = await sql<{ installed: boolean }[]>`
    select exists(select 1 from pg_extension where extname = 'supabase_vault') as installed
  `;
  add(
    findings,
    vaultAvailable[0]?.installed ? "INFO" : "WARNING",
    "Vault extension",
    vaultAvailable[0]?.installed ? "supabase_vault is installed" : "supabase_vault was not installed or is unavailable",
  );
}

function printFindings(title: string, findings: Finding[]) {
  console.log(title);
  console.log("=".repeat(title.length));
  for (const finding of findings) {
    console.log(`${finding.level} ${finding.name} - ${finding.detail}`);
  }
  const counts = findings.reduce(
    (acc, finding) => {
      acc[finding.level] += 1;
      return acc;
    },
    { BLOCKER: 0, INFO: 0, WARNING: 0 } as Record<FindingLevel, number>,
  );
  console.log("");
  console.log(`Summary: ${counts.BLOCKER} blockers, ${counts.WARNING} warnings, ${counts.INFO} info.`);
}

async function main() {
  const apply = process.argv.includes("--apply");
  const findings: Finding[] = [];
  const loadInfo = loadLocalEnvFile(localEnvPath);
  add(
    findings,
    loadInfo.status === "found" ? "INFO" : "BLOCKER",
    "Local production env file lookup",
    loadInfo.status === "found"
      ? `${localEnvPath} found; loaded ${loadInfo.loaded}; kept ${loadInfo.skipped} existing process env values`
      : `${localEnvPath} not found`,
  );

  assertProductionSafety(findings);
  await inspectMigration(findings);

  const sql = createSql();
  try {
    await sql`select 1`;
    add(findings, "INFO", "Production database connection", "connection check passed");
    await inspectProductionShape(sql, findings);

    const preApplyBlockers = findings.filter((finding) => finding.level === "BLOCKER");
    if (preApplyBlockers.length) {
      printFindings("Phoenix RLS gap closure production preflight", findings);
      process.exitCode = 1;
      return;
    }

    if (!apply) {
      printFindings("Phoenix RLS gap closure production preflight", findings);
      console.log("Final: DRY RUN PASS. Re-run with --apply and PHOENIX_PRODUCTION_RLS_GAP_CLOSURE_CONFIRM=YES_APPLY_RLS_GAP_CLOSURE_TO_PRODUCTION to apply.");
      return;
    }

    if (env("PHOENIX_PRODUCTION_RLS_GAP_CLOSURE_CONFIRM") !== "YES_APPLY_RLS_GAP_CLOSURE_TO_PRODUCTION") {
      throw new Error("PHOENIX_PRODUCTION_RLS_GAP_CLOSURE_CONFIRM must be exactly YES_APPLY_RLS_GAP_CLOSURE_TO_PRODUCTION.");
    }

    await createMetadataBackups(sql, findings);
    await applyMigration(sql, findings);
    await validateForeignKeys(sql, findings);
    await validatePostApply(sql, findings);

    printFindings("Phoenix RLS gap closure production apply report", findings);
    const postApplyBlockers = findings.filter((finding) => finding.level === "BLOCKER");
    process.exitCode = postApplyBlockers.length ? 1 : 0;
    console.log(postApplyBlockers.length ? "Final: APPLY COMPLETED WITH BLOCKERS" : "Final: APPLY PASS");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
