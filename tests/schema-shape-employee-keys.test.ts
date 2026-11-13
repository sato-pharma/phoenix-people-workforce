import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  employeeKeyName,
  evaluateSchemaShape,
  readEmployeeKeyBaseline,
  type EmployeeKey,
  type SchemaShape,
} from "../scripts/check-schema-shape.ts";

/**
 * THE EMPLOYEE-KEY COUNT ONLY RISES (enterprise audit 2026-11-13, F-DB-001, REC-037: "the money, leave
 * and attendance tables all carry the foreign key; the orphan count is zero and stays zero").
 *
 * 20261113160008, 20261113160747 and 20261113161558 put a validated foreign key to
 * public.employees(hr_id) on every money, leave and attendance table, each after an orphan count of
 * zero. A validated key makes an orphan row impossible, so "stays zero" is "the key stays, and stays
 * validated". tests/employee-key-foreign-keys.test.ts pins the migrations; it cannot see a key dropped
 * or re-added NOT VALID by hand, which is how most of this schema has changed. So:
 *
 *  - here, in the required CI: the committed baseline holds at least MIN_EMPLOYEE_KEYS keys, includes
 *    every money, leave and attendance key, and the nightly gate fires on a key gone or unvalidated;
 *  - every night (Migration Drift Check, staging and production): scripts/check-schema-shape.ts asks
 *    the live database through phx_ci_employee_keys() and fails on a baseline key missing there.
 *
 * Measured 2026-11-13: 112 keys on production, all validated, on 78 tables; staging identical.
 */

// 🔴 THIS NUMBER MAY ONLY RISE. When a migration adds a key, add it to the baseline and raise this in
// the same PR. Lowering it is removing a guard on whose money a row is — the owner is told first.
const MIN_EMPLOYEE_KEYS = 112;

// The money, leave and attendance keys REC-037 is about (its three migrations), as schema.table.column.
const REQUIRED = [
  ...[
    "attendance_annual_balance_charges",
    "attendance_exceptions",
    "attendance_settlements",
    "attendance_weekly_digests",
    "automated_payroll_carry_forward",
    "automated_payroll_draft_cell_history",
    "automated_payroll_draft_rows",
    "automated_payroll_held_entered",
    "automated_payroll_held_part1_unpaid",
    "automated_payroll_held_releases",
    "automated_payroll_held_settlements",
    "automated_payroll_standing_additions",
    "daily_deductions_lines",
    "deductions_candidates",
    "deductions_publication_lines",
    "dispute_refunds",
    "payroll_copilot_adjustments",
    "payroll_copilot_expense_decisions",
    "payroll_copilot_flags",
    "payroll_copilot_vacation_settlements",
    "payroll_recurring_adjustments",
    "v2_vacation_requests",
  ].map((t) => `public.${t}.employee_hr_id`),
  "public.salary_records.hr_id",
  "public.payroll_resignation_candidates.hr_id",
  "public.outstation_expense_requests.medical_trip_hr_id",
];

const key = (name: string, validated = true): EmployeeKey => {
  const [table_schema, table_name, column_name] = name.split(".");
  return { table_schema, table_name, column_name, constraint_name: `${table_name}_${column_name}_fkey`, validated };
};

/** A shape with nothing else wrong, so every violation below is the employee-key gate's own. */
function shapeWith(keys: EmployeeKey[] | undefined): SchemaShape {
  return {
    tables_total: 429,
    tables_rls_enabled: 423,
    tables_force_rls: 0,
    policies_total: 433,
    primary_keys_total: 425,
    unique_total: 100,
    foreign_keys_total: 385,
    check_total: 50,
    indexes_total: 1606,
    triggers_total: 107,
    schema_usage: { anon: true, authenticated: true, service_role: true },
    tables_exposed_without_rls: [],
    tables_rls_disabled: [],
    tables_without_primary_key: [],
    tables_rls_enabled_without_policy: [],
    default_acl_leaks: [],
    private_schema_usage: { anon: false, authenticated: true, service_role: true },
    policies_using_private_schema: 64,
    stale_snapshot_schemas: [],
    snapshot_tables_in_public: [],
    employee_keys: keys,
  };
}

const codes = (shape: SchemaShape, baseline: readonly string[]) =>
  evaluateSchemaShape(shape, { employeeKeyBaseline: baseline })
    .filter((v) => v.code.startsWith("employee_key"))
    .map((v) => `${v.severity}:${v.code}`);

export function runSchemaShapeEmployeeKeysTests() {
  // ---- The baseline: only rises, holds every money/leave/attendance key ----------------------------
  const baseline = readEmployeeKeyBaseline();
  assert.ok(
    baseline.length >= MIN_EMPLOYEE_KEYS,
    `THE EMPLOYEE-KEY COUNT ONLY RISES: the baseline holds ${baseline.length}, the floor is ${MIN_EMPLOYEE_KEYS}. ` +
      "A key taken off the list is a table that can take a row for nobody again, unwatched",
  );
  assert.deepEqual(baseline, [...baseline].sort(), "the baseline stays sorted, so a change to it reads as one line");
  assert.equal(new Set(baseline).size, baseline.length, "no key is listed twice");
  for (const name of baseline) assert.match(name, /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/, name);
  for (const name of REQUIRED) {
    assert.ok(baseline.includes(name), `${name} is a money, leave or attendance key and must stay in the baseline`);
  }

  // ---- The nightly gate --------------------------------------------------------------------------
  const live = baseline.map((name) => key(name));
  assert.deepEqual(codes(shapeWith(live), baseline), [], "the live database as measured: no finding");

  // A key dropped by hand fires, and names it.
  const missing = "public.salary_records.hr_id";
  const withoutOne = live.filter((k) => employeeKeyName(k) !== missing);
  assert.deepEqual(codes(shapeWith(withoutOne), baseline), ["error:employee_key_dropped"], "A DROPPED EMPLOYEE KEY FAILS THE NIGHT");
  const message = evaluateSchemaShape(shapeWith(withoutOne), { employeeKeyBaseline: baseline })
    .find((v) => v.code === "employee_key_dropped")?.message ?? "";
  assert.ok(message.includes(missing), `the finding names the key: ${message}`);

  // A key put back NOT VALID fires: it vouches for nothing already in the table.
  const unvalidated = live.map((k) => (employeeKeyName(k) === missing ? { ...k, validated: false } : k));
  assert.deepEqual(codes(shapeWith(unvalidated), baseline), ["error:employee_key_not_validated"], "A NOT VALID KEY FAILS THE NIGHT");

  // A new key the baseline does not list yet is a warning, never a failure: the night must not go red
  // between a migration being applied and its PR merging.
  const extra = [...live, key("public.some_new_table.employee_hr_id")];
  assert.deepEqual(codes(shapeWith(extra), baseline), ["warning:employee_key_baseline_behind"]);

  // A target that predates the function stays silent rather than inventing a finding.
  assert.deepEqual(codes(shapeWith(undefined), baseline), []);

  // ---- The function and its wiring ---------------------------------------------------------------
  const sql = readFileSync("supabase/migrations/20261113171643_ci_employee_keys.sql", "utf8");
  assert.match(sql, /create or replace function public\.phx_ci_employee_keys\(\)/);
  assert.match(sql, /\bstable\b/, "a read, declared as one");
  assert.match(
    sql,
    /revoke execute on function public\.phx_ci_employee_keys\(\) from public, anon, authenticated;\s*grant execute on function public\.phx_ci_employee_keys\(\) to service_role;/,
    "SECURITY DEFINER over the catalogue: never callable with the key that ships in the browser",
  );
  const body = sql.slice(sql.indexOf("as $$"), sql.lastIndexOf("$$;"));
  assert.doesNotMatch(body, /\b(insert|update|delete|truncate|alter|drop)\b/i, "the function only reads");

  const script = readFileSync("scripts/check-schema-shape.ts", "utf8");
  assert.match(script, /supabase\.rpc\("phx_ci_employee_keys"\)/, "the nightly check asks the live database");
}
