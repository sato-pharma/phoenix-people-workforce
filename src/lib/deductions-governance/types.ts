// Deductions Governance Center: governance/reporting only; no payroll/leave mutation.

export const deductionSourceModules = [
  "FIELD_WORKFORCE",
  "ATTENDANCE_DEVICE",
  "VACATION",
  "MANUAL_HR",
  "DISCIPLINARY",
  "PAYROLL_ADJUSTMENT",
  "EXPENSE_RECOVERY",
  "OTHER",
  // Rows sourced from the unified Deductions module (src/lib/deductions/),
  // not this legacy governance module — a distinct value on purpose, so a
  // reader can tell at a glance which pipeline produced a given portal row
  // during the dual-read transition period.
  "DEDUCTIONS_MODULE",
] as const;
export type DeductionSourceModule = (typeof deductionSourceModules)[number];

export const deductionTypes = [
  "no_activity",
  "absence",
  "late_arrival",
  "early_leave",
  "short_hours",
  "missing_punch",
  "unpaid_leave",
  "leave_without_balance",
  "retroactive_leave",
  "disciplinary_deduction",
  "manual_deduction",
  "expense_recovery",
  "salary_adjustment",
  "other",
  // The unified Deductions module's own 7 category slugs, used verbatim as
  // the deductionType for rows sourced from that module (see DEDUCTIONS_MODULE
  // above) — deliberately not force-mapped onto the legacy, finer-grained
  // vocabulary above, which encodes a precision (late_arrival vs short_hours
  // vs missing_punch, etc.) the new connectors don't distinguish.
  "fingerprint",
  "crm",
  "no_records_activity",
  "unpaid_vacation",
  "insufficient_balance_vacation",
  "loan",
] as const;
export type DeductionType = (typeof deductionTypes)[number];

export const deductionUnits = [
  "days",
  "hours",
  "amount",
  "count",
  "percentage",
] as const;
export type DeductionUnit = (typeof deductionUnits)[number];

export const deductionCalculationStatuses = [
  "calculated",
  "requires_payroll_formula",
  "requires_payroll_review",
  "not_applicable",
] as const;
export type DeductionCalculationStatus = (typeof deductionCalculationStatuses)[number];

export const deductionSeverities = ["Low", "Medium", "High", "Review"] as const;
export type DeductionSeverity = (typeof deductionSeverities)[number];

export const deductionDecisionStatuses = [
  "Pending",
  "Approved for Payroll",
  "Approved for Leave Adjustment",
  "Do Not Take Action",
  "Needs Follow-up",
  "Disputed",
  "Resolved",
  "Cancelled",
] as const;
export type DeductionDecisionStatus = (typeof deductionDecisionStatuses)[number];

export const deductionDecisionReasons = [
  "Employee confirmed",
  "Employee did not respond (auto-confirmed)",
  "Dispute reviewed and rejected",
  "System issue",
  "Manager approved exception",
  "Official training",
  "Meeting / cycle meeting",
  "Medical excuse pending",
  "Doctor conference",
  "Area assignment issue",
  "Public holiday conflict",
  "Late CRM sync",
  "Fingerprint device issue",
  "Leave already covered",
  "Policy violation",
  "No action needed",
  "Other",
] as const;
export type DeductionDecisionReason = (typeof deductionDecisionReasons)[number];

export const deductionPayrollHandoffStatuses = [
  "Not pushed",
  "Export only",
  "Pending integration",
  "Imported to Payroll",
] as const;
export type DeductionPayrollHandoffStatus = (typeof deductionPayrollHandoffStatuses)[number];

export const deductionPayrollColumns = [
  "crm",
  "finger_print",
  "unpaid_vacations",
  // The unified Deductions module's other 2 real salary_records columns
  // (src/lib/deductions/calculations.ts's DEDUCTIONS_CATEGORY_CONFIG) — this
  // legacy governance module never produced a Loan or catch-all Other
  // candidate, so it never needed these until the portal started reading rows
  // sourced from the new module too.
  "loans",
  "other_deductions",
] as const;
export type DeductionPayrollColumn = (typeof deductionPayrollColumns)[number];

export type DeductionCandidate = {
  id: string;
  sourceModule: DeductionSourceModule;
  sourceRecordId: string;
  candidateKey: string;
  employeeCode: string;
  employeeHrIdCompact: string;
  employeeName: string | null;
  monthKey: string;
  month: number;
  year: number;
  deductionType: DeductionType;
  deductionUnit: DeductionUnit;
  deductionValue: number;
  estimatedAmount: number | null;
  calculationStatus: DeductionCalculationStatus;
  severity: DeductionSeverity | null;
  reason: string | null;
  evidence: Record<string, unknown>;
  holidayContext: string | null;
  dates: string[];
  hierarchySnapshot: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
  supersededAt: string | null;
  supersededByCandidateId: string | null;
};

export type DeductionDecision = {
  id: string;
  candidateId: string;
  decisionStatus: DeductionDecisionStatus;
  decisionReason: string;
  hrNote: string;
  appliedDeductionValue: number | null;
  appliedAmount: number | null;
  payrollColumn: DeductionPayrollColumn | null;
  decidedBy: string | null;
  decidedAt: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  payrollHandoffStatus: DeductionPayrollHandoffStatus;
  lastExportId: string | null;
  finalizedSummaryId: string | null;
  actorRoleAtDecision: string | null;
  actorScopeAtDecision: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DeductionExport = {
  id: string;
  monthKey: string | null;
  generatedBy: string;
  generatedAt: string;
  decisionCount: number;
  filtersSnapshot: Record<string, unknown>;
  fileName: string;
  notes: string | null;
};

export type DeductionMonthlySummary = {
  id: string;
  monthKey: string;
  month: number;
  year: number;
  status: "finalized" | "superseded";
  finalizedBy: string;
  finalizedAt: string;
  candidateCount: number;
  employeeCount: number;
  totalDays: number;
  totalAmount: number;
  sourceCounts: Record<string, unknown>;
  notes: string | null;
  createdAt: string;
};

export type DeductionMonthlySummaryLine = {
  id: string;
  summaryId: string;
  candidateId: string;
  decisionId: string;
  employeeCode: string;
  employeeHrIdCompact: string;
  employeeName: string | null;
  monthKey: string;
  sourceModule: DeductionSourceModule;
  deductionType: DeductionType;
  payrollColumn: DeductionPayrollColumn;
  deductionUnit: DeductionUnit;
  originalDeductionValue: number;
  appliedDeductionValue: number;
  appliedAmount: number;
  dates: string[];
  reason: string | null;
  hrNote: string | null;
  createdAt: string;
};

export type DeductionComment = {
  id: string;
  candidateId: string;
  authorLoginId: string;
  authorHrId: string | null;
  authorRole: string | null;
  body: string;
  createdAt: string;
};

// Draft shape emitted by source-module connectors prior to insert.
// id, candidateKey, employeeHrIdCompact, createdAt, supersededAt,
// supersededByCandidateId are computed/owned by the service layer.
// createdBy may be omitted; the service will default it from options.
export type DeductionCandidateDraft = {
  sourceModule: DeductionSourceModule;
  sourceRecordId: string;
  employeeCode: string;
  employeeName?: string | null;
  monthKey: string;
  month: number;
  year: number;
  deductionType: DeductionType;
  deductionUnit: DeductionUnit;
  deductionValue: number;
  estimatedAmount?: number | null;
  calculationStatus?: DeductionCalculationStatus;
  severity?: DeductionSeverity | null;
  reason?: string | null;
  evidence?: Record<string, unknown>;
  holidayContext?: string | null;
  dates: string[];
  hierarchySnapshot?: Record<string, unknown>;
  createdBy?: string;
};
