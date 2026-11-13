// THE DISPUTE CENTER — the one shape every dispute takes on screen, whichever module raised it.
//
// Owner, 2026-10-09: the Calendar Disputes, the Deduction Disputes and the Weekly Attendance Review
// disputes must all "approve, reject, decide, open a conversation, wait for their conversation,
// upload a picture in both, and everything is saved — closed or open, it never disappears from me or
// the employee". Each module keeps its own record and its own decision (they move different things:
// a calendar overlay, a payslip line, a settled attendance day); this file is the common language the
// conversation, the history, the reopen and the Case Briefing are written in, so the three screens
// cannot drift into three different answers to "who is it waiting on?".
//
// Pure types only — safe to import from a client component.

/**
 * Which module a case lives in. The `ref` is that module's own id for it. `daily` is a released DAILY
 * deduction line (owner, 2026-11-13), whose ref is the dispute's own id — the line itself is deleted when
 * it is withdrawn.
 */
export type DisputeCaseKind = "calendar" | "deduction" | "digest" | "daily";

export const DISPUTE_CASE_KINDS: readonly DisputeCaseKind[] = ["calendar", "deduction", "digest", "daily"];

export function isDisputeCaseKind(value: unknown): value is DisputeCaseKind {
  return value === "calendar" || value === "deduction" || value === "digest" || value === "daily";
}

/** The human name of each module, for a heading or a notification. */
export const DISPUTE_CASE_KIND_LABELS: Record<DisputeCaseKind, string> = {
  calendar: "Calendar dispute",
  deduction: "Deduction dispute",
  digest: "Weekly attendance dispute",
  daily: "Daily deduction dispute",
};

/**
 * Where a case stands — the ONE question every inbox tab and every chip answers.
 *
 *  - waiting_reviewer   the employee spoke last (or just opened it): the reviewer owes an answer.
 *  - waiting_employee   the reviewer asked something and the employee has not answered yet.
 *  - reopen_requested   decided, and the employee asked for it to be looked at again.
 *  - decided            closed with a decision. It stays visible for ever; it is only closed.
 *
 * There is no deadline and nothing closes on its own (owner, 2026-10-09: "wait, no deadline").
 */
export type DisputeCaseState = "waiting_reviewer" | "waiting_employee" | "reopen_requested" | "decided";

export const DISPUTE_CASE_STATE_LABELS: Record<DisputeCaseState, string> = {
  decided: "Decided",
  reopen_requested: "Reopen requested",
  waiting_employee: "Waiting for employee",
  waiting_reviewer: "Waiting for reviewer",
};

/** Who wrote a line of the conversation. */
export type DisputeSide = "employee" | "reviewer";

export type DisputeAttachment = {
  contentType: string;
  fileName: string;
  id: string;
  sizeBytes: number;
  /** A same-origin route that checks who is asking before it serves a byte. */
  url: string;
};

export type DisputeMessage = {
  attachments: DisputeAttachment[];
  authorHrId: string | null;
  authorName: string | null;
  body: string;
  createdAt: string;
  id: string;
  side: DisputeSide;
};

export type DisputeCaseEventType =
  | "decided"
  | "refund_cancelled"
  | "refund_recommended"
  | "reopen_declined"
  | "reopen_requested"
  | "reopened";

export type DisputeCaseEvent = {
  actorHrId: string | null;
  actorName: string | null;
  actorRole: string | null;
  createdAt: string;
  details: Record<string, unknown>;
  eventType: DisputeCaseEventType;
  id: string;
  note: string | null;
};

/** The decision currently on record, in words a reader can act on. */
export type DisputeDecision = {
  /** "Accepted", "Rejected", "Reduced to 1 day", "Upheld — no deduction"… */
  label: string;
  note: string | null;
  decidedAt: string | null;
  decidedByName: string | null;
  /** True when the outcome favoured the employee (accepted / upheld / reduced). */
  favoursEmployee: boolean;
};

export type DisputeRefund = {
  amount: number;
  createdAt: string;
  id: string;
  reason: string;
  sourceMonthKey: string;
  status: "recommended" | "cancelled";
  targetMonthKey: string;
};

/** One labelled fact from the module's own record — already in words, never a code or an HR id. */
export type DisputeCaseFact = {
  label: string;
  value: string;
  /** Optional tone, so a problem flag and a proof of work do not read alike. */
  tone?: "danger" | "info" | "success" | "warning";
};

/** The money a deduction dispute is about, so Reduce can be typed against the real figure. */
export type DisputeDeductionMoney = {
  /** The month whose payroll takes (or took) it, YYYY-MM. */
  monthKey: string;
  unit: "days" | "amount";
  /** What the module detected. */
  detectedValue: number;
  /** What is charged now (days, or EGP for an amount deduction). */
  chargedValue: number;
  chargedAmount: number;
  /** "active" while it is on the payslip; "withdrawn" when it was taken off; "none" never pushed. */
  lineStatus: "active" | "withdrawn" | "none";
  decisionStatus: string | null;
};

/** The weekly-review day a digest dispute is about. */
export type DisputeDigestDay = {
  workDate: string;
  deductionDays: number;
  /** null when the day could not be priced. */
  deductionValue: number | null;
  /** "disputed", "dispute_upheld", "dispute_rejected". */
  action: string;
  chosenMethod: "salary" | "annual_balance" | null;
};

/**
 * One dispute, as both sides see it. The module-specific record (the calendar day, the payslip line,
 * the attendance day) travels beside it in the module's own screen; this is what is common.
 */
export type DisputeCase = {
  kind: DisputeCaseKind;
  ref: string;
  employeeHrId: string;
  employeeName: string;
  /** "Calendar — Saturday 4 Oct 2026", "Fingerprint deduction — September 2026"… */
  title: string;
  /** What the module's own record shows, beside the claim. Empty when it was not loaded. */
  facts: DisputeCaseFact[];
  /** True when some of the record could not be read, so an empty list is "unknown", never "nothing". */
  factsIncomplete: boolean;
  /** Who the viewer is to this case. */
  viewer: { isOwner: boolean; isReviewer: boolean };
  deduction?: DisputeDeductionMoney;
  digest?: DisputeDigestDay;
  /** The employee's opening words — the claim, the comment, the dispute reason. */
  opening: DisputeMessage;
  /** Every reply after the opening, oldest first. */
  messages: DisputeMessage[];
  events: DisputeCaseEvent[];
  decision: DisputeDecision | null;
  refunds: DisputeRefund[];
  state: DisputeCaseState;
  openedAt: string;
  /** The newest thing that happened — the sort key of every list. */
  lastActivityAt: string;
  /** Can the viewer still write in the thread? Always true until it is decided; the reviewer can
   *  still write after a decision (to explain), the employee asks to reopen instead. */
  canReply: boolean;
};
