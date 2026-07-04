export type FieldWorkforceSeverity = "Low" | "Medium" | "High" | "Review";

export type FieldWorkforceCellStatus =
  | "N"
  | "AV"
  | "CP"
  | "VISITS"
  | "F"
  | "BLANK"
  | "UNKNOWN";

export type FieldWorkforceReviewCandidateType =
  | "campaign_signal"
  | "employee_match"
  | "friday_overlap"
  | "hiring_date"
  | "no_activity"
  | "pre_hire_activity"
  | "public_holiday_overlap"
  | "unknown_value"
  | "vacation_signal";

export type FieldWorkforceValidationIssue = {
  code: string;
  field?: string;
  message: string;
  rowNumber?: number;
  severity: "error" | "warning";
};

export type FieldWorkforceSourceCellValue = string | number | boolean | null;

export type FieldWorkforceDateColumn = {
  columnIndex: number;
  dateIso: string;
  dayNumber: number;
  header: string;
};

export type FieldWorkforceIgnoredColumn = {
  columnIndex: number;
  dayNumber?: number;
  header: string;
  reason: string;
};

export type FieldWorkforceParsedEmployeeRow = {
  employeeName: string;
  hiringDateIso: string | null;
  hrId: string;
  monthLabel: string | null;
  rawDailyValues: Record<string, FieldWorkforceSourceCellValue>;
  rawHiringDate: FieldWorkforceSourceCellValue;
  sourceRowNumber: number;
  year: number | null;
};

export type FieldWorkforceParsedWorkbook = {
  dateColumns: FieldWorkforceDateColumn[];
  errors: FieldWorkforceValidationIssue[];
  fileName: string;
  headerRowNumber: number;
  ignoredColumns: FieldWorkforceIgnoredColumn[];
  month: number | null;
  monthLabel: string | null;
  rows: FieldWorkforceParsedEmployeeRow[];
  sheetName: string;
  warnings: FieldWorkforceValidationIssue[];
  year: number | null;
};

export type FieldWorkforceEmployeeReference = {
  areaName?: string | null;
  departmentName?: string | null;
  employmentStatus?: string | null;
  fullName: string;
  hireDate?: string | null;
  hrId: string;
  jobTitle?: string | null;
  /** Last working date for resigned/terminated employees — days after it are ignored. */
  lastWorkingDate?: string | null;
  lineName?: string | null;
  managerHrId?: string | null;
  managerName?: string | null;
  roleName?: string | null;
  teamName?: string | null;
};

export type FieldWorkforceHoliday = {
  endDate?: string | null;
  name: string;
  startDate: string;
};

export type FieldWorkforceDayCell = {
  context: string[];
  countedAsNoActivityCandidate: boolean;
  countedAsVisitTotal: boolean;
  countedAsWorkedDay: boolean;
  dateIso: string;
  dayNumber: number;
  employeeName: string;
  explanation: string;
  holidayName?: string;
  hrId: string;
  ignored: boolean;
  ignoreReason?: string;
  isFriday: boolean;
  isPreHire: boolean;
  isPublicHoliday: boolean;
  rawValue: FieldWorkforceSourceCellValue;
  severity?: FieldWorkforceSeverity;
  status: FieldWorkforceCellStatus;
  visitCount?: number;
};

export type FieldWorkforceNoActivityPattern = {
  adjacentToFridayDates: string[];
  adjacentToPublicHolidayDates: string[];
  consecutiveSignalCount: number;
  hasThreeDayStreak: boolean;
  hasTwoDayStreak: boolean;
  highMonthlyCount: boolean;
  longestStreak: number;
  summary: string;
};

/**
 * How confidently this employee was tied to an iReports360 CRM identity — the join that
 * decides whether their "N" (no-activity) days are trustworthy. A day is only credible
 * evidence of absence if we could actually have SEEN the rep's visits; if we never resolved
 * their CRM identity, a blank month is a data-mapping gap, not absence.
 *  - crm_id       : directory has a CRM id for this employee (deterministic, strongest).
 *  - crm_username : no CRM id, but a CRM username is on file to resolve them.
 *  - override     : resolved only because the visits-report sync mapped their hr_id
 *                   (manual override / username) — no directory crm_id/username of our own.
 *  - unresolved   : no way to tie this employee to CRM activity. Their N days are NOT
 *                   trustworthy and MUST be excluded from deduction candidates.
 */
export type FieldWorkforceCrmIdentityConfidence =
  | "crm_id"
  | "crm_username"
  | "override"
  | "unresolved";

export type FieldWorkforceCrmIdentity = {
  attributedVisitRows: number;
  confidence: FieldWorkforceCrmIdentityConfidence;
  crmId: string | null;
};

export type FieldWorkforceEmployeeSummary = {
  areaName: string | null;
  campaignDays: number;
  compliancePercent: number;
  /**
   * CRM-identity resolution for the live (visits-mirror) path. Null on the Excel-upload
   * path, where the workbook itself is the trusted source and no CRM join happens.
   */
  crmIdentity?: FieldWorkforceCrmIdentity | null;
  employeeName: string;
  employmentStatus: string | null;
  eligibleWorkingDays: number;
  fridays: number;
  hiringDateIso: string | null;
  hiringDateSource: "employee_directory" | "missing" | "workbook";
  holidayWarnings: number;
  hrId: string;
  lineName: string | null;
  managerHrId: string | null;
  managerName: string | null;
  matchedEmployeeName: string | null;
  matchedHrId: string | null;
  matchStatus: "matched" | "unmatched";
  noActivityCandidates: number;
  noActivityPattern: FieldWorkforceNoActivityPattern;
  preHireIgnoredValues: number;
  roleName: string | null;
  severityCounts: Record<FieldWorkforceSeverity, number>;
  sourceRowNumber: number;
  teamName: string | null;
  timeline: FieldWorkforceDayCell[];
  totalVisits: number;
  unknownValues: number;
  vacationSignalDays: number;
  workedDays: number;
};

export type FieldWorkforceReviewCandidate = {
  context: string[];
  dateIso: string | null;
  dayNumber: number | null;
  employeeName: string;
  explanation: string;
  holidayName?: string;
  hrId: string;
  id: string;
  normalizedMeaning: string;
  rawValue: FieldWorkforceSourceCellValue;
  severity: FieldWorkforceSeverity;
  type: FieldWorkforceReviewCandidateType;
};

export type FieldWorkforcePreviewMetadata = {
  dateRange: {
    end: string | null;
    start: string | null;
  };
  employeeCount: number;
  fileName: string;
  holidayConnected: boolean;
  holidayMessage: string | null;
  holidaySourceLabel: string;
  holidaysDetected: number;
  matchedEmployees: number;
  month: number;
  monthLabel: string;
  sheetName: string;
  unmatchedEmployees: number;
  year: number;
};

export type FieldWorkforcePreviewResult = {
  errors: FieldWorkforceValidationIssue[];
  employees: FieldWorkforceEmployeeSummary[];
  metadata: FieldWorkforcePreviewMetadata;
  reviewCandidates: FieldWorkforceReviewCandidate[];
  severityCounts: Record<FieldWorkforceSeverity, number>;
  warnings: FieldWorkforceValidationIssue[];
};

export type FieldWorkforceArchiveImportStatus = "archived" | "superseded";

export type FieldWorkforceArchiveListItem = {
  employeeCount: number;
  highSeverityCount: number;
  id: string;
  month: number;
  monthKey: string;
  reviewCandidateCount: number;
  sheetName: string;
  sourceFilename: string;
  status: FieldWorkforceArchiveImportStatus;
  uploadedAt: string;
  uploadedBy: string;
  year: number;
};

export type FieldWorkforceArchiveDetail = {
  archive: FieldWorkforceArchiveListItem;
  preview: FieldWorkforcePreviewResult;
};

export type FieldWorkforceArchiveDuplicate = {
  existing: FieldWorkforceArchiveListItem;
  monthKey: string;
};

export type FieldWorkforceRecommendationType =
  | "leave_reconciliation"
  | "payroll_deduction";

export type FieldWorkforceRecommendationSourceType =
  | "approved_leave_request"
  | "calendar_av"
  | "n_retroactive_candidate"
  | "no_activity_candidate";

export type FieldWorkforceDecisionStatus =
  | "Pending"
  | "Approved for Leave Adjustment Report"
  | "Approved for Payroll Deduction Report"
  | "Do Not Take Action"
  | "Needs Follow-up"
  | "Disputed"
  | "Resolved"
  | "Cancelled";

export type FieldWorkforceDecisionReason =
  | "System issue"
  | "Manager approved field exception"
  | "Official training"
  | "Meeting / cycle meeting"
  | "Medical excuse pending"
  | "Doctor conference"
  | "Area assignment issue"
  | "Public holiday conflict"
  | "Late CRM sync"
  | "Duplicate / data issue"
  | "Already covered"
  | "No action needed"
  | "Other";

export type FieldWorkforceCoverageStatus =
  | "already_covered"
  | "leave_source_not_connected"
  | "needs_reconciliation"
  | "not_applicable"
  | "payroll_calculation_required";

export type FieldWorkforceRecommendation = {
  areaName: string | null;
  dates: string[];
  daysCount: number;
  decisionId: string | null;
  decisionReason: FieldWorkforceDecisionReason | "";
  decisionStatus: FieldWorkforceDecisionStatus;
  decidedAt: string | null;
  decidedBy: string | null;
  employeeCode: string;
  employeeName: string;
  employmentStatus: string | null;
  estimatedAmount: number | null;
  existingCoverageStatus: FieldWorkforceCoverageStatus;
  holidayContext: string | null;
  hrNote: string;
  importId: string;
  lineName: string | null;
  managerName: string | null;
  monthKey: string;
  recommendation: string;
  recommendationKey: string;
  recommendationReason: string;
  recommendationType: FieldWorkforceRecommendationType;
  resolvedAt: string | null;
  resolvedBy: string | null;
  roleName: string | null;
  severity: FieldWorkforceSeverity;
  sourceLabel: string;
  sourceType: FieldWorkforceRecommendationSourceType;
  teamName: string | null;
};

export type FieldWorkforceFinalAction = {
  actionType: "Leave Balance Adjustment" | "Payroll Deduction" | "No Action";
  amount: number | null;
  areaName: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  approvedDates: string[];
  approvedDaysCount: number;
  decisionReason: FieldWorkforceDecisionReason | "";
  decisionStatus: FieldWorkforceDecisionStatus;
  employeeCode: string;
  employeeName: string;
  employmentStatus: string | null;
  hrNote: string;
  lineName: string | null;
  managerName: string | null;
  monthKey: string;
  pushStatus: "Export only" | "Not pushed" | "Pending integration";
  recommendationKey: string;
  roleName: string | null;
  teamName: string | null;
};

export type FieldWorkforceComparisonRow = {
  areaName: string | null;
  campaignDays: number;
  compliancePercent: number;
  employeeCode: string;
  employeeName: string;
  employmentStatus: string | null;
  importId: string;
  lineName: string | null;
  managerName: string | null;
  monthKey: string;
  noActivityDays: number;
  roleName: string | null;
  teamName: string | null;
  totalVisits: number;
  vacationDays: number;
  workedDays: number;
};

export type FieldWorkforceComparisonReport = {
  archiveCount: number;
  hierarchyAvailable: boolean;
  rows: FieldWorkforceComparisonRow[];
};

export type FieldWorkforceRecommendationsReport = {
  archive: FieldWorkforceArchiveListItem;
  finalActions: FieldWorkforceFinalAction[];
  integrationStatus: {
    leaveSource: "connected" | "not_connected";
    leaveSourceMessage: string;
    payrollAmount: "available" | "requires_calculation";
    payrollAmountMessage: string;
  };
  leaveRecommendations: FieldWorkforceRecommendation[];
  payrollRecommendations: FieldWorkforceRecommendation[];
};
