// Unified Deductions module: single source of truth for every payroll deduction.
// Governance/reporting layer only until Phase 2's publish snapshot exists — no
// trigger or application path in this module writes salary_records/salary_batches.

/**
 * Categories the workspace SHOWS. Excludes `no_records_activity`, whose connector was
 * retired from DEDUCTION_COLLECTORS once it lost its population — the field workforce
 * belongs to `crm` and Head Office has no CRM obligation, which is everybody. A tab that
 * is permanently empty and zero looks identical to a broken connector, so it is hidden
 * rather than shown at 0.00.
 *
 * `deductionsCategories` itself is unchanged: it still backs the DB enum, the category
 * config, and every historical row (July 2026 has 263 superseded no_records candidates),
 * so narrowing it would break reads of data that legitimately exists.
 */
export const visibleDeductionsCategories = [
  "fingerprint",
  "crm",
  // Its own tab beside CRM: the morning or afternoon a district manager or rep left unaccounted
  // for (owner, 2026-10-08). Approval-required, paid through the CRM column.
  "crm_half_day",
  // A field day the Super Admin decided in the HR operations report (owner, 2026-10-20), carried into
  // the weekly attendance review by src/lib/hr-ops-reports/bridge.ts. Approval-required, paid through
  // the CRM column.
  "field_review",
  "unpaid_vacation",
  "insufficient_balance_vacation",
  "loan",
  "other",
] as const;

export const deductionsCategories = [
  "fingerprint",
  "crm",
  "crm_half_day",
  "no_records_activity",
  "unpaid_vacation",
  "insufficient_balance_vacation",
  // A head-office week with no weekly plan submitted by that Monday (owner, 2026-10-12). A
  // DAILY-module connector only, never in DEDUCTION_COLLECTORS, so it can never charge on a
  // month scan — see src/lib/daily-deductions/no-weekly-plan-select.ts.
  "no_weekly_plan",
  "loan",
  "other",
  // A field day decided in the HR operations report (owner, 2026-10-20). Its ONLY writer is
  // src/lib/hr-ops-reports/bridge.ts — never a month-scan collector — and the weekly attendance
  // review's answer reaches it through digest-bridge.ts like a fingerprint day
  // (20261020072217_hr_ops_bridge_field_review.sql).
  "field_review",
] as const;
export type DeductionsCategory = (typeof deductionsCategories)[number];

/**
 * The human NAME of each deduction category — the reason line the employee reads.
 *
 * Added 2026-10-12 with the owner's decision that a released deduction is emailed with its amount
 * and its reason: an email reading `crm_half_day` names nothing to the person it charges, and the
 * standing rule is names, never codes. Typed as a FULL `Record`, so adding a category without
 * naming it here does not compile — a missing entry would otherwise mail the raw code.
 *
 * It lives in this file for the same reason `LEAVE_BALANCE_CATEGORIES` does: `deductions/types.ts`
 * imports nothing, so the notifier, a client component and a server route can all read one list.
 * The per-category config row in the database carries the admin-screen label; this is the sentence
 * an EMPLOYEE is told, and a best-effort notifier must not depend on a database read to say it.
 */
export const deductionsCategoryNames: Record<DeductionsCategory, string> = {
  crm: "CRM — no visit activity recorded",
  crm_half_day: "CRM — half day",
  field_review: "Field day — reviewed by HR",
  fingerprint: "Fingerprint attendance — no punch recorded",
  insufficient_balance_vacation: "Vacation with insufficient leave balance",
  loan: "Loan instalment",
  no_records_activity: "No records — no punch and no other activity recorded",
  // Head-office only, a DAILY-module connector (owner, 2026-10-12): a week whose weekly plan
  // was not submitted by that Monday. It reaches this map because a released daily line is
  // emailed like any other, and the mail must name a reason rather than the code.
  no_weekly_plan: "No weekly plan submitted for that week",
  other: "Other deduction",
  unpaid_vacation: "Unpaid vacation",
};

/** The category's human name, or the raw value when something unknown reaches here. */
export function deductionCategoryName(category: string | null | undefined): string {
  const key = String(category ?? "").trim();
  return deductionsCategoryNames[key as DeductionsCategory] ?? (key || "Deduction");
}

/**
 * The categories "Deduct from leave balance" exists for. CRM and CRM half day on 2026-10-09, widened
 * the same day on the owner's word: "also show the deduct from balance in unpaid and insufficient".
 *
 * It lives in this file — the one module in `deductions/` with no imports at all — because FOUR
 * places have to agree on it: the admin workspace (a client component, which cannot import the
 * charge service), the `recordDecision` guard that stops a bulk decide charging a day to salary AND
 * leave, the charge service itself, and the database function. A second hand-written list in any of
 * them is exactly the drift this constant exists to prevent.
 *
 * An unpaid or insufficient-balance vacation day is, by definition, a day the annual balance could
 * NOT pay for — so on most of those rows the button answers "no annual leave balance left", and that
 * is the correct answer rather than a fault. It becomes usable once the balance is there again: a new
 * annual period, or days given back. Charging one consumes the balance exactly once, because
 * `phx_attendance_balance_inputs` counts an approved request by its `paid_duration_days`, which for
 * an unpaid day is zero — the day sits in the leave ledger, but not as a day the balance paid for.
 */
export const LEAVE_BALANCE_CATEGORIES = [
  "crm",
  "crm_half_day",
  "unpaid_vacation",
  "insufficient_balance_vacation",
] as const satisfies readonly DeductionsCategory[];

/** Whether a deduction's category can be taken from the annual leave balance at all. */
export function isLeaveBalanceCategory(category: string | null | undefined): boolean {
  return (LEAVE_BALANCE_CATEGORIES as readonly string[]).includes(String(category ?? ""));
}

export const deductionsUnits = ["days", "amount"] as const;
export type DeductionsUnit = (typeof deductionsUnits)[number];

export const deductionsCalculationStatuses = ["calculated", "requires_review"] as const;
export type DeductionsCalculationStatus = (typeof deductionsCalculationStatuses)[number];

export const deductionsSeverities = ["Low", "Medium", "High", "Review"] as const;
export type DeductionsSeverity = (typeof deductionsSeverities)[number];

// Payroll-deductions only — no leave-balance-adjustment status (out of scope
// for this module) and no export/handoff bookkeeping (the Phase-2 publish
// snapshot *is* the handoff).
export const deductionsDecisionStatuses = [
  "Pending",
  "Approved for Payroll",
  "Do Not Take Action",
  "Needs Follow-up",
  "Disputed",
] as const;
export type DeductionsDecisionStatus = (typeof deductionsDecisionStatuses)[number];

export const deductionsSalaryRecordsColumns = [
  "finger_print",
  "crm",
  "unpaid_vacations",
  "loans",
  "other_deductions",
] as const;
export type DeductionsSalaryRecordsColumn = (typeof deductionsSalaryRecordsColumns)[number];

export type DeductionsCategoryConfig = {
  category: DeductionsCategory;
  label: string;
  detectionEngine: string;
  requiresApproval: boolean;
  salaryRecordsColumn: DeductionsSalaryRecordsColumn | null;
  sortOrder: number;
};

export type DeductionsCandidate = {
  id: string;
  category: DeductionsCategory;
  sourceSystem: string;
  sourceRecordId: string;
  candidateKey: string;
  employeeHrId: string;
  employeeHrIdCompact: string;
  employeeName: string | null;
  monthKey: string;
  month: number;
  year: number;
  unit: DeductionsUnit;
  rawValue: number;
  estimatedAmount: number | null;
  calculationStatus: DeductionsCalculationStatus;
  severity: DeductionsSeverity | null;
  reason: string | null;
  evidence: Record<string, unknown>;
  dates: string[];
  hierarchySnapshot: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
  refreshedAt: string | null;
  lockedAt: string | null;
  supersededAt: string | null;
  supersededByCandidateId: string | null;
};

export type DeductionsDecision = {
  id: string;
  candidateId: string;
  decisionStatus: DeductionsDecisionStatus;
  decisionReason: string;
  hrNote: string;
  appliedValue: number | null;
  appliedAmount: number | null;
  /**
   * The exact days this decision charges — always a subset of the parent
   * candidate's `dates`. `null` means the reviewer never narrowed the selection,
   * so every detected day applies; an EMPTY array means they cleared them all.
   * The two are not interchangeable: treating `null` as "no days" would turn
   * every historical decision into a 0.00 EGP deduction.
   */
  appliedDates: string[] | null;
  decidedBy: string | null;
  decidedAt: string | null;
  actorRoleAtDecision: string | null;
  createdAt: string;
  updatedAt: string;
};

// Draft shape emitted by a category connector prior to insert. id, candidateKey,
// employeeHrIdCompact, createdAt, lockedAt, supersededAt, supersededByCandidateId
// are computed/owned by the service layer, not the connector.
export type DeductionsCandidateDraft = {
  category: DeductionsCategory;
  sourceSystem: string;
  sourceRecordId: string;
  employeeHrId: string;
  employeeName?: string | null;
  monthKey: string;
  month: number;
  year: number;
  unit: DeductionsUnit;
  rawValue: number;
  estimatedAmount?: number | null;
  calculationStatus?: DeductionsCalculationStatus;
  severity?: DeductionsSeverity | null;
  reason?: string | null;
  evidence?: Record<string, unknown>;
  dates: string[];
  hierarchySnapshot?: Record<string, unknown>;
  createdBy?: string;
};

// A candidate joined with its decision (LEFT JOIN — a fresh candidate may have
// no decision row yet at the DB level, though the service layer always creates
// one at insert time so this should only ever be null transiently).
export type DeductionsCandidateWithDecision = DeductionsCandidate & {
  decision: DeductionsDecision | null;
  /**
   * Display enrichment resolved from the employees table at read time, not
   * stored on the candidate. `employeeName` is captured when the candidate is
   * collected and is sometimes null (5 of July 2026's 102), which used to make
   * the workspace fall back to printing the HR code — and a raw code must never
   * reach a screen. Optional so existing fixtures need not carry it.
   */
  hireDate?: string | null;
  /**
   * Any of this candidate's days that sit directly beside a governmental
   * holiday (nearest WORKING day either side — see holiday-bridge.ts).
   * Display annotation resolved at read time; it explains a row, it does not
   * change what the row charges.
   */
  holidayBridges?: Array<{
    date: string;
    adjacentTo: "before" | "after";
    holidayName: string;
    holidayStartDate: string;
    holidayEndDate: string;
  }>;
};

export const deductionsPublicationStatuses = ["published", "superseded"] as const;
export type DeductionsPublicationStatus = (typeof deductionsPublicationStatuses)[number];

export type DeductionsPublication = {
  id: string;
  month: number;
  year: number;
  monthKey: string;
  status: DeductionsPublicationStatus;
  publishedBy: string;
  publishedAt: string;
  supersededAt: string | null;
  supersededByPublicationId: string | null;
  candidateCount: number;
  employeeCount: number;
  categoryTotals: Partial<Record<DeductionsCategory, number>>;
  notes: string | null;
  createdAt: string;
};

export type DeductionsPublicationLine = {
  id: string;
  publicationId: string;
  candidateId: string;
  decisionId: string | null;
  employeeHrId: string;
  employeeHrIdCompact: string;
  employeeName: string | null;
  monthKey: string;
  category: DeductionsCategory;
  unit: DeductionsUnit;
  originalValue: number;
  appliedValue: number;
  appliedAmount: number;
  dates: string[];
  reason: string | null;
  hrNote: string | null;
  createdAt: string;
};

// The employee-portal display line (src/lib/deductions/portal.ts). One row per
// published deduction the viewer is allowed to see. Named for the portal, not a
// "monthly summary": this module's publish snapshot *is* the record, so there is
// no separate summary object the way the retired governance module had. The
// shape mirrors what DeductionsPortalWorkspace renders and nothing more —
// `sourceModule` is always "DEDUCTIONS_MODULE" now that the legacy dual-read is
// gone, kept only because the component still prints it beside the category.
export type DeductionsPortalLine = {
  id: string;
  summaryId: string;
  candidateId: string;
  decisionId: string;
  employeeCode: string;
  employeeHrIdCompact: string;
  employeeName: string | null;
  monthKey: string;
  sourceModule: "DEDUCTIONS_MODULE";
  deductionType: DeductionsCategory;
  payrollColumn: DeductionsSalaryRecordsColumn;
  deductionUnit: DeductionsUnit;
  originalDeductionValue: number;
  appliedDeductionValue: number;
  appliedAmount: number;
  dates: string[];
  reason: string | null;
  hrNote: string | null;
  createdAt: string;
};

/**
 * One deduction raised against the employee, as his own portal shows it (owner, 2026-10-09: every
 * deduction from the September salary on, with HR's answer on each).
 *
 * Unlike {@link DeductionsPortalLine} this is NOT a released publication line — it is the candidate
 * itself, so a row HR has not decided yet is in here too. `outcome` says what the person is facing
 * and is derived from the DECISION, because that is what Automated Payroll charges; `canComment` is
 * the separate question of whether the row was released and can be argued with.
 */
export type DeductionsPortalLedgerRow = {
  candidateId: string;
  /** The active published line, when this row was released to him; null when it was not. */
  releasedLineId: string | null;
  employeeCode: string;
  employeeHrIdCompact: string;
  employeeName: string | null;
  monthKey: string;
  category: DeductionsCategory;
  payrollColumn: DeductionsSalaryRecordsColumn;
  unit: DeductionsUnit;
  dates: string[];
  /** Why the system raised it, in the connector's own words. */
  whyFlagged: string | null;
  /** What was detected before anyone looked at it. */
  detectedValue: number;
  detectedAmount: number | null;
  /** What is actually being taken — zero on anything not approved for payroll. */
  chargedValue: number;
  chargedAmount: number;
  outcome: "on_payslip" | "cleared" | "under_review" | "needs_follow_up" | "disputed";
  /** HR's decision status verbatim, or "Pending" when nobody has decided. */
  hrStatus: string;
  /** HR's written answer on this row — the decision reason. */
  hrResponse: string | null;
  hrNote: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  canComment: boolean;
  createdAt: string;
};

// Employee/HR comment thread on a published candidate (Phase 4). Mirrors
// legacy deductions-governance's DeductionComment shape 1:1 — see
// src/lib/deductions/comments.ts.
export type DeductionsComment = {
  id: string;
  candidateId: string;
  authorLoginId: string;
  authorHrId: string | null;
  authorRole: string | null;
  /** The author's human-readable name, resolved from employees at read time. Null when it cannot
   *  be resolved. Lets a thread label who wrote each line — the employee, or the HR person who
   *  replied — now that a deduction dispute is a two-way conversation, not a one-sided note. */
  authorName?: string | null;
  body: string;
  createdAt: string;
  /** Pictures the sender attached (a Super Admin reply can carry up to four). Absent or empty when
   *  there are none; each is opened through `url`, a permission-checked route, never a stored link. */
  attachments?: DeductionsCommentAttachment[];
};

export type DeductionsCommentAttachment = {
  contentType: string;
  fileName: string;
  id: string;
  sizeBytes: number;
  url: string;
};

/** One labelled fact from a deduction's evidence — already in words, never a code or an HR id. */
export type DeductionDisputeFact = { label: string; value: string };

/** The decision recorded on a deduction, as the Disputes inbox shows it. */
export type DeductionDisputeDecision = {
  status: string;
  reason: string;
  hrNote: string;
  decidedByName: string | null;
  decidedAt: string | null;
  appliedValue: number | null;
  appliedAmount: number | null;
  /** null = never narrowed (every detected day charges); [] = every day cleared. */
  appliedDates: string[] | null;
};

/**
 * Everything the person answering a dispute needs to see WITHOUT leaving the Disputes tab (owner,
 * 2026-10-08): what raised the deduction, the rule it was measured against, the days and the
 * arithmetic, the evidence the check recorded, and the decision that put it on the payslip.
 * Built by `buildDisputeBasis` (dispute-basis.ts) from rows the inbox read already loaded.
 */
export type DeductionDisputeBasis = {
  detectedBy: string;
  explanation: string;
  reason: string | null;
  severity: DeductionsSeverity | null;
  needsReview: boolean;
  unit: DeductionsUnit;
  detectedValue: number;
  detectedDates: string[];
  estimatedAmount: number | null;
  ratePerUnit: number | null;
  rateBasis: string | null;
  facts: DeductionDisputeFact[];
  decision: DeductionDisputeDecision | null;
  chargedAmount: number;
  chargedValue: number;
  publishedAt: string;
  pushedAt: string | null;
  pushedByName: string | null;
};

/** One person a reply is addressed to, by name — the Disputes inbox never shows an HR code. */
export type DeductionDisputeRecipient = { name: string; title: string | null };

/** Who a reply to this dispute reaches: the employee (To) and their managers (CC). */
export type DeductionDisputeAudience = {
  to: DeductionDisputeRecipient;
  managers: DeductionDisputeRecipient[];
};

/** What happened to a reply once it was sent — shown under the composer so the sender can see it. */
export type DeductionDisputeDelivery = {
  to: DeductionDisputeRecipient & { telegramLinked: boolean };
  cc: Array<DeductionDisputeRecipient & { telegramLinked: boolean; relation: "manager" | "sender" }>;
};

// One employee's dispute thread on a published deduction, as the ADMIN Deductions
// screen reads it — the counterpart to the portal's per-line thread. A comment
// mails HR with a link to /admin/deductions, so there has to be a place there that
// actually shows it; this is the row that place renders. Only a deduction that is still
// ACTIVE on the payslip is listed (owner, 2026-10-08), so `line` and `basis` are present for
// every thread the inbox returns; they stay nullable for the pure grouping function's callers.
export type AdminDeductionCommentThread = {
  candidateId: string;
  line: DeductionsPortalLine | null;
  /** Why the deduction was made, in words — null only when the candidate row could not be read. */
  basis?: DeductionDisputeBasis | null;
  /** Who a reply reaches, so the sender sees the To and CC before pressing Reply. */
  replyAudience?: DeductionDisputeAudience | null;
  comments: DeductionsComment[];
  /** The newest comment's createdAt — threads sort by this, most recent first. */
  latestCommentAt: string;
};
