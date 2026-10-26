// Double Visit Analytics reads LIVE, directly off ireports360_visits (the Visits Report
// mirror) — there is no import/preview/publish/Excel concept anymore (removed 2026-07-04).
// A "double visit" = a visit with a double_crm_id partner AND visit_type in (0 Regular,
// -8 Campaign/Prospection) — owner decision, since a shared double_crm_id on a Meeting/
// Training/Conference/Vacation row is joint-attendance bookkeeping, not fieldwork.
//
// Every visit count below is AM · PM · Pharmacies, three figures apart: a pharmacy visit is never
// counted in pmVisits (or amVisits), whatever period the CRM tagged it with — THE AM · PM ·
// PHARMACIES GOLDEN RULE, decided in src/lib/crm/visit-count-buckets.ts.
//
// `phoenixVisits` / `phoenixVisitCount` / `fromPhoenix` mark a started team's Phoenix CRM double
// visits. Phoenix CRM logs no pharmacy visit, so a pharmacy figure built from them is printed through
// that helper — "not recorded in Phoenix", never 0. Optional everywhere: absent means none, and a
// payload from before they existed reads exactly as it did.

import type { PhoenixVisitDetail } from "@/lib/crm/phoenix-visit-detail";
import type { VisitCountBucket } from "@/lib/crm/visit-count-buckets";

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
  pharmacyVisitCount: number;
  /** Of the AM · PM · Pharmacies visits, Phoenix CRM's own — see the note at the top. */
  phoenixVisitCount?: number;
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
  /** The figure this row counts in; null when the CRM recorded no period. Absent on an older payload. */
  countBucket?: VisitCountBucket | null;
  date: string;
  doubleVisitorHrId: string | null;
  doubleVisitorName: string | null;
  /** A chain visit's SECOND double visitor. The entry is still ONE visit (`visitCount` 1); a manager-side
   * figure reads it through `visitLogPerDoubleVisitor`, which credits him exactly as the first. */
  doubleVisitor2HrId?: string | null;
  doubleVisitor2Name?: string | null;
  /** A Phoenix CRM double visit — see the note at the top. */
  fromPhoenix?: boolean;
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
  pharmacyVisits: number;
  /** Of the AM · PM · Pharmacies visits, Phoenix CRM's own — see the note at the top. */
  phoenixVisits?: number;
  pmVisits: number;
  role: string | null;
  roleCode: DoubleVisitRoleCode | null;
  teamMrCount: number | null;
  /**
   * The HR ids behind `teamMrCount` — every active medical rep anywhere beneath a DSM/RM/NSM — so the
   * manager profile's "not visited" list names the same team the coverage figure counts, not only his
   * direct reports (owner, 2026-10-20). Null exactly when `teamMrCount` is.
   */
  teamMrHrIds?: string[] | null;
  totalDvs: number;
};

export type DoubleVisitRoleRollup = {
  activeManagerCount: number;
  amVisits: number;
  avgCallsPerDay: number | null;
  avgCoveragePct: number | null;
  distinctMrs: number;
  neglectedMrCount: number | null;
  pharmacyVisits: number;
  /** Of the AM · PM · Pharmacies visits, Phoenix CRM's own — see the note at the top. */
  phoenixVisits?: number;
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
  /**
   * Active medical reps anywhere beneath a DSM/RM/NSM — the same team the active summaries count —
   * so a manager with zero double visits reads as every one of them neglected, not as a blank.
   * Null for a role with no field team (owner, 2026-10-20).
   */
  teamMrCount?: number | null;
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
    /** Doctor/pharmacy/institution split of the day's REGULAR visits — display-only context,
     * present only on snapshots written since the pharmacy-split change (optional so every
     * stored pre-change snapshot still parses). Nothing in eligibility/amounts reads these. */
    doctor?: number;
    evidenceRows: number;
    institution?: number;
    pharmacy?: number;
    /** THE AM · PM · PHARMACIES GOLDEN RULE: the day's pharmacy visits, never inside `am`/`pm`.
     * Absent on a snapshot written before the 2026-09-21 split, where pharmacies sit inside
     * am/pm — so absent means "not counted separately", never 0. */
    pharmacies?: number;
    pm: number;
    total: number;
  }>;
  /** Trip-total kind split of REGULAR visits — same display-only, additive-snapshot posture. */
  doctorVisits?: number;
  institutionVisits?: number;
  pharmacyVisits?: number;
  importId: string | null;
  matchedDates: string[];
  // "unmapped" arrives from the corrected CRM visit read (the rep has no CRM id, so their
  // activity cannot be matched at all) — distinct from "no_activity", which means we looked
  // and the rep genuinely did not work. Nothing branches on this value; it is stored and shown.
  matchStatus: "manual" | "matched" | "no_activity" | "partial" | "stale_import" | "unmapped";
  missingDates: string[];
  /** The third workload figure (AM · PM · Pharmacies). Optional for the same reason as the
   * per-day `pharmacies`: every stored pre-split snapshot must still parse. */
  pharmacyWorkload?: number;
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
  pharmacyVisits: number;
  /** Of the AM · PM · Pharmacies visits, Phoenix CRM's own — see the note at the top. */
  phoenixVisits?: number;
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
  /**
   * Has the VIEWER'S OWN evaluator tier met its configured DV requirement on this probationer's
   * active case? Read from probation_dv_days via computeDvProgress — never from a second opinion.
   *
   * `null` renders N/A, and means "your tier owes nothing here, or nothing could be measured":
   * the viewer holds no evaluator tier (Regional Manager), the tier's requirement is 0, the viewer
   * is a PM/GPM on a CNS rep (the Case model exempts that pairing), or the progress read failed.
   * A failure must land here and NOT on `false` — a red "Pending" nobody owes is what the retired
   * employee_probation checkbox source produced for every probationer for months.
   */
  dvDone: boolean | null;
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
   * warning 31-60, critical >60 (reuses the buildMrScores 30/60 thresholds). A rep with no DV in the
   * lookback is banded on days since HIRE instead — overdue only once that passes 30 (warning) or
   * 60 (critical); with no hire date on record it reads critical. */
  cadenceBand: DoubleVisitCadenceBand;
  /** Convenience flag: cadenceBand !== "healthy". Drives the "overdue only" filter + digest count.
   * Only reps who have started (hire date on or before today, Cairo) are on the roster at all. */
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
  /** The figure this row counts in; null when the CRM recorded no period. Absent on an older payload. */
  countBucket?: VisitCountBucket | null;
  daysSinceVisitedHire: number | null;
  /** A Phoenix CRM double visit — see the note at the top. */
  fromPhoenix?: boolean;
  doubleVisitorHrId: string | null;
  doubleVisitorName: string | null;
  /** A chain visit's SECOND double visitor (owner, 2026-10-08: one visit, in both managers' records).
   * `visitCount` stays 1 — the rep received it once — and the visitor filters match EITHER manager
   * (report-filters.ts), so each finds the visit under his own name. */
  doubleVisitor2HrId?: string | null;
  doubleVisitor2Name?: string | null;
  doubleVisitor2Role?: string | null;
  /** The double-visitor's job title / role label (e.g. "District Manager"), resolved via
   * resolveDvRole. Null when the double-visitor can't be matched to a directory employee. */
  doubleVisitorRole: string | null;
  /** The Phoenix field set, already shaped to THIS reader's tier and flattened one value per column —
   * the sheet prints it as-is. Null on a vendor row, and on any payload built without a viewer. */
  phoenixColumns?: Record<string, string | number | null> | null;
  /** The same field set, grouped. The SCREEN reads this one: the fits-the-screen rule forbids a new
   * column, so the groups merge into the cells the table already has, as thin lines under them. */
  phoenix?: PhoenixVisitDetail | null;
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
  /** Active Medical Reps in scope whose hire date is after today (Cairo): named in a note on the
   * DV Planner and counted NOWHERE — not in the roster, coverage, Never Visited or probation.
   * Optional so an older payload or a hand-built fixture still type-checks. */
  startingSoon?: DoubleVisitStartingSoonEntry[];
};

export type DoubleVisitStartingSoonEntry = {
  areaName: string | null;
  /** YYYY-MM-DD, after today. */
  hireDate: string;
  name: string;
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
