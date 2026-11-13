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
const SLICE2 = "20261113160747_leavers_known_only_from_payroll_become_historical_records.sql";
const SLICE2_TABLES = ["payroll_resignation_candidates", "salary_records"];
const RESTORED = ["B-20", "B-21", "B-29", "B-36", "B-44", "B-70", "B-71", "B-87", "B-89", "B-90", "B-93", "B-121", "B-165"];

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
    for (const table of [...TABLES, ...(name > SLICE2 ? SLICE2_TABLES : [])]) {
      assert.ok(
        !later.includes(`drop constraint ${table}_phx_employee_fkey`) &&
          !later.includes(`drop constraint if exists ${table}_phx_employee_fkey`),
        `${name} drops the employee key on ${table}. Removing it is a decision the owner is told about ` +
          `first, never a line inside another migration`,
      );
    }
  }

  // ---- Slice 2: the 13 leavers known only from payroll, then salary history and candidates keyed ---
  assert.ok(files.includes(SLICE2), `the migration must still be here: ${SLICE2}`);
  const slice2 = readFileSync(path.join(MIGRATIONS, SLICE2), "utf8");
  const [insertPart] = slice2.split("do $$");
  const restored = [...insertPart.matchAll(/'(B-\d+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(restored)].sort(), [...RESTORED].sort(), "exactly the 13 leavers are restored");
  assert.match(
    insertPart,
    /'historical_payroll_record', false, false/,
    "the owner chose Historical payroll record, kept off payroll and the organogram — a 'resigned' insert opens " +
      "a replacement vacancy for each person and needs a resignation date 12 of them do not have",
  );
  assert.doesNotMatch(
    insertPart.split("insert into public.employees")[1] ?? "",
    /resignation_date|last_working_date|hire_date/,
    "no date is invented for the restored people",
  );
  const off = insertPart.indexOf("disable trigger phx_employee_insert_reconcile_stale_vacancies");
  const ins = insertPart.indexOf("insert into public.employees");
  const on = insertPart.indexOf("enable trigger phx_employee_insert_reconcile_stale_vacancies");
  assert.ok(off > 0 && off < ins && ins < on, "the vacancy re-reconcile is off for the insert only, and back on after it");
  const pairs2 = [...slice2.matchAll(/array\['([a-z_0-9]+)',\s*'hr_id'\]/g)].map((m) => m[1]);
  assert.deepEqual([...pairs2].sort(), SLICE2_TABLES, "salary history and resignation candidates carry the key");
  assert.ok(
    slice2.indexOf("naming no employee") < slice2.indexOf("add constraint %I foreign key"),
    "the orphan count runs before the key",
  );
  assert.match(slice2, /references public\.employees \(hr_id\) on update cascade on delete restrict not valid/);

  // ---- Slice 3: medical-trip ids stored in the employee's own case, then keyed ------------------------
  const SLICE3 = "20261113161558_medical_trip_ids_name_a_real_employee.sql";
  assert.ok(files.includes(SLICE3), `the migration must still be here: ${SLICE3}`);
  const slice3 = readFileSync(path.join(MIGRATIONS, SLICE3), "utf8");
  const preimage = slice3.indexOf("create table if not exists outstation_backup_20261113.medical_trip_ids_pre_case_repair");
  const repair = slice3.indexOf("set medical_trip_hr_id = o.medical_trip_hr_id");
  const trigger = slice3.indexOf("create trigger phx_outstation_medical_trip_hr_id_canonical");
  const key = slice3.indexOf("add constraint outstation_expense_requests_medical_trip_phx_employee_fkey");
  assert.ok(
    preimage > 0 && preimage < trigger && trigger < repair && repair < key,
    "pre-image first, then the trigger, then the repair through it, then the key",
  );
  assert.match(
    slice3,
    /before insert or update of medical_trip_hr_id on public\.outstation_expense_requests/,
    "the seat model still hands the forms lower-case ids: without the trigger every new medical-trip expense is refused",
  );
  assert.match(
    slice3,
    /new\.medical_trip_hr_id := null;/,
    "an id naming nobody is cleared (the name is kept) so a District Manager's expense is never refused over it",
  );
  assert.match(slice3, /references public\.employees \(hr_id\)\s+on update cascade on delete restrict not valid/);
  for (const name of files.filter((file) => file > SLICE3)) {
    const later = readFileSync(path.join(MIGRATIONS, name), "utf8").toLowerCase();
    assert.ok(
      !later.includes("drop trigger phx_outstation_medical_trip_hr_id_canonical") &&
        !later.includes("drop trigger if exists phx_outstation_medical_trip_hr_id_canonical"),
      `${name} drops the medical-trip canonical trigger — the key then refuses every new medical-trip expense`,
    );
  }

  // ---- No ledger row, so each needs its evidenced exception -------------------------------------
  const inventory = readFileSync("scripts/lib/migration-inventory.ts", "utf8");
  for (const name of [FILE, SLICE2, SLICE3]) {
    assert.ok(inventory.includes(`"${name}",`), `${name} needs its ACKNOWLEDGED_EXCEPTIONS entry`);
  }
}
