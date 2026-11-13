import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migrationSource = readFileSync(
  new URL("../supabase/scripts/20260511_rls_gap_closure.sql", import.meta.url),
  "utf8",
);

const rlsGapTables = [
  "employee_probation",
  "brick_reference_imports",
  "brick_reference_rows",
  "employee_locations",
  "geo_bricks",
  "geo_locations",
  "geo_trip_routes",
  "outstation_expense_requests",
  "outstation_location_audit_logs",
  "outstation_policy_rules",
  "password_setup_tokens",
] as const;

function assertContains(pattern: RegExp, message: string) {
  assert.match(migrationSource, pattern, message);
}

export function runRlsGapClosureTests() {
  for (const table of rlsGapTables) {
    assertContains(
      new RegExp(`alter table if exists public\\.${table}\\s+enable row level security`, "i"),
      `${table} must explicitly enable RLS`,
    );
    assertContains(
      new RegExp(`'${table}'`, "i"),
      `${table} must be included in the service-role policy loop`,
    );
  }

  assertContains(
    /create policy %I on public\.%I for all to service_role using \(true\) with check \(true\)/i,
    "migration must create explicit service-role policies for the RLS gap tables",
  );

  for (const table of rlsGapTables.filter((table) => table !== "password_setup_tokens")) {
    assertContains(
      new RegExp(`drop policy if exists ${table}_(?:select|insert|write|update|delete)`, "i"),
      `${table} must define at least one authenticated access policy`,
    );
  }

  assertContains(
    /revoke all on table public\.password_setup_tokens from anon, authenticated/i,
    "password setup tokens must remain service-role only",
  );
  assertContains(
    /to_regprocedure\('public\.current_access_can_see_employee\(text, text\)'\)/i,
    "existing current_access helpers must be executable by authenticated RLS policies",
  );
  assertContains(
    /grant execute on function %s to authenticated, service_role/i,
    "migration must grant executable helper functions through its dynamic helper loop",
  );
  assertContains(
    /private\.phx_can_access_employee\(target_hr_id text\)/i,
    "hierarchy and temporal employee access helper must exist",
  );
  assertContains(
    /scope_type in \([\s\S]*'DEPARTMENT'[\s\S]*\)/i,
    "user access profiles must allow a department isolation scope",
  );
  assertContains(
    /private\.phx_current_scope\(\) in \('DEPARTMENT', 'HR', 'SUPER_ADMIN'\)[\s\S]*actor\.department_id = target\.department_id/i,
    "employee access must include department-based isolation",
  );
  assertContains(
    /lower\(coalesce\(target\.employment_status, 'active'\)\) in \('resigned', 'terminated', 'inactive', 'left'\)/i,
    "employee access must include temporal employment-status handling",
  );
  assertContains(
    /create or replace view public\.v_employee_locations_masked\s+with \(security_invoker = true\)/i,
    "sensitive employee location data must have a masking view",
  );
  assertContains(
    /update public\.outstation_expense_requests child[\s\S]*lower\(child\.employee_hr_id\) = lower\(parent\.hr_id\)/i,
    "migration must canonicalize case-only HR_ID mismatches before FK validation",
  );
  assertContains(
    /create table if not exists public\.sensitive_data_access_audit/i,
    "sensitive data access audit table must exist",
  );
  assertContains(
    /create extension if not exists supabase_vault cascade/i,
    "Supabase Vault must be enabled when available for database-level secret management",
  );
  assertContains(
    /private\.log_sensitive_data_access_event\([\s\S]*'v_employee_locations_masked'/i,
    "masked sensitive-data reads must write audit events",
  );
  assertContains(
    /alter view public\.v_hr_id_orphan_audit set \(security_invoker = true\)/i,
    "security-definer audit view must be converted to security invoker",
  );

  for (const constraint of [
    "employee_locations_employee_hr_id_fkey",
    "employee_probation_employee_hr_id_fkey",
    "geo_trip_routes_employee_hr_id_fkey",
    "geo_bricks_employee_hr_id_fkey",
    "outstation_expense_requests_employee_hr_id_fkey",
  ]) {
    assertContains(new RegExp(constraint, "i"), `${constraint} must be defined`);
  }

  assertContains(/on delete cascade/i, "at least one child table must define cascade delete behavior");
  assertContains(/on delete set null/i, "historical optional employee references must define set-null behavior");
  assertContains(/on delete restrict/i, "financial workflow rows must restrict parent deletion");
}
