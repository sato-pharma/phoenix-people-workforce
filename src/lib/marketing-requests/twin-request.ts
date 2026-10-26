// ─────────────────────────────────────────────────────────────────────────────
// Twin detection — the double-PAYMENT guard.
//
// A twin is the same requester asking for the same activity (customer + request type) at the same
// cost while an earlier copy is still live. It is not the ROI double-count `request-overlap.ts`
// detects (two campaigns credited the same invoice lines); it is one activity paid for twice.
//
// Found on production 26 Oct 2026 (the Pedia NSM page audit): five pairs submitted minutes apart,
// all a double tap or a resubmit-from-scratch. Four were caught by a rejection. The fifth was not —
// one copy approved and active, its twin submitted two minutes earlier still sitting at Finance
// Execution 65 days later, one click from paying the same EGP 4,500 again.
//
// Submission refuses a twin outright (`assertNoMarketingRequestTwin` in service.ts); the approval
// screens name any twin that predates the guard. Neither decides anything about the money: an
// approver still approves, returns or rejects.
// ─────────────────────────────────────────────────────────────────────────────

import { marketingRequestStatusLabel } from "@/lib/marketing-requests/request-status-label";

/**
 * The statuses that make an earlier request a live twin: still in the approval chain, or approved
 * and committed. It is `pending_approval` plus `approvedMarketingRequestStatuses` (service.ts),
 * written out here because this module must stay importable without the service; the regression
 * test asserts the two lists agree. A draft, a returned, a rejected, a cancelled and an archived
 * request do not block — none of them is going to be paid as it stands.
 */
export const MARKETING_REQUEST_TWIN_STATUSES: readonly string[] = [
  "pending_approval",
  "approved",
  "active",
  "roi_tracking",
  "closed",
  "finance_hold",
];

const TWIN_STATUS_SET: ReadonlySet<string> = new Set(MARKETING_REQUEST_TWIN_STATUSES);

export type TwinSubject = {
  /** Null for a request not saved yet (a first submit); the request's own id on a resubmit. */
  requestId: string | null;
  requesterHrId: string;
  customerId: string;
  requestTypeId: number;
  estimatedCost: number;
};

export type TwinCandidate = TwinSubject & {
  requestId: string;
  requestCode: string;
  status: string;
  /** `submitted_at`, else `created_at` — the instant the twin entered the chain. */
  submittedAt: string | null;
  /** `step_code` of the rung currently holding it, so a request at Finance reads "approved · with finance". */
  currentStepCode: string | null;
};

function sameHrId(left: string, right: string) {
  return left.trim().toUpperCase() === right.trim().toUpperCase();
}

/** Costs are numeric(12,2): equal to the piastre, so a float round-trip can never split a twin. */
function sameCost(left: number, right: number) {
  return Math.abs(Number(left) - Number(right)) < 0.005;
}

/** Every live twin of `subject`, earliest first. */
export function findMarketingRequestTwins(subject: TwinSubject, candidates: TwinCandidate[]): TwinCandidate[] {
  return candidates
    .filter(
      (candidate) =>
        candidate.requestId !== subject.requestId &&
        TWIN_STATUS_SET.has(candidate.status) &&
        sameHrId(candidate.requesterHrId, subject.requesterHrId) &&
        candidate.customerId === subject.customerId &&
        Number(candidate.requestTypeId) === Number(subject.requestTypeId) &&
        sameCost(candidate.estimatedCost, subject.estimatedCost),
    )
    .sort((left, right) => String(left.submittedAt ?? "").localeCompare(String(right.submittedAt ?? "")));
}

const CAIRO_DAY = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "Africa/Cairo",
  year: "numeric",
});

/** The day an instant fell on in Cairo ("22 Aug 2026"), never raw UTC. */
export function twinSubmittedDay(value: string | null | undefined): string {
  if (!value) return "an earlier date";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "an earlier date" : CAIRO_DAY.format(date);
}

function egp(value: number) {
  return `EGP ${Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

export function twinStatusLabel(twin: Pick<TwinCandidate, "currentStepCode" | "status">) {
  return marketingRequestStatusLabel({ currentStepCode: twin.currentStepCode, status: twin.status });
}

/** The refusal a requester reads when the submit is a twin. Names the customer and the date, never an id. */
export function twinRefusalMessage(params: { customerName: string | null; twin: TwinCandidate }): string {
  const { twin } = params;
  const customer = params.customerName?.trim() || "this customer";
  return (
    `You already submitted this request for ${customer} on ${twinSubmittedDay(twin.submittedAt)}: ` +
    `the same request type and the same cost (${egp(twin.estimatedCost)}), and it is ${twinStatusLabel(twin)}. ` +
    "Submitting it again would pay for the same activity twice. " +
    "Follow the earlier request instead, or change the request type or the cost if this really is a second activity."
  );
}

/** The warning an approver reads beside the decision buttons. */
export type MarketingDecisionTwin = {
  requestCode: string;
  status: string;
  statusLabel: string;
  submittedDay: string;
  description: string;
};

export function describeTwinForApprover(twin: TwinCandidate): MarketingDecisionTwin {
  const statusLabel = twinStatusLabel(twin);
  const submittedDay = twinSubmittedDay(twin.submittedAt);
  return {
    description:
      `The same requester submitted this customer, request type and cost (${egp(twin.estimatedCost)}) ` +
      `on ${submittedDay}, and that request is ${statusLabel}. Paying both would pay for the same activity twice.`,
    requestCode: twin.requestCode,
    status: twin.status,
    statusLabel,
    submittedDay,
  };
}
