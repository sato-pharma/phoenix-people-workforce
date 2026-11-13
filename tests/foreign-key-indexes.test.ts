import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * EVERY FOREIGN KEY IN public HAS AN INDEX THAT LEADS WITH ITS COLUMNS (enterprise audit 2026-11-13,
 * F-DB-006, S03).
 *
 * Postgres checks a foreign key from the PARENT's side too: deleting, merging or renaming a parent row
 * has to find every child row naming it, and with no index that is a scan of the child table per row.
 * The advisor's `unindexed_foreign_keys` lint read 59 on production on 2026-11-13 — the audit's 41, plus
 * the 21 keys to employees(hr_id) added that afternoon without one — and 20261113181700 indexed all 59.
 * After it the advisor reported no such lint at all, on production and on staging.
 *
 * This pins the migration's shape: the right count, every employee key it was written for, names that
 * fit Postgres's 63-byte limit (a longer one is silently TRUNCATED, so two could collide and IF NOT
 * EXISTS would skip the second), and statements that can run inside the migration's transaction.
 */

const FILE = "supabase/migrations/20261113181700_index_unindexed_foreign_keys.sql";

// The 21 keys to public.employees(hr_id) that were unindexed, as table.column.
const EMPLOYEE_KEYS = [
  "app_auth_users.test_persona_of_hr_id",
  "attendance_annual_balance_charges.employee_hr_id",
  "automated_payroll_carry_forward.employee_hr_id",
  "automated_payroll_draft_cell_history.employee_hr_id",
  "automated_payroll_draft_rows.employee_hr_id",
  "automated_payroll_held_entered.employee_hr_id",
  "automated_payroll_held_part1_unpaid.employee_hr_id",
  "automated_payroll_held_releases.employee_hr_id",
  "automated_payroll_held_settlements.employee_hr_id",
  "automated_payroll_standing_additions.employee_hr_id",
  "crm_contact_list_changes.decided_by",
  "crm_contact_list_changes.requested_by",
  "crm_native_visit_vacation_day_requests.hr_decided_by",
  "daily_deductions_lines.employee_hr_id",
  "deductions_candidates.employee_hr_id",
  "deductions_publication_lines.employee_hr_id",
  "dispute_refunds.employee_hr_id",
  "outstation_expense_requests.medical_trip_hr_id",
  "payroll_copilot_expense_decisions.employee_hr_id",
  "payroll_copilot_flags.employee_hr_id",
  "payroll_copilot_vacation_settlements.employee_hr_id",
];

// Composite keys: the index must lead with the key's columns IN THE KEY'S ORDER to cover it.
const COMPOSITE: Record<string, string> = {
  source_of_sales_customer_map: "brick_id, area_code, region_code",
  prodplan_alarm_events: "material_id, unit_kind",
  prodplan_expiry_events: "material_id, unit_kind",
  prodplan_material_prices: "material_id, unit_kind",
  prodplan_run_materials: "material_id, unit_kind",
  prodplan_stock_entries: "material_id, unit_kind",
};

const STATEMENT = /create index if not exists ([a-z0-9_]+)\s+on public\.([a-z0-9_]+) \(([a-z0-9_, ]+)\);/g;

export function runForeignKeyIndexesTests() {
  const sql = readFileSync(FILE, "utf8");
  const statements = [...sql.matchAll(STATEMENT)].map(([, name, table, cols]) => ({ name, table, cols }));

  // First, so it names itself rather than surfacing as a short count.
  assert.doesNotMatch(sql, /^\s*create index concurrently/im, "CONCURRENTLY cannot run in a transaction");

  assert.equal(statements.length, 59, "the advisor's 59 unindexed foreign keys, one index each");
  assert.equal((sql.match(/^create /gm) ?? []).length, 59, "nothing created besides the 59 indexes");

  const names = statements.map((s) => s.name);
  assert.equal(new Set(names).size, names.length, "every index name is unique");
  for (const name of names) {
    assert.ok(
      Buffer.byteLength(name) <= 63,
      `${name} is over 63 bytes: Postgres truncates it, and IF NOT EXISTS then skips on the truncated name`,
    );
    assert.match(name, /_fk_idx$/, `${name} says what it is for`);
  }

  const keys = new Set(statements.map((s) => `${s.table}.${s.cols}`));
  for (const key of EMPLOYEE_KEYS) {
    assert.ok(keys.has(key), `${key} is a key to employees(hr_id) and must get its index`);
  }
  for (const [table, cols] of Object.entries(COMPOSITE)) {
    assert.ok(keys.has(`${table}.${cols}`), `${table} (${cols}): a composite key is covered only in its own order`);
  }

  // Runs inside the migration's transaction: CONCURRENTLY cannot, and a lock wait must give up rather
  // than queue every write behind it.
  assert.match(sql, /^begin;\s*\nset local lock_timeout = '5s';/m, "a lock wait gives up after 5 seconds");
  assert.match(sql, /\ncommit;\n$/, "the transaction is closed");
  assert.doesNotMatch(sql.replace(/^--.*$/gm, ""), /\b(drop|alter|delete|update|insert|truncate)\b/i, "indexes only");
}
