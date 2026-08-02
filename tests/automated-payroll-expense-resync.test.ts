import assert from "node:assert/strict";

import {
  expenseDecisionsThatChanged,
  planExpenseResync,
  type ExpenseDecisionSnapshot,
} from "../src/lib/automated-payroll/expense-resync.ts";
import type { MonthlySalaryRun } from "../src/lib/automated-payroll/types.ts";

/**
 * Pins the freeze that made HR's approval decisions invisible to payroll.
 *
 * The payroll Expenses step is a SNAPSHOT: confirming it writes each employee's figure into
 * automated_payroll_draft_rows.expenses, and from then on the sheet is assembled from that column
 * alone. The recommendation is still recalculated on every load and then discarded, because a
 * saved draft value always wins (`pick` in recommend.ts). Nothing invalidated that snapshot when
 * the approval underneath it changed.
 *
 * Verified in production 2026-08-03 (project ozucdzovmcqvepbozvqf, run
 * 2f1660e5-a6d8-4ccb-9492-0d589f252b43): the p2_expenses step was confirmed 2026-08-01 15:18 UTC;
 * HR then partially approved and rejected trips on 2026-08-02 20:59 UTC. Seven of fifteen
 * employees were left carrying the 1 Aug figure — Ahmed Nashaat at 2,719 against an approved
 * 1,849, which is above even his own 2,174 claim because two trips he rejected were still being
 * counted. The figures below are those real rows.
 *
 * The diff must stay NARROW as well as correct. The approvals screen submits a report's full
 * record set on every save, so a resync that fired for every submitted row would wipe a
 * hand-typed wizard figure for employees nobody touched — trading a silent overpayment for a
 * silent overwrite. Both directions are asserted.
 */

function snapshot(overrides: Partial<ExpenseDecisionSnapshot> & { tripId: string; hrId: string }): ExpenseDecisionSnapshot {
  return {
    approvedAmount: null,
    hrApproved: true,
    payoutMonth: 7,
    payoutYear: 2026,
    status: "Approved",
    total: 0,
    ...overrides,
  };
}

function run(overrides: Partial<MonthlySalaryRun> = {}): MonthlySalaryRun {
  return {
    id: "2f1660e5-a6d8-4ccb-9492-0d589f252b43",
    month: 7,
    year: 2026,
    monthKey: "2026-07",
    phase: "part2",
    part1ConfirmedAt: "2026-07-26T12:59:30.834Z",
    part1ConfirmedBy: "phx-1",
    part2ConfirmedAt: null,
    part2ConfirmedBy: null,
    publishedBatchId: null,
    publishedAt: null,
    publishedBy: null,
    createdBy: "phx-1",
    createdAt: "2026-07-20T16:07:50.381Z",
    updatedAt: "2026-07-26T12:59:30.834Z",
    ...overrides,
  };
}

export function runAutomatedPayrollExpenseResyncTests() {
  // ---- the real 2 Aug review that payroll never saw -------------------------
  // Yehya Kamal (B-23): four trips partially approved, 3,521 claimed -> 2,667 approved.
  // Ahmed Nashaat (B-175): one partial approval AND two rejections.
  // Salim Gomaa (B-76): submitted in the same save, decided on earlier, untouched.
  const before: ExpenseDecisionSnapshot[] = [
    snapshot({ tripId: "TRP-00284", hrId: "B-23", total: 505 }),
    snapshot({ tripId: "TRP-00349", hrId: "B-23", total: 790 }),
    snapshot({ tripId: "TRP-00290", hrId: "B-175", total: 910 }),
    snapshot({ tripId: "TRP-00298", hrId: "B-175", total: 260 }),
    snapshot({ tripId: "TRP-00276", hrId: "B-76", total: 3416 }),
  ];
  const after: ExpenseDecisionSnapshot[] = [
    snapshot({ tripId: "TRP-00284", hrId: "B-23", total: 505, approvedAmount: 343 }),
    snapshot({ tripId: "TRP-00349", hrId: "B-23", total: 790, approvedAmount: 460 }),
    snapshot({ tripId: "TRP-00290", hrId: "B-175", total: 910, approvedAmount: 585 }),
    snapshot({ tripId: "TRP-00298", hrId: "B-175", total: 260, hrApproved: false, status: "Rejected" }),
    snapshot({ tripId: "TRP-00276", hrId: "B-76", total: 3416 }),
  ];

  const changed = expenseDecisionsThatChanged(before, after);

  // THE HEADLINE ASSERTION. Before the fix nothing was collected at all, so no run was ever
  // re-opened and the confirmed step kept paying its 1 Aug figures.
  assert.deepEqual(
    [...changed.hrIds].sort(),
    ["B-175", "B-23"],
    "a partial approval and a rejection must both mark their employee for resync: without this the confirmed Expenses step keeps paying the figure it was confirmed with (Yehya Kamal 3,521 instead of 2,667)",
  );
  assert.ok(
    !changed.hrIds.includes("B-76"),
    "an untouched trip submitted in the same save must NOT trigger a resync — the approvals screen posts the whole report every time, and clearing Salim Gomaa's frozen figure would silently discard a hand-typed wizard amount",
  );
  assert.deepEqual(
    changed.periods,
    [{ month: 7, year: 2026 }],
    "the payout period drives which run is re-opened, and these June trips pay in July 2026",
  );

  // ---- a rejection carries no amount change, so state must be compared too --
  const rejectionOnly = expenseDecisionsThatChanged(
    [snapshot({ tripId: "TRP-00304", hrId: "B-175", total: 285 })],
    [snapshot({ tripId: "TRP-00304", hrId: "B-175", total: 285, hrApproved: false, status: "Rejected" })],
  );
  assert.deepEqual(
    rejectionOnly.hrIds,
    ["B-175"],
    "a rejection leaves total and approved_amount untouched — comparing amounts alone would miss it, which is exactly how 545 EGP of rejected trips stayed in Ahmed Nashaat's frozen 2,719",
  );

  // ---- a deleted row must resync: rejecting a request drops its expense row --
  const removed = expenseDecisionsThatChanged(
    [snapshot({ tripId: "OUTSTATION-91", hrId: "B-12", total: 331 })],
    [],
  );
  assert.deepEqual(
    removed.hrIds,
    ["B-12"],
    "rejecting an outstation request DELETES its expense row, so the confirmed step would go on reimbursing a trip that no longer exists",
  );

  // ---- a brand new row must resync ------------------------------------------
  const added = expenseDecisionsThatChanged(
    [],
    [snapshot({ tripId: "TRP-00348", hrId: "B-74", total: 505 })],
  );
  assert.deepEqual(
    added.hrIds,
    ["B-74"],
    "a trip approved after the step was confirmed must reach payroll too — Ahmed Abdallah was 505 SHORT, so this bug underpaid as well as overpaid",
  );

  // ---- a genuinely unchanged save must do nothing ---------------------------
  const noop = expenseDecisionsThatChanged(before, before);
  assert.deepEqual(
    noop.hrIds,
    [],
    "re-saving identical decisions must not clear anyone's frozen figure",
  );
  assert.deepEqual(noop.periods, [], "and must not re-open any run");

  // ---- a trip moving payroll months must resync BOTH months -----------------
  const moved = expenseDecisionsThatChanged(
    [snapshot({ tripId: "TRP-00500", hrId: "B-5", total: 400, payoutMonth: 7, payoutYear: 2026 })],
    [snapshot({ tripId: "TRP-00500", hrId: "B-5", total: 400, payoutMonth: 8, payoutYear: 2026 })],
  );
  assert.deepEqual(
    [...moved.periods].sort((left, right) => left.month - right.month),
    [
      { month: 7, year: 2026 },
      { month: 8, year: 2026 },
    ],
    "the run the trip LEFT is now overstated and the run it joined understated — both must recompute",
  );

  // ---- sub-piastre noise must not count as a decision ----------------------
  const rounding = expenseDecisionsThatChanged(
    [snapshot({ tripId: "TRP-00600", hrId: "B-1", total: 400 })],
    [snapshot({ tripId: "TRP-00600", hrId: "B-1", total: 400.001 })],
  );
  assert.deepEqual(
    rounding.hrIds,
    [],
    "the figure round-trips through a number input and currency rounding; treating that as a decision would re-open a run on every save",
  );

  // ---- which runs may be re-opened -----------------------------------------
  assert.equal(
    planExpenseResync(run()).ok,
    true,
    "the July 2026 run was in Part 2 with Part 2 unconfirmed — exactly the state this must repair",
  );
  assert.deepEqual(
    planExpenseResync(null),
    { ok: false, reason: "no_active_run" },
    "an expense decision for a period with no open run is normal and must not error",
  );
  assert.deepEqual(
    planExpenseResync(run({ phase: "ready", part2ConfirmedAt: "2026-08-02T10:00:00.000Z" })),
    { ok: false, reason: "part2_already_confirmed" },
    "confirming Part 2 settles the carry-forward ledger, so an expense save must never silently rewind it — this is reported as a skip, not done quietly",
  );
}
