import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  describeExpenseResyncNotApplied,
  expenseDecisionsThatChanged,
  type ExpenseDecisionSnapshot,
} from "../src/lib/automated-payroll/expense-resync.ts";
import {
  buildExpenseStepRows,
  type PayoutExpenseTrip,
  type PopulationMember,
} from "../src/lib/automated-payroll/recommend.ts";
import type { DraftRow } from "../src/lib/automated-payroll/types.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";

/**
 * FOUR WAYS OUTSTATION MONEY LEFT THE PAYROLL PICTURE WITHOUT A WORD.
 *
 *   35 — a failed expense read showed the step as "nobody travelled", and the run paid no reimbursement.
 *   44 — one approvals save covering two payout months wiped a hand-typed figure in the month where
 *        nothing of that person's had moved.
 *   45 — approved trips for someone outside the run were skipped with no row, counter or warning.
 *   47 — a decision that could not reach payroll because Part 2 was already confirmed was reported to
 *        nobody, and the approvals page said "Approvals saved".
 */

function bodyOf(source: string, signature: string, limit = 12000): string {
  const start = source.indexOf(signature);
  const end = source.indexOf("\nexport ", start + 10);
  assert.ok(start >= 0 && end > start, `${signature} and its end must be found`);
  const body = source.slice(start, end);
  assert.ok(body.length < limit, `the slice for ${signature} must stay bounded (got ${body.length})`);
  return body;
}

function snapshot(overrides: Partial<ExpenseDecisionSnapshot> & { tripId: string; hrId: string }): ExpenseDecisionSnapshot {
  return { approvedAmount: null, hrApproved: true, payoutMonth: 7, payoutYear: 2026, status: "Approved", total: 0, ...overrides };
}

function member(hrId: string, fullName: string): PopulationMember {
  return {
    employee: { hrId, fullName, hireDate: "2024-01-01" } as unknown as EmployeeDirectoryRow,
    compact: hrId.toLowerCase().replace(/[^a-z0-9]+/g, ""),
    lifecycle: "regular",
    lastWorkingDate: null,
    noticeLastWorkingDate: null,
  };
}

function trip(overrides: Partial<PayoutExpenseTrip> = {}): PayoutExpenseTrip {
  return {
    tripId: "T-1", expenseDate: "2026-08-05", toDate: "2026-08-05", fromLocation: "Cairo",
    toLocation: "Alexandria", tripType: "traveling", transportationType: "Car", km: 220, travelCost: 400,
    meetingAmount: 0, allowance: 100, otherAmount: 0, total: 500, approvedAmount: null, hrApproved: true,
    hrStatus: "", description: "", ...overrides,
  };
}

export function runAutomatedPayrollExpenseGapsTests() {
  // ==== 35: a failed expense read stops the step, it does not empty it ============================
  const recommend = readFileSync("src/lib/automated-payroll/recommend.ts", "utf8");
  assert.ok(!recommend.includes("Defensive: empty map on any failure"), "the loader no longer promises an empty map on failure");
  const loader = bodyOf(recommend, "async function loadPayoutExpenseTrips(", 6000);
  assert.equal(
    (loader.match(/throw new ExpenseSourceUnavailableError\(period\)/g) ?? []).length,
    2,
    "HEADLINE: both a read that errors and a read that throws must refuse, never return what was collected",
  );
  assert.equal(
    (loader.match(/return buildPayoutExpenseTripMap\(collected\)/g) ?? []).length,
    1,
    "the collected trips are returned only once, after every page read succeeded",
  );
  assert.match(loader, /super\(\s*`Conflict: the outstation expenses for/, "the refusal is a 409 whose words reach the step");

  // ==== 44: an employee is cleared only in the payout month their decision moved in ===============
  const twoMonths = expenseDecisionsThatChanged(
    [
      snapshot({ tripId: "T-JUL", hrId: "B-1", total: 400, payoutMonth: 7 }),
      snapshot({ tripId: "T-AUG", hrId: "B-2", total: 300, payoutMonth: 8 }),
      snapshot({ tripId: "T-AUG-1", hrId: "B-1", total: 250, payoutMonth: 8 }),
    ],
    [
      snapshot({ tripId: "T-JUL", hrId: "B-1", total: 400, payoutMonth: 7, approvedAmount: 350 }),
      snapshot({ tripId: "T-AUG", hrId: "B-2", total: 300, payoutMonth: 8, hrApproved: false, status: "Rejected" }),
      snapshot({ tripId: "T-AUG-1", hrId: "B-1", total: 250, payoutMonth: 8 }),
    ],
  );
  assert.deepEqual(
    Object.fromEntries(twoMonths.byPeriod.map((period) => [period.month, [...period.hrIds].sort()])),
    { 7: ["B-1"], 8: ["B-2"] },
    "HEADLINE: B-1 moved only in July and B-2 only in August; clearing both in both months wiped B-1's untouched August figure",
  );
  const moved = expenseDecisionsThatChanged(
    [snapshot({ tripId: "T-M", hrId: "B-5", total: 400, payoutMonth: 7 })],
    [snapshot({ tripId: "T-M", hrId: "B-5", total: 400, payoutMonth: 8 })],
  );
  assert.deepEqual(
    moved.byPeriod.map((period) => `${period.month}:${period.hrIds.join(",")}`).sort(),
    ["7:B-5", "8:B-5"],
    "a trip that moved months still clears its person in both the month it left and the month it joined",
  );
  const resyncSource = readFileSync("src/lib/automated-payroll/expense-resync.ts", "utf8");
  const resyncBody = bodyOf(resyncSource, "export async function resyncPayrollExpenseStep(");
  assert.match(resyncBody, /for \(const period of target\.byPeriod\)/, "the resync walks the paired list");
  assert.match(resyncBody, /clearDraftExpenses\(run\.id, period\.hrIds\)/, "and clears only that period's people");
  assert.doesNotMatch(resyncBody, /clearDraftExpenses\(run\.id, target\.hrIds\)/, "never every changed person in every period");

  // ==== 45: trips for someone outside the run are shown, read-only, never dropped ================
  const outsideTrips = new Map<string, PayoutExpenseTrip[]>([
    [
      "b9",
      [
        trip({ tripId: "T-9", total: 1400, hrApproved: true, hrId: "B-9", specialist: "Karim Nabil" }),
        trip({ tripId: "T-10", total: 2000, hrApproved: false, hrId: "B-9", specialist: "Karim Nabil" }),
      ],
    ],
  ]);
  const rows = buildExpenseStepRows([member("B-1", "Stays In")], outsideTrips, new Map<string, DraftRow>());
  const outside = rows.find((row) => row.hrId === "B-9");
  assert.ok(outside, "HEADLINE: approved trips for someone outside the run must produce a row, not vanish");
  assert.equal(outside!.readOnly, true, "shown read-only: the step never pays someone the run does not carry");
  assert.deepEqual(outside!.values, {}, "and it carries no values, so confirming the step writes nothing for them");
  assert.equal(outside!.fullName, "Karim Nabil", "named from the trip itself, since there is no population member");
  assert.match(outside!.readOnlyNote ?? "", /EGP 1,400\.00 approved/, "the note says how much approved money is waiting");
  assert.match(outside!.readOnlyNote ?? "", /EGP 2,000\.00 awaiting decision/, "and how much is still undecided");
  assert.equal(outside!.details?.length, 2, "and lists both trips");

  const runService = readFileSync("src/lib/automated-payroll/run-service.ts", "utf8");
  assert.match(
    bodyOf(runService, "export function summarizeStep("),
    /allRows\.filter\(\(row\) => !row\.readOnly\)/,
    "the confirm record counts only rows it writes, not read-only rows",
  );

  // ==== 47: a decision that did not reach payroll is said out loud =================================
  const lines = describeExpenseResyncNotApplied([
    { action: "resync", month: 9, year: 2026, runId: "run-9", clearedHrIds: ["B-1"], reopenedStep: true },
    { action: "skip", month: 9, year: 2026, reason: "no_active_run" },
    { action: "skip", month: 8, year: 2026, reason: "part2_already_confirmed" },
    { action: "failed", month: 10, year: 2026, message: "connection reset" },
  ]);
  assert.equal(lines.length, 2, "a resync and an ordinary no-open-run skip say nothing; the other two do");
  assert.match(lines[0], /August 2026 already has Part 2 confirmed/, "HEADLINE: a confirmed Part 2 that ignored the decision is named");
  assert.match(lines[1], /October 2026 could not be updated/, "and a failed resync is named too");

  assert.match(resyncBody, /automated_payroll_expense_resync_skipped_part2_confirmed/, "the Part 2 skip is logged, not silent");
  const expenses = readFileSync("src/lib/outstation/expenses.ts", "utf8");
  assert.match(expenses, /return await resyncPayrollExpenseStep\(target\);/, "the wrapper returns the outcomes instead of discarding them");
  assert.match(expenses, /options\?\.onPayrollResync\?\.\(payrollResync\);/, "the save hands them back to its caller");
  assert.ok(
    expenses.includes("written.map((row) => toExpenseDecisionSnapshot(row))"),
    "the snapshot call another test pins word for word must survive",
  );
  const route = readFileSync("app/api/admin/outstation/expenses/route.ts", "utf8");
  assert.match(
    route,
    /payrollWarnings: describeExpenseResyncNotApplied\(payrollResync\)/,
    "the approvals save response carries the warnings",
  );
}
