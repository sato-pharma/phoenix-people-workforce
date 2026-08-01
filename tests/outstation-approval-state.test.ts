import assert from "node:assert/strict";
import {
  APPROVED_STATUS,
  EXPENSE_STATE_LABEL,
  REJECTED_STATUS,
  expenseApprovalState,
  isRejectedStatus,
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

  // --- labels stay the literals the database already holds ---

  assert.equal(EXPENSE_STATE_LABEL.approved, "Approved", "label must match the stored literal");
  assert.equal(EXPENSE_STATE_LABEL.rejected, "Rejected", "label must match the stored literal");
  assert.equal(
    isRejectedStatus(EXPENSE_STATE_LABEL.rejected),
    true,
    "the label the command centre emits must round-trip back through the rejection test",
  );
}
