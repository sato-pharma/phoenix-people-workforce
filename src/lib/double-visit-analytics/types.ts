export type DoubleVisitSourceType = "excel" | "ireports360";
export type DoubleVisitImportStatus = "archived" | "preview" | "published" | "superseded";
export type DoubleVisitPeriod = "AM" | "PM" | "UNKNOWN";
export type DoubleVisitVisitedEmployeeStatus =
  | "active_mapped"
  | "blank_hr_id"
  | "non_mr"
  | "resigned"
  | "unmapped"
  | "vacant";

export type DoubleVisitValidationIssue = {
  code: string;
  message: string;
  rowNumber?: number | null;
  severity: "error" | "warning";
};

export type DoubleVisitNormalizedRow = {
  activityDate: string;
  areaName: string | null;
  doubleVisitorHrId: string | null;
  doubleVisitorName: string | null;
  lineName: string | null;
  period: DoubleVisitPeriod;
  rawPayload: Record<string, unknown>;
  sourceHash: string;
  sourceRecordId: string | null;
  sourceRowNumber: number | null;
  sourceType: DoubleVisitSourceType;
  visitCount: number;
  visitedEmployeeHrId: string | null;
  visitedEmployeeName: string | null;
  visitedEmployeeStatus: DoubleVisitVisitedEmployeeStatus;
};

export type DoubleVisitImportSummary = {
  activeMappedVisitCount: number;
  amVisitCount: number;
  areaCount: number;
  dateFrom: string;
  dateTo: string;
  doubleVisitorCount: number;
  duplicateWarningCount: number;
  lineCount: number;
  missingVisitedHrIdCount: number;
  mrCoverageCount: number;
  pmVisitCount: number;
  totalRows: number;
  totalVisits: number;
  vacantOrUnmappedVisitCount: number;
  warningCount: number;
};

export type DoubleVisitPreview = {
  importId?: string;
  metadata: {
    fileName: string;
    generatedAt: string;
    sheetName: string | null;
    sourceType: DoubleVisitSourceType;
  };
  rows: DoubleVisitNormalizedRow[];
  sampleRows: DoubleVisitNormalizedRow[];
  summary: DoubleVisitImportSummary;
  warnings: DoubleVisitValidationIssue[];
};

export type DoubleVisitImportListItem = DoubleVisitImportSummary & {
  id: string;
  publishedAt: string | null;
  publishedBy: string | null;
  sheetName: string | null;
  sourceFilename: string;
  sourceType: DoubleVisitSourceType;
  status: DoubleVisitImportStatus;
  uploadedAt: string;
  uploadedBy: string;
};

export type DoubleVisitKpis = {
  activeCalendarDays: number;
  activeDoubleVisitDays: number;
  activeMappedVisitCount: number;
  amPmRatio: number | null;
  amVisitCount: number;
  averageVisitsPerDoubleVisitDay: number;
  averageVisitsPerDoubleVisitor: number;
  doubleVisitorCount: number;
  mrCoverageCount: number;
  pmVisitCount: number;
  totalVisits: number;
  vacantOrUnmappedShare: number;
  vacantOrUnmappedVisitCount: number;
};

export type DoubleVisitBreakdownRow = {
  activeMappedVisits?: number;
  coveragePercent?: number;
  doubleVisitorCount?: number;
  label: string;
  mrCount?: number;
  status?: "healthy" | "critical" | "warning";
  totalVisits: number;
  vacantOrUnmappedVisits?: number;
};

export type DoubleVisitMrScore = {
  areaName: string | null;
  band: "critical" | "healthy" | "warning";
  daysSinceLastDv: number | null;
  distinctDoubleVisitors: number;
  dvsLast90Days: number;
  employeeStatus: string | null;
  hireDate: string | null;
  hrId: string;
  lastDoubleVisitorName: string | null;
  lastDvDate: string | null;
  lineName: string | null;
  managerHrId: string | null;
  managerName: string | null;
  mrName: string;
  totalDvs: number;
};

export type DoubleVisitExecutiveManagerReport = {
  areaName: string | null;
  concentrationRatio: number;
  criticalMrCount: number;
  expectedMrCount: number;
  latestDvDate: string | null;
  lineName: string | null;
  managerHrId: string;
  managerName: string;
  neglectedMrCount: number;
  overFocusedMrCount: number;
  touchedMrCount: number;
  touchedPercent: number;
  totalDvs: number;
};

export type DoubleVisitLogEntry = {
  area: string | null;
  date: string;
  doubleVisitorHrId: string | null;
  doubleVisitorName: string | null;
  period: DoubleVisitPeriod;
  visitCount: number;
  visitedHrId: string | null;
  visitedName: string | null;
  visitedStatus: DoubleVisitVisitedEmployeeStatus;
};

export type DoubleVisitRoleCode = "DSM" | "GPM" | "NSM" | "PM" | "RM" | "TM";

// Personal-effort lens: one row per double-visitor (what THIS manager personally did),
// distinct from DoubleVisitExecutiveManagerReport which measures DVs received by a team.
export type DoubleVisitManagerSummary = {
  activeDvDays: number;
  amVisits: number;
  areaName: string | null;
  callsPerActiveDay: number;
  concentrationPct: number | null;
  coveragePct: number | null;
  daysSinceLastDv: number | null;
  distinctMrs: number;
  firstDvDate: string | null;
  inDirectory: boolean;
  lastDvDate: string | null;
  lineName: string | null;
  managerHrId: string;
  managerName: string;
  neglectedMrCount: number | null;
  overFocusedMrCount: number;
  pmVisits: number;
  role: string | null;
  roleCode: DoubleVisitRoleCode | null;
  teamMrCount: number | null;
  totalDvs: number;
};

export type DoubleVisitRoleRollup = {
  activeManagerCount: number;
  amVisits: number;
  avgCallsPerDay: number | null;
  avgCoveragePct: number | null;
  distinctMrs: number;
  neglectedMrCount: number | null;
  pmVisits: number;
  roleCode: DoubleVisitRoleCode;
  roleLabel: string;
  totalActiveDvDays: number;
  totalDvs: number;
};

export type DoubleVisitInsightCategory =
  | "balance"
  | "concentration"
  | "coverage"
  | "inactivity"
  | "neglect"
  | "performance";

export type DoubleVisitInsightSeverity = "critical" | "info" | "positive" | "warning";

export type DoubleVisitInsight = {
  category: DoubleVisitInsightCategory;
  detail: string;
  id: string;
  managerHrId: string | null;
  mrHrId: string | null;
  rank: number;
  severity: DoubleVisitInsightSeverity;
  title: string;
};

export type DoubleVisitIdleManager = {
  areaName: string | null;
  hrId: string;
  lineName: string | null;
  name: string;
  role: string;
  roleCode: DoubleVisitRoleCode;
};

export type DoubleVisitExecutiveSummary = {
  idleManagers: DoubleVisitIdleManager[];
  insights: DoubleVisitInsight[];
  roleRollups: DoubleVisitRoleRollup[];
};

export type DoubleVisitManagerMrPair = {
  area: string | null;
  days: number;
  firstDate: string | null;
  lastDate: string | null;
  managerHrId: string;
  managerName: string;
  mrHrId: string | null;
  mrName: string;
  visits: number;
  visitsPerDay: number;
};

export type DoubleVisitExpenseWorkloadEvidence = {
  amWorkload: number;
  dateBreakdown: Array<{
    am: number;
    date: string;
    evidenceRows: number;
    pm: number;
    total: number;
  }>;
  importId: string | null;
  matchedDates: string[];
  matchStatus: "manual" | "matched" | "no_activity" | "partial" | "stale_import";
  missingDates: string[];
  pmWorkload: number;
  source: "double_visit_import" | "manual";
  sourceLabel: string;
};

export type DoubleVisitDashboardData = {
  asOfDate: string;
  dateFrom: string;
  dateTo: string;
  executiveReports: DoubleVisitExecutiveManagerReport[];
  executiveSummary: DoubleVisitExecutiveSummary;
  filters: {
    areas: string[];
    doubleVisitors: string[];
    lines: string[];
  };
  heatmap: {
    byArea: DoubleVisitBreakdownRow[];
    byLine: DoubleVisitBreakdownRow[];
  };
  imports: DoubleVisitImportListItem[];
  kpis: DoubleVisitKpis;
  managerSummaries: DoubleVisitManagerSummary[];
  mrScores: DoubleVisitMrScore[];
  publishedImport: DoubleVisitImportListItem | null;
  salesComparisonAvailable: boolean;
  schemaReady: boolean;
  visitLog: DoubleVisitLogEntry[];
};

// ── Portal landing-page "focus" widgets (trend / scope coverage / probation) ────

export type DoubleVisitFocusTrendPoint = {
  count: number;
  label: string;
  month: string; // "YYYY-MM"
};

export type DoubleVisitFocusRosterEntry = {
  areaName: string | null;
  daysSinceHire: number | null;
  flagged: boolean;
  hireDate: string | null;
  hrId: string;
  name: string;
  visited: boolean;
};

export type DoubleVisitFocusProbationEntry = {
  daysRemaining: number;
  dvCount: number;
  dvDone: boolean | null; // null when the viewer's role has no dedicated probation DV checkbox (Regional Manager)
  hireDate: string;
  hrId: string;
  name: string;
  probationEndDate: string;
};

export type DoubleVisitScopeFocus = {
  coveragePct: number | null;
  coveredCount: number;
  neglected: DoubleVisitFocusRosterEntry[];
  neglectedCount: number;
  neglectedTruncated: boolean;
  rosterSize: number;
  summarySentence: string;
};

export type DoubleVisitPortalFocus = {
  probation: DoubleVisitFocusProbationEntry[];
  probationTruncated: boolean;
  reportHref: string;
  scope: DoubleVisitScopeFocus | null;
  trend: DoubleVisitFocusTrendPoint[];
};

// ── Double Visit Report page (flat, filterable, sortable, exportable table) ────

export type DoubleVisitReportRow = {
  activityDate: string;
  areaName: string | null;
  daysSinceVisitedHire: number | null;
  doubleVisitorHrId: string | null;
  doubleVisitorName: string | null;
  lineName: string | null;
  period: DoubleVisitPeriod;
  visitCount: number;
  visitedEmployeeHireDate: string | null;
  visitedHrId: string | null;
  visitedName: string | null;
  visitedStatus: DoubleVisitVisitedEmployeeStatus;
  /**
   * "Regular" (iReports360 visitType 0, or any Excel-sourced row — that workflow has no other
   * concept), the CRM's own label for a non-regular visit (e.g. "Campaign"/"Conference"), or
   * "Non-Regular" when the type is present but undescribed. All visit kinds still count toward
   * totals — this is for visibility, not filtering (owner decision).
   */
  visitKind: string;
};

export type DoubleVisitReportData = {
  asOfDate: string;
  dateFrom: string;
  dateTo: string;
  filters: {
    areas: string[];
    doubleVisitors: string[];
    lines: string[];
    visitKinds: string[];
  };
  neverVisited: DoubleVisitFocusRosterEntry[];
  probation: DoubleVisitFocusProbationEntry[];
  rows: DoubleVisitReportRow[];
  schemaReady: boolean;
};

// ── Data Integrity Report (admin-only): every visit that could NOT be confidently
// counted or attributed, so HR can decide what to do with each one instead of it
// silently vanishing from every manager-facing number. ──────────────────────────

export type DoubleVisitIntegrityIssueType =
  | "double_visitor_unmapped"
  | "visited_blank_or_unmapped"
  | "visited_vacant_seat"
  | "visited_resigned"
  | "visited_is_manager";

export type DoubleVisitIntegrityIssue = {
  activityDate: string;
  areaName: string | null;
  doubleVisitorHrIdRaw: string | null;
  doubleVisitorName: string | null;
  id: string;
  issueLabel: string;
  issueType: DoubleVisitIntegrityIssueType;
  lineName: string | null;
  sourceFilename: string | null;
  sourceType: DoubleVisitSourceType;
  visitCount: number;
  visitedHrIdRaw: string | null;
  visitedName: string | null;
  visitedStatus: DoubleVisitVisitedEmployeeStatus;
};

export type DoubleVisitIntegrityImportSummary = {
  dateFrom: string;
  dateTo: string;
  duplicateWarningCount: number;
  id: string;
  missingVisitedHrIdCount: number;
  sourceFilename: string;
  sourceType: DoubleVisitSourceType;
  status: DoubleVisitImportStatus;
  totalRows: number;
  uploadedAt: string;
  vacantOrUnmappedVisitCount: number;
};

export type DoubleVisitIntegrityReport = {
  asOfDate: string;
  countsByType: Record<DoubleVisitIntegrityIssueType, number>;
  importSummaries: DoubleVisitIntegrityImportSummary[];
  issues: DoubleVisitIntegrityIssue[];
  schemaReady: boolean;
  totalRowsScanned: number;
};
