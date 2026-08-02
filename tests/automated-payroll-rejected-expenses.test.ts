import assert from "node:assert/strict";

import {
  buildPayoutExpenseTripMap,
  payoutExpenseRowIsPayable,
  type PayoutExpenseRow,
  type PayoutExpenseTrip,
} from "../src/lib/automated-payroll/recommend.ts";
import { payableExpenseAmount } from "../src/lib/outstation/payable.ts";
import { compactHrKey } from "../src/lib/payroll/copilot/feeders.ts";

/**
 * Pins the one thing that made an HR rejection cost money instead of saving it.
 *
 * Outstation approval is THREE-state, but only approval lives in `hr_approved`: a rejection is
 * written to the free-text `status` column instead (src/lib/outstation/approval-state.ts). The
 * Part-2 expense feeder selected neither `status` nor filtered on it, so a trip HR had explicitly
 * REJECTED on /admin/outstation/expense-approvals was summed at its FULL CLAIMED amount — the
 * rejection changed the approvals screen and nothing else.
 *
 * Verified in production 2026-08-02 (project ozucdzovmcqvepbozvqf): ten never-imported rejected
 * trips worth 2,121 EGP, three of them (1,265 EGP) tagged for the July 2026 payout — whose run
 * was sitting in Part 2, the exact phase that pulls expenses, at the time. The figures below are
 * those real rows.
 *
 * PENDING rows must KEEP flowing through: the wizard is deliberately the approval point, and
 * silently dropping pending trips here would under-reimburse instead of over-reimburse. That is
 * why the test asserts both directions — a fix that excluded everything unapproved would pass a
 * rejection-only test while quietly costing employees money.
 */

function expenseRow(overrides: Partial<PayoutExpenseRow> & { hr_id: string }): PayoutExpenseRow {
  return {
    allowance: 0,
    approved_amount: null,
    description: "",
    expense_date: "2026-06-03",
    from_location: "Cairo",
    hr_approved: false,
    hr_status: "",
    km: 0,
    location: null,
    meeting_amount: 0,
    other_amount: 0,
    status: null,
    to_date: "2026-06-03",
    to_location: "Alexandria",
    total: 0,
    transportation_type: "car",
    travel_cost: 0,
    trip_id: "TRP-TEST",
    trip_type: "traveling",
    ...overrides,
  };
}

/** What the sheet would actually reimburse this employee. */
function payableFor(map: Map<string, PayoutExpenseTrip[]>, hrId: string): number {
  const trips = map.get(compactHrKey(hrId)) ?? [];
  const total = trips.reduce((sum, trip) => sum + payableExpenseAmount(trip.approvedAmount, trip.total), 0);
  return Math.round(total * 100) / 100;
}

export function runAutomatedPayrollRejectedExpensesTests() {
  // ---- the real July 2026 rows that exposed this ---------------------------
  // Ahmed Hekal (B-5): two 427 duplicates rejected, 1,953 of genuine expense.
  // Taha Mohamed (B-94): one 411 trip rejected, 870 of genuine expense.
  const rows: PayoutExpenseRow[] = [
    expenseRow({ hr_id: "B-5", trip_id: "TRP-00281", total: 427, status: "Rejected", hr_approved: false }),
    expenseRow({ hr_id: "B-5", trip_id: "TRP-00283", total: 427, status: "Rejected", hr_approved: false }),
    expenseRow({ hr_id: "B-5", trip_id: "TRP-00290", total: 1000, hr_approved: true, status: "Approved" }),
    expenseRow({ hr_id: "B-5", trip_id: "TRP-00291", total: 953, hr_approved: false, status: null }),
    expenseRow({ hr_id: "B-94", trip_id: "TRP-00341", total: 411, status: "Rejected", hr_approved: false }),
    expenseRow({ hr_id: "B-94", trip_id: "TRP-00350", total: 870, hr_approved: true, status: "Approved" }),
  ];

  const map = buildPayoutExpenseTripMap(rows);

  // THE HEADLINE ASSERTION. Before the fix this was 2,807 — the two rejected 427 duplicates
  // were reimbursed in full alongside the genuine 1,953.
  assert.equal(
    payableFor(map, "B-5"),
    1953,
    "a trip HR rejected must not be reimbursed: Ahmed Hekal's two 427 duplicates were rejected, so the sheet must carry 1,953 and not the 2,807 that summing every row produces",
  );
  assert.equal(
    payableFor(map, "B-94"),
    870,
    "Taha Mohamed's 411 trip was rejected as 'No Expense in Greater Cairo', so only the genuine 870 may reach the sheet",
  );

  const hekalTripIds = (map.get(compactHrKey("B-5")) ?? []).map((trip) => trip.tripId);
  assert.ok(!hekalTripIds.includes("TRP-00281"), "a rejected trip must not survive into the breakdown panel either");
  assert.ok(!hekalTripIds.includes("TRP-00283"), "both rejected duplicates must be dropped, not just the first");
  assert.ok(
    hekalTripIds.includes("TRP-00291"),
    "the PENDING trip must still appear — this wizard is the approval point, and dropping pending rows would under-reimburse",
  );

  // ---- pending must keep flowing (the opposite failure mode) ---------------
  const pendingOnly = buildPayoutExpenseTripMap([
    expenseRow({ hr_id: "B-77", trip_id: "TRP-P1", total: 500, hr_approved: false, status: null }),
    expenseRow({ hr_id: "B-77", trip_id: "TRP-P2", total: 250, hr_approved: false, status: "" }),
  ]);
  assert.equal(
    payableFor(pendingOnly, "B-77"),
    750,
    "an unapproved-but-not-rejected trip is PENDING and must still reach the sheet — excluding it would silently underpay every employee whose expenses HR had not clicked through yet",
  );

  // ---- a later approval beats a stale rejection ----------------------------
  // expenseApprovalState deliberately lets hr_approved win, so a trip that was rejected and then
  // approved must pay. Re-deriving the rule here instead of reusing that helper would break this.
  const unrejected = buildPayoutExpenseTripMap([
    expenseRow({ hr_id: "B-31", trip_id: "TRP-U1", total: 600, hr_approved: true, status: "Rejected" }),
  ]);
  assert.equal(
    payableFor(unrejected, "B-31"),
    600,
    "a rejection that was later approved must pay: approval is the newer decision, and this is exactly the precedence expenseApprovalState encodes",
  );

  // ---- HR's reduced amount still wins on a surviving trip ------------------
  const reduced = buildPayoutExpenseTripMap([
    expenseRow({ hr_id: "B-42", trip_id: "TRP-R1", total: 2000, approved_amount: 500, hr_approved: true, status: "Approved" }),
    expenseRow({ hr_id: "B-42", trip_id: "TRP-R2", total: 300, status: "Rejected", hr_approved: false }),
  ]);
  assert.equal(
    payableFor(reduced, "B-42"),
    500,
    "excluding rejected trips must not disturb the approved-amount rule: the 2,000 claim reduced to 500 pays 500, and the rejected 300 pays nothing",
  );

  // ---- the predicate itself, including the shapes production actually stores ----
  assert.equal(payoutExpenseRowIsPayable({ hr_approved: false, status: "Rejected" }), false);
  assert.equal(payoutExpenseRowIsPayable({ hr_approved: false, status: null }), true, "null status is pending, not rejected");
  assert.equal(payoutExpenseRowIsPayable({ hr_approved: false, status: "" }), true, "blank status is pending");
  assert.equal(payoutExpenseRowIsPayable({ hr_approved: true, status: "Approved" }), true);
  assert.equal(
    payoutExpenseRowIsPayable({ hr_approved: false, status: "rejected by hr" }),
    false,
    "rejection is matched as a substring, case-insensitively — more than one surface has written this column over the years",
  );
  assert.equal(
    payoutExpenseRowIsPayable({ hr_approved: null, status: "Rejected" }),
    false,
    "a null hr_approved must not read as approved and resurrect a rejected trip",
  );

  // ---- a zero-value rejected row must not create a phantom trip ------------
  // Three of the ten live rejected rows carry total = 0. They cost nothing, but they would still
  // show up as trips in the employee's breakdown and make a rejected trip look reimbursed.
  const zeroValued = buildPayoutExpenseTripMap([
    expenseRow({ hr_id: "B-12", trip_id: "TRP-009", total: 0, status: "Rejected", hr_approved: false }),
  ]);
  assert.equal(
    (zeroValued.get(compactHrKey("B-12")) ?? []).length,
    0,
    "a rejected trip worth 0 must still be dropped — otherwise it renders in the breakdown as though it were being paid",
  );
}
