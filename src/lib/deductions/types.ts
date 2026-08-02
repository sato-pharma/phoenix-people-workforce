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
  "unpaid_vacation",
  "insufficient_balance_vacation",
  "loan",
  "other",
] as const;

export const deductionsCategories = [
  "fingerprint",
  "crm",
  "no_records_activity",
  "unpaid_vacation",
  "insufficient_balance_vacation",
  "loan",
  "other",
] as const;
export type DeductionsCategory = (typeof deductionsCategories)[number];

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

// Employee/HR comment thread on a published candidate (Phase 4). Mirrors
// legacy deductions-governance's DeductionComment shape 1:1 — see
// src/lib/deductions/comments.ts.
export type DeductionsComment = {
  id: string;
  candidateId: string;
  authorLoginId: string;
  authorHrId: string | null;
  authorRole: string | null;
  body: string;
  createdAt: string;
};
