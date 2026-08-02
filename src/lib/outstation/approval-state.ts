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

/**
 * Whether HR moved the payable figure off the employee's claim.
 *
 * Half a pound of tolerance: the figure round-trips through a number input and currency rounding,
 * so an exact `!==` would mark untouched rows as adjusted and demand a reason for nothing.
 */
export function isAdjustedAmount(
  approvedAmount: number | null | undefined,
  claimedTotal: number | null | undefined,
): boolean {
  const approved = Number(approvedAmount);
  const claimed = Number(claimedTotal);
  if (!Number.isFinite(approved) || !Number.isFinite(claimed)) return false;
  return Math.abs(approved - claimed) > 0.5;
}

export type BulkApprovalCandidate = {
  approvedAmount: number;
  claimedTotal: number;
  hrApproved: boolean | null | undefined;
  hrComment: string;
  status: string | null | undefined;
  tripId: string;
};

/**
 * Splits a multi-select into what one bulk approval may actually touch.
 *
 * Bulk approve exists to clear a backlog, not to bypass the rules that guard it, so this applies
 * the SAME two gates the single-trip Approve button applies — and nothing may be approved that the
 * per-trip button would have refused:
 *
 *   - only a PENDING trip can be approved (an already-approved one is a no-op, and a rejected one
 *     must be un-rejected deliberately — silently flipping a rejection in a batch is exactly the
 *     kind of thing nobody notices until payroll runs);
 *   - a trip whose amount was reduced needs a written reason first, because a deduction the
 *     employee cannot be given a reason for is not defensible.
 *
 * Everything excluded is returned rather than dropped, so the UI can say precisely why a selected
 * trip did not get approved instead of leaving the reviewer to guess.
 */
export function planBulkApproval(candidates: ReadonlyArray<BulkApprovalCandidate>): {
  approvableTripIds: string[];
  needsReasonTripIds: string[];
  notPendingTripIds: string[];
} {
  const approvableTripIds: string[] = [];
  const needsReasonTripIds: string[] = [];
  const notPendingTripIds: string[] = [];

  for (const candidate of candidates) {
    if (expenseApprovalState(candidate) !== "pending") {
      notPendingTripIds.push(candidate.tripId);
      continue;
    }
    if (
      isAdjustedAmount(candidate.approvedAmount, candidate.claimedTotal) &&
      !String(candidate.hrComment ?? "").trim()
    ) {
      needsReasonTripIds.push(candidate.tripId);
      continue;
    }
    approvableTripIds.push(candidate.tripId);
  }

  return { approvableTripIds, needsReasonTripIds, notPendingTripIds };
}
