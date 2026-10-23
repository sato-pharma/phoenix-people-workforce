import type { VisitCountSplit } from "@/lib/crm/visit-count-buckets";

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
  /** Every manager above `managerName`, nearest first (live path only). */
  managersAbove?: string[] | null;
  regionName?: string | null;
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
  /**
   * CRM-logging-timing signal for this day, from the visits mirror's crm_save_date/ampm
   * columns. IMPORTANT: this is when the visit was LOGGED/SAVED into the CRM, not a
   * GPS-verified visit time — iReports360 does not return an actual visit clock time
   * (visit_date_time is a fixed midnight placeholder on every row, verified in production).
   * crm_save_date is a reasonable proxy for real-time field logging (spreads realistically
   * across a rep's day rather than clustering at one batch-save instant), but every UI label
   * says "logged" not "visited" so HR never mistakes it for something GPS-verified.
   * Informational only — never affects severity, status, or deduction candidates. Null/undefined
   * on the Excel-upload path (the workbook has no per-visit timestamps).
   */
  loggingTiming?: FieldWorkforceLoggingTiming | null;
  /**
   * Cross-check against the physical fingerprint attendance system for this day, when the
   * employee is device-mapped (so a missing punch is a real signal, not just "we don't track
   * them"). Never set for a day with an approved attendance exception (already explained), or
   * for an employee with no active device mapping. Informational only — never affects
   * severity, status, or deduction candidates.
   *  - visits_no_punch: FWC classified this a worked day (VISITS/CP), but no fingerprint punch
   *    exists for the employee that day.
   *  - punch_no_visits: the employee physically punched in that day, but FWC classified it "N"
   *    (no CRM activity) — corroborates a genuine no-activity day rather than a CRM logging gap.
   *  - av_with_punch: FWC classified this a vacation signal ("AV"), and the employee's
   *    fingerprint activity that day (last punch minus first punch) proves at least
   *    AV_HALF_DAY_MAX_WORKED_MINUTES (5h) worked — a full contradiction between the CRM
   *    calendar and physical attendance, not just a brief appearance.
   *  - av_with_partial_punch: same AV+punch disagreement, but worked minutes are under the 5h
   *    threshold (or unresolvable) — reads as a half-day vacation rather than a full
   *    contradiction. This is the conservative default when duration can't be computed.
   *    Both AV variants mainly fire for office-based (Head Office) staff, since field reps are
   *    not fingerprint-device-mapped in the first place.
   */
  attendanceCrossCheck?: FieldWorkforceAttendanceCrossCheckResult | null;
  /**
   * True when this day's AV-classified CRM visit carries an excuse-labeled comment (e.g.
   * "Afternoon Excuse", "Morning Excuse") rather than an actual vacation label. iReports360 has
   * no separate visit_type for excuses — both are logged under the same AV-mapped types, told
   * apart only by free-text comment. Only ever set on the live CRM-mirror path
   * (ireports360-source.ts); always undefined on the Excel-upload path, which has no comment
   * data. Used only to exclude excuse days from the av_with_punch cross-check recommendation —
   * never affects the base AV classification, severity, or deduction candidates.
   */
  isExcuseLabeledAv?: boolean;
  /**
   * A "mixed" day: this day counts its regular visits (status VISITS) but a campaign-class
   * activity ALSO occurred. Drives the grid's two-color split square and keeps the campaignDays
   * metric accurate now that a mixed day no longer classifies as CP (owner decision 2026-07-20 —
   * a rep's real regular visits are never hidden/dropped just because a campaign shared the day).
   */
  campaignOverlay?: boolean;
  visitCount?: number;
  /**
   * Count of this day's REGULAR visits the employee logged as the PRIMARY agent (their OWN
   * visits), as opposed to visits credited to them only as a double-visit (ride-along) partner.
   * Set only on the live CRM-mirror path, and only for a "VISITS" day (0 when every credited
   * visit that day was a ride-along). The employee-portal Team Calendar uses it to (a) show a
   * manager's own visit count rather than one inflated by ride-alongs, and (b) render a pure
   * ride-along day (ownVisitCount === 0 on a VISITS day) as a distinct "DV" coaching marker
   * instead of a numeric count that would duplicate the rep's visits onto the manager's row.
   * Undefined on the Excel-upload path and on non-VISITS days. Informational only — never affects
   * severity, status, deduction candidates, or the admin Field Workforce Compliance surface.
   */
  ownVisitCount?: number;
  /**
   * The person's OWN visits that day, AM · PM · Pharmacies apart (owner, 2026-10-23: "in team calendar … make the square
   * … 2 for AM, 9 for PM, and 5 for pharmacies … same for district managers, and same in everywhere"). Bucketed by the
   * golden rule's one helper (`visitCountBucket`), so a pharmacy is never filed in a half. Live CRM-mirror path only,
   * set beside `ownVisitCount`; informational — never affects severity, status or a deduction candidate.
   */
  ownVisitSplit?: VisitCountSplit;
  /**
   * The visits this person was credited with as a double or chain partner — a manager's ride-alongs — split the same
   * way. The portal prints it on a ride-along day, so a district manager's square shows what he joined, not a bare "DV".
   */
  rideAlongSplit?: VisitCountSplit;
  /**
   * A manager's OWN single visits logged in Phoenix CRM (`phoenix_crm_manager_visits`), split by his customer's list.
   * That table is not in the visits mirror, so the engine never sees it; the portal Team Calendar attaches it after
   * the build (owner, 2026-10-23: "any record submitted by himself … must appear"). Display only.
   */
  managerOwnSplit?: VisitCountSplit;
  /**
   * Whether this day's REGULAR (customer) visits were all logged AM, all PM, or a mix, from
   * the visits mirror's ampm column. Only set when status is "VISITS" and at least one that
   * day's regular visits carries an ampm tag; "MIXED" (both AM and PM present) renders the
   * same as untagged/null — the distinct AM/PM colors exist to flag a HALF-day visit pattern,
   * not to distinguish a normal full day. Never set on the Excel-upload path (no per-visit
   * ampm data). Informational only — never affects severity, status, or deduction candidates.
   */
  visitPeriod?: "AM" | "PM" | "MIXED" | null;
};

export type FieldWorkforceAttendanceCrossCheckResult =
  | "av_with_partial_punch"
  | "av_with_punch"
  | "punch_no_visits"
  | "visits_no_punch";

/**
 * CRM-logging-timing signal for one employee-day, computed from the visits mirror's
 * crm_save_date (both regular and non-regular visit types) and ampm columns. Times are
 * Cairo-local "HH:MM" (24h) — the time each visit record was saved into the CRM, not a
 * GPS-verified visit time. isLateStart is null (not just false) when the day has no
 * ampm='AM'-tagged visit to judge — never inferred from an untagged visit.
 */
export type FieldWorkforceLoggingTiming = {
  activeWindowMinutes: number | null;
  firstLoggedTime: string | null;
  isLateStart: boolean | null;
  lastLoggedTime: string | null;
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

/**
 * Suspicious customer-visit-pattern flags for one employee-month, computed from the visits
 * mirror's contact_crm_id/contact_name/ampm columns on regular (customer) visits only.
 * Informational only — never affects severity, status, or deduction candidates.
 *  - low_variety: <3 distinct contacts visited all month (only when the employee had visits).
 *  - high_concentration: >=60% of the month's visits went to a single contact.
 *  - consecutive_same_contact: the same contact was visited 3+ consecutive calendar days.
 *  - pm_recurring_contact: the same contact appears in the ampm='PM' slot twice within one
 *    ISO week, or in the PM slot across every week that month with any PM visit.
 */
export type FieldWorkforceCustomerAuthenticity = {
  distinctContacts: number;
  flagged: boolean;
  flaggedRules: string[];
  topContactName: string | null;
  topContactShare: number | null;
  totalCustomerVisits: number;
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
  /**
   * Customer-visit-pattern signal for the live (visits-mirror) path. Null on the Excel-upload
   * path (the workbook has no per-visit contact identity).
   */
  customerAuthenticity?: FieldWorkforceCustomerAuthenticity | null;
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
  /**
   * Every manager above `managerName` on the org tree, nearest first — so the Manager filter can
   * offer a Regional or National Sales Manager who has no row of his own on this report (owner,
   * 2026-10-20: "when you filter by manager you find no manager"). Live path only.
   */
  managersAbove?: string[] | null;
  matchedEmployeeName: string | null;
  matchedHrId: string | null;
  matchStatus: "matched" | "unmatched";
  noActivityCandidates: number;
  noActivityPattern: FieldWorkforceNoActivityPattern;
  preHireIgnoredValues: number;
  /**
   * Region — live (visits-mirror) path only, from the employee directory's region_name.
   * Undefined on the Excel-upload/archive path, which never carried this field.
   */
  regionName?: string | null;
  roleName: string | null;
  severityCounts: Record<FieldWorkforceSeverity, number>;
  sourceRowNumber: number;
  teamName: string | null;
  timeline: FieldWorkforceDayCell[];
  totalVisits: number;
  unknownValues: number;
  vacationSignalDays: number;
  /**
   * Month-level rollup of each day's loggingTiming. Null/undefined on the Excel-upload path or
   * when no day that month had a CRM-logged save timestamp. Informational only.
   */
  loggingTimingSummary?: FieldWorkforceLoggingTimingSummary | null;
  workedDays: number;
};

export type FieldWorkforceLoggingTimingSummary = {
  avgFirstLoggedTime: string | null;
  lateStartDayCount: number;
  timedDayCount: number;
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
  /**
   * Whether the Google Egypt holiday calendar was actually READ for this month.
   * `false` means the month's public holidays are incomplete (degraded fallback), so any day
   * marked "no activity" may in fact be a national holiday — payroll deduction recommendations
   * are suppressed in that state (see recommendations.ts). `null` = not asserted (Excel-upload
   * path / archives predating this field), which is treated as "not degraded".
   */
  holidayCalendarReachable: boolean | null;
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
  | "av_with_attendance_punch"
  | "av_with_partial_attendance_punch"
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
    /** "degraded" when this month's national-holiday data is missing/incomplete. In that state
     * payroll deduction recommendations are deliberately suppressed (a missing public holiday
     * would otherwise be misread as a no-activity day for the whole field force). */
    holidaySource: "connected" | "degraded";
    holidaySourceMessage: string | null;
    leaveSource: "connected" | "not_connected";
    leaveSourceMessage: string;
    payrollAmount: "available" | "requires_calculation";
    payrollAmountMessage: string;
  };
  leaveRecommendations: FieldWorkforceRecommendation[];
  payrollRecommendations: FieldWorkforceRecommendation[];
};
