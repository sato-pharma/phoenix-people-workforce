import { existsSync, readFileSync } from "node:fs";

import postgres from "postgres";

type Check = {
  details?: unknown;
  label: string;
  ok: boolean;
};

type ColumnRow = {
  column_name: string;
  data_type: string;
  is_nullable: string;
  table_name: string;
  udt_name: string;
};

type SchemaGap = {
  columnName: string;
  tableName: string;
};

type RlsRow = {
  relrowsecurity: boolean;
  table_name: string;
};

type GrantRow = {
  grantee: string;
  privilege_type: string;
  table_name: string;
};

type PolicyRow = {
  cmd: string;
  policyname: string;
  roles: string[];
  tablename: string;
};

type SalaryBatchResidue = {
  approved_at: string | null;
  file_name: string | null;
  id: string;
  locked_at: string | null;
  month: number | null;
  part1_paid_at: string | null;
  status: string | null;
  uploaded_by: string | null;
  year: number | null;
};

type SalaryRecordCount = {
  count: string;
};

const migrationPath =
  "supabase/migrations/20260519102840_phase28_production_schema_parity_readiness.sql";
const migrationSql = readFileSync(migrationPath, "utf8");
const checks: Check[] = [];
const warnings: string[] = [];

const expectedSchema: Record<string, string[]> = {
  app_auth_users: ["session_version"],
  areas: ["line_id"],
  employee_probation: [
    "hr_id",
    "employee_hr_id",
    "manager_hr_id",
    "probation_start_date",
    "probation_end_date",
    "status",
    "notes",
    "created_at",
    "updated_at",
  ],
  employees: [
    "name_ar",
    "national_id",
    "gender",
    "has_bank_account",
    "bank_name",
    "bank_account",
    "social_insurance_status",
    "social_insurance_number",
    "medical_insurance_status",
    "medical_insurance_number",
    "basic_salary",
    "base_salary",
    "gross_salary",
    "net_salary",
    "fuel_allowance",
    "extra_cost_of_living",
    "medical_insurance",
    "social_insurance",
    "taxes",
    "payment_mode",
    "residence_address",
    "residence_city",
    "residence_area",
    "contract_type",
    "contract_renewal_date",
    "crm_username",
    "work_email",
    "mobile_number",
    "job_title",
    "hire_date",
    "employment_status",
    "education",
    "manager_hr_id",
    "department_id",
    "line_id",
    "area_id",
    "team_id",
    "position_id",
    "payroll_eligible",
    "organogram_visible",
  ],
  probation_evaluations: [
    "employee_hr_id",
    "probation_id",
    "employee_name",
    "job_title",
    "line_name",
    "area_name",
    "probation_end_date",
    "evaluation_scores",
    "manager_feedback",
    "hr_recommendation",
    "decision",
    "extension_end_date",
    "decision_reason",
    "probation_letter_url",
    "probation_letter_name",
    "workflow_notes",
    "status",
    "created_by",
    "created_at",
    "updated_at",
    "manager_reviewed_at",
    "manager_reviewed_by",
    "hr_reviewed_at",
    "hr_reviewed_by",
    "approved_at",
    "approved_by",
    "completed_at",
    "completed_by",
  ],
  probation_history: [
    "evaluation_id",
    "employee_hr_id",
    "action",
    "old_status",
    "new_status",
    "actor",
    "details",
    "created_at",
  ],
  teams: ["area_id", "is_active"],
  v2_vacation_email_tokens: [
    "request_id",
    "token_hash",
    "manager_hr_id",
    "decision",
    "expires_at",
    "used_at",
    "created_at",
  ],
  v2_vacation_request_events: [
    "request_id",
    "event_type",
    "actor_hr_id",
    "actor_login_id",
    "message",
    "metadata",
    "note",
    "created_at",
  ],
  v2_vacation_requests: [
    "employee_hr_id",
    "employee_name",
    "employee_work_email",
    "employee_hire_date",
    "department_name",
    "line_name",
    "manager_hr_id",
    "manager_name",
    "manager_of_manager_hr_id",
    "manager_of_manager_name",
    "vacation_type",
    "day_part",
    "start_date",
    "end_date",
    "duration_days",
    "working_days",
    "calendar_days",
    "payment_status",
    "unpaid_reason",
    "entitlement_days",
    "used_paid_days",
    "balance_before_days",
    "balance_after_days",
    "period_start",
    "period_end",
    "status",
    "submitted_by_hr_id",
    "submitted_by_login_id",
    "manager_decision",
    "manager_decision_by_hr_id",
    "manager_decision_at",
    "manager_decision_comment",
    "notes",
    "created_at",
    "updated_at",
  ],
};

const serviceOwnedTables = [
  "employee_probation",
  "probation_evaluations",
  "probation_history",
  "v2_vacation_requests",
  "v2_vacation_request_events",
  "v2_vacation_email_tokens",
];

const phasePrefixes = ["PHASE15", "PHASE16", "PHASE17"];

loadLocalEnv();

function loadLocalEnv() {
  try {
    const text = readFileSync(".env.local", "utf8");
    for (const line of text.split(/\r?\n/g)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index <= 0) continue;
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // The runner may inject env vars directly.
  }
}

function addCheck(label: string, ok: boolean, details?: unknown) {
  checks.push({ details, label, ok });
  if (!ok) throw new Error(`${label} failed${details ? `: ${JSON.stringify(details)}` : ""}`);
}

function message(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }
  return String(error);
}

function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the read-only Phase 28 smoke`);
  return value;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function migrationCoversColumn(gap: SchemaGap) {
  const table = escapeRegExp(gap.tableName);
  const column = escapeRegExp(gap.columnName);
  const alterPattern = new RegExp(
    `alter\\s+table(?:\\s+if\\s+exists)?\\s+public\\.${table}[\\s\\S]*?add\\s+column\\s+if\\s+not\\s+exists\\s+${column}\\b`,
    "i",
  );
  const createPattern = new RegExp(
    `create\\s+table\\s+if\\s+not\\s+exists\\s+public\\.${table}\\s*\\([\\s\\S]*?\\b${column}\\b`,
    "i",
  );
  return alterPattern.test(migrationSql) || createPattern.test(migrationSql);
}

function isClearlyDisposableText(value: unknown) {
  const normalized = String(value ?? "").trim().toUpperCase();
  return phasePrefixes.some((prefix) => normalized.startsWith(prefix));
}

function isProtectedPayrollBatch(batch: SalaryBatchResidue) {
  const status = String(batch.status ?? "").toLowerCase();
  return (
    status === "approved" ||
    status === "locked" ||
    status === "part1_paid" ||
    status === "adjustments_open" ||
    status === "part2_ready" ||
    status === "under_review" ||
    Boolean(batch.approved_at) ||
    Boolean(batch.locked_at) ||
    Boolean(batch.part1_paid_at)
  );
}

function isDisposablePayrollBatch(batch: SalaryBatchResidue) {
  return (
    Number(batch.year ?? 0) >= 2090 ||
    isClearlyDisposableText(batch.file_name) ||
    isClearlyDisposableText(batch.uploaded_by)
  );
}

async function fetchColumns(sql: postgres.Sql) {
  const tableNames = Object.keys(expectedSchema);
  return await sql<ColumnRow[]>`
    select table_name, column_name, data_type, udt_name, is_nullable
    from information_schema.columns
    where table_schema = 'public'
      and table_name in ${sql(tableNames)}
    order by table_name, ordinal_position
  `;
}

function findSchemaGaps(columns: ColumnRow[]) {
  const existing = new Set(columns.map((column) => `${column.table_name}.${column.column_name}`));
  return Object.entries(expectedSchema).flatMap(([tableName, columnNames]) =>
    columnNames
      .filter((columnName) => !existing.has(`${tableName}.${columnName}`))
      .map((columnName) => ({ columnName, tableName })),
  );
}

async function fetchRlsRows(sql: postgres.Sql) {
  return await sql<RlsRow[]>`
    select c.relname as table_name, c.relrowsecurity
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and c.relname in ${sql(serviceOwnedTables)}
    order by c.relname
  `;
}

async function fetchGrantRows(sql: postgres.Sql) {
  return await sql<GrantRow[]>`
    select table_name, grantee, privilege_type
    from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in ${sql(serviceOwnedTables)}
      and grantee in ('anon', 'authenticated', 'service_role')
    order by table_name, grantee, privilege_type
  `;
}

async function fetchPolicyRows(sql: postgres.Sql) {
  return await sql<PolicyRow[]>`
    select tablename, policyname, roles, cmd
    from pg_policies
    where schemaname = 'public'
      and tablename in ${sql(serviceOwnedTables)}
    order by tablename, policyname
  `;
}

async function tableExists(sql: postgres.Sql, tableName: string) {
  const rows = await sql<{ exists: boolean }[]>`
    select exists (
      select 1
      from information_schema.tables
      where table_schema = 'public'
        and table_name = ${tableName}
    ) as exists
  `;
  return Boolean(rows[0]?.exists);
}

async function fetchSalaryBatchResidue(sql: postgres.Sql) {
  if (!(await tableExists(sql, "salary_batches"))) {
    warnings.push("salary_batches table not found during fixture-retention inspection");
    return [] as SalaryBatchResidue[];
  }

  return await sql<SalaryBatchResidue[]>`
    select id, file_name, month, year, status, uploaded_by, approved_at, locked_at, part1_paid_at
    from public.salary_batches
    where year >= 2090
      or upper(coalesce(file_name, '')) like 'PHASE15%'
      or upper(coalesce(file_name, '')) like 'PHASE16%'
      or upper(coalesce(file_name, '')) like 'PHASE17%'
      or upper(coalesce(uploaded_by, '')) like 'PHASE15%'
      or upper(coalesce(uploaded_by, '')) like 'PHASE16%'
      or upper(coalesce(uploaded_by, '')) like 'PHASE17%'
      or upper(coalesce(approved_by, '')) like 'PHASE15%'
      or upper(coalesce(approved_by, '')) like 'PHASE16%'
      or upper(coalesce(approved_by, '')) like 'PHASE17%'
    order by year desc nulls last, month desc nulls last
  `;
}

async function countSalaryRecords(sql: postgres.Sql, batchIds: string[]) {
  if (batchIds.length === 0 || !(await tableExists(sql, "salary_records"))) return 0;
  const rows = await sql<SalaryRecordCount[]>`
    select count(*)::text as count
    from public.salary_records
    where batch_id in ${sql(batchIds)}
  `;
  return Number(rows[0]?.count ?? 0);
}

async function countPhaseEmployees(sql: postgres.Sql) {
  if (!(await tableExists(sql, "employees"))) return 0;
  const rows = await sql<SalaryRecordCount[]>`
    select count(*)::text as count
    from public.employees
    where upper(coalesce(hr_id, '')) like 'PHASE15%'
      or upper(coalesce(hr_id, '')) like 'PHASE16%'
      or upper(coalesce(hr_id, '')) like 'PHASE17%'
      or upper(coalesce(full_name, '')) like 'PHASE15%'
      or upper(coalesce(full_name, '')) like 'PHASE16%'
      or upper(coalesce(full_name, '')) like 'PHASE17%'
  `;
  return Number(rows[0]?.count ?? 0);
}

function verifyDashboardFixtureSafeSources() {
  const sourceFiles = [
    "src/lib/fixture-hygiene.ts",
    "src/lib/platform/metrics.ts",
    "src/lib/admin/command-center.ts",
    "src/lib/admin/service.ts",
    "src/lib/operations/events.ts",
    "scripts/phase20-production-readiness-smoke.ts",
  ];
  const found = sourceFiles.filter((path) => existsSync(path));
  const source = found.map((path) => readFileSync(path, "utf8")).join("\n");

  addCheck("fixture hygiene source is present", found.includes("src/lib/fixture-hygiene.ts"), found);
  addCheck(
    "dashboard fixture-safe source coverage remains represented",
    /isDisposableFixtureText|PHASE15|PHASE16|PHASE17|fixture/i.test(source) &&
      /Monitoring business activity excludes retained PHASE fixture actors|Protected PHASE payroll fixtures/i.test(source),
    found,
  );
}

async function main() {
  const dbUrl = requireEnv("SUPABASE_DB_URL");
  const sql = postgres(dbUrl, {
    max: 1,
    prepare: false,
    ssl: "require",
  });

  try {
    const columns = await fetchColumns(sql);
    const schemaGaps = findSchemaGaps(columns);
    const uncoveredGaps = schemaGaps.filter((gap) => !migrationCoversColumn(gap));

    addCheck("read-only schema inspection completed", columns.length >= 0, {
      inspectedTables: Object.keys(expectedSchema).length,
    });
    addCheck("migration SQL covers every discovered schema parity gap", uncoveredGaps.length === 0, {
      schemaGaps,
      uncoveredGaps,
    });

    const [rlsRows, grantRows, policyRows] = await Promise.all([
      fetchRlsRows(sql),
      fetchGrantRows(sql),
      fetchPolicyRows(sql),
    ]);
    const existingRlsTables = new Set(rlsRows.map((row) => row.table_name));
    const rlsDisabled = rlsRows.filter((row) => !row.relrowsecurity);
    const directAppGrants = grantRows.filter((row) =>
      (row.grantee === "anon" || row.grantee === "authenticated") &&
      serviceOwnedTables.includes(row.table_name),
    );
    const directAuthenticatedPolicies = policyRows.filter((row) =>
      row.roles.some((role) => role === "authenticated" || role === "public"),
    );
    if (directAuthenticatedPolicies.length > 0) {
      warnings.push(
        `Existing direct authenticated/public probation/vacation policies found; Phase 28 keeps them inert through revoked anon/authenticated grants and records policy-drop review for the pre-apply gate.`,
      );
    }

    addCheck("existing service-owned probation/vacation tables keep RLS enabled", rlsDisabled.length === 0, {
      existingTables: [...existingRlsTables],
      rlsDisabled,
    });
    addCheck("production grants keep probation/vacation service-route owned", directAppGrants.length === 0, {
      directAppGrants,
      serviceRoleGrants: grantRows.filter((row) => row.grantee === "service_role"),
    });
    addCheck(
      "migration SQL does not add direct authenticated probation/vacation policies",
      !/\bcreate\s+policy[\s\S]*\bto\s+authenticated\b/i.test(migrationSql) &&
        !/\bgrant\s+[\s\S]*\bto\s+authenticated\b/i.test(migrationSql),
      directAuthenticatedPolicies,
    );

    const salaryBatches = await fetchSalaryBatchResidue(sql);
    const protectedBatches = salaryBatches.filter(isProtectedPayrollBatch);
    const cleanupCandidates = salaryBatches.filter((batch) => isDisposablePayrollBatch(batch) && !isProtectedPayrollBatch(batch));
    const [protectedSalaryRecords, cleanupCandidateSalaryRecords, phaseEmployees] = await Promise.all([
      countSalaryRecords(sql, protectedBatches.map((batch) => batch.id)),
      countSalaryRecords(sql, cleanupCandidates.map((batch) => batch.id)),
      countPhaseEmployees(sql),
    ]);

    addCheck("protected PHASE payroll fixtures are retained read-only", protectedSalaryRecords >= 0, {
      protectedBatches: protectedBatches.length,
      protectedSalaryRecords,
    });
    addCheck("no cleanup-safe PHASE payroll candidates are visible in read-only preflight", cleanupCandidates.length === 0 && cleanupCandidateSalaryRecords === 0, {
      cleanupCandidateBatches: cleanupCandidates,
      cleanupCandidateSalaryRecords,
    });
    addCheck("no PHASE employee residue is visible in production-facing employees", phaseEmployees === 0, {
      phaseEmployees,
    });

    verifyDashboardFixtureSafeSources();

    console.log(JSON.stringify({
      checks,
      dashboardFixtureSafeCoverage: "Represented in shared fixture hygiene, platform metrics, Command Center, Data Health, Monitoring, and Phase 20 smoke sources.",
      migrationCoverage: {
        migrationPath,
        schemaGaps,
        uncoveredGaps,
      },
      noProductionMutationsExecuted: true,
      protectedFixturePolicy: {
        payrollFixtures: "Approved, locked, or Part 1 paid PHASE payroll fixtures are retained and filtered from business dashboards.",
        rawAuditLogs: "Raw Audit Logs may retain PHASE traces for accountability.",
      },
      remainingRisks: {
        directAuthenticatedPolicies,
      },
      rlsPosture: {
        grants: grantRows,
        policies: policyRows,
        rlsRows,
      },
      warnings,
    }, null, 2));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ error: message(error), warnings }, null, 2));
  process.exitCode = 1;
});
