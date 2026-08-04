import { strict as assert } from "node:assert";

import {
  buildPayrollExpenseDsmSummaries,
  summarizePayrollExpenses,
} from "../src/lib/outstation/expense-metrics.ts";
import type { PayrollExpenseApproval } from "../src/lib/payroll/types.ts";

/**
 * Pins the two things that made the outstation expense KPIs lie about money.
 *
 * 1. REJECTED WAS COUNTED AS PENDING. Approval is three-state but only approval lives in
 *    `hr_approved` — a rejection is written to the free-text `status` column
 *    (src/lib/outstation/approval-state.ts). `summarizePayrollExpenses` split on `!hrApproved`,
 *    so the "Pending" KPI on /admin/outstation/expense-command and in the portal's team views
 *    billed every rejected trip as money still awaiting a decision, on the very screens that
 *    render those same trips with a Rejected badge and offer a Rejected filter.
 *
 * 2. TWO DEFINITIONS OF "APPROVED" ON ONE SCREEN. The NSM Team Expenses header card summed the
 *    HR-approved PAYABLE amount while the per-DSM "Approved" column underneath summed the RAW
 *    claim, so an adjusted trip produced two different numbers under one label.
 *
 * The figures below are real production rows (project ozucdzovmcqvepbozvqf, read 2026-08-04),
 * aggregated to keep the fixture readable:
 *   - 88 approved trips, 42,458.82 claimed, 40,829.82 payable — 7 of them cut by HR (1,629.00).
 *   - 241 genuinely pending trips worth 86,408.00.
 *   - 16 rejected trips worth 4,192.00, which the Pending KPI was reporting as 90,600.00.
 *
 * Both directions matter. A "fix" that dropped everything unapproved would pass a rejection-only
 * assertion while hiding the real backlog HR is chasing, so pending is asserted too.
 */

/**
 * `status` is typed `string` on the record, but the column is nullable and
 * `expenseApprovalState` is deliberately typed to accept `string | null | undefined`. The fixture
 * therefore has to be able to model a real NULL, which `Partial<PayrollExpenseApproval>` alone
 * cannot express — `status: null` is a compile error against `string | undefined`.
 */
type ExpenseOverrides = Partial<Omit<PayrollExpenseApproval, "status">> & {
  status?: string | null;
};

function expense(input: ExpenseOverrides): PayrollExpenseApproval {
  const { status, ...rest } = input;

  return {
    allowance: 0,
    amWorkload: 0,
    approvedAmount: null,
    approvedAt: null,
    approvedBy: null,
    date: "2026-06-10T00:00:00.000Z",
    description: "",
    from: "Cairo",
    hr: "",
    hrApproved: false,
    hrComment: "",
    hrId: "B-23",
    hrNotes: "",
    km: 0,
    location: "",
    meetingAmount: 0,
    open: "",
    other: 0,
    payoutMonth: 7,
    payoutYear: 2026,
    pmWorkload: 0,
    reportId: null,
    requestType: "Travel",
    row: 1,
    sourceFileName: "",
    specialist: "Sample DSM",
    to: "Alexandria",
    toDate: "",
    total: 0,
    transportationType: "car",
    travelCost: 0,
    tripId: "",
    tripType: "traveling",
    ...rest,
    // Kept out of the spread so an explicit `null` survives instead of being defaulted away.
    status: (status === undefined ? "" : status) as string,
  };
}

export function runOutstationExpenseApprovalStateMetricsTests() {
  const rows: PayrollExpenseApproval[] = [
    // The 81 approved trips HR never adjusted — claim and payable are the same figure.
    expense({ hrApproved: true, status: "Approved", total: 36939.82, tripId: "TRP-APPROVED-ASIS" }),
    // The 7 approved trips HR cut. These are the rows where "claimed" and "payable" diverge.
    expense({ approvedAmount: 1867, hrApproved: true, status: "Approved", total: 2721, tripId: "TRP-00412" }),
    expense({ approvedAmount: 1114, hrApproved: true, status: "Approved", total: 1439, tripId: "TRP-00455" }),
    expense({ approvedAmount: 585, hrApproved: true, status: "Approved", total: 910, tripId: "TRP-00478" }),
    expense({ approvedAmount: 324, hrApproved: true, status: "Approved", total: 449, tripId: "TRP-00501" }),
    // Undecided: no approval, no rejection. This is the real backlog.
    expense({ hrApproved: false, status: null, total: 86408, tripId: "TRP-PENDING" }),
    // Decided, and decided against. Never paid, never awaiting anything.
    expense({ hrApproved: false, status: "Rejected", total: 4192, tripId: "TRP-REJECTED" }),
  ];

  const summary = summarizePayrollExpenses(rows);

  // ---- defect 1: rejected money is not pending money -----------------------
  // THE HEADLINE ASSERTION. Before the fix this read 90,600.00 — the 4,192.00 of rejected trips
  // was folded into the backlog.
  assert.equal(
    summary.pendingAmount,
    86408,
    "the Pending KPI must exclude rejected trips: 86,408.00 is awaiting a decision and the rejected 4,192.00 never will be, so the card must not report the 90,600.00 that summing every unapproved row produces",
  );
  assert.equal(
    summary.pendingRows,
    1,
    "the 'N awaiting' count follows the same rule — a rejected trip is not awaiting anything, so it must not be queued in the reviewer's backlog",
  );

  // The opposite failure mode: pending must keep flowing. Excluding everything unapproved would
  // hide the backlog entirely and read as a clean queue when HR has 86,408.00 still to decide.
  const pendingOnly = summarizePayrollExpenses([
    expense({ hrApproved: false, status: null, total: 500, tripId: "TRP-P1" }),
    expense({ hrApproved: false, status: "", total: 250, tripId: "TRP-P2" }),
  ]);
  assert.equal(
    pendingOnly.pendingAmount,
    750,
    "a null or blank status is PENDING, not rejected — dropping those rows would report an empty backlog while HR still owes a decision on every one of them",
  );

  // Rejected money must stay visible somewhere rather than silently vanishing between the cards.
  assert.equal(
    summary.totalAmount,
    133058.82,
    "Total Expenses still covers every claim including the rejected 4,192.00 — excluding rejected from Pending must not delete the money from the page",
  );
  assert.equal(summary.totalRows, 7, "every trip is still counted in the total row count");

  // A rejection that was later approved must pay. expenseApprovalState deliberately lets
  // hrApproved win; re-deriving the rule here instead of reusing that helper would break this.
  const unrejected = summarizePayrollExpenses([
    expense({ hrApproved: true, status: "Rejected", total: 600, tripId: "TRP-U1" }),
  ]);
  assert.equal(
    unrejected.approvedAmount,
    600,
    "a stale Rejected status on an approved trip must not strip it from Approved: approval is the newer decision, which is the precedence expenseApprovalState encodes",
  );
  assert.equal(unrejected.pendingAmount, 0, "and it must not reappear in Pending either");

  // ---- defect 2: one meaning of "Approved" per screen ----------------------
  assert.equal(
    summary.approvedAmount,
    40829.82,
    "Approved is the PAYABLE amount — HR's adjusted figure where there is one — because that is the money that actually moves",
  );

  const [dsm] = buildPayrollExpenseDsmSummaries({
    dsms: [{ fullName: "Sample DSM", hrId: "B-23", lineName: "Line A" }],
    expenses: rows,
  });

  // THE HEADLINE ASSERTION for defect 2. The header stat card and the per-DSM table row beneath it
  // are built from these two different functions over the same trips. Before the fix the row summed
  // 42,458.82 of raw claims under a card showing 40,829.82 of payable — 1,629.00 apart, both
  // labelled Approved, stacked on one page.
  assert.equal(
    dsm?.approvedAmount,
    summary.approvedAmount,
    "the per-DSM Approved column and the Approved header card cover the same trips, so they must produce the same number — two figures under one label is what sent an NSM chasing a 1,629.00 discrepancy that did not exist",
  );
  assert.equal(
    dsm?.approvedAmount,
    40829.82,
    "and that shared number is the payable total, not the 42,458.82 the employees originally claimed",
  );

  assert.equal(
    dsm?.pendingAmount,
    86408,
    "the per-DSM Pending column excludes rejected trips for the same reason the header card does",
  );
  assert.equal(dsm?.pendingTrips, 1, "and so does its trip count");
  assert.equal(
    dsm?.approvedTrips,
    5,
    "trip counts are unaffected by the payable rule — reducing an amount does not un-approve the trip",
  );

  // The rejected trip leaves both queues but stays in the DSM's overall activity: the trip was
  // taken, so hiding it from Total Expenses would misstate what the team actually spent effort on.
  assert.equal(dsm?.totalTrips, 7, "a rejected trip still happened and still counts as a trip");
  assert.equal(
    dsm?.totalExpenses,
    133058.82,
    "the DSM's Total Expenses still carries the rejected claim, so Approved + Pending deliberately falls short of it rather than the rejection disappearing without trace",
  );
}
