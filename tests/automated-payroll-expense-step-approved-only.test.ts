import assert from "node:assert/strict";

import {
  buildExpenseStepRows,
  type PayoutExpenseTrip,
  type PopulationMember,
} from "../src/lib/automated-payroll/recommend.ts";
import { STEP_DEFINITIONS } from "../src/lib/automated-payroll/step-definitions.ts";
import type { DraftRow } from "../src/lib/automated-payroll/types.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";

/**
 * THE OUTSTATION EXPENSES STEP PROPOSES WHAT HR APPROVED, NOT WHAT IT FOUND.
 * Owner decision 2026-09-08.
 *
 * The step used to sum every trip the feeder returned — approved or merely undecided — because
 * the wizard was treated as the approval point and HR was expected to zero anything that should
 * not pay. Measured on production ozucdzovmcqvepbozvqf that day, the September 2026 payout held
 * 10 approved trips worth 8,806.31 and 12 undecided ones worth 5,823.07, so the step would have
 * proposed 14,629.38 — 66% above what the owner had approved on the Expense Approvals page. He
 * reported exactly that mismatch, and had already responded to it by hand-typing all 15 expense
 * figures of the published August run rather than using the step.
 *
 * THE SAFETY PROPERTY IS THAT THE UNDECIDED MONEY STAYS VISIBLE. Excluding it from the proposal
 * while also hiding it would be indistinguishable from auto-rejecting it, and the owner's standing
 * rule is that the system flags an expense and never auto-rejects one. So the trips remain in the
 * breakdown and their value is subtotalled into the "Awaiting Decision" context column — the
 * assertions below pin BOTH halves, because a change that dropped them entirely would satisfy the
 * headline figure and quietly underpay people.
 *
 * The rejection half is upstream in buildPayoutExpenseTripMap and is NOT touched by this — see
 * tests/automated-payroll-rejected-expenses.test.ts, whose assertions are all on the trip map.
 */

function member(hrId: string, fullName: string): PopulationMember {
  return {
    employee: { hrId, fullName, hireDate: "2024-01-01" } as unknown as EmployeeDirectoryRow,
    compact: hrId.toLowerCase().replace(/[^a-z0-9]+/g, ""),
    lifecycle: "regular",
    lastWorkingDate: null,
    noticeLastWorkingDate: null,
    unpaidDaysInSpan: 0,
  };
}

function trip(overrides: Partial<PayoutExpenseTrip> = {}): PayoutExpenseTrip {
  return {
    tripId: "T-1",
    expenseDate: "2026-08-05",
    toDate: "2026-08-05",
    fromLocation: "Cairo",
    toLocation: "Alexandria",
    tripType: "traveling",
    transportationType: "Car",
    km: 220,
    travelCost: 400,
    meetingAmount: 0,
    allowance: 100,
    otherAmount: 0,
    total: 500,
    approvedAmount: null,
    hrApproved: true,
    hrStatus: "",
    description: "",
    ...overrides,
  };
}

function tripsFor(hrId: string, trips: PayoutExpenseTrip[]): Map<string, PayoutExpenseTrip[]> {
  return new Map([[hrId.toLowerCase().replace(/[^a-z0-9]+/g, ""), trips]]);
}

const noDrafts = new Map<string, DraftRow>();

export function runAutomatedPayrollExpenseStepApprovedOnlyTests() {
  // ---- the live September 2026 shape that prompted the change -------------------------------
  // Dina Hamdy Fadel Mohamed Bdair (B-12) carried two trips into the September payout:
  // OUTSTATION-99 approved at 541.90, and OUTSTATION-50 still undecided at 341.68.
  const dina = [
    trip({ tripId: "OUTSTATION-99", total: 541.9, hrApproved: true, expenseDate: "2026-08-24" }),
    trip({ tripId: "OUTSTATION-50", total: 341.68, hrApproved: false, expenseDate: "2026-08-05" }),
  ];
  const [dinaRow] = buildExpenseStepRows([member("B-12", "Dina Hamdy Fadel Mohamed Bdair")], tripsFor("B-12", dina), noDrafts);

  assert.ok(dinaRow, "an employee with trips must still produce a row");
  assert.equal(
    dinaRow.recommended.expenses,
    541.9,
    "THE HEADLINE: the step proposes only the approved trip — 541.90, never the 883.58 that summing both produces",
  );
  assert.equal(
    dinaRow.values.expenses,
    541.9,
    "with no saved draft the proposed figure is what the box shows",
  );
  assert.equal(
    dinaRow.context["Awaiting Decision"],
    341.68,
    "the undecided trip's value is surfaced, not discarded — this is what stops the exclusion reading as a refusal",
  );
  assert.equal(dinaRow.context.Trips, 2, "the trip COUNT still covers every trip, decided or not");
  assert.equal(
    (dinaRow.details ?? []).length,
    2,
    "both trips stay in the breakdown: HR must be able to see the one that is not being paid",
  );
  assert.equal(
    (dinaRow.details ?? []).find((line) => line["Trip ID"] === "OUTSTATION-50")?.["HR Approved"],
    "Not yet approved",
    "and the undecided trip says so on its own line",
  );

  // ---- an employee whose trips are ALL undecided -------------------------------------------
  // The dangerous case: proposing 0 is correct, but the row must still render, or the money is
  // invisible AND unpaid — the failure mode the visible-subtotal rule exists to prevent.
  const allPending = [
    trip({ tripId: "OUTSTATION-58", total: 344.6, hrApproved: false }),
    trip({ tripId: "OUTSTATION-59", total: 369.8, hrApproved: false }),
  ];
  const [pendingRow] = buildExpenseStepRows([member("B-119", "Saad Mohamed Saad Salama")], tripsFor("B-119", allPending), noDrafts);

  assert.ok(pendingRow, "an employee with only undecided trips must STILL be listed — a missing row is money nobody can see");
  assert.equal(pendingRow.recommended.expenses, 0, "nothing approved means nothing proposed");
  assert.equal(
    pendingRow.context["Awaiting Decision"],
    714.4,
    "the full undecided value is on the row, so the omission is legible rather than silent",
  );
  assert.equal((pendingRow.details ?? []).length, 2, "and every undecided trip is still expandable");

  // ---- HR's reduced amount still wins on an APPROVED trip -----------------------------------
  const reduced = [
    trip({ tripId: "OUTSTATION-56", total: 1160, approvedAmount: 1035, hrApproved: true }),
    trip({ tripId: "OUTSTATION-54", total: 1445, approvedAmount: 1120, hrApproved: true }),
    trip({ tripId: "OUTSTATION-55", total: 510.56, approvedAmount: null, hrApproved: true }),
  ];
  const [nahed] = buildExpenseStepRows([member("A-10", "Nahed Tarek Hassan Omar Hattab")], tripsFor("A-10", reduced), noDrafts);

  assert.equal(
    nahed.recommended.expenses,
    2665.56,
    "narrowing to approved trips must not disturb the approved-amount rule: 1,035 + 1,120 + the untouched 510.56",
  );
  assert.equal(nahed.context["Awaiting Decision"], 0, "nothing is waiting when every trip is decided");

  // ---- a saved draft still wins over the proposal -------------------------------------------
  // HR typing a figure is the override that has always existed, and it must survive this change —
  // it is the path the owner used for all 15 rows of the August run.
  const drafts = new Map<string, DraftRow>([
    ["b12", { expenses: 900, expensesNote: "agreed with the DM" } as unknown as DraftRow],
  ]);
  const [dinaOverridden] = buildExpenseStepRows([member("B-12", "Dina Hamdy Fadel Mohamed Bdair")], tripsFor("B-12", dina), drafts);

  assert.equal(dinaOverridden.values.expenses, 900, "a hand-typed figure still beats the proposal");
  assert.equal(
    dinaOverridden.recommended.expenses,
    541.9,
    "and the proposal stays visible underneath it, so the grid's diff/reset still means something",
  );

  // ---- the column must be DECLARED, or the value renders nowhere ----------------------------
  // `Trips` shipped populated-but-undeclared once and was blank in the grid, the mobile card and
  // the xlsx for weeks. The same mistake in reverse would make this subtotal invisible, which is
  // precisely the state this change exists to avoid.
  const declared = STEP_DEFINITIONS.p2_expenses.contextColumns.find((column) => column.key === "Awaiting Decision");
  assert.ok(declared, "the step must DECLARE the Awaiting Decision column or the subtotal renders nowhere");
  assert.equal(declared?.money, true, "and declare it as money, so the grid and the xlsx both currency-format it");
  assert.ok(
    !STEP_DEFINITIONS.p2_expenses.subtitle.includes("INCLUDED here"),
    "the subtitle must no longer tell HR that undecided rows are included in the figure",
  );
}
