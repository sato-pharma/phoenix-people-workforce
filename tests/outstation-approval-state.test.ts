import assert from "node:assert/strict";
import {
  APPROVED_STATUS,
  EXPENSE_STATE_LABEL,
  REJECTED_STATUS,
  expenseApprovalState,
  isAdjustedAmount,
  isRejectedStatus,
  planBulkApproval,
} from "../src/lib/outstation/approval-state.ts";

export function runOutstationApprovalStateTests() {
  // --- isRejectedStatus: substring, not equality ---

  assert.equal(isRejectedStatus(REJECTED_STATUS), true, "the literal production stores must read back as rejected");
  assert.equal(isRejectedStatus("rejected"), true, "case must not decide whether an expense was rejected");
  assert.equal(isRejectedStatus("Rejected by HR"), true, "a decorated status still means rejected — equality against one literal would read this back as pending and silently reopen a closed decision");
  assert.equal(isRejectedStatus(""), false, "blank is the overwhelmingly common live value and means pending, never rejected");
  assert.equal(isRejectedStatus(null), false, "a null status is pending, not rejected");
  assert.equal(isRejectedStatus(undefined), false, "a missing status is pending, not rejected");
  assert.equal(isRejectedStatus(APPROVED_STATUS), false, "approved must never be mistaken for rejected");

  // --- expenseApprovalState: every trip lands in exactly one queue ---

  assert.equal(
    expenseApprovalState({ hrApproved: false, status: "" }),
    "pending",
    "an untouched row is pending",
  );
  assert.equal(
    expenseApprovalState({ hrApproved: true, status: APPROVED_STATUS }),
    "approved",
    "an approved row is approved",
  );
  assert.equal(
    expenseApprovalState({ hrApproved: false, status: REJECTED_STATUS }),
    "rejected",
    "rejection is carried by status, since hr_approved cannot express it",
  );
  assert.equal(
    expenseApprovalState({ hrApproved: true, status: REJECTED_STATUS }),
    "approved",
    "approval beats a stale rejected status — otherwise a rejected-then-approved trip would appear in two queues at once and could be paid twice or not at all",
  );
  assert.equal(
    expenseApprovalState({ hrApproved: false, status: APPROVED_STATUS }),
    "pending",
    "hr_approved is the only approval signal; a status string alone must never approve a payment",
  );
  assert.equal(
    expenseApprovalState({ hrApproved: null, status: null }),
    "pending",
    "missing values fail closed to pending rather than to approved",
  );

  // --- the three queues partition the space: no trip is in two, none in zero ---

  const rows = [
    { hrApproved: false, status: "" },
    { hrApproved: true, status: APPROVED_STATUS },
    { hrApproved: false, status: REJECTED_STATUS },
    { hrApproved: true, status: REJECTED_STATUS },
    { hrApproved: false, status: "rejected late" },
  ];
  const counts = { approved: 0, pending: 0, rejected: 0 };
  for (const row of rows) counts[expenseApprovalState(row)] += 1;
  assert.equal(
    counts.approved + counts.pending + counts.rejected,
    rows.length,
    "every trip is counted exactly once, so the Pending / Approved / Rejected tab counts always add up to the total",
  );
  assert.deepEqual(counts, { approved: 2, pending: 1, rejected: 2 }, "queue split is stable");

  // --- isAdjustedAmount: the tolerance that decides whether a reason is owed ---

  assert.equal(isAdjustedAmount(2000, 2000), false, "an untouched claim is not an adjustment");
  assert.equal(isAdjustedAmount(1500, 2000), true, "a 500 reduction is an adjustment");
  assert.equal(
    isAdjustedAmount(2000.2, 2000),
    false,
    "sub-half-pound drift from the number input and currency rounding must not demand a reason for nothing",
  );
  assert.equal(isAdjustedAmount(0, 2000), true, "approving nothing against a real claim is an adjustment");

  // --- planBulkApproval: clearing a backlog must not bypass the gates that guard it ---

  const candidate = (overrides: Partial<Parameters<typeof planBulkApproval>[0][number]>) => ({
    approvedAmount: 2000,
    claimedTotal: 2000,
    hrApproved: false,
    hrComment: "",
    status: "",
    tripId: "TRIP-X",
    ...overrides,
  });

  const plan = planBulkApproval([
    candidate({ tripId: "clean" }),
    candidate({ approvedAmount: 1500, hrComment: "Hotel receipt missing", tripId: "reduced-with-reason" }),
    candidate({ approvedAmount: 1500, hrComment: "   ", tripId: "reduced-no-reason" }),
    candidate({ hrApproved: true, status: APPROVED_STATUS, tripId: "already-approved" }),
    candidate({ status: REJECTED_STATUS, tripId: "already-rejected" }),
  ]);

  assert.deepEqual(
    plan.approvableTripIds,
    ["clean", "reduced-with-reason"],
    "only the untouched trip and the reduced-but-explained one may be approved in bulk",
  );
  assert.deepEqual(
    plan.needsReasonTripIds,
    ["reduced-no-reason"],
    "a reduced amount with only whitespace for a reason is BLOCKED — bulk approve must not become the way to deduct money from a rep with no explanation on file, which is the one thing the single-trip button already refuses",
  );
  assert.deepEqual(
    plan.notPendingTripIds,
    ["already-approved", "already-rejected"],
    "a rejected trip must never be flipped to approved inside a batch — that decision has to be undone deliberately, or nobody notices until payroll runs",
  );
  assert.equal(
    plan.approvableTripIds.length + plan.needsPreCutTripIds.length + plan.needsReasonTripIds.length + plan.notPendingTripIds.length,
    5,
    "every selected trip is accounted for, so the UI can always explain why one did not get approved",
  );
  assert.deepEqual(
    planBulkApproval([]),
    { approvableTripIds: [], needsPreCutTripIds: [], needsReasonTripIds: [], notPendingTripIds: [] },
    "an empty selection approves nothing rather than throwing",
  );

  // Whatever bulk approve lets through, the single-trip button must have let through too.
  for (const single of [
    candidate({ tripId: "a" }),
    candidate({ approvedAmount: 1500, hrComment: "reason", tripId: "b" }),
    candidate({ approvedAmount: 1500, tripId: "c" }),
    candidate({ hrApproved: true, tripId: "d" }),
    candidate({ status: REJECTED_STATUS, tripId: "e" }),
  ]) {
    const bulkAllows = planBulkApproval([single]).approvableTripIds.length === 1;
    const singleAllows =
      expenseApprovalState(single) === "pending" &&
      !(isAdjustedAmount(single.approvedAmount, single.claimedTotal) && !single.hrComment.trim());
    assert.equal(
      bulkAllows,
      singleAllows,
      `bulk and single-trip approval must agree for ${single.tripId} — a batch is not a loophole`,
    );
  }

  // --- labels stay the literals the database already holds ---

  assert.equal(EXPENSE_STATE_LABEL.approved, "Approved", "label must match the stored literal");
  assert.equal(EXPENSE_STATE_LABEL.rejected, "Rejected", "label must match the stored literal");
  assert.equal(
    isRejectedStatus(EXPENSE_STATE_LABEL.rejected),
    true,
    "the label the command centre emits must round-trip back through the rejection test",
  );
}
