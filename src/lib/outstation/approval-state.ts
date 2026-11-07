import { normalizeApprovedAmount } from "@/lib/outstation/payable";

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
 * Where a trip sits in the single approvals queue: undecided first, then approved, then rejected.
 *
 * The screen showed three tabs until 2026-09-08, when the owner asked for one list instead. The
 * work still has to surface first — a reviewer opening a 400-trip queue is there for the 60 nobody
 * has decided — so the ordering carries what the tabs used to, without hiding the other two states
 * behind a click.
 *
 * Rank the STORED decision, never the live one. Ranking what is on screen would move a row the
 * instant it is decided, so every approval would shuffle the list out from under the reviewer
 * working down it. The list settles on the next load, which is after Save.
 */
export function expenseApprovalQueueRank(state: ExpenseApprovalState): number {
  return state === "pending" ? 0 : state === "approved" ? 1 : 2;
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
  /** The trip's allowance; a pre-cut is only ever a share of it. */
  allowance?: number | null;
  approvedAmount: number;
  claimedTotal: number;
  hrApproved: boolean | null | undefined;
  hrComment: string;
  status: string | null | undefined;
  tripId: string;
  /** The trip's field-work reading — the live day-by-day one once the trip was opened. */
  workloadMatchStatus?: string | null;
};

/** Field-work readings that mean at least one trip day had no visit and no meeting. */
const IDLE_WORKLOAD_STATUSES = new Set(["no_activity", "partial"]);

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
 *     employee cannot be given a reason for is not defensible;
 *   - an untouched trip with idle days and an allowance carries a PRE-CUT (owner, 2026-11-07:
 *     "he put trip from 23 to 26 and visits are 23 24 25 only, then don't count 26"). The single
 *     Approve applies it; a batch cannot see it, so the trip is held back to be opened and
 *     approved on its own — a batch never pays an idle day in full behind his back.
 *
 * Everything excluded is returned rather than dropped, so the UI can say precisely why a selected
 * trip did not get approved instead of leaving the reviewer to guess.
 */
export function planBulkApproval(candidates: ReadonlyArray<BulkApprovalCandidate>): {
  approvableTripIds: string[];
  needsPreCutTripIds: string[];
  needsReasonTripIds: string[];
  notPendingTripIds: string[];
} {
  const approvableTripIds: string[] = [];
  const needsPreCutTripIds: string[] = [];
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
    if (
      !isAdjustedAmount(candidate.approvedAmount, candidate.claimedTotal) &&
      Number(candidate.allowance) > 0 &&
      IDLE_WORKLOAD_STATUSES.has(String(candidate.workloadMatchStatus ?? ""))
    ) {
      needsPreCutTripIds.push(candidate.tripId);
      continue;
    }
    approvableTripIds.push(candidate.tripId);
  }

  return { approvableTripIds, needsPreCutTripIds, needsReasonTripIds, notPendingTripIds };
}

/** One reviewer decision as the Expense Approvals screen holds it. */
export type ExpenseApprovalDecision = {
  approvedAmount: number;
  hrApproved: boolean;
  hrComment: string;
  status: string;
};

/**
 * Whether a decision on screen differs from the one stored on the row — the ONE answer to that,
 * shared by the Save button's unsaved count and by the payload Save actually sends.
 *
 * It lives here because those two were written separately and drifted: the count included the
 * rejected/not-rejected term and the payload builder did not, so "Undo rejection" raised the Save
 * bar, sent nothing, and reported "Approvals saved." while the row came back rejected. A reviewer
 * has no way to tell that apart from a save that worked.
 *
 * All four terms matter, and none is derivable from another: approval lives in `hrApproved`,
 * rejection in `status`, the payable figure in `approvedAmount` and the reason in `hrComment`.
 * The half-pound tolerance on the amount is the same one `isAdjustedAmount` uses — the figure
 * round-trips through a number input, so an exact compare marks untouched rows as changed.
 */
export function expenseDecisionChanged(
  local: ExpenseApprovalDecision,
  stored: ExpenseApprovalDecision,
): boolean {
  return (
    local.hrApproved !== stored.hrApproved ||
    Math.abs(local.approvedAmount - stored.approvedAmount) > 0.5 ||
    local.hrComment.trim() !== stored.hrComment.trim() ||
    isRejectedStatus(local.status) !== isRejectedStatus(stored.status)
  );
}

/**
 * The HR decision as it stands on an `outstation_expenses` row right now.
 *
 * Deliberately the WHOLE decision, not just the amount. The three-state split above means a
 * rejection lives in `status`, an approval in `hr_approved`, and neither is derivable from the
 * other — while the reason a claim was cut lives in `hr_comment` and who cut it in
 * `approved_by`/`approved_at`. Carry half of that forward and the other half reverts, which reads
 * as a decision nobody made.
 */
export type StoredExpenseDecision = {
  approvedAmount: number | null;
  approvedAt: string | null;
  approvedBy: string | null;
  hrApproved: boolean;
  hrComment: string;
  hrStatus: string;
  status: string;
};

export type ExpenseDecisionWrite = StoredExpenseDecision & {
  /**
   * Whether this write is itself an approval decision. False for a carry-forward, which writes
   * back exactly what was already stored and therefore exercises no approval authority — that is
   * what lets an employee re-price their own trip without holding HR Manager rights.
   */
  decidesApproval: boolean;
};

/**
 * What belongs in a row's decision columns on a save — the one place that answers it.
 *
 * Two kinds of caller write to `outstation_expenses`, and they mean opposite things by the same
 * payload. The Expense Approvals screen IS the decision: whatever it sends is what HR just chose.
 * The outstation workflow is not — it re-pushes a trip whenever its own figures move (an employee
 * adding an extra ticket, an admin editing the trip), and its record carries a hard-coded
 * "Approved" because that is the right DEFAULT for a trip reaching payroll for the first time,
 * not because anything was decided this time round.
 *
 * Told apart by `preserveExistingDecision`. With it set and a row already stored, the stored
 * decision wins outright: HR's reduction from 800 to 500 survives the employee adding a ticket,
 * and an HR rejection is not flipped back to Approved by an admin editing the destination. With
 * no row stored there is nothing to preserve, so the incoming default creates the row as before.
 *
 * A caller that genuinely IS deciding — writeOutstationRequestPayableAmount, carrying HR's typed
 * figure from the approvals queue — passes `preserveExistingDecision: false` and overwrites, which
 * is the whole point of that path.
 */
export function resolveExpenseDecisionWrite(input: {
  approvedBy: string;
  claimedTotal: number | null | undefined;
  incoming: {
    approvedAmount?: number | null;
    hrApproved?: boolean;
    hrComment?: string;
    hrStatus?: string;
    status?: string;
  };
  now: string;
  preserveExistingDecision?: boolean;
  stored: StoredExpenseDecision | null;
}): ExpenseDecisionWrite {
  const carried = input.preserveExistingDecision ? input.stored : null;
  if (carried) {
    return {
      ...carried,
      // A carry-forward keeps HR's decision verbatim — with ONE cap it cannot skip: approved_amount
      // may never sit above a claim that this re-import has since LOWERED. approved_amount > total
      // breaches expense_claims_approved_total_range, which is what froze all 416 claims once (see
      // normalizeApprovedAmount). The decision branch below already clamps at the claim; a preserved
      // amount has to as well, or a re-uploaded sheet (or a workflow re-push) that shrinks a trip's
      // total below what HR approved writes the same over-claim row. This only ever REDUCES a
      // preserved figure to the trip's new, smaller claim — it never raises a payment, never
      // approves, and is a no-op whenever the claim is unchanged or higher (the ordinary case).
      approvedAmount: normalizeApprovedAmount(carried.approvedAmount, input.claimedTotal),
      decidesApproval: false,
    };
  }

  const approved = Boolean(input.incoming.hrApproved);
  return {
    approvedAmount: normalizeApprovedAmount(input.incoming.approvedAmount, input.claimedTotal),
    approvedAt: approved ? input.now : null,
    approvedBy: approved ? input.approvedBy : null,
    decidesApproval: approved,
    hrApproved: approved,
    hrComment: input.incoming.hrComment ?? "",
    hrStatus: input.incoming.hrStatus ?? "",
    status: input.incoming.status ?? "",
  };
}
