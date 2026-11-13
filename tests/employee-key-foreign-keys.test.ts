import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * A PAY, DEDUCTION, LEAVE OR ATTENDANCE ROW MUST NAME A REAL EMPLOYEE (enterprise audit 2026-11-13,
 * F-DB-001, REC-037 slice 1).
 *
 * hr_id is a text key the application normalises in code. Until 20261113160008 none of the payroll-run,
 * deduction, dispute-refund, leave or attendance-settlement tables carried a foreign key to
 * public.employees, so a mistyped or differently-cased id made a row that belonged to nobody, and every
 * report joining on the key dropped it silently. The migration adds 22 keys, each after an orphan count
 * that refuses to proceed — and on staging it did refuse, on two leftover test rows.
 *
 * What a live probe cannot see, and this test pins: the 22 stay listed, the guard stays in front of them,
 * the clause stays CASCADE/RESTRICT, and no LATER migration drops or disables one.
 */

const MIGRATIONS = "supabase/migrations";
const FILE = "20261113160008_money_leave_attendance_rows_name_a_real_employee.sql";

const TABLES = [
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
];

export async function runEmployeeKeyForeignKeysTests() {
  const files = readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).sort();
  assert.ok(files.includes(FILE), `the migration must still be here: ${FILE}`);
  const body = readFileSync(path.join(MIGRATIONS, FILE), "utf8");

  // ---- HEADLINE: every money, leave and attendance table named, each exactly once -----------------
  const pairs = [...body.matchAll(/array\['([a-z_0-9]+)',\s*'employee_hr_id'\]/g)].map((m) => m[1]);
  assert.deepEqual(
    [...pairs].sort(),
    [...TABLES].sort(),
    "the 22 tables whose rows say WHOSE money, leave or attendance it is must each carry the key — a table " +
      "taken off this list goes back to accepting a row for nobody",
  );
  assert.equal(new Set(pairs).size, pairs.length, "no table is listed twice");

  // ---- The orphan count runs FIRST and refuses ---------------------------------------------------
  const guardAt = body.indexOf("not exists (select 1 from public.employees e where e.hr_id = t.%I)");
  const addAt = body.indexOf("add constraint %I foreign key");
  assert.ok(guardAt > 0, "the orphan count must stay");
  assert.ok(addAt > guardAt, "the orphan count must run before any key is added");
  assert.match(body, /raise exception 'public\.%\.% holds % row\(s\) naming no employee/);

  // ---- The clause and the two-step add ------------------------------------------------------------
  assert.match(
    body,
    /references public\.employees \(hr_id\) on update cascade on delete restrict not valid/,
    "ON DELETE RESTRICT: a person with pay or leave rows can never be deleted out from under them; " +
      "CASCADE on update keeps a corrected id attached; NOT VALID then VALIDATE keeps the lock short",
  );
  assert.match(body, /alter table public\.%I validate constraint %I/);

  // ---- Nothing LATER takes a key off --------------------------------------------------------------
  for (const name of files.filter((file) => file > FILE)) {
    const later = readFileSync(path.join(MIGRATIONS, name), "utf8").toLowerCase();
    for (const table of TABLES) {
      assert.ok(
        !later.includes(`drop constraint ${table}_phx_employee_fkey`) &&
          !later.includes(`drop constraint if exists ${table}_phx_employee_fkey`),
        `${name} drops the employee key on ${table}. Removing it is a decision the owner is told about ` +
          `first, never a line inside another migration`,
      );
    }
  }

  // ---- No ledger row, so it needs its evidenced exception ----------------------------------------
  const inventory = readFileSync("scripts/lib/migration-inventory.ts", "utf8");
  assert.ok(inventory.includes(`"${FILE}",`), `${FILE} needs its ACKNOWLEDGED_EXCEPTIONS entry`);
}
