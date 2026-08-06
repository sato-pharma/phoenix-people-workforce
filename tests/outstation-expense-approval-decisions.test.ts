import assert from "node:assert/strict";

import {
  outstationRequestIdFromTripId,
  partitionExpenseApprovalRecords,
  planOutstationRequestDecision,
} from "../src/lib/outstation/expense-approval-decisions.ts";
import { carryStoredDecisionOntoRequestExpenses } from "../src/lib/outstation/expenses.ts";

/**
 * The Expense Approvals queue lists Phoenix-submitted outstation requests alongside imported
 * expense rows, but only the imported ones could ever be decided there: approving a request wrote
 * an `outstation_expenses` row that the next page load dropped in the dedup, while the request's
 * own status was never touched. The screen said "Approvals saved." and the trip stayed Pending.
 *
 * These lock the routing decision that fixes it, and the read-back that keeps a trimmed amount
 * visible after a reload.
 */
export function runOutstationExpenseApprovalDecisionsTests() {
  // ── Which rows belong to the outstation workflow ────────────────────────────
  {
    assert.equal(outstationRequestIdFromTripId("OUTSTATION-48"), 48, "a request trip id yields its request id");
    assert.equal(outstationRequestIdFromTripId("TRIP-2026-01"), null, "an imported trip id is not a request");
    assert.equal(outstationRequestIdFromTripId(""), null, "an empty trip id is not a request");
    assert.equal(outstationRequestIdFromTripId(null), null, "a missing trip id is not a request");
    // Malformed suffixes must read as "not a request" rather than resolving to someone else's row.
    assert.equal(outstationRequestIdFromTripId("OUTSTATION-"), null, "no id after the prefix is not a request");
    assert.equal(outstationRequestIdFromTripId("OUTSTATION-4a"), null, "a non-numeric id is not a request");
    assert.equal(outstationRequestIdFromTripId("OUTSTATION--4"), null, "a negative id is not a request");
    assert.equal(outstationRequestIdFromTripId("OUTSTATION-0"), null, "zero is not a request id");
    assert.equal(outstationRequestIdFromTripId("outstation-48"), null, "the prefix is case-sensitive");
  }

  {
    const { payrollRecords, requestRecords } = partitionExpenseApprovalRecords([
      { tripId: "TRIP-1" },
      { tripId: "OUTSTATION-48" },
      { tripId: "TRIP-2" },
      { tripId: "OUTSTATION-51" },
    ]);
    assert.deepEqual(
      payrollRecords.map((record) => record.tripId),
      ["TRIP-1", "TRIP-2"],
      "imported rows stay on the payroll upsert path",
    );
    assert.deepEqual(
      requestRecords.map((entry) => entry.requestId),
      [48, 51],
      "app-submitted rows are routed to the outstation workflow, carrying their request id",
    );
  }

  // ── What one decision means ────────────────────────────────────────────────
  const plan = (input: {
    amount?: number;
    approved: boolean;
    comment?: string;
    status?: string;
    stored?: number | null;
    total?: number;
    was: string;
  }) =>
    planOutstationRequestDecision({
      claimedTotal: input.total ?? 1000,
      currentStatus: input.was,
      decision: {
        approvedAmount: input.amount ?? input.total ?? 1000,
        hrApproved: input.approved,
        hrComment: input.comment ?? "",
        status: input.status ?? "",
      },
      storedApprovedAmount: input.stored ?? null,
    });

  {
    assert.equal(
      plan({ approved: true, was: "submitted" }).action,
      "approve",
      "approving a submitted request accepts it through the outstation workflow",
    );
    assert.equal(
      plan({ approved: false, comment: "Distance under the floor.", status: "Rejected", was: "submitted" }).action,
      "reject",
      "rejecting a submitted request rejects it through the outstation workflow",
    );
  }

  {
    const refused = plan({ approved: false, status: "Rejected", was: "submitted" });
    assert.equal(refused.action, "blocked", "a rejection with no written reason is refused");
    assert.match(String(refused.reason), /reason/i, "the refusal says a reason is what is missing");
  }

  {
    const refused = plan({ amount: 400, approved: true, was: "submitted" });
    assert.equal(refused.action, "blocked", "trimming the payable figure without a reason is refused");
    assert.match(String(refused.reason), /reason/i, "the refusal names the missing reason");
  }

  {
    const allowed = plan({ amount: 400, approved: true, comment: "Hotel not eligible.", was: "submitted" });
    assert.equal(allowed.action, "approve", "a trimmed figure with a written reason is approved");
  }

  // Unapprove / Undo rejection ask for a return to PENDING. The outstation workflow registry has no
  // transition back to pending from a decided request — accepting one already moved money into
  // payroll — so this is refused rather than invented.
  {
    const refused = plan({ approved: false, was: "accepted_by_system" });
    assert.equal(refused.action, "blocked", "an accepted request cannot be sent back to pending here");
    assert.match(String(refused.reason), /pending/i, "the refusal explains it is the pending state that is unreachable");

    const refusedUndo = plan({ approved: false, was: "rejected_by_admin" });
    assert.equal(refusedUndo.action, "blocked", "undoing a rejection back to pending is refused too");
  }

  // ── Idempotence: the screen posts its whole record set on every Save ────────
  {
    assert.equal(
      plan({ approved: true, was: "accepted_by_system" }).action,
      "skip",
      "an already-accepted request with an untouched amount is not re-run",
    );
    assert.equal(
      plan({ approved: true, was: "accepted_by_admin" }).action,
      "skip",
      "accepted_by_admin reads as approved too, so it is not re-run",
    );
    assert.equal(
      plan({ approved: false, comment: "no", status: "Rejected", was: "rejected_by_system" }).action,
      "skip",
      "an already-rejected request is not re-rejected",
    );
    assert.equal(
      plan({ amount: 400, approved: true, comment: "Hotel not eligible.", stored: 400, was: "accepted_by_system" })
        .action,
      "skip",
      "an adjustment that is already stored is not rewritten",
    );
  }

  {
    assert.equal(
      plan({ amount: 400, approved: true, comment: "Hotel not eligible.", stored: null, was: "accepted_by_system" })
        .action,
      "amount",
      "trimming an already-accepted trip writes the payable figure without re-running the workflow",
    );
    assert.equal(
      plan({ amount: 1000, approved: true, comment: "Restored.", stored: 400, total: 1000, was: "accepted_by_system" })
        .action,
      "amount",
      "clearing a deduction back to the full claim is a write, not a no-op",
    );
  }

  // ── The trimmed figure survives a reload ───────────────────────────────────
  // `outstation_expense_requests` has no approved_amount column: the figure lives on the linked
  // `outstation_expenses` row, which is exactly the row the dedup drops.
  {
    const live = [
      { approvedAmount: null, hrComment: "", tripId: "OUTSTATION-48" },
      { approvedAmount: null, hrComment: "Rejected: no ticket.", tripId: "OUTSTATION-51" },
      { approvedAmount: null, hrComment: "", tripId: "OUTSTATION-99" },
    ];
    const historical = [
      { approvedAmount: 400, hrComment: "Hotel not eligible.", tripId: "OUTSTATION-48" },
      { approvedAmount: null, hrComment: "An older expense-row note.", tripId: "OUTSTATION-51" },
      { approvedAmount: 900, hrComment: "unrelated", tripId: "TRIP-7" },
    ];
    const carried = carryStoredDecisionOntoRequestExpenses(live, historical);

    assert.equal(carried[0].approvedAmount, 400, "the stored trimmed figure is carried onto the request row");
    assert.equal(carried[0].hrComment, "Hotel not eligible.", "and so is the reason behind it");
    assert.equal(
      carried[1].hrComment,
      "Rejected: no ticket.",
      "a reason written on the request itself is never overwritten by an older expense-row comment",
    );
    assert.equal(carried[2].approvedAmount, null, "a request with no linked expense row is left untouched");
    assert.equal(carried.length, 3, "carrying never adds or drops rows");
  }
}
