/**
 * Lets the Expense Approvals screen decide a Phoenix-submitted outstation request.
 *
 * The approvals queue (`listUnifiedOutstationExpenses`) has always shown BOTH kinds of row side by
 * side: historical Excel-imported trips from `outstation_expenses`, and app-submitted requests from
 * `outstation_expense_requests` mapped into the same shape. Only the first kind could actually be
 * decided there. Approving a request row wrote an `outstation_expenses` row keyed
 * `OUTSTATION-<id>` — which the very next page load then DROPPED, because the request row shadows
 * it in the dedup — while `outstation_expense_requests.status` was never touched. The decision
 * looked saved, reported "Approvals saved.", and left the trip sitting in Pending forever.
 *
 * So a request row's decision is routed to the outstation workflow instead of to the expense
 * upsert. That reuses `approveOutstationRequestForPayroll` / `rejectOutstationRequestAsAdmin`
 * wholesale, which is the point: the two-photo + workload evidence gate, the
 * already-in-payroll lock, the audit log, and the employee notification all keep firing exactly as
 * they do from the Queue tab. Nothing about approving an outstation request is re-implemented here.
 *
 * The planning half is pure and lives at the top so it can be tested without a database.
 */

import { isAdjustedAmount } from "@/lib/outstation/approval-state";
import { outstationStatusLabel } from "@/lib/outstation/payroll-expense-mapping";

/** Trip-id prefix that marks a queue row as an app-submitted request (`outstationPayrollTripId`). */
export const OUTSTATION_REQUEST_TRIP_PREFIX = "OUTSTATION-";

/**
 * The request id behind a queue row, or null when the row is an ordinary imported expense.
 *
 * Strict on purpose: only a positive integer after the prefix counts. A malformed trip id must read
 * as "not a request" and travel down the historical path rather than resolving to some other
 * employee's request.
 */
export function outstationRequestIdFromTripId(tripId: string | null | undefined): number | null {
  const raw = String(tripId ?? "");
  if (!raw.startsWith(OUTSTATION_REQUEST_TRIP_PREFIX)) return null;
  const suffix = raw.slice(OUTSTATION_REQUEST_TRIP_PREFIX.length);
  if (!/^\d+$/.test(suffix)) return null;
  const id = Number(suffix);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Splits one Save payload into the rows each write path owns. */
export function partitionExpenseApprovalRecords<T extends { tripId: string }>(
  records: ReadonlyArray<T>,
): { payrollRecords: T[]; requestRecords: Array<{ record: T; requestId: number }> } {
  const payrollRecords: T[] = [];
  const requestRecords: Array<{ record: T; requestId: number }> = [];

  for (const record of records) {
    const requestId = outstationRequestIdFromTripId(record.tripId);
    if (requestId === null) payrollRecords.push(record);
    else requestRecords.push({ record, requestId });
  }

  return { payrollRecords, requestRecords };
}

export type OutstationRequestDecisionAction =
  /** Accept the request and push it to payroll. */
  | "approve"
  /** Reject the request and pull any linked payroll row back out. */
  | "reject"
  /** Already in the decided state; only the payable figure / reason moved. */
  | "amount"
  /** Nothing changed — do not re-run the workflow, do not write an audit row. */
  | "skip"
  /** Refused, with a reason the reviewer can act on. */
  | "blocked";

export type OutstationRequestDecisionPlan = {
  action: OutstationRequestDecisionAction;
  reason?: string;
};

/**
 * What one request row's decision means, from the row's stored status and what the reviewer left on
 * screen. Pure — no database, no access context.
 *
 * The two refusals are deliberate and mirror the rules the queue already enforces client-side, so
 * the server cannot be talked into something the buttons would have refused:
 *
 *   - a rejection needs a written reason (`rejectOutstationRequestAsAdmin` demands one anyway, but
 *     failing here names the trip instead of surfacing a bare service error);
 *   - a reduced payable figure needs a written reason, because a deduction the employee cannot be
 *     given a reason for is not defensible (same rule as `planBulkApproval`).
 *
 * "Unapprove" / "Undo rejection" is refused rather than invented. Those buttons ask for a return to
 * PENDING, and the outstation workflow registry has no transition back to pending from a decided
 * request — accepting one already moved money into payroll. Making one up here would be a new
 * payroll state transition wearing the clothes of a UI fix.
 */
export function planOutstationRequestDecision(input: {
  claimedTotal: number;
  currentStatus: string | null | undefined;
  decision: {
    approvedAmount: number;
    hrApproved: boolean;
    hrComment: string;
    status: string | null | undefined;
  };
  storedApprovedAmount: number | null | undefined;
}): OutstationRequestDecisionPlan {
  const currentLabel = outstationStatusLabel(input.currentStatus);
  const currentState =
    currentLabel === "Approved" ? "approved" : currentLabel === "Rejected" ? "rejected" : "pending";
  const desiredState = input.decision.hrApproved
    ? "approved"
    : String(input.decision.status ?? "").toLowerCase().includes("reject")
      ? "rejected"
      : "pending";

  const comment = String(input.decision.hrComment ?? "").trim();
  const adjusted = isAdjustedAmount(input.decision.approvedAmount, input.claimedTotal);

  if (desiredState === "rejected" && !comment) {
    return { action: "blocked", reason: "a rejection reason is required" };
  }
  if (desiredState === "approved" && adjusted && !comment) {
    return { action: "blocked", reason: "a changed approved amount needs a written reason" };
  }

  if (desiredState !== currentState) {
    if (desiredState === "approved") return { action: "approve" };
    if (desiredState === "rejected") return { action: "reject" };
    return {
      action: "blocked",
      reason:
        "an app-submitted request cannot be moved back to pending here — approve or reject it instead",
    };
  }

  // Same decision as what is stored. The payable figure and its reason can still move (HR trimming
  // an already-approved trip), and that is the only thing left to write.
  if (currentState === "approved") {
    const stored = input.storedApprovedAmount ?? null;
    const nextAmount = adjusted ? input.decision.approvedAmount : null;
    const amountMoved =
      stored === null ? nextAmount !== null : nextAmount === null || Math.abs(stored - nextAmount) > 0.005;
    if (amountMoved) return { action: "amount" };
  }

  return { action: "skip" };
}
