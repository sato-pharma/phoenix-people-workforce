export const VACATION_TYPES = [
  { label: "Annual Vacation", value: "annual" },
  { label: "Emergency Vacation", value: "emergency" },
  { label: "Sick Vacation", value: "sick" },
  { label: "Other", value: "other" },
  { label: "Compensatory Day", value: "compensatory" },
] as const;

export const VACATION_REQUEST_TYPES = [
  { label: "Annual", value: "annual" },
  { label: "Sick", value: "sick" },
  { label: "Other", value: "other" },
  { label: "Compensatory Day", value: "compensatory" },
] as const satisfies ReadonlyArray<{ label: string; value: VacationType }>;

export const VACATION_DAY_PARTS = [
  { label: "Full day", value: "full_day" },
  { label: "AM only", value: "am_only" },
  { label: "PM only", value: "pm_only" },
] as const;

export const VACATION_STATUSES = [
  { label: "Needs HR Assignment", value: "needs_assignment" },
  { label: "Pending Manager", value: "pending_manager" },
  { label: "Pending HR", value: "pending_hr" },
  { label: "Approved", value: "approved" },
  { label: "Rejected", value: "rejected" },
  { label: "Returned to Employee", value: "returned" },
] as const;

export const VACATION_PAYMENT_STATUSES = [
  { label: "Paid", value: "paid" },
  { label: "Partially Paid", value: "partial" },
  { label: "Unpaid", value: "unpaid" },
] as const;

export const VACATION_WEEKLY_OFF_MODES = [
  { label: "Working", value: "working" },
  { label: "AM off", value: "am_only" },
  { label: "PM off", value: "pm_only" },
  { label: "Full day off", value: "full_day" },
] as const;

export type VacationType = (typeof VACATION_TYPES)[number]["value"];
export type VacationDayPart = (typeof VACATION_DAY_PARTS)[number]["value"];
export type VacationRequestStatus = (typeof VACATION_STATUSES)[number]["value"];
export type VacationPaymentStatus = (typeof VACATION_PAYMENT_STATUSES)[number]["value"];
export type VacationDecision = "approve" | "reject" | "return";
export type VacationUnpaidReason = "first_six_months" | "insufficient_balance" | "missing_hire_date";
export type VacationWeeklyOffMode = (typeof VACATION_WEEKLY_OFF_MODES)[number]["value"];
export type VacationEvidenceType = "compensatory" | "sick";
export type VacationEvidenceReviewStatus = "accepted" | "needs_follow_up" | "pending" | "rejected";
export type VacationTimelineEventType =
  | "admin_created"
  | "admin_deleted"
  | "admin_updated"
  | "approval_admin_override"
  | "evidence_reviewed"
  | "evidence_uploaded"
  | "hr_approved"
  | "hr_rejected"
  | "manager_approved"
  | "manager_rejected"
  | "notification_failed"
  | "overlap_warning"
  | "sla_escalation"
  | "sla_reminder"
  | "submitted"
  | string;

// Sequential approval workflow (Annual / Other / Compensatory). Backend keeps the generic step
// keys below; the conceptual generic identity + dynamic display labels are derived in
// src/lib/vacation/approval-flow.ts. Emergency + Sick keep the legacy parallel flow.
export type VacationWorkflowStepKey = "direct_manager" | "manager_of_manager" | "manager_level_3" | "hr";
export type VacationGenericStepName =
  | "management_approval_1"
  | "management_approval_2"
  | "management_approval_3"
  | "hr_acknowledgement";
export type VacationApprovalStepStatus = "pending" | "approved" | "rejected";

export type VacationApprovalStepState = {
  order: number;
  status: VacationApprovalStepStatus;
  stepKey: VacationWorkflowStepKey;
};

export type VacationActionButton =
  | "approve"
  | "reject"
  | "acknowledge"
  | "assign"
  | "return"
  // Super Admin only, and only once the active management approver has sat on the step for
  // ADMIN_OVERRIDE_STALL_DAYS. Decides that approver's step in their place; the chain then
  // carries on normally and the next approver starts a fresh clock (owner decision 2026-09-10).
  | "overrideApprove"
  | "overrideReject";
export type VacationActionAvailability = Record<
  VacationActionButton,
  { enabled: boolean; disabledReason: string | null }
>;

export type VacationRequestInput = {
  dayPart: VacationDayPart;
  endDate: string;
  startDate: string;
  vacationType: VacationType;
};

export type VacationBalanceSnapshot = {
  balanceAfterDays: number;
  balanceBeforeDays: number;
  entitlementDays: number;
  paymentStatus: VacationPaymentStatus;
  paidDurationDays: number;
  periodEnd: string | null;
  periodStart: string | null;
  unpaidReason: VacationUnpaidReason | null;
  unpaidDurationDays: number;
  usedPaidDays: number;
};

export type VacationEmployeeSummary = {
  departmentName: string | null;
  fullName: string;
  displayName: string;
  hireDate: string | null;
  hrId: string;
  lineName: string | null;
  managerHrId: string | null;
  managerName: string | null;
  workEmail: string | null;
};

export type VacationWeeklyOffPolicyRecord = {
  friday: VacationWeeklyOffMode;
  id: string | null;
  jobTitle: string;
  saturday: VacationWeeklyOffMode;
  thursday: VacationWeeklyOffMode;
  updatedAt: string | null;
};

export type VacationWeeklyOffPolicySnapshot = {
  capturedAt: string;
  friday: VacationWeeklyOffMode;
  jobTitle: string;
  policyId: string | null;
  saturday: VacationWeeklyOffMode;
  thursday: VacationWeeklyOffMode;
  updatedAt: string | null;
};

export type VacationEvidenceReview = {
  createdAt: string;
  evidenceType: VacationEvidenceType;
  id: string;
  requestId: string;
  reviewNote: string | null;
  reviewedAt: string | null;
  reviewedByHrId: string | null;
  status: VacationEvidenceReviewStatus;
  updatedAt: string;
};

/**
 * One uploaded evidence FILE on a leave request, with the date THAT file arrived.
 *
 * A sick request accepts several files at submit and accepts more afterwards — a later upload adds
 * to the earlier ones and never replaces them (owner, 2026-10-03) — so "when was the evidence
 * uploaded" has one answer per FILE, not one per request. The legacy `sickAttachment*` /
 * `compensatoryAttachment*` fields on the record still name the FIRST file.
 */
export type VacationRequestAttachment = {
  bucket: string;
  contentType: string | null;
  id: string;
  kind: VacationEvidenceType;
  objectPath: string;
  originalName: string | null;
  requestId: string;
  sizeBytes: number;
  uploadedAt: string;
  uploadedByHrId: string | null;
};

export type VacationOverlapWarning = {
  code:
    | "employee_overlap"
    | "evidence_required"
    | "holiday_adjacent"
    | "manager_absent"
    | "team_overlap";
  message: string;
  relatedRequestIds: string[];
  severity: "info" | "warning";
};

export type VacationSlaStatus = {
  businessDaysPending: number;
  dueAt: string | null;
  isOverdue: boolean;
  lastEscalatedAt: string | null;
  lastRemindedAt: string | null;
  stage: "approved" | "manager" | "hr" | "rejected" | "returned";
};

export type VacationTimelineEvent = {
  actorHrId: string | null;
  actorLoginId: string | null;
  createdAt: string;
  eventType: VacationTimelineEventType;
  id: string;
  message: string;
  metadata: Record<string, unknown>;
  source: "decision" | "evidence" | "event" | "system";
};

export type VacationDashboardData = {
  dailyEscalationRunStatus: {
    finishedAt: string | null;
    runDate: string | null;
    status: "completed" | "failed" | "not_run" | "running";
  };
  evidence: {
    accepted: number;
    needsFollowUp: number;
    pending: number;
    rejected: number;
  };
  leaveDaysByDepartment: Array<{ departmentName: string; days: number }>;
  leaveDaysByLine: Array<{ days: number; lineName: string }>;
  managerBottlenecks: Array<{ managerHrId: string | null; managerName: string | null; overdue: number; pending: number }>;
  overlapWarnings: number;
  overdueBySla: {
    hr: number;
    manager: number;
    total: number;
  };
  pendingByStage: {
    hr: number;
    manager: number;
    total: number;
  };
};

export type VacationAuditExportMetadata = {
  actorHrId: string | null;
  actorLoginId: string | null;
  exportedAt: string;
  filters: VacationReportFilters;
  rowCount: number;
  scope: string;
};

export type VacationControlData = {
  policies: VacationWeeklyOffPolicyRecord[];
  titles: string[];
};

export type VacationRequestRecord = VacationBalanceSnapshot & {
  canDecide: boolean;
  createdAt: string;
  dayPart: VacationDayPart;
  departmentName: string | null;
  durationDays: number;
  employeeHireDate: string | null;
  employeeHrId: string;
  employeeName: string;
  employeeWorkEmail: string | null;
  endDate: string;
  id: string;
  compensatoryAttachmentBucket: string | null;
  compensatoryAttachmentContentType: string | null;
  compensatoryAttachmentObjectPath: string | null;
  compensatoryAttachmentOriginalName: string | null;
  compensatoryAttachmentSizeBytes: number;
  compensatoryAttachmentUploadedAt: string | null;
  compensatoryEventDate: string | null;
  compensatoryEventLocation: string | null;
  compensatoryEventName: string | null;
  compensatoryManager1: string | null;
  compensatoryManager2: string | null;
  sickAttachmentBucket: string | null;
  sickAttachmentContentType: string | null;
  sickAttachmentObjectPath: string | null;
  sickAttachmentOriginalName: string | null;
  sickAttachmentSizeBytes: number;
  sickAttachmentUploadedAt: string | null;
  lineName: string | null;
  hrDecision: "approved" | "rejected" | null;
  hrDecisionAt: string | null;
  hrDecisionByHrId: string | null;
  hrDecisionComment: string | null;
  managerDecision: "approved" | "rejected" | null;
  managerDecisionAt: string | null;
  managerDecisionByHrId: string | null;
  managerDecisionComment: string | null;
  managerHrId: string | null;
  managerName: string | null;
  managerOfManagerHrId: string | null;
  managerOfManagerName: string | null;
  employeeNote: string | null;
  notes: string | null;
  requestCode: string;
  startDate: string;
  status: VacationRequestStatus;
  submittedByHrId: string | null;
  vacationType: VacationType;
  // EVERY uploaded evidence file, oldest first, each with its own upload date. Hydrated beside
  // evidenceReviews; `[]` on a record read without that hydration.
  attachments: VacationRequestAttachment[];
  evidenceReviews: VacationEvidenceReview[];
  overlapWarnings: VacationOverlapWarning[];
  slaStatus: VacationSlaStatus;
  timelineEventCount: number;
  weeklyOffPolicySnapshot: VacationWeeklyOffPolicySnapshot | null;
  // Sequential-workflow display enrichment (optional; populated for Action Center + tracking).
  stageLabel?: string;
  workflowSequential?: boolean;
  genericActiveStep?: VacationGenericStepName | null;
};

export type VacationActionCenterRow = VacationRequestRecord & {
  approvalSteps: Array<
    VacationApprovalStepState & {
      approverHrId: string;
      approverName: string | null;
      approverTitle: string | null;
      decidedAt: string | null;
      decisionComment: string | null;
      genericStep: VacationGenericStepName;
    }
  >;
  assignedActorName: string | null;
  assignedActorTitle: string | null;
  actionAvailability: VacationActionAvailability;
  adminOverride: VacationAdminOverrideState | null;
  slaAgeDays: number;
  viewerStepKind: "management" | "hr" | "none";
};

/**
 * The stalled-approver override, as the viewer sees it. `available` is the server's verdict and
 * the only thing that decides whether the button renders; `reason` explains a false. Present on
 * every pending row so HR can see the wait building, not just once it unlocks.
 */
export type VacationAdminOverrideState = {
  approverHrId: string | null;
  approverName: string | null;
  available: boolean;
  availableAt: string | null;
  daysPending: number;
  reason: string | null;
};

export type VacationActionCenterData = {
  canAssign: boolean;
  generatedAt: string;
  rows: VacationActionCenterRow[];
};

export type VacationReportFilters = {
  dateFrom?: string;
  dateTo?: string;
  department?: string;
  employee?: string;
  line?: string;
  manager?: string;
  paymentStatus?: VacationPaymentStatus | "all";
  requestId?: string;
  search?: string;
  status?: VacationRequestStatus | "all";
  vacationType?: VacationType | "all";
};

export type VacationEligibilityStatus = "eligible" | "first_six_months" | "missing_hire_date";

export type VacationEmployeeEligibilityRow = {
  annualBalanceDays: number;
  annualEntitlementDays: number;
  annualUsedDays: number;
  daysSinceHire: number | null;
  daysUntilEligibility: number | null;
  departmentName: string | null;
  eligibilityStatus: VacationEligibilityStatus;
  eligibleForAnnualPaidLeave: boolean;
  employmentStatus: string | null;
  fullName: string;
  displayName: string;
  hireDate: string | null;
  hrId: string;
  lineName: string | null;
  managerHrId: string | null;
  managerName: string | null;
  reviewFlags: string[];
  sixMonthAnniversary: string | null;
};

export type VacationReportData = {
  canAdminManage: boolean;
  canExport: boolean;
  canReviewAttachments: boolean;
  viewerHrId: string | null;
  dashboard: VacationDashboardData;
  employeeEligibility: VacationEmployeeEligibilityRow[];
  employeeEligibilitySummary: {
    activeEmployees: number;
    eligibleNow: number;
    inFirstSixMonths: number;
    missingHireDate: number;
    zeroBalance: number;
  };
  filters: VacationReportFilters;
  /**
   * Deductions (CRM no-record days and half days) the Super Admin took from annual leave instead of
   * salary, with the comment written for the employee (owner, 2026-10-09). Scoped to the same
   * employees the report shows. `failed` is true when the read failed, so the page can say so instead
   * of showing an empty list.
   */
  leaveBalanceDeductions?: {
    failed: boolean;
    rows: Array<{
      chargedAt: string;
      comment: string;
      days: number;
      employeeHrId: string;
      employeeName: string;
      /**
       * This person has LEFT (resigned · terminated · not_renewed). Said here as well as on the
       * Entitlements row and in the charge dialog, because this section is the one place the charge
       * itself is listed — and a day taken from a leaver's balance is the case where the final
       * settlement may already have paid that balance out.
       */
      employeeHasLeft: boolean;
      /** The day they stopped working, or null when it is not on record. */
      lastWorkingDate: string | null;
      workDate: string;
    }>;
  };
  options: {
    departments: string[];
    employees: Array<{ label: string; value: string }>;
    lines: string[];
    managers: Array<{ label: string; value: string }>;
  };
  rows: VacationRequestRecord[];
  summary: {
    approved: number;
    managerDecisionActions: number;
    paidDays: number;
    pending: number;
    rejected: number;
    total: number;
    unpaidDays: number;
  };
};
