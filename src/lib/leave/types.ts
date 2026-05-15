import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";

export type LeaveStatus =
  | "draft"
  | "pending_manager"
  | "manager_approved"
  | "manager_rejected"
  | "pending_hr"
  | "hr_approved"
  | "hr_rejected"
  | "cancelled";

export type LeaveApprovalStatus = "pending" | "approved" | "rejected" | "not_required";
export type LeavePayrollStatus = "not_required" | "pending" | "processed" | "blocked";
export type LeavePaymentStatus = "paid" | "unpaid" | "in_review" | "non_deducted";
export type LeaveDurationUnit = "full_day" | "am" | "pm";
export type LeaveTransactionType =
  | "opening_balance"
  | "accrual"
  | "carry_forward"
  | "adjustment"
  | "pending"
  | "pending_reversal"
  | "consumed"
  | "consumed_reversal";

export type LeaveType = {
  id: string;
  code: string;
  name: string;
  isPaid: boolean;
  affectsPayroll: boolean;
  requiresAttachment: boolean;
  requiresManagerApproval: boolean;
  requiresHrApproval: boolean;
  employeeSelectable: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type LeavePolicy = {
  id: string;
  name: string;
  country: string;
  annualDaysFirstYear: number;
  annualDaysAfterFirstYear: number;
  accrualMethod: "monthly";
  accrualFrequency: "monthly";
  allowNegativeBalance: boolean;
  carryForwardEnabled: boolean;
  carryForwardLimit: number;
  carryForwardExpiryMonths: number;
  weekendDays: number[];
  isDefault: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type LeaveTitleWeekendRule = {
  employeeCount: number;
  isConfigured: boolean;
  title: string;
  titleKey: string;
  weekendDays: number[];
};

export type EmployeeLeaveBalance = {
  id: string;
  employeeHrId: string;
  leaveTypeId: string;
  policyId: string;
  year: number;
  openingBalance: number;
  accrued: number;
  consumed: number;
  pending: number;
  adjusted: number;
  carryForward: number;
  availableBalance: number;
  lastAccrualDate: string | null;
  createdAt: string;
  updatedAt: string;
};

export type LeaveRequest = {
  id: string;
  employeeHrId: string;
  leaveTypeId: string;
  policyId: string;
  startDate: string;
  endDate: string;
  totalCalendarDays: number;
  totalWorkingDays: number;
  reason: string | null;
  attachmentUrl: string | null;
  balanceLeaveTypeId: string | null;
  durationUnit: LeaveDurationUnit;
  hrBalanceDecision: "deduct" | "no_deduct" | null;
  paymentReason: string | null;
  paymentStatus: LeavePaymentStatus;
  status: LeaveStatus;
  managerStatus: LeaveApprovalStatus;
  hrStatus: LeaveApprovalStatus;
  payrollStatus: LeavePayrollStatus;
  managerComment: string | null;
  hrComment: string | null;
  requestedAt: string;
  managerDecisionAt: string | null;
  hrDecisionAt: string | null;
  createdAt: string;
  updatedAt: string;
  employee?: Pick<EmployeeDirectoryRow, "areaName" | "fullName" | "hrId" | "jobTitle" | "lineName" | "managerHrId" | "managerName"> | null;
  leaveType?: Pick<LeaveType, "code" | "name" | "isPaid" | "affectsPayroll"> | null;
  approvalHistory?: LeaveApproval[];
};

export type LeaveTransaction = {
  id: string;
  employeeHrId: string;
  leaveTypeId: string;
  policyId: string;
  requestId: string | null;
  transactionType: LeaveTransactionType;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  notes: string | null;
  createdBy: string | null;
  createdAt: string;
};

export type LeaveApproval = {
  id: string;
  requestId: string;
  approverHrId: string;
  approverRole: string;
  approvalStep: "hr" | "manager" | "system";
  status: "adjusted" | "approved" | "cancelled" | "rejected";
  comment: string | null;
  actionDate: string;
  createdAt: string;
};

export type LeaveAuditLog = {
  id: string;
  correlationId: string;
  eventType: string;
  requestId: string | null;
  employeeHrId: string | null;
  actorHrId: string | null;
  actorRole: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type PublicHoliday = {
  id: string;
  name: string;
  date: string;
  endDate?: string | null;
  durationDays?: number | null;
  year: number;
  country: string;
  isActive: boolean;
  createdAt: string;
};

export type PublicHolidaySyncResult = {
  calendarId: string;
  country: string;
  holidays: PublicHoliday[];
  source: "google_calendar_api" | "google_calendar_ical" | "nager_date_fallback";
  synced: number;
  warning?: string;
  year: number;
};

export type LeaveWallet = {
  annualEntitlement: number;
  accrued: number;
  used: number;
  pending: number;
  available: number;
  openingBalance: number;
  carryForward: number;
  adjusted: number;
  balance?: EmployeeLeaveBalance | null;
};

export type LeaveRequestFilters = {
  employee?: string;
  employeeHrId?: string;
  line?: string;
  area?: string;
  managerHrId?: string;
  paymentStatus?: string;
  status?: string;
  leaveTypeId?: string;
  limit?: number;
  month?: number;
  offset?: number;
  year?: number;
  startDate?: string;
  endDate?: string;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
};

export type LeaveCalendarItem = {
  id: string;
  kind: "holiday" | "request";
  title: string;
  employeeHrId?: string | null;
  employeeName?: string | null;
  lineName?: string | null;
  areaName?: string | null;
  leaveTypeName?: string | null;
  startDate: string;
  endDate: string;
  status: LeaveStatus | "public_holiday";
  totalWorkingDays: number;
};

export type TeamAvailabilityDay = {
  date: string;
  approved: LeaveRequest[];
  pending: LeaveRequest[];
  rejected: LeaveRequest[];
  publicHolidays: PublicHoliday[];
  conflictCount: number;
};

export type LeaveConflictWarning = {
  code: "same_area_capacity" | "same_line_capacity" | "overlapping_employee";
  message: string;
  severity: "blocker" | "warning";
  count: number;
  threshold: number;
};

export type LeaveConflictResult = {
  blocked: boolean;
  warnings: LeaveConflictWarning[];
  overlappingRequests: LeaveRequest[];
  sameAreaCount: number;
  sameLineCount: number;
};

export type LeaveAnalytics = {
  requestsByStatus: Array<{ label: string; value: number }>;
  consumptionByMonth: Array<{ label: string; value: number }>;
  topLeaveTypes: Array<{ label: string; value: number }>;
  usageByLine: Array<{ label: string; value: number }>;
  pendingApprovalAging: Array<{ label: string; value: number }>;
  upcomingApprovedLeave: LeaveRequest[];
  publicHolidayImpact: Array<{ label: string; value: number }>;
};

export type LeaveAccrualPreviewEmployee = {
  employeeHrId: string;
  employeeName: string;
  lineName: string | null;
  monthlyAccrual: number;
  alreadyAccrued: boolean;
  lastAccrualDate: string | null;
};

export type LeaveAccrualPreview = {
  alreadyAccrued: number;
  employees: LeaveAccrualPreviewEmployee[];
  lastRunAt: string | null;
  month: number;
  period: string;
  totalAccrualDays: number;
  upcomingPeriod: string;
  wouldAccrue: number;
  year: number;
};

export type SubmitLeaveRequestInput = {
  leaveTypeId: string;
  startDate: string;
  endDate: string;
  durationUnit?: LeaveDurationUnit;
  reason?: string | null;
  attachmentUrl?: string | null;
};

export type LeaveDecisionInput = {
  balanceDecision?: "deduct" | "no_deduct" | null;
  decision: "approved" | "rejected";
  comment?: string | null;
};

export type LeaveAdjustmentInput = {
  employeeHrId: string;
  leaveTypeId: string;
  amount: number;
  reason: string;
  year?: number;
};

export type VacationReportScope = "my" | "team" | "company";

export type VacationReportRow = {
  id: string;
  employeeHrId: string;
  employeeName: string | null;
  title: string | null;
  line: string | null;
  area: string | null;
  directManager: string | null;
  directManagerHrId: string | null;
  requestDate: string;
  leaveType: string | null;
  fromDate: string;
  toDate: string;
  duration: number;
  durationUnit: LeaveDurationUnit;
  balanceBefore: number | null;
  balanceAfter: number | null;
  paymentStatus: LeavePaymentStatus;
  managerApprovalStatus: LeaveApprovalStatus;
  managerApprovedBy: string | null;
  managerDecisionDate: string | null;
  hrApprovalStatus: LeaveApprovalStatus;
  hrApprovedBy: string | null;
  hrDecisionDate: string | null;
  finalStatus: LeaveStatus;
  reason: string | null;
  attachmentStatus: "attached" | "missing";
  createdAt: string;
};

export type VacationReportData = {
  canExport: boolean;
  filters: LeaveRequestFilters;
  rows: VacationReportRow[];
  scope: VacationReportScope;
  title: string;
};

export type VacationReportWorkspace = {
  companyReport?: VacationReportData | null;
  myReport?: VacationReportData | null;
  teamReport?: VacationReportData | null;
};

export type HistoricalVacationUploadValue = string | number | null;

export type HistoricalVacationUploadRow = Record<string, HistoricalVacationUploadValue>;

export type HistoricalVacationAcceptedRow = {
  employeeHrId: string;
  externalReference: string | null;
  legacySystem: string | null;
  projectedBalanceImpact: number;
  row: HistoricalVacationUploadRow;
  rowNumber: number;
  warnings: string[];
};

export type HistoricalVacationRejectedRow = {
  errors: string[];
  row: HistoricalVacationUploadRow;
  rowNumber: number;
  warnings: string[];
};

export type HistoricalVacationImportSummary = {
  acceptedRows: number;
  affectedEmployees: number;
  duplicateRows: number;
  projectedBalanceImpact: number;
  rejectedRows: number;
  totalRows: number;
};

export type HistoricalVacationDryRunResult = {
  acceptedRows: HistoricalVacationAcceptedRow[];
  fileName: string;
  rejectedRows: HistoricalVacationRejectedRow[];
  summary: HistoricalVacationImportSummary;
  warnings: string[];
};

export type HistoricalVacationConfirmResult = HistoricalVacationDryRunResult & {
  batchId: string | null;
  importedRows: number;
};

export type ActiveEmployeeAccrualRow = {
  accruedToDate: number;
  adjustments: number;
  annualEntitlement: number;
  area: string | null;
  availableBalance: number;
  carryForward: number;
  directManager: string | null;
  employeeHrId: string;
  employeeName: string;
  hiringDate: string | null;
  lastAccrualMonth: string | null;
  lastLeaveTransactionDate: string | null;
  line: string | null;
  monthlyAccrual: number;
  openingBalance: number;
  pending: number;
  policyBasis: string;
  serviceDuration: string;
  status: string;
  title: string | null;
  usedConsumed: number;
};

export type ActiveEmployeeAccrualReport = {
  generatedAt: string;
  pagination: {
    limit: number;
    offset: number;
    totalRows: number;
  };
  rows: ActiveEmployeeAccrualRow[];
  year: number;
};
