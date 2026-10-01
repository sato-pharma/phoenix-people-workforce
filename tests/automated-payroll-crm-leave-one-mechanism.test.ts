import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { approvedPaidDaysInPeriod } from "../src/lib/vacation/service.ts";
import { fakeSupabaseClient } from "./fixtures/fake-supabase-table.ts";

/**
 * A CRM LEAVE DAY REACHES A LEAVE BALANCE BY EXACTLY ONE PATH.
 *
 * THE RULE (owner, 2026-07-21, mechanism settled 2026-10-01). A vacation day, whether it came from
 * a formal Phoenix request or from the CRM, subtracts from the leave balance first; salary covers
 * only what the balance cannot. The owner's decision on HOW: `scripts/import-crm-vacation-backfill.ts`
 * imports each CRM vacation signal as a real Phoenix request in `v2_vacation_requests`, through the
 * same balance engine the admin UI uses, behind three guards — hire-date attribution (a CRM account
 * is a SEAT the vendor renames to its next occupant), national-holiday adjacency, and overlap
 * containment against an existing request. It has done so all year: 468 requests, 415 days,
 * January–August 2026, imported 2026-08-03 and 2026-08-24.
 *
 * WHY A SECOND MECHANISM IS NOT AN ALTERNATIVE BUT A DOUBLE CHARGE. Automated payroll's Part 2
 * Vacation confirm used to ALSO write a `payroll_copilot_vacation_settlements` row per employee.
 * `approvedPaidDaysInPeriod` sums requestDays + settledDays + attendanceDays, so a settlement row
 * and an imported request covering the same day are BOTH charged against the balance. That is not
 * hypothetical — production carries such a pair, and the first half of this test proves the double
 * count arithmetically rather than by assertion about intent.
 *
 * WHAT THE WRITE ACTUALLY DID BEFORE IT WAS REMOVED. It set `run_id` to an `automated_payroll_runs`
 * id while the column is a foreign key onto `payroll_copilot_runs`, so every insert was refused
 * `23503`, logged, and skipped — no automated run has ever written a row. Worse, the supersede ran
 * FIRST, was scoped to `employee_hr_id_compact` + `start_date` alone, and its error was discarded:
 * each confirm retired whatever live row held that slot and replaced it with nothing. On
 * 2026-08-04 07:49:03 Cairo the July run retired Khaled Mohamed Ali Bedair's 1.00-day balance
 * settlement of 2026-07-12, written by `system:crm-correction-2026-07-21`. All 8 `p2_vacation`
 * confirms on production recorded `crmLeaveBalanceSettled` null.
 *
 * So the pin is in two halves: the arithmetic that makes two mechanisms wrong, and the source
 * assertion that the payroll confirm has no settlement write to be the second one.
 */

const PERIOD = { periodEnd: "2026-08-01", periodStart: "2026-07-01" };

/** Reads only `.from`; the fixture is a tiny query engine, cast at the boundary as its siblings do. */
function balanceTables(tables: Record<string, Array<Record<string, unknown>>>) {
  return fakeSupabaseClient(tables) as never;
}

export async function runAutomatedPayrollCrmLeaveOneMechanismTests() {
  // ---- HEADLINE: THE SAME DAY, COUNTED BY BOTH MECHANISMS, IS CHARGED TWICE -------------------
  //
  // Modelled on production: B-185's three CRM leave days of July 2026 exist as imported Phoenix
  // requests totalling 2.00 paid days (0.50 on the 9th, 1.00 on the 14th, 0.50 on the 16th) AND as
  // one live `balance` settlement for 2.00 days anchored on the 9th.
  const bothMechanisms = balanceTables({
    v2_vacation_requests: [
      { id: "req-09", employee_hr_id: "B-185", status: "approved", vacation_type: "annual", start_date: "2026-07-09", duration_days: 0.5, paid_duration_days: 0.5, payment_status: "paid" },
      { id: "req-14", employee_hr_id: "B-185", status: "approved", vacation_type: "annual", start_date: "2026-07-14", duration_days: 1, paid_duration_days: 1, payment_status: "paid" },
      { id: "req-16", employee_hr_id: "B-185", status: "approved", vacation_type: "annual", start_date: "2026-07-16", duration_days: 0.5, paid_duration_days: 0.5, payment_status: "paid" },
    ],
    payroll_copilot_vacation_settlements: [
      { employee_hr_id_compact: "b185", settlement_method: "balance", superseded_at: null, start_date: "2026-07-09", balance_days_consumed: 2, run_id: null },
    ],
    vacation_attendance_charges: [],
  });
  const doubleCharged = await approvedPaidDaysInPeriod(
    { employeeHrId: "B-185", vacationType: "annual", ...PERIOD },
    bothMechanisms,
  );
  assert.equal(
    doubleCharged,
    4,
    "2.00 days of real leave, held by BOTH mechanisms, is charged as 4.00 — approvedPaidDaysInPeriod sums "
      + "requestDays + settledDays, so a settlement row and an imported request for the same day are both taken. "
      + "This is the arithmetic that makes 'turn the ledger on as well' wrong, not merely redundant",
  );

  // ---- THE IMPORTER ALONE CHARGES THE DAYS ONCE ----------------------------------------------
  const importerOnly = balanceTables({
    v2_vacation_requests: [
      { id: "req-09", employee_hr_id: "B-185", status: "approved", vacation_type: "annual", start_date: "2026-07-09", duration_days: 0.5, paid_duration_days: 0.5, payment_status: "paid" },
      { id: "req-14", employee_hr_id: "B-185", status: "approved", vacation_type: "annual", start_date: "2026-07-14", duration_days: 1, paid_duration_days: 1, payment_status: "paid" },
      { id: "req-16", employee_hr_id: "B-185", status: "approved", vacation_type: "annual", start_date: "2026-07-16", duration_days: 0.5, paid_duration_days: 0.5, payment_status: "paid" },
    ],
    payroll_copilot_vacation_settlements: [],
    vacation_attendance_charges: [],
  });
  assert.equal(
    await approvedPaidDaysInPeriod({ employeeHrId: "B-185", vacationType: "annual", ...PERIOD }, importerOnly),
    2,
    "the importer's three requests charge exactly the 2.00 days taken — one mechanism, counted once",
  );

  // ---- A COPILOT SETTLEMENT STILL COUNTS -----------------------------------------------------
  // The ledger is NOT dead data. The Payroll Copilot's own Unpaid Vacation tab writes to it, and
  // those rows must keep reducing the balance. Removing the payroll confirm's write must not be
  // read as a licence to stop summing the table.
  const copilotOnly = balanceTables({
    v2_vacation_requests: [],
    payroll_copilot_vacation_settlements: [
      { employee_hr_id_compact: "b185", settlement_method: "balance", superseded_at: null, start_date: "2026-07-09", balance_days_consumed: 2, run_id: "copilot-run" },
    ],
    vacation_attendance_charges: [],
  });
  assert.equal(
    await approvedPaidDaysInPeriod({ employeeHrId: "B-185", vacationType: "annual", ...PERIOD }, copilotOnly),
    2,
    "a Copilot-decided settlement still counts against the balance — the ledger keeps its own writer",
  );

  // ---- THE PAYROLL CONFIRM HAS NO SETTLEMENT WRITE TO BE THE SECOND MECHANISM ------------------
  // Comments stripped, so this file's own account of the removed function cannot satisfy a match.
  const runService = stripComments(readFileSync("src/lib/automated-payroll/run-service.ts", "utf8"));
  assert.equal(
    runService.includes("payroll_copilot_vacation_settlements"),
    false,
    "automated payroll's run service must not name payroll_copilot_vacation_settlements at all — the importer "
      + "owns that ledger's CRM-sourced rows",
  );
  assert.equal(
    runService.includes("settleCrmLeaveBalanceForPeriod"),
    false,
    "the removed settlement write must not come back into the confirm path: its foreign key never permitted an "
      + "insert, and its unscoped supersede destroyed live rows it could not replace",
  );
  assert.equal(
    runService.includes("crmLeaveBalanceSettled"),
    false,
    "and no step summary may claim a CRM leave balance was settled by the run",
  );

  const recommend = stripComments(readFileSync("src/lib/automated-payroll/recommend.ts", "utf8"));
  assert.equal(
    recommend.includes("payroll_copilot_vacation_settlements"),
    false,
    "automated payroll must not write the leave-balance ledger from anywhere — a CRM leave day reaches a balance "
      + "through scripts/import-crm-vacation-backfill.ts and nothing else (owner, 2026-10-01)",
  );

  // ---- THE IMPORTER KEEPS THE THREE GUARDS THAT MAKE IT THE SAFE PATH -------------------------
  // It is the safe path BECAUSE of these, not by default. The owner's holiday protection of
  // 2026-09-16 now sits here, in front of the write that actually happens.
  const importer = stripComments(readFileSync("scripts/import-crm-vacation-backfill.ts", "utf8"));
  for (const guard of [
    "refuseLeaveBeforeHire",
    "validateOfficialHolidayAdjacency",
    "createVacationRequestAsAdmin",
  ]) {
    assert.ok(
      importer.includes(guard),
      `the CRM vacation importer must keep ${guard} — it is the only path CRM leave reaches a balance by, so `
        + "its guards are the whole protection: hire-date attribution against CRM seat reuse, national-holiday "
        + "adjacency (owner, 2026-09-16), and the shared balance engine rather than a raw insert",
    );
  }

  console.log("  automated payroll CRM leave one mechanism: 10 assertions passed");
}
