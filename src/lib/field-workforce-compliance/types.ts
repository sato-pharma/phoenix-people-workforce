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
  departmentName?: string | null;
  fullName: string;
  hireDate?: string | null;
  hrId: string;
  jobTitle?: string | null;
  lineName?: string | null;
  managerName?: string | null;
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

export type FieldWorkforceEmployeeSummary = {
  campaignDays: number;
  employeeName: string;
  eligibleWorkingDays: number;
  fridays: number;
  hiringDateIso: string | null;
  hiringDateSource: "employee_directory" | "missing" | "workbook";
  holidayWarnings: number;
  hrId: string;
  matchedEmployeeName: string | null;
  matchedHrId: string | null;
  matchStatus: "matched" | "unmatched";
  noActivityCandidates: number;
  preHireIgnoredValues: number;
  severityCounts: Record<FieldWorkforceSeverity, number>;
  sourceRowNumber: number;
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
  | "calendar_av"
  | "n_retroactive_candidate"
  | "no_activity_candidate";

export type FieldWorkforceDecisionStatus =
  | "Pending"
  | "Approved for Leave Adjustment Report"
  | "Approved for Payroll Deduction Report"
  | "Do Not Take Action"
  | "Needs Follow-up"
  | "Cancelled";

export type FieldWorkforceCoverageStatus =
  | "already_covered"
  | "leave_source_not_connected"
  | "needs_reconciliation"
  | "not_applicable"
  | "payroll_calculation_required";

export type FieldWorkforceRecommendation = {
  dates: string[];
  daysCount: number;
  decisionId: string | null;
  decisionStatus: FieldWorkforceDecisionStatus;
  decidedAt: string | null;
  decidedBy: string | null;
  employeeCode: string;
  employeeName: string;
  estimatedAmount: number | null;
  existingCoverageStatus: FieldWorkforceCoverageStatus;
  holidayContext: string | null;
  hrNote: string;
  importId: string;
  monthKey: string;
  recommendation: string;
  recommendationKey: string;
  recommendationReason: string;
  recommendationType: FieldWorkforceRecommendationType;
  severity: FieldWorkforceSeverity;
  sourceLabel: string;
  sourceType: FieldWorkforceRecommendationSourceType;
};

export type FieldWorkforceFinalAction = {
  actionType: "Leave Balance Adjustment" | "Payroll Deduction" | "No Action";
  amount: number | null;
  approvedAt: string | null;
  approvedBy: string | null;
  approvedDates: string[];
  approvedDaysCount: number;
  employeeCode: string;
  employeeName: string;
  hrNote: string;
  monthKey: string;
  pushStatus: "Export only" | "Not pushed" | "Pending integration";
  recommendationKey: string;
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
