export type DoubleVisitSourceType = "excel" | "ireports360";
export type DoubleVisitImportStatus = "archived" | "preview" | "published" | "superseded";
export type DoubleVisitPeriod = "AM" | "PM" | "UNKNOWN";
export type DoubleVisitVisitedEmployeeStatus =
  | "active_mapped"
  | "blank_hr_id"
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
