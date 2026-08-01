/**
 * Outstation expense approval is 3-state, and `hr_approved` only encodes one of those states.
 *
 * Approved lives in the boolean `hr_approved`; rejection lives in the free-text `status` column;
 * anything else is still pending. That split is not obvious from the schema, and it was previously
 * re-derived by hand in two places (the command-centre enrichment and the approvals workspace) —
 * which is exactly how a row ends up counted as pending in one surface and rejected in another.
 */

/** The literals production already stores. Keep writing exactly these. */
export const APPROVED_STATUS = "Approved";
export const REJECTED_STATUS = "Rejected";

export const PENDING_STATUS = "Pending";

export type ExpenseApprovalState = "approved" | "rejected" | "pending";

/** Display label per state — what the command centre surfaces as a row's `status`. */
export const EXPENSE_STATE_LABEL: Record<ExpenseApprovalState, string> = {
  approved: APPROVED_STATUS,
  pending: PENDING_STATUS,
  rejected: REJECTED_STATUS,
};

/**
 * Substring test, not equality: rejected rows have been written by more than one surface over the
 * years, so comparing to a single literal would silently read some of them back as pending.
 */
export function isRejectedStatus(status: string | null | undefined): boolean {
  return String(status ?? "").toLowerCase().includes("reject");
}

/**
 * The one place that decides which queue a trip belongs in.
 *
 * `hrApproved` deliberately wins over a stale "Rejected" status — a row that was rejected and
 * later approved must appear in exactly one queue, and approval is the later decision.
 */
export function expenseApprovalState(input: {
  hrApproved: boolean | null | undefined;
  status: string | null | undefined;
}): ExpenseApprovalState {
  if (input.hrApproved) return "approved";
  return isRejectedStatus(input.status) ? "rejected" : "pending";
}
