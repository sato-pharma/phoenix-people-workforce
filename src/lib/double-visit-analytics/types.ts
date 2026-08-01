// Double Visit Analytics reads LIVE, directly off ireports360_visits (the Visits Report
// mirror) — there is no import/preview/publish/Excel concept anymore (removed 2026-07-04).
// A "double visit" = a visit with a double_crm_id partner AND visit_type in (0 Regular,
// -8 Campaign/Prospection) — owner decision, since a shared double_crm_id on a Meeting/
// Training/Conference/Vacation row is joint-attendance bookkeeping, not fieldwork.

export type DoubleVisitSourceType = "excel" | "ireports360";
export type DoubleVisitPeriod = "AM" | "PM" | "UNKNOWN";
export type DoubleVisitVisitedEmployeeStatus =
  | "active_mapped"
  | "blank_hr_id"
  | "non_mr"
  | "resigned"
  | "unmapped"
  | "vacant";

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
  dvsPrev90Days: number;
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
  trendDirection: "improving" | "declining" | "flat";
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

export type DoubleVisitRoleCode = "DSM" | "GPM" | "MM" | "NSM" | "PM" | "RM" | "SFE" | "TM";

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
  effectivenessScore: number | null;
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
  // "unmapped" arrives from the corrected CRM visit read (the rep has no CRM id, so their
  // activity cannot be matched at all) — distinct from "no_activity", which means we looked
  // and the rep genuinely did not work. Nothing branches on this value; it is stored and shown.
  matchStatus: "manual" | "matched" | "no_activity" | "partial" | "stale_import" | "unmapped";
  missingDates: string[];
  pmWorkload: number;
  // Visit-kind counts within the trip window (visitType -8 = campaign, 0 = regular),
  // summed by visit_count. Used by the outstation campaign-cap rule for DM/TM.
  campaignVisits: number;
  regularVisits: number;
  source: "double_visit_import" | "manual";
  sourceLabel: string;
};

// One point in the weekly double-visit trend (ISO week start date, e.g. a Monday).
export type DoubleVisitTrendPoint = {
  amVisits: number;
  distinctMrs: number;
  pmVisits: number;
  totalDvs: number;
  weekStart: string;
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
  kpis: DoubleVisitKpis;
  managerSummaries: DoubleVisitManagerSummary[];
  mrScores: DoubleVisitMrScore[];
  neglectedMrs: DoubleVisitMrScore[];
  salesComparisonAvailable: boolean;
  schemaReady: boolean;
  trend: DoubleVisitTrendPoint[];
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

// ── DV Planner: every active Medical Rep in the viewer's scope, one row each, for a
// chosen period — not just the ones who happen to have activity in that window. ────

export type DoubleVisitCadenceBand = "healthy" | "warning" | "critical";

export type DoubleVisitRosterEntry = {
  areaName: string | null;
  /** Cadence band from days-since-last-DV (regardless of the selected window): healthy <=30,
   * warning 31-60, critical >60 or never (reuses the buildMrScores 30/60 thresholds). */
  cadenceBand: DoubleVisitCadenceBand;
  /** Convenience flag: cadenceBand !== "healthy". Drives the "overdue only" filter + digest count. */
  cadenceOverdue: boolean;
  daysSinceHire: number | null;
  /** Days since this rep's most recent double visit measured from TODAY (not dateTo), looked back
   * over CADENCE_LOOKBACK_DAYS. Null when no DV found within the lookback window. */
  daysSinceLastVisit: number | null;
  /** Never visited in the selected period AND overdue (daysSinceHire >= NEVER_VISITED_FLAG_DAYS). */
  flagged: boolean;
  hireDate: string | null;
  hrId: string;
  /** Most recent activityDate among this rep's double visits in the selected period, else null. */
  lastVisitDate: string | null;
  /** Most recent double-visit date within the cadence lookback, even if before the selected
   * window — this is what distinguishes "getting stale" from "truly never visited". */
  lastVisitDateEver: string | null;
  lineName: string | null;
  managerHrId: string | null;
  managerName: string | null;
  name: string;
  onProbation: boolean;
  probationDaysRemaining: number | null;
  probationDvDone: boolean | null;
  /** Count of double-visit records for this rep within the selected period. */
  visitCount: number;
  visited: boolean;
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
  /** Inclusive start of the window trend/scope/probation-DV-count are computed over (YYYY-MM-DD). */
  periodFrom: string;
  /** Inclusive end of that window (YYYY-MM-DD), i.e. today. */
  periodTo: string;
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
  /** The double-visitor's job title / role label (e.g. "District Manager"), resolved via
   * resolveDvRole. Null when the double-visitor can't be matched to a directory employee. */
  doubleVisitorRole: string | null;
  lineName: string | null;
  period: DoubleVisitPeriod;
  /** Region containing areaName, resolved from the employee directory's area→region mapping
   * (not a raw source-system field — the DV feed itself carries no region). */
  regionName: string | null;
  visitCount: number;
  visitedEmployeeHireDate: string | null;
  visitedHrId: string | null;
  visitedName: string | null;
  visitedStatus: DoubleVisitVisitedEmployeeStatus;
  /** "Regular" (visitType 0) or the CRM's own label for Campaign (visitType -8) — the only
   * two visit types that ever reach this table (see the module header comment). */
  visitKind: string;
};

export type DoubleVisitReportData = {
  asOfDate: string;
  dateFrom: string;
  dateTo: string;
  filters: {
    areas: string[];
    /** Distinct double-visitor job-title/role labels present in `rows` (e.g. "District
     * Manager", "Regional Manager") — replaces the old line-based filter. */
    doubleVisitorRoles: string[];
    doubleVisitors: string[];
    regions: string[];
    visitKinds: string[];
  };
  neverVisited: DoubleVisitFocusRosterEntry[];
  probation: DoubleVisitFocusProbationEntry[];
  /** Every active Medical Rep in the viewer's scope for [dateFrom, dateTo] — see DV Planner. */
  roster: DoubleVisitRosterEntry[];
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

// Kept for the workspace's conditional "problematic imports" panel (always empty now that
// there is no import concept) — see getDoubleVisitDataIntegrityReport in service.ts.
export type DoubleVisitIntegrityImportSummary = {
  dateFrom: string;
  dateTo: string;
  duplicateWarningCount: number;
  id: string;
  missingVisitedHrIdCount: number;
  sourceFilename: string;
  sourceType: DoubleVisitSourceType;
  status: "archived" | "preview" | "published" | "superseded";
  totalRows: number;
  uploadedAt: string;
  vacantOrUnmappedVisitCount: number;
};

// A double visit that WOULD have been discarded as "visited party is a manager", but was
// recovered by following the same-day chain down to the real Medical Rep the whole convoy
// actually saw (senior manager → junior/hinge manager → Medical Rep). See resolveDoubleVisitChains.
export type DoubleVisitRecoveredChain = {
  activityDate: string;
  areaName: string | null;
  customerSample: string[];
  higherManagerHrId: string | null; // the senior double-visitor who was losing the credit
  higherManagerName: string | null;
  hingeManagerHrId: string | null; // the junior manager whose record links the two halves
  hingeManagerName: string | null;
  id: string;
  lineName: string | null;
  period: DoubleVisitPeriod;
  resolvedMrHrId: string | null; // the real MR the credit is re-attributed to
  resolvedMrName: string | null;
  visitCount: number;
};

export type DoubleVisitIntegrityReport = {
  asOfDate: string;
  countsByType: Record<DoubleVisitIntegrityIssueType, number>;
  importSummaries: DoubleVisitIntegrityImportSummary[];
  issues: DoubleVisitIntegrityIssue[];
  schemaReady: boolean;
  totalRowsScanned: number;
};
