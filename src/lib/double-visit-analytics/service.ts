import ExcelJS from "exceljs";

import { type AccessContext, normalizeHrIdForAccess, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isTerminalEmploymentStatus } from "@/lib/auth/session-lifecycle";
import { canUseAdminCrmWorkspace } from "@/lib/crm/admin-access";
import { getEmployeeDirectoryRows, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { resolveJobFunctionRole } from "@/lib/employees/job-function";
import { getProbationRows } from "@/lib/probation/service";
import {
  dvRequirementMetForRole,
  getActiveProbationDvProgressByEmployee,
} from "@/lib/probation/intelligence/dv-progress-lookup";
import type { ProbationEvaluatorRole } from "@/lib/probation/intelligence/types";
import type { DvProgress } from "@/lib/probation/intelligence/report-metrics";
import type { ProbationRow } from "@/lib/probation/types";
import { buildReportSummaryMetrics, formatActiveFilters } from "@/lib/double-visit-analytics/report-filters";
import { normalizeRegionLabel, regionsWithinManagerHierarchy, sameWorkforceLine } from "@/lib/workforce/hierarchy-resolver";
import { getOrLoadShared, sharedReadKey } from "@/lib/cache/shared-read";
import { compareUuidText, dayScanRuns, DOUBLE_VISIT_SLICE_DAYS, getDoubleVisitRows, visitPartnerHrIds } from "@/lib/crm/reads";
import { mapWithConcurrency } from "@/lib/reconciliation/concurrency";
import { cairoTodayIso } from "@/lib/crm/dates";
import { buildDownwardCut } from "@/lib/crm/doctor-coverage-scope";
import { getDoctorCoverageConfig, type DoctorCoverageLineOverrides } from "@/lib/crm/doctor-coverage-config";
import { buildCrmIdentityMaps, getCrmIdentityResolutions, resolveEmployeeHrId } from "@/lib/crm/identity";
import { isCrmVisitsSchemaReady } from "@/lib/crm/schema";
import { CRM_VISITS_UNIFIED_VIEW } from "@/lib/crm/tables";
import type { CrmResolutionRow } from "@/lib/crm/types";
import { logWarning } from "@/lib/observability/log";
import type { PrivateCalendarItem } from "@/lib/private-calendar/logic";
import {
  classifyDoubleVisitRows,
  doubleVisitCompanionPeople,
  privateCalendarActivityKindLabels,
  privateCalendarVisitKind,
  type ClassifiedDoubleVisitRow,
  type PrivateCalendarVisitKind,
} from "@/lib/private-calendar/activity-kinds";
import { privateCalendarTileCountsText } from "@/lib/private-calendar/day-tile";
import { isPhoenixNativeVisitRow } from "@/lib/crm/phoenix-team-starts";
import {
  PHOENIX_VISIT_DETAIL_COLUMNS,
  phoenixDetailViewer,
  phoenixRowSight,
  phoenixVisitDetail,
  phoenixVisitDetailColumns,
  pickPhoenixVisitDetailRow,
  type PhoenixVisitDetailRow,
} from "@/lib/crm/phoenix-visit-detail";
import {
  addBucketToSplit,
  emptyVisitCountSplit,
  pharmacyCellNote,
  pharmacyCellValue,
  pharmacyRecordingOf,
  pharmacyValueText,
  type VisitCountSplit,
} from "@/lib/crm/visit-count-buckets";
import { doubleVisitCountBucket, entryPeriodLabel, sumDoubleVisitSplit } from "@/lib/double-visit-analytics/count-bucket";
import {
  doubleVisitorViews,
  keepDoubleVisitors,
  perDoubleVisitorRows,
  visitLogPerDoubleVisitor,
} from "@/lib/double-visit-analytics/chain-visitors";
import type {
  DoubleVisitBreakdownRow,
  DoubleVisitCadenceBand,
  DoubleVisitDashboardData,
  DoubleVisitExecutiveManagerReport,
  DoubleVisitExecutiveSummary,
  DoubleVisitExpenseWorkloadEvidence,
  DoubleVisitIdleManager,
  DoubleVisitInsight,
  DoubleVisitInsightSeverity,
  DoubleVisitKpis,
  DoubleVisitLogEntry,
  DoubleVisitManagerMrPair,
  DoubleVisitManagerSummary,
  DoubleVisitMrScore,
  DoubleVisitFocusProbationEntry,
  DoubleVisitFocusRosterEntry,
  DoubleVisitFocusTrendPoint,
  DoubleVisitIntegrityIssue,
  DoubleVisitIntegrityIssueType,
  DoubleVisitIntegrityReport,
  DoubleVisitPortalFocus,
  DoubleVisitRecoveredChain,
  DoubleVisitReportData,
  DoubleVisitReportRow,
  DoubleVisitRoleCode,
  DoubleVisitRoleRollup,
  DoubleVisitRosterEntry,
  DoubleVisitScopeFocus,
  DoubleVisitSourceType,
  DoubleVisitStartingSoonEntry,
  DoubleVisitTrendPoint,
  DoubleVisitVisitedEmployeeStatus,
} from "@/lib/double-visit-analytics/types";

// ── Double Visit Analytics: LIVE, directly off ireports360_visits ───────────────────
//
// Rebuilt 2026-07-04 (owner decision): the module used to maintain its own mirror
// (double_visit_rows/double_visit_imports), populated by a manual Excel upload, an
// on-demand iReports360 pull, or an automatic "publish a snapshot" cron step — a SECOND,
// separately-scheduled copy of the same CRM data already held by the Visits Report
// (ireports360_visits, synced 3x daily — see src/lib/visits-report/service.ts). That
// import/publish/Excel machinery, and both tables, are gone. There is no snapshot to
// publish and nothing to import: every read below queries ireports360_visits directly,
// so Double Visit Analytics can never drift from the Visits Report's own numbers.
//
// A "double visit" = a visit whose double_crm_id names a second participant AND whose
// visit_type is 0 (Regular) or -8 (Campaign/Prospection) — owner decision, since a shared
// double_crm_id on a Meeting/Training/Conference/Vacation row is joint-attendance
// bookkeeping in the CRM, not fieldwork. agent_hr_id/double_hr_id on ireports360_visits
// are already resolved (manual override -> crm_id -> crm_username; see
// resolveEmployeeHrId in visits-report/service.ts and the Visits Report's own "Unmapped
// Agents" tab), so this module does no CRM-identity resolution of its own.
const DOUBLE_VISIT_TYPE_CODES = [0, -8] as const;

export type DoubleVisitDbRow = {
  activity_date: string;
  area_name: string | null;
  double_visitor_hr_id: string | null;
  double_visitor_name: string | null;
  id: string;
  line_name: string | null;
  period: "AM" | "PM" | "UNKNOWN";
  visit_type: number | null;
  visit_type_description: string | null;
  source_record_id: string | null;
  source_type: DoubleVisitSourceType;
  visit_count: number | null;
  visited_employee_hr_id: string | null;
  visited_employee_name: string | null;
  visited_employee_status: string;
  // Set when this row's visited party was a manager but the same-day chain resolved it down to
  // the real MR (see resolveDoubleVisitChains). The row above already carries the RESOLVED MR in
  // visited_employee_*; these keep the original hinge manager + customers for the audit trail.
  resolved_via_chain?: boolean;
  chain_hinge_hr_id?: string | null;
  chain_hinge_name?: string | null;
  chain_customer_names?: string[] | null;
  // The vendor's contact speciality — 'pharmacy' marks a pharmacy visit, which is counted apart
  // from AM and PM (see src/lib/crm/visit-count-buckets.ts). Sent on regular visits only.
  speciality?: string | null;
  // A started team's Phoenix CRM visit (its negative crm_visit_id). Phoenix CRM logs no pharmacy
  // visit, so every AM · PM · Pharmacies figure built from these rows says its pharmacy figure was
  // never recorded rather than print 0 (src/lib/crm/visit-count-buckets.ts). Absent on a vendor row.
  from_phoenix?: boolean;
  // Slot 2 — a chain visit's SECOND double visitor, on the same row. The vendor split a chain into two
  // rows and `resolveDoubleVisitChains` below reassembles them; Phoenix CRM saves one row carrying both
  // people, so without these the second person did a double visit nobody can see.
  //
  // 🔴 ONE VISIT, IN BOTH MANAGERS' RECORDS (owner, 2026-10-08 — chain-visitors.ts). `visit_count` stays
  // 1 on this row, so the rep receives it once; every MANAGER-side figure reads `perDoubleVisitorRows`,
  // which gives slot 2 the same view of the row slot 1 has, so he is counted exactly as slot 1 is.
  double_visitor2_hr_id?: string | null;
  double_visitor2_name?: string | null;
  // EVERYONE ELSE on a Phoenix rep visit, past the two slots (owner, 2026-10-27, "Everything is
  // applicable"): a visit can carry the district and regional managers, a product manager, a group
  // product manager and a training manager at once, and the slots hold the first two. Read from the
  // door's `companion_hr_ids`; absent on a vendor row and whenever nobody stands past slot 2. Who is
  // NAMED and CREDITED on the visit — never its kind, which stays decided by the slots.
  double_visitor_more?: Array<{ hr_id: string; name: string | null }>;
  // The Phoenix field set, raw and unshaped. Sight is decided by the reader (phoenix-visit-detail.ts),
  // and this row reaches readers at three different tiers plus the scoring engine, which prints nothing.
  phoenix_detail?: PhoenixVisitDetailRow;
};

function text(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/** A Phoenix CRM double visit — it logs no pharmacy visit (src/lib/crm/visit-count-buckets.ts). */
const fromPhoenixRow = (row: DoubleVisitDbRow) => row.from_phoenix === true;

/** `{ phoenixVisits }` only when there are any, so a vendor-only payload keeps its old shape. */
const phoenixVisitsOf = (count: number) => (count > 0 ? { phoenixVisits: count } : {});

function nullableText(value: unknown) {
  const normalized = text(value);
  return normalized || null;
}

function asNumber(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round(value: number, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// Only the precise "table not provisioned" signals — NOT the bare table name or a generic
// "does not exist", which would also match permission-denied/column-drift errors and mask a
// real outage as a benign empty state (a known gap in the sibling Visits Report, not repeated
// here).
function schemaMissing(error: unknown) {
  const message = error instanceof Error ? error.message : JSON.stringify(error);
  return /schema cache|PGRST205|42P01|relation ".*" does not exist/i.test(message);
}

async function isDoubleVisitSchemaReady() {
  return isCrmVisitsSchemaReady();
}

function emptyDashboard(dateFrom: string, dateTo: string): DoubleVisitDashboardData {
  return {
    asOfDate: todayIso(),
    dateFrom,
    dateTo,
    executiveReports: [],
    executiveSummary: { idleManagers: [], insights: [], roleRollups: [] },
    filters: { areas: [], doubleVisitors: [], lines: [] },
    heatmap: { byArea: [], byLine: [] },
    kpis: {
      activeCalendarDays: 0,
      activeDoubleVisitDays: 0,
      activeMappedVisitCount: 0,
      amPmRatio: null,
      amVisitCount: 0,
      averageVisitsPerDoubleVisitDay: 0,
      averageVisitsPerDoubleVisitor: 0,
      doubleVisitorCount: 0,
      mrCoverageCount: 0,
      pharmacyVisitCount: 0,
      pmVisitCount: 0,
      totalVisits: 0,
      vacantOrUnmappedShare: 0,
      vacantOrUnmappedVisitCount: 0,
    },
    managerSummaries: [],
    mrScores: [],
    neglectedMrs: [],
    salesComparisonAvailable: false,
    schemaReady: false,
    trend: [],
    visitLog: [],
  };
}

/**
 * "Today" here is a BUSINESS day, so it is Cairo's calendar date, not the server's.
 *
 * Railway production sets no TZ variable, so this used to return UTC's date. Every `asOfDate`
 * stamp, `daysBetween` gap and — the one that actually moves a number — `currentMonthBounds`
 * hung off it. Between 00:00 and 03:00 Cairo on the 1st of a month UTC is still on the 31st, so
 * a manager opening his portal after midnight on the 1st saw the double-visit pulse still
 * counting the month that had just ended.
 */
function todayIso() {
  return cairoTodayIso();
}

function addDaysIso(dateIso: string, days: number) {
  const date = new Date(`${dateIso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function eachDate(start: string, end: string) {
  const dates: string[] = [];
  let current = start;
  while (current <= end) {
    dates.push(current);
    current = addDaysIso(current, 1);
  }
  return dates;
}

function daysBetween(start: string | null, end = todayIso()) {
  if (!start) return null;
  const startTime = new Date(`${start}T00:00:00Z`).getTime();
  const endTime = new Date(`${end}T00:00:00Z`).getTime();
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) return null;
  return Math.max(0, Math.round((endTime - startTime) / 86400000));
}

function normalizedHrKey(value: string | null | undefined) {
  return normalizeHrIdForAccess(value);
}

function normalizeLabelKey(value: string | null | undefined) {
  return text(value).toLowerCase();
}

function descendantHrIds(managerKey: string, employees: EmployeeDirectoryRow[]) {
  const childrenByManager = new Map<string, EmployeeDirectoryRow[]>();
  for (const employee of employees) {
    const managerKeyValue = normalizedHrKey(employee.managerHrId);
    if (!managerKeyValue) continue;
    childrenByManager.set(managerKeyValue, [...(childrenByManager.get(managerKeyValue) ?? []), employee]);
  }

  const allowed = new Set<string>([managerKey]);
  const queue = [...(childrenByManager.get(managerKey) ?? [])];
  while (queue.length > 0) {
    const employee = queue.shift();
    const key = normalizedHrKey(employee?.hrId);
    if (!employee || !key || allowed.has(key)) continue;
    allowed.add(key);
    queue.push(...(childrenByManager.get(key) ?? []));
  }
  return allowed;
}

/**
 * What the scope needs that the employee directory does not carry. Optional everywhere, so a caller
 * that passes nothing gets exactly the pre-2026-10-20 scope.
 */
export type DoubleVisitScopeOptions = {
  /** doctor_coverage_config.line_overrides (normalizeHrIdForAccess key → line ids) — the lines a
   * Product / Group Product Manager covers when it is more than the one on his employee record. */
  lineOverrides?: DoctorCoverageLineOverrides;
};

/** The IO half of {@link DoubleVisitScopeOptions}: the same cached config doctor coverage reads, so
 * it costs no extra read on a warm cache, and it never throws (it degrades to "no overrides"). */
export async function loadDoubleVisitScopeOptions(): Promise<DoubleVisitScopeOptions> {
  const config = await getDoctorCoverageConfig();
  return { lineOverrides: config.lineOverrides };
}

export function resolveDoubleVisitAccessScope(
  access: AccessContext,
  employees: EmployeeDirectoryRow[],
  options: DoubleVisitScopeOptions = {},
) {
  if (
    access.scope === "system" ||
    access.role === "CEO" ||
    access.role === "Super Admin" ||
    access.role === "SFE Manager" ||
    access.role === "Training Manager" ||
    // Marketing Manager: executive company-wide READ oversight of double-visit analytics.
    access.role === "Marketing Manager"
  ) {
    return { all: true as const };
  }
  // National Sales Manager is NOT company-wide: he sees only his own scope — himself plus
  // everyone reporting up to him (the descendantHrIds chain resolved below).

  const viewerIdentity = resolveEmployeeIdentityId(access) ?? access.hrId ?? access.loginId;
  const viewerKey = normalizedHrKey(viewerIdentity);
  const viewer = viewerKey
    ? employees.find((employee) => normalizedHrKey(employee.hrId) === viewerKey) ?? null
    : null;

  // ── THE DOWNWARD RULE (owner, 2026-09-04; totals decision 2026-09-13) ──────────────────────
  // "Never an employee sees his direct manager. You see yourself and your scope down." Until this
  // block, the rule lived only in doctor coverage, so Product Manager B-155 saw his own manager A-8
  // on this board while she was hidden from him on every CRM board. The ladder and the climb are
  // NOT re-implemented here: buildDownwardCut is the locked resolver's own helpers, exported.
  //
  // Two cuts, as there:
  //   1. CHAIN — every ancestor of the viewer, climbed over the FULL directory (callers pass
  //      includeInactive: true, so a departed middle manager does not stop the climb). Applied to
  //      EVERY scoped viewer.
  //   2. LADDER — anyone whose title is on the ladder at or above the viewer's seat. UNRANKED titles
  //      are NOT cut here (owner, 2026-09-13 questions workbook: "Shown") — a Training Manager's or
  //      SFE Manager's double visit to the viewer's reps stays on the board. The doctor-coverage
  //      resolver and coaching still exclude unranked titles; this board alone differs.
  //      Applied ONLY for the roles whose scope WIDENS past their own reporting subtree — PM/GPM
  //      (whole line) and RM (line ∩ region). The subtree itself is downward by construction and is
  //      exempt from the ladder, exactly as doctor coverage exempts its `team` basis: ranking it
  //      would drop a real report whose title sits off the ladder out of his own manager's board.
  //
  // `excludedVisitorKeys` carries both cuts (normalizeHrIdForAccess keys, the SAME domain as
  // allowedHrIds). Owner decision 2026-09-13: an excluded person's visits are hidden FROM THE TOTALS
  // TOO — the headline shrinks so the KPI band still equals the leaderboard sum. filterRowsForAccess
  // drops them first, and filterEmployeesForDoubleVisitAccess can never readmit them.
  const cut = buildDownwardCut({ role: access.role, viewerHrId: viewerIdentity ?? null, employees });
  const excludedVisitorKeys = new Set<string>(cut.chain);
  if (viewerKey) excludedVisitorKeys.delete(viewerKey);

  const subtreeHrIds = viewerKey ? descendantHrIds(viewerKey, employees) : new Set<string>();
  const appliesLadder =
    access.role === "Product Manager" ||
    access.role === "Group Product Manager" ||
    access.role === "Regional Manager";
  if (appliesLadder) {
    for (const employee of employees) {
      const key = normalizedHrKey(employee.hrId);
      if (!key || key === viewerKey || subtreeHrIds.has(key)) continue;
      if (cut.isRankedAtOrAboveViewer(employee)) excludedVisitorKeys.add(key);
    }
  }
  const isExcluded = (key: string | null | undefined) => Boolean(key && excludedVisitorKeys.has(key));

  // A cycle in manager links can put an ancestor inside the subtree walk; the chain wins.
  const allowedHrIds = new Set<string>(Array.from(subtreeHrIds).filter((key) => !isExcluded(key)));
  const allowedAreas = new Set<string>();
  const allowedLines = new Set<string>();

  if (access.role === "Regional Manager" && viewer && viewerKey) {
    // Owner rule (2026-07-18): a Regional Manager owns exactly ONE product line across a specific
    // set of regions — their scope is Medical Reps on the RM's own line whose region is one their
    // own management subtree actually covers. Shared with employee-portal + weekly-planning (see
    // workforce/hierarchy-resolver.ts for why the RM's own region_name can't be used directly).
    // The previous area/line label expansion leaked BOTH ways (cross-line reps in the same area,
    // and same-line reps in regions he doesn't cover), so it is removed — allowedAreas/allowedLines
    // stay empty and scoping is by hrId only. descendantHrIds (above) still carries the RM + his
    // subtree so rows where THEY are the double-visitor stay in scope.
    const rmRegionKeys = regionsWithinManagerHierarchy(employees, viewerKey, normalizedHrKey);
    if (rmRegionKeys.size > 0) {
      for (const employee of employees) {
        if (!sameWorkforceLine(viewer, employee)) continue;
        const region = normalizeRegionLabel(employee.regionName);
        if (!region || !rmRegionKeys.has(region)) continue;
        const key = normalizedHrKey(employee.hrId);
        if (key && !isExcluded(key)) allowedHrIds.add(key);
      }
    }
  }

  // GPM and PM oversee their entire product LINE, not just their reporting chain. In
  // production the employee directory keys lines by numeric line_id (line_name is null on
  // the manager records), and the DV feed labels lines with an unrelated text code — so
  // matching on line_name alone never fires. Resolve the full line with the canonical
  // sameWorkforceLine (line_id preferred, line-name fallback) and add every line member to
  // allowedHrIds, so a DV is in scope whenever the double-visitor OR the visited MR sits on
  // the line. Without this a GPM saw only their direct chain (≈30 of ≈1,900 line visits).
  //
  // A line OVERRIDE wins when one exists, read exactly as doctor coverage reads it (its `line`
  // basis): some managers cover more than one line — Ahmed Sharaf (B-155) is recorded on Pedia and
  // owns brands on Anti Infective too (owner, 2026-08-09) — and the employee record alone lost every
  // rep on his second line from this board (owner, 2026-10-20). The ladder above already runs over
  // the whole directory, so a second line's DSMs and RSMs are cut exactly like the first's.
  const overrideLineIds = viewerKey ? options.lineOverrides?.[viewerKey] : undefined;
  const scopedLineIds = overrideLineIds && overrideLineIds.length > 0 ? overrideLineIds : null;
  if (
    (access.role === "Product Manager" ||
     access.role === "Group Product Manager") &&
    viewer &&
    (scopedLineIds || viewer.lineId != null || viewer.lineName)
  ) {
    const onScopedLine = (employee: EmployeeDirectoryRow) =>
      scopedLineIds
        ? employee.lineId != null && scopedLineIds.includes(employee.lineId)
        : sameWorkforceLine(viewer, employee);
    for (const employee of employees) {
      if (!onScopedLine(employee)) continue;
      const key = normalizedHrKey(employee.hrId);
      if (key && !isExcluded(key)) allowedHrIds.add(key);
      // Keep any non-null line label too, so line-tagged rows with no mapped employee
      // (e.g. resigned/vacant territories on the line) are still captured.
      const line = normalizeLabelKey(employee.lineName);
      if (line) allowedLines.add(line);
    }
  }

  return {
    all: false as const,
    allowedAreas,
    allowedHrIds,
    allowedLines,
    excludedVisitorKeys,
  };
}

export function filterRowsForAccess(
  rows: DoubleVisitDbRow[],
  access: AccessContext,
  employees: EmployeeDirectoryRow[],
  options: DoubleVisitScopeOptions = {},
) {
  const scope = resolveDoubleVisitAccessScope(access, employees, options);
  if (scope.all) return rows;
  const admitted: DoubleVisitDbRow[] = [];
  for (const original of rows) {
    // Downward rule FIRST, before any admit: a visit BY someone above the viewer (or, on a widening
    // role, at/above his rank) is hidden from the rows AND the totals (owner, 2026-09-13), even
    // though it was made to one of HIS reps. Keyed on the visitor only, and on exclusion — never on
    // directory membership — so an unmapped `CRM:<id>` visitor and a visit to a vacant territory
    // still reach the line-label fallback below.
    //
    // A chain visit carries TWO visitors, and the rule is applied to each: the one above the viewer is
    // taken off the row (his credit hidden), the other keeps it. The row goes only when both are above.
    const row = keepDoubleVisitors(original, (hrId) => {
      const key = normalizedHrKey(hrId);
      return !(key && scope.excludedVisitorKeys.has(key));
    });
    if (!row) continue;
    const visitorKeys = doubleVisitorViews(row).map((view) => normalizedHrKey(view.double_visitor_hr_id));
    const visitedKey = normalizedHrKey(row.visited_employee_hr_id);
    if (
      visitorKeys.some((key) => key && scope.allowedHrIds.has(key)) ||
      (visitedKey && scope.allowedHrIds.has(visitedKey)) ||
      (row.area_name && scope.allowedAreas.has(normalizeLabelKey(row.area_name))) ||
      (row.line_name && scope.allowedLines.has(normalizeLabelKey(row.line_name)))
    ) {
      admitted.push(row);
    }
  }
  return admitted;
}

export function filterEmployeesForDoubleVisitAccess(
  employees: EmployeeDirectoryRow[],
  access: AccessContext,
  options: DoubleVisitScopeOptions = {},
) {
  const scope = resolveDoubleVisitAccessScope(access, employees, options);
  if (scope.all) return employees;
  // PEOPLE are admitted by identity only. allowedLines/allowedAreas are ROW rules — they exist so a
  // line-tagged visit with no mapped employee (a vacant territory) still counts. Letting them admit
  // EMPLOYEES too is what readmitted an excluded manager into scopedEmployees, and from there into
  // the By Manager tab and the "did zero double visits" idle list (a false zero about a real person).
  return employees.filter((employee) => {
    const key = normalizedHrKey(employee.hrId);
    return Boolean(key && scope.allowedHrIds.has(key) && !scope.excludedVisitorKeys.has(key));
  });
}

function currentMonthBounds(referenceDate = todayIso()) {
  const date = new Date(`${referenceDate}T00:00:00Z`);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const start = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
  const end = new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10);
  return { end, start };
}

// ── Live loader: ireports360_visits -> DoubleVisitDbRow ─────────────────────────────

export type MirrorVisitRow = PhoenixVisitDetailRow & {
  /** Slot 2 — a chain visit's second person. Absent on a vendor row, which has one partner column. */
  double2_crm_id?: number | null;
  double2_hr_id?: string | null;
  double2_name?: string | null;
  /** Everyone on a Phoenix rep visit besides the rep, the two slots included (2026-10-27). Null on a
   * vendor row. */
  companion_hr_ids?: string[] | null;
  agent_crm_id: number | null;
  agent_hr_id: string | null;
  agent_name: string | null;
  ampm: string | null;
  contact_name: string | null;
  crm_visit_id: number;
  customer_name: string | null;
  double_crm_id: number | null;
  double_hr_id: string | null;
  double_name: string | null;
  id: string;
  speciality?: string | null;
  visit_date: string;
  visit_type: number | null;
  visit_type_description: string | null;
};

function periodFromAmpm(value: string | null): "AM" | "PM" | "UNKNOWN" {
  const normalized = text(value).toUpperCase();
  if (normalized === "AM") return "AM";
  if (normalized === "PM") return "PM";
  return "UNKNOWN";
}

// The CRM's own display-name text encodes "Name ( Area / Line )" — used only as a fallback
// label when the visited agent has no employee-directory match, so an unmapped visit still
// shows a readable area/line instead of blank.
function extractNameAreaLine(value: string | null | undefined) {
  const raw = text(value);
  if (!raw) return { areaName: null as string | null, lineName: null as string | null, name: null as string | null };
  const match = raw.match(/^(.*?)\s*\((.*?)\)\s*$/);
  if (!match) return { areaName: null, lineName: null, name: raw };
  const name = text(match[1]) || null;
  const parts = text(match[2]).split(/[/|]/).map((part) => text(part)).filter(Boolean);
  const lineName = parts.length > 1 ? parts[parts.length - 1] : null;
  const areaName = parts.length > 1 ? parts.slice(0, -1).join(" / ") : parts[0] ?? null;
  return { areaName, lineName, name: name || raw };
}

async function paginateLiveMirrorVisits(
  dateFrom: string,
  dateTo: string,
  options?: { includeResignedAgents?: boolean; shareSettledWeeks?: boolean; visitDates?: readonly string[]; withoutVisitDetail?: boolean },
): Promise<MirrorVisitRow[]> {
  // Reads through the CRM single-door double-visit loader (keyset-paginated past the PostgREST
  // row cap, resigned/excluded agents removed by default). The canonical double-visit predicate —
  // a real partner (double_crm_id present and ≠ 0) on a fieldwork visit type (Regular 0 / Campaign
  // -8) — lives in crm/reads, so this module can never drift from the Visits Report's own
  // definition. `includeResignedAgents` is default-false and only ever passed by the private
  // calendar's Performed-visit loader (see loadDoubleVisitPrivateCalendarItems) — every other
  // caller of this function keeps the resigned-agent exclusion. dbRowFromMirrorVisit below
  // compensates by preferring the raw CRM label over a resigned employee's identity, since the
  // resolved agent_hr_id is frequently just a stale, reused CRM account (see memory
  // crm-resigned-slot-reused-for-new-hire).
  const read = (filter: { dateFrom: string; dateTo: string; visitDates?: readonly string[] }) =>
    getDoubleVisitRows<MirrorVisitRow>({
      ...filter,
      includeResignedAgents: options?.includeResignedAgents,
      visitTypes: [...DOUBLE_VISIT_TYPE_CODES],
      columns:
        "id, crm_visit_id, visit_date, agent_crm_id, agent_hr_id, agent_name, contact_name, customer_name, " +
        "double_crm_id, double_hr_id, double_name, double2_crm_id, double2_hr_id, double2_name, companion_hr_ids, ampm, " +
        "visit_type, visit_type_description, speciality" +
        // THE PHOENIX FIELD SET, raw. This loader has no reader — `getDoubleVisitReportData` holds the
        // access context and shapes it to that reader's tier there. Selecting it here and deciding sight
        // there is deliberate: this function also feeds the scoring engine and the private calendar,
        // neither of which prints a column, so neither needs a viewer threaded into it.
        // The portal focus panel only counts, so it leaves the field set behind: more than half of each
        // request's bytes on every manager's landing (494 KB against 219 KB, one week, 2 Nov 2026).
        (options?.withoutVisitDetail ? "" : `, ${PHOENIX_VISIT_DETAIL_COLUMNS}`),
    });
  // Whole days only (see findDoubleVisitCalendarDays): every row of each listed day, whoever it names.
  if (options?.visitDates && options.shareSettledWeeks) {
    const sharedKey = sharedReadKey({ includeResignedAgents: options.includeResignedAgents, withoutVisitDetail: options.withoutVisitDetail });
    return readListedDaysSharingSettledWeeks(options.visitDates, { end: dateTo, start: dateFrom }, read, sharedKey);
  }
  if (options?.visitDates) return readListedDayRuns(options.visitDates, { end: dateTo, start: dateFrom }, read);
  return read({ dateFrom, dateTo });
}

/** Week-runs of listed days in flight at once — as many as the door's own day slices. */
const LISTED_DAY_RUN_CONCURRENCY = 4;

/**
 * A read of listed whole days, a week of them per request, back in the whole-window read's id order.
 *
 * WHY A WEEK PER REQUEST (2026-10-28, "now fix the double-visit read"). A day list travels in the
 * request URL, and past a few hundred values PostgREST answers an empty set with no error (50 is the
 * house limit, see `rep-doctor-lists.ts`). So one request carries only its own run of days, bounded by
 * the run's first and last day, and about a week of double visits fits in one page (see
 * DOUBLE_VISIT_SLICE_DAYS) — a run is usually one request. Any number of days can be read this way.
 *
 * WHY THE SORT. The runs come back in day order, but the whole-window read is in id order and chain
 * visits are resolved from a day's rows in that order, so the rows are put back in it. Each day lands
 * in exactly one run, and the door's duplicate collapse works inside one day, so the rows are exactly
 * the whole-window read's rows for those days. Exported for its unit test.
 */
export async function readListedDayRuns<Row extends { id: string }>(
  days: readonly string[],
  window: { end: string; start: string },
  read: (filter: { dateFrom: string; dateTo: string; visitDates: string[] }) => Promise<Row[]>,
): Promise<Row[]> {
  const listed = Array.from(new Set(days)).filter((day) => day >= window.start && day <= window.end).sort();
  const runs = dayScanRuns(listed, DOUBLE_VISIT_SLICE_DAYS);
  const parts = await mapWithConcurrency(runs, LISTED_DAY_RUN_CONCURRENCY, (run) =>
    read({ dateFrom: run[0], dateTo: run[run.length - 1], visitDates: run }),
  );
  return parts.flat().sort((left, right) => compareUuidText(left.id, right.id));
}

const SETTLED_DOUBLE_VISIT_WEEKS = "double-visit-settled-weeks";

/** A whole week is settled once its last day is more than this many days old. */
const SETTLED_WEEK_AFTER_DAYS = 7;

/** One hour is the owner's word (2026-11-03). The budget holds about two years of weeks: 17,897 rows in the 44 weeks to 3 Nov 2026. */
export const SETTLED_WEEK_READ_LIMITS = { maxEntries: 120, maxRowsTotal: 40_000, ttlMs: 60 * 60 * 1000 };

/**
 * A read of listed whole days that takes its settled weeks from one copy every manager shares.
 *
 * WHY (2026-11-03, "fix the manager's double-visit panel on the home"). The portal focus panel was the
 * slowest card on a manager's home: about 5.8 s and 28 requests in a typical minute on 3 Nov 2026. The typical
 * manager had double-visited on 62 days since January, so each open read those whole days again, about 6,200
 * rows with no probationer's days on top, and so did every other manager. A week more than 7 days old hardly
 * changes, and the owner chose how late it may be: a correction to one may reach the panel up to an hour late.
 * So each settled week is read whole, once an hour, and everyone filters it to their own days. The last 7 days
 * are always read live.
 *
 * WHY THE SAME ROWS. The door's duplicate collapse works inside one day and the rows are cut to the listed
 * days after it, so each listed day holds exactly what readListedDayRuns gives it; the sort puts them back in
 * the same id order. Credit is decided from these rows on every open (liveDoubleVisitRowsFromMirror), with
 * that open's identity overrides and directory, so only the visits themselves can be an hour old.
 *
 * An empty week is never kept: this door answers [] for a missing view, and an hour of that would read as
 * nobody having visited. A failed read keeps nothing either. Exported for its unit test.
 */
export async function readListedDaysSharingSettledWeeks<Row extends { id: string; visit_date: string }>(
  days: readonly string[],
  window: { end: string; start: string },
  read: (filter: { dateFrom: string; dateTo: string; visitDates?: string[] }) => Promise<Row[]>,
  sharedKey: string,
  now: () => number = Date.now,
): Promise<Row[]> {
  const listed = new Set(days.filter((day) => day >= window.start && day <= window.end));
  const newestSettledDay = addDaysIso(window.end, -SETTLED_WEEK_AFTER_DAYS - 1);
  const recentDays: string[] = [];
  const settledWeeks = new Set<string>();
  for (const day of listed) {
    const week = isoWeekStart(day);
    if (addDaysIso(week, 6) <= newestSettledDay) settledWeeks.add(week);
    else recentDays.push(day);
  }
  const [recent, settled] = await Promise.all([
    readListedDayRuns(recentDays, window, read),
    mapWithConcurrency([...settledWeeks], LISTED_DAY_RUN_CONCURRENCY, async (week) => {
      const { rows } = await getOrLoadShared(
        SETTLED_DOUBLE_VISIT_WEEKS,
        `${sharedKey}|${week}`,
        async () => {
          const weekRows = await read({ dateFrom: week, dateTo: addDaysIso(week, 6) });
          return weekRows.length > 0 ? weekRows : null;
        },
        SETTLED_WEEK_READ_LIMITS,
        now,
      );
      return (rows ?? []).filter((row) => listed.has(row.visit_date));
    }),
  ]);
  return [...recent, ...settled.flat()].sort((left, right) => compareUuidText(left.id, right.id));
}

// RETIRED 2026-08-01: a hardcoded agent_crm_id -> hr_id corrections map used to live here, with two
// owner-confirmed entries written straight into the source.
//
// It fixed the same problem the identity override table fixes — a CRM slot reused for a departing
// rep's replacement, so `employees.crm_id` keeps resolving to the person who left — but it fixed it
// for DOUBLE VISIT ANALYTICS ONLY. That is exactly why the misattributed work stayed invisible on
// every other surface (Team Calendar, Field Workforce Compliance, the portal) for months: this file
// looked correct, so the underlying data never got fixed.
//
// Both entries now live in `ireports360_crm_identity_resolutions` (tier 1 of the shared identity
// waterfall, written 2026-07-31), which every consumer reads. Reading the SAME table here — rather
// than deleting the correction outright — is deliberate: the mirror's stored `agent_hr_id` is only
// re-stamped when the sync next touches a row, so until then `visit.agent_hr_id` still holds the
// leaver's id and dropping the correction would visibly regress this module.
//
// 🔴 BUT ONLY THROUGH THE SHARED WATERFALL, NEVER AS A BARE crm_id → hr_id LOOKUP (2026-10-26). A
// mapping names who a CRM account belonged to, not who holds it today, and an account passes from a
// leaver to the next hire on the same territory. Applied bare, the 2026-08-28 mapping of account
// 1437 ("( Sohag 2 / A )") to Mostafa Khaled, who left on 30 Apr, kept crediting every double visit
// with Mariam Younan, who has held that account since her 1 Oct hire, to him. So her District
// Manager's coverage card listed her as never double-visited while the probation watchlist beside it
// read DV DONE from the same three visits. The waterfall (resolveEmployeeAttribution) scopes the
// mapping to the label it was saved against and to the mapped person's own employment, so a reseated
// account heals the day its new holder starts, with nobody having to edit the mapping.
type CrmOverrideResolver = (visit: MirrorVisitRow) => string | undefined;

function dbRowFromMirrorVisit(
  visit: MirrorVisitRow,
  employeeByHrKey: Map<string, EmployeeDirectoryRow>,
  managerHrIdKeys: Set<string>,
  resolution: DoubleVisitChainResolution | null,
  resolveOverriddenHrId: CrmOverrideResolver,
): DoubleVisitDbRow {
  // When the same-day chain resolves this "manager-visited" row down to the real MR, the visited
  // party becomes that MR (the whole convoy actually saw them); otherwise it stays the recorded
  // agent, unless an admin's identity override says the CRM slot belongs to someone else. Everything
  // downstream — coverage, MR scores, calendar — then credits the real, correctly-identified person.
  const rawVisitedHrId = resolution ? resolution.mrHrId : visit.agent_hr_id;
  const correctedHrId = !resolution && visit.agent_crm_id != null
    ? resolveOverriddenHrId(visit)
    : undefined;
  const effectiveVisitedHrId = correctedHrId ?? rawVisitedHrId;
  const visitedKey = canonicalHrIdKey(effectiveVisitedHrId);
  const visitedEmployee = visitedKey ? employeeByHrKey.get(visitedKey) ?? null : null;
  const doubleKey = canonicalHrIdKey(visit.double_hr_id);
  const doubleEmployee = doubleKey ? employeeByHrKey.get(doubleKey) ?? null : null;
  const double2Key = canonicalHrIdKey(visit.double2_hr_id ?? null);
  const double2Employee = double2Key ? employeeByHrKey.get(double2Key) ?? null : null;
  // Past the two slots: every other companion the door lists, named from the directory.
  const slotKeys = new Set([doubleKey, double2Key].filter((key): key is string => Boolean(key)));
  const moreVisitors = visitPartnerHrIds({ companion_hr_ids: visit.companion_hr_ids })
    .filter((hrId) => !slotKeys.has(canonicalHrIdKey(hrId) ?? ""))
    .map((hrId) => {
      const employee = employeeByHrKey.get(canonicalHrIdKey(hrId) ?? "") ?? null;
      return { hr_id: employee?.hrId ?? hrId, name: employee?.displayName ?? null };
    });
  const label = extractNameAreaLine(
    (resolution ? resolution.mrName : visit.agent_name) ?? visit.contact_name ?? visit.customer_name,
  );

  // Manager-to-manager and resigned reclassification mirrors the deleted parser.ts's
  // markManagerVisitedRows/markResignedVisitedRows: a double visit is always manager -> MR,
  // never manager -> manager, and a visited employee's CURRENT employment status (not a
  // point-in-time annotation) decides "resigned".
  let visitedStatus: DoubleVisitVisitedEmployeeStatus = visitedEmployee ? "active_mapped" : "unmapped";
  if (visitedStatus === "active_mapped" && visitedKey && managerHrIdKeys.has(visitedKey)) {
    visitedStatus = "non_mr";
  } else if (visitedStatus === "active_mapped" && visitedEmployee && isTerminalEmploymentStatus(visitedEmployee.employmentStatus)) {
    visitedStatus = "resigned";
  }

  // A resolved visited-employee identity that is itself RESIGNED is more often a stale
  // CRM account reused for that resigned employee's replacement (see memory
  // crm-resigned-slot-reused-for-new-hire) than a real visit with someone who has since
  // left. Prefer the raw CRM label (agent_name/contact_name/customer_name — always
  // current per-sync) for the DISPLAYED name/area/line in that case. Never silently
  // re-match to a different employee record; that guesswork is exactly what caused the
  // original mis-attribution, and the correct replacement employee may not even exist
  // in Phoenix yet.
  const preferRawLabel = visitedStatus === "resigned";

  return {
    activity_date: visit.visit_date,
    area_name: preferRawLabel ? (label.areaName ?? visitedEmployee?.areaName ?? null) : (visitedEmployee?.areaName ?? label.areaName),
    double_visitor_hr_id: visit.double_hr_id ?? (visit.double_crm_id ? `CRM:${visit.double_crm_id}` : null),
    double_visitor_name: doubleEmployee?.displayName ?? visit.double_name ?? null,
    double_visitor2_hr_id: visit.double2_hr_id ?? (visit.double2_crm_id ? `CRM:${visit.double2_crm_id}` : null),
    double_visitor2_name: double2Employee?.displayName ?? visit.double2_name ?? null,
    ...(moreVisitors.length > 0 ? { double_visitor_more: moreVisitors } : {}),
    phoenix_detail: pickPhoenixVisitDetailRow(visit as unknown as Record<string, unknown>),
    id: visit.id,
    line_name: preferRawLabel ? (label.lineName ?? visitedEmployee?.lineName ?? null) : (visitedEmployee?.lineName ?? label.lineName),
    period: periodFromAmpm(visit.ampm),
    visit_type: visit.visit_type,
    visit_type_description: visit.visit_type_description,
    source_record_id: String(visit.crm_visit_id),
    source_type: "ireports360",
    speciality: visit.speciality ?? null,
    ...(isPhoenixNativeVisitRow(visit) ? { from_phoenix: true } : {}),
    visit_count: 1,
    visited_employee_hr_id: effectiveVisitedHrId,
    visited_employee_name: preferRawLabel
      ? (label.name ?? (resolution ? resolution.mrName : visit.agent_name))
      : (visitedEmployee?.displayName ?? label.name ?? (resolution ? resolution.mrName : visit.agent_name)),
    visited_employee_status: visitedStatus,
    resolved_via_chain: resolution ? true : undefined,
    chain_hinge_hr_id: resolution?.hingeHrId ?? undefined,
    chain_hinge_name: resolution?.hingeName ?? undefined,
    chain_customer_names: resolution?.customerNames ?? undefined,
  };
}

// ── Same-day chain resolution: "manager rides along on a junior manager's double visit" ──
//
// iReports360 stores only ONE partner per visit row, so when a senior manager (e.g. an NSM)
// accompanies a junior manager (e.g. a DM) who is himself double-visiting a Medical Rep, the
// CRM splits it: the senior→junior pair lands on one set of rows and the junior→MR pair on
// another — same day. The senior's rows then look like "double visit whose visited party is a
// manager" and drop out of every real-MR number, so the senior looks like they did no field
// coaching at all. This walks the chain: for a row whose VISITED party M is a manager, follow
// the people M personally double-visited that day (recursively through any further managers)
// down to the real Medical Rep(s). If that resolves to EXACTLY ONE mapped active MR, the row is
// re-attributed to that MR. Ambiguous days (M double-visited more than one MR that couldn't be
// separated by AM/PM) are left flagged — the resolver only recovers real fieldwork, it never
// guesses, and it never mutates ireports360_visits (a read-time derivation only).

type MirrorAdjacencyNode = {
  agentKey: string;
  customers: Set<string>;
  name: string | null;
  periods: Set<"AM" | "PM" | "UNKNOWN">;
  rawHrId: string;
};

export type DoubleVisitChainResolution = {
  customerNames: string[];
  hingeHrId: string | null;
  hingeName: string | null;
  mrHrId: string;
  mrName: string | null;
};

export function resolveDoubleVisitChains(
  mirrorRows: MirrorVisitRow[],
  isManagerKey: (key: string) => boolean,
  isMedicalRepKey: (key: string) => boolean,
): Map<string, DoubleVisitChainResolution> {
  // Per date: a hinge (double-visitor) key -> everyone that person double-visited that day.
  const adjacencyByDate = new Map<string, Map<string, Map<string, MirrorAdjacencyNode>>>();
  for (const row of mirrorRows) {
    if (!row.agent_hr_id) continue;
    const agentKey = canonicalHrIdKey(row.agent_hr_id);
    const hingeKey = canonicalHrIdKey(row.double_hr_id);
    if (!agentKey || !hingeKey) continue;
    const byHinge = adjacencyByDate.get(row.visit_date) ?? new Map<string, Map<string, MirrorAdjacencyNode>>();
    const nodes = byHinge.get(hingeKey) ?? new Map<string, MirrorAdjacencyNode>();
    const node = nodes.get(agentKey) ?? {
      agentKey,
      customers: new Set<string>(),
      name: nullableText(row.agent_name),
      periods: new Set<"AM" | "PM" | "UNKNOWN">(),
      rawHrId: row.agent_hr_id,
    };
    node.periods.add(periodFromAmpm(row.ampm));
    const customer = nullableText(row.contact_name) ?? nullableText(row.customer_name);
    if (customer) node.customers.add(customer);
    nodes.set(agentKey, node);
    byHinge.set(hingeKey, nodes);
    adjacencyByDate.set(row.visit_date, byHinge);
  }

  // Real MRs reachable from a hinge manager on one date, optionally restricted to a period.
  // Recurses through intermediate managers (multi-level convoys); anyone who is neither a known
  // active MR nor a known manager is ignored so a chain never resolves to an unknown identity.
  const reachableMrs = (
    date: string,
    startKey: string,
    period: "AM" | "PM" | "UNKNOWN" | null,
  ): Map<string, MirrorAdjacencyNode> => {
    const found = new Map<string, MirrorAdjacencyNode>();
    const byHinge = adjacencyByDate.get(date);
    if (!byHinge) return found;
    const seen = new Set<string>();
    const stack = [startKey];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const nodes = byHinge.get(cur);
      if (!nodes) continue;
      for (const node of nodes.values()) {
        if (period && !node.periods.has(period)) continue;
        if (isMedicalRepKey(node.agentKey)) {
          found.set(node.agentKey, node);
        } else if (isManagerKey(node.agentKey)) {
          stack.push(node.agentKey);
        }
      }
    }
    return found;
  };

  const resolutions = new Map<string, DoubleVisitChainResolution>();
  for (const row of mirrorRows) {
    const hingeKey = canonicalHrIdKey(row.agent_hr_id); // the (manager) VISITED party = the hinge
    if (!hingeKey || !isManagerKey(hingeKey)) continue;
    const period = periodFromAmpm(row.ampm);
    // Period-preferred first (keeps a distinct AM chain and PM chain apart), then whole-day.
    let mrs = period === "UNKNOWN" ? new Map<string, MirrorAdjacencyNode>() : reachableMrs(row.visit_date, hingeKey, period);
    if (mrs.size !== 1) mrs = reachableMrs(row.visit_date, hingeKey, null);
    if (mrs.size !== 1) continue; // no chain, or ambiguous → leave flagged, never guess
    const mr = mrs.values().next().value as MirrorAdjacencyNode;
    resolutions.set(row.id, {
      customerNames: Array.from(mr.customers),
      hingeHrId: row.agent_hr_id,
      hingeName: nullableText(row.agent_name),
      mrHrId: mr.rawHrId,
      mrName: mr.name,
    });
  }
  return resolutions;
}

/** The single source loader every function in this module reads through: every double visit
 * (see the module header for the exact definition) in [dateFrom, dateTo], read straight off
 * ireports360_visits and enriched with area/line/status from the employee directory. */
export async function getLiveDoubleVisitRows(
  dateFrom: string,
  dateTo: string,
  employees: EmployeeDirectoryRow[],
  options?: {
    includeResignedAgents?: boolean;
    /** Read only these whole days of the window (see findDoubleVisitCalendarDays). */
    visitDates?: readonly string[];
    /** Leave the Phoenix field set out of the read, for a caller that prints no visit (the focus panel). */
    withoutVisitDetail?: boolean;
    /** The focus panel only: listed days of a settled week come from a copy up to an hour old (readListedDaysSharingSettledWeeks). */
    shareSettledWeeks?: boolean;
    /** The identity overrides the caller already read, so ONE snapshot decides both which days were
     * read and who each visit is credited to. */
    crmIdentityResolutions?: readonly CrmResolutionRow[];
  },
): Promise<DoubleVisitDbRow[]> {
  const mirrorRows = await paginateLiveMirrorVisits(dateFrom, dateTo, options);
  if (mirrorRows.length === 0) return [];
  // Admin identity overrides (tier 1 of the shared CRM waterfall) — replaces the hardcoded
  // corrections map that used to sit in this file. Deliberately NOT wrapped in a try/catch: this
  // decides WHO a visit is credited to, and the module rule is that a failed read may blank an
  // overlay but must never quietly change an attribution. A real read failure surfaces instead of
  // silently reverting every corrected row to the departed employee it used to name.
  return liveDoubleVisitRowsFromMirror(
    mirrorRows,
    employees,
    options?.crmIdentityResolutions ?? (await getCrmIdentityResolutions()),
  );
}

/** The attribution half of {@link getLiveDoubleVisitRows}: a window's mirror rows, credited to the
 * right people and enriched from the directory. Each day is resolved from its own rows alone (the
 * chain note below), so a read of whole days gives each of those days exactly the rows a read of
 * the whole window gives it. Pure, exported for its unit test. */
export function liveDoubleVisitRowsFromMirror(
  mirrorRows: MirrorVisitRow[],
  employees: EmployeeDirectoryRow[],
  crmIdentityResolutions: readonly CrmResolutionRow[],
): DoubleVisitDbRow[] {
  // Only an account an admin mapped is re-resolved here; every other row keeps the hr id the sync
  // stamped with this same waterfall. A mapped account is answered as the sync answers it on that
  // row's date — the mapped person inside their own employment, otherwise whoever the account's
  // crm_id or label names and was employed that day — and a row nobody can own keeps its stamp.
  const identityMaps = buildCrmIdentityMaps(employees, [...crmIdentityResolutions]);
  const resolveOverriddenHrId: CrmOverrideResolver = (visit) => {
    if (!identityMaps.hrIdByManualOverride.has(String(visit.agent_crm_id))) return undefined;
    return resolveEmployeeHrId(visit.agent_crm_id, visit.agent_name, identityMaps, visit.visit_date) ?? undefined;
  };
  const employeeByHrKey = new Map(
    employees
      .map((employee) => [canonicalHrIdKey(employee.hrId), employee] as const)
      .filter((entry): entry is [string, EmployeeDirectoryRow] => Boolean(entry[0])),
  );
  const managerHrIdKeys = new Set(
    employees
      .filter((employee) => resolveDvRole(employee) !== null)
      .map((employee) => canonicalHrIdKey(employee.hrId))
      .filter((key): key is string => Boolean(key)),
  );
  const medicalRepHrIdKeys = new Set(
    employees
      .filter((employee) => isActiveEmployee(employee) && isMedicalRep(employee))
      .map((employee) => canonicalHrIdKey(employee.hrId))
      .filter((key): key is string => Boolean(key)),
  );
  // Recover senior-manager double visits that the CRM split into a manager→manager record plus a
  // separate manager→MR record on the same day (see resolveDoubleVisitChains). Both halves are
  // always inside [dateFrom, dateTo] because they share a date, so any range the callers request
  // is self-sufficient for resolution.
  const chainResolutions = resolveDoubleVisitChains(
    mirrorRows,
    (key) => managerHrIdKeys.has(key),
    (key) => medicalRepHrIdKeys.has(key),
  );
  return mirrorRows.map((visit) =>
    dbRowFromMirrorVisit(visit, employeeByHrKey, managerHrIdKeys, chainResolutions.get(visit.id) ?? null, resolveOverriddenHrId),
  );
}

function isoWeekStart(dateIso: string): string {
  const date = new Date(`${dateIso}T00:00:00Z`);
  const day = date.getUTCDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(date);
  monday.setUTCDate(date.getUTCDate() + diffToMonday);
  return monday.toISOString().slice(0, 10);
}

function buildWeeklyTrend(rows: DoubleVisitDbRow[]): DoubleVisitTrendPoint[] {
  const byWeek = new Map<string, { am: number; mrs: Set<string>; pharmacies: number; phoenix: number; pm: number; total: number }>();
  for (const row of rows) {
    const week = isoWeekStart(row.activity_date);
    const bucket = byWeek.get(week) ?? { am: 0, mrs: new Set<string>(), pharmacies: 0, phoenix: 0, pm: 0, total: 0 };
    const count = asNumber(row.visit_count);
    bucket.total += count;
    // AM · PM · Pharmacies apart — a pharmacy visit is never one of the PM doctors (count-bucket.ts).
    const countBucket = doubleVisitCountBucket(row);
    if (countBucket === "AM") bucket.am += count;
    else if (countBucket === "PM") bucket.pm += count;
    else if (countBucket === "Pharmacies") bucket.pharmacies += count;
    if (countBucket && row.from_phoenix) bucket.phoenix += count;
    const visitedKey = canonicalHrIdKey(row.visited_employee_hr_id);
    if (visitedKey) bucket.mrs.add(visitedKey);
    byWeek.set(week, bucket);
  }
  return Array.from(byWeek.entries())
    .map(([weekStart, bucket]) => ({
      amVisits: bucket.am,
      distinctMrs: bucket.mrs.size,
      pharmacyVisits: bucket.pharmacies,
      ...(bucket.phoenix > 0 ? { phoenixVisits: bucket.phoenix } : {}),
      pmVisits: bucket.pm,
      totalDvs: bucket.total,
      weekStart,
    }))
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

export function isActiveEmployee(employee: EmployeeDirectoryRow) {
  const status = text(employee.employmentStatus).toLowerCase();
  return status === "active" || status === "on_leave";
}

/**
 * The set of canonical HR-id keys for LEAVERS (resigned/terminated/inactive) in the directory.
 *
 * A leaver's NAME is never surfaced as a live double-visitor on the current dashboard (owner,
 * 2026-09-29: a resigned/terminated employee shows only in the Resignations module). This is a
 * DISPLAY concern only — every count, KPI, heatmap and executive score is built from HR-ids in
 * buildScopedDoubleVisitDashboardCore and is untouched, so hiding the name changes no number.
 */
export function leaverVisitorKeySet(employees: EmployeeDirectoryRow[]): Set<string> {
  return new Set(
    employees
      .filter((employee) => !isActiveEmployee(employee))
      .map((employee) => canonicalHrIdKey(employee.hrId))
      .filter((key): key is string => Boolean(key)),
  );
}

/** True when this double-visitor HR-id belongs to a leaver, so their name must not be shown. */
export function isLeaverVisitorHrId(hrId: string | null | undefined, leaverKeys: Set<string>): boolean {
  const key = canonicalHrIdKey(hrId);
  return key ? leaverKeys.has(key) : false;
}

const allowedDoubleVisitorRoles = [
  "Medical Rep",
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
  "Marketing Manager",
  "SFE Manager",
  "Training Manager",
] as const;

export function isMedicalRep(employee: EmployeeDirectoryRow) {
  return /medical\s*rep|medical\s*representative/i.test(`${employee.positionTitle ?? ""} ${employee.jobTitle ?? ""}`);
}

function isAllowedDoubleVisitor(employee: EmployeeDirectoryRow | null) {
  if (!employee) return true;
  const posRole = resolveJobFunctionRole(employee.positionTitle);
  const jobRole = resolveJobFunctionRole(employee.jobTitle);
  if (posRole === "CEO" || jobRole === "CEO") return false;
  return (
    allowedDoubleVisitorRoles.includes(posRole as (typeof allowedDoubleVisitorRoles)[number]) ||
    allowedDoubleVisitorRoles.includes(jobRole as (typeof allowedDoubleVisitorRoles)[number])
  );
}

function isDisallowedExecutiveManager(employee: EmployeeDirectoryRow | null) {
  if (!employee) return false;
  return (
    resolveJobFunctionRole(employee.positionTitle) === "CEO" ||
    resolveJobFunctionRole(employee.jobTitle) === "CEO"
  );
}

function filterRowsByAllowedDoubleVisitor(rows: DoubleVisitDbRow[], employeeByHrId: Map<string, EmployeeDirectoryRow>) {
  // Per visitor: a chain visit whose second manager is not an allowed double-visitor keeps the first.
  return rows.flatMap((original) => {
    const row = keepDoubleVisitors(original, (hrId) => {
      const doubleVisitorKey = normalizedHrKey(hrId);
      if (!doubleVisitorKey) return true;
      return isAllowedDoubleVisitor(employeeByHrId.get(doubleVisitorKey) ?? null);
    });
    return row ? [row] : [];
  });
}

function buildMrScores(rows: DoubleVisitDbRow[], employees: EmployeeDirectoryRow[], asOfDate: string): DoubleVisitMrScore[] {
  const activeMrs = employees.filter((employee) => isActiveEmployee(employee) && isMedicalRep(employee));
  const rowsByMr = new Map<string, DoubleVisitDbRow[]>();
  for (const row of rows) {
    const key = canonicalHrIdKey(row.visited_employee_hr_id);
    if (!key) continue;
    rowsByMr.set(key, [...(rowsByMr.get(key) ?? []), row]);
  }
  const last90Start = addDaysIso(asOfDate, -90);
  const prev90Start = addDaysIso(asOfDate, -180);
  const prev90End = addDaysIso(asOfDate, -91);
  return activeMrs.map((employee) => {
    const key = canonicalHrIdKey(employee.hrId) ?? "";
    const mrRows = rowsByMr.get(key) ?? [];
    const sorted = [...mrRows].sort((left, right) => left.activity_date.localeCompare(right.activity_date));
    const last = sorted.at(-1) ?? null;
    const lastDvDate = last?.activity_date ?? null;
    const days = daysBetween(lastDvDate, asOfDate);
    const dvsLast90Days = mrRows
      .filter((row) => row.activity_date >= last90Start && row.activity_date <= asOfDate)
      .reduce((sum, row) => sum + asNumber(row.visit_count), 0);
    // Best-effort delta: only as accurate as the caller's own [dateFrom,dateTo] range allows —
    // same limitation dvsLast90Days already has. A range narrower than 180 days simply yields
    // fewer/zero prior-period visits rather than a true rolling comparison.
    const dvsPrev90Days = mrRows
      .filter((row) => row.activity_date >= prev90Start && row.activity_date <= prev90End)
      .reduce((sum, row) => sum + asNumber(row.visit_count), 0);
    const trendDirection: DoubleVisitMrScore["trendDirection"] =
      dvsLast90Days > dvsPrev90Days ? "improving" : dvsLast90Days < dvsPrev90Days ? "declining" : "flat";
    // The visits are the rep's (counted once above); the PEOPLE who gave them are both managers.
    const distinctVisitors = new Set(perDoubleVisitorRows(mrRows).map((row) => canonicalHrIdKey(row.double_visitor_hr_id)).filter(Boolean));
    const band = days == null || days > 60 || dvsLast90Days === 0
      ? "critical"
      : days > 30
        ? "warning"
        : "healthy";
    return {
      areaName: employee.areaName,
      band,
      daysSinceLastDv: days,
      distinctDoubleVisitors: distinctVisitors.size,
      dvsLast90Days,
      dvsPrev90Days,
      employeeStatus: employee.employmentStatus,
      hireDate: employee.hireDate,
      hrId: employee.hrId,
      lastDoubleVisitorName: last?.double_visitor_name ?? null,
      lastDvDate,
      lineName: employee.lineName,
      managerHrId: employee.managerHrId,
      managerName: employee.managerName,
      mrName: employee.displayName,
      totalDvs: mrRows.reduce((sum, row) => sum + asNumber(row.visit_count), 0),
      trendDirection,
    } satisfies DoubleVisitMrScore;
  }).sort((left, right) => {
    const bandRank = { critical: 0, warning: 1, healthy: 2 };
    return bandRank[left.band] - bandRank[right.band] || left.mrName.localeCompare(right.mrName);
  });
}

// SFE Manager joined on 2026-10-20: he is an allowed double visitor (allowedDoubleVisitorRoles) with
// his own leaderboard code, yet the By Manager tab never listed him, because he sits in no org-chart
// chain above a rep and was missing here (owner: every role a module applies to must appear in it).
const functionalDoubleVisitorRoles = ["Product Manager", "Group Product Manager", "Marketing Manager", "Training Manager", "SFE Manager"] as const;

function isFunctionalDoubleVisitorRole(employee: EmployeeDirectoryRow): boolean {
  const posRole = resolveJobFunctionRole(employee.positionTitle);
  const jobRole = resolveJobFunctionRole(employee.jobTitle);
  return (functionalDoubleVisitorRoles as readonly string[]).includes(posRole) ||
    (functionalDoubleVisitorRoles as readonly string[]).includes(jobRole);
}

function buildExecutiveReports(scores: DoubleVisitMrScore[], employees: EmployeeDirectoryRow[], rows: DoubleVisitDbRow[]): DoubleVisitExecutiveManagerReport[] {
  const employeesByHrId = new Map(employees.map((employee) => [canonicalHrIdKey(employee.hrId), employee]));
  const reportsByManager = new Map<string, { manager: EmployeeDirectoryRow; mrs: DoubleVisitMrScore[] }>();

  // Pass 1: org-chart hierarchy walk (DSM → RM → NSM)
  for (const score of scores) {
    let managerKey = canonicalHrIdKey(score.managerHrId);
    const seen = new Set<string>();
    while (managerKey && !seen.has(managerKey)) {
      seen.add(managerKey);
      const manager = employeesByHrId.get(managerKey);
      if (!manager) break;
      if (isDisallowedExecutiveManager(manager)) break;
      const current = reportsByManager.get(managerKey) ?? { manager, mrs: [] };
      current.mrs.push(score);
      reportsByManager.set(managerKey, current);
      managerKey = canonicalHrIdKey(manager.managerHrId);
    }
  }

  // Pass 2: functional double-visitors (PM / GPM / MM / Training / SFE) who appear in
  // the rows but are not in the org-chart hierarchy above any MR.
  const visitorRows = perDoubleVisitorRows(rows);
  const doubleVisitorKeys = new Set(visitorRows.map((row) => canonicalHrIdKey(row.double_visitor_hr_id)).filter(Boolean));
  for (const dvKey of doubleVisitorKeys) {
    if (reportsByManager.has(dvKey ?? "")) continue;
    const dvEmployee = dvKey ? employeesByHrId.get(dvKey) : undefined;
    if (!dvEmployee || !isFunctionalDoubleVisitorRole(dvEmployee)) continue;

    const posRole = resolveJobFunctionRole(dvEmployee.positionTitle);
    const jobRole = resolveJobFunctionRole(dvEmployee.jobTitle);
    const isLineScopedRole =
      posRole === "Product Manager" ||
      posRole === "Group Product Manager" ||
      posRole === "Marketing Manager" ||
      posRole === "Training Manager" ||
      posRole === "SFE Manager" ||
      jobRole === "Product Manager" ||
      jobRole === "Group Product Manager" ||
      jobRole === "Marketing Manager" ||
      jobRole === "Training Manager" ||
      jobRole === "SFE Manager";

    // PM/GPM/MM/TM/SFE have no fixed org-chart team, so scope their executive report to
    // exactly the MRs they actually visited. This is self-scoping: a PM covering two
    // lines (e.g. Pedia + Anti Inf) automatically gets both sets of MR scores, and a
    // TM or SFE Manager does not get incorrectly assigned the entire MR universe.
    const dvVisitedMrKeys = isLineScopedRole
      ? new Set(
          visitorRows
            .filter((r) => canonicalHrIdKey(r.double_visitor_hr_id) === dvKey)
            .map((r) => canonicalHrIdKey(r.visited_employee_hr_id))
            .filter(Boolean),
        )
      : null;
    const lineFiltered =
      dvVisitedMrKeys && dvVisitedMrKeys.size > 0
        ? scores.filter((s) => dvVisitedMrKeys.has(canonicalHrIdKey(s.hrId)))
        : null;
    const expectedScores = lineFiltered && lineFiltered.length > 0 ? lineFiltered : scores;

    if (expectedScores.length > 0) {
      reportsByManager.set(dvKey ?? "", { manager: dvEmployee, mrs: expectedScores });
    }
  }

  return Array.from(reportsByManager.entries()).map(([managerHrId, group]) => {
    const totalDvs = group.mrs.reduce((sum, mr) => sum + mr.totalDvs, 0);
    const topFour = [...group.mrs].sort((left, right) => right.totalDvs - left.totalDvs).slice(0, 4);
    const topFourDvs = topFour.reduce((sum, mr) => sum + mr.totalDvs, 0);
    const touched = group.mrs.filter((mr) => mr.totalDvs > 0);
    const averageDvs = group.mrs.length ? totalDvs / group.mrs.length : 0;
    const latestDvDate = group.mrs.map((mr) => mr.lastDvDate).filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
    return {
      areaName: group.manager.areaName,
      concentrationRatio: totalDvs > 0 ? round(topFourDvs / totalDvs, 4) : 0,
      criticalMrCount: group.mrs.filter((mr) => mr.band === "critical").length,
      expectedMrCount: group.mrs.length,
      latestDvDate,
      lineName: group.manager.lineName,
      managerHrId: group.manager.hrId || managerHrId,
      managerName: group.manager.displayName || group.manager.hrId || managerHrId,
      neglectedMrCount: group.mrs.filter((mr) => mr.band !== "healthy").length,
      overFocusedMrCount: group.mrs.filter((mr) => averageDvs > 0 && mr.totalDvs >= Math.max(5, averageDvs * 2)).length,
      touchedMrCount: touched.length,
      touchedPercent: group.mrs.length ? round((touched.length / group.mrs.length) * 100, 1) : 0,
      totalDvs,
    } satisfies DoubleVisitExecutiveManagerReport;
  }).filter((report) => report.expectedMrCount > 0)
    .sort((left, right) => right.neglectedMrCount - left.neglectedMrCount || left.managerName.localeCompare(right.managerName));
}

// ── Personal-effort summaries (one row per double-visitor) ──────────────────────

const DV_ROLE_CODES: Record<string, DoubleVisitRoleCode> = {
  "District Manager": "DSM",
  "Group Product Manager": "GPM",
  "Marketing Manager": "MM",
  "National Sales Manager": "NSM",
  "Product Manager": "PM",
  "Regional Manager": "RM",
  "SFE Manager": "SFE",
  "Training Manager": "TM",
};

const DV_ROLE_LABELS: Record<DoubleVisitRoleCode, string> = {
  DSM: "District Manager",
  GPM: "Group Product Manager",
  MM: "Marketing Manager",
  NSM: "National Sales Manager",
  PM: "Product Manager",
  RM: "Regional Manager",
  SFE: "SFE Manager",
  TM: "Training Manager",
};

const DV_ROLE_CODE_ORDER: DoubleVisitRoleCode[] = ["DSM", "RM", "NSM", "PM", "GPM", "MM", "SFE", "TM"];
const HIERARCHY_ROLE_CODES = new Set<DoubleVisitRoleCode>(["DSM", "RM", "NSM"]);

// Single source of truth for a double-visitor's role code. Mirrors isAllowedDoubleVisitor /
// isFunctionalDoubleVisitorRole: check positionTitle, then jobTitle. CEO has no code → null.
function resolveDvRole(employee: EmployeeDirectoryRow | null): { role: string; roleCode: DoubleVisitRoleCode } | null {
  if (!employee) return null;
  const posRole = resolveJobFunctionRole(employee.positionTitle);
  if (DV_ROLE_CODES[posRole]) return { role: posRole, roleCode: DV_ROLE_CODES[posRole] };
  const jobRole = resolveJobFunctionRole(employee.jobTitle);
  if (DV_ROLE_CODES[jobRole]) return { role: jobRole, roleCode: DV_ROLE_CODES[jobRole] };
  return null;
}

export function buildManagerSummariesDetailed(
  rows: DoubleVisitDbRow[],
  employees: EmployeeDirectoryRow[],
  asOfDate: string,
): { summaries: DoubleVisitManagerSummary[]; visitedKeysByManager: Map<string, Set<string>> } {
  const employeesByHrId = new Map(
    employees
      .map((employee) => [canonicalHrIdKey(employee.hrId), employee] as const)
      .filter((entry): entry is [string, EmployeeDirectoryRow] => Boolean(entry[0])),
  );

  // The team MRs live in the descendantHrIds normalization domain (normalizeHrIdForAccess), which
  // is DISTINCT from canonicalHrIdKey. Coverage intersects this set with the MRs a manager visited,
  // so that side is re-derived from the raw row in THIS domain below (visitedTeamKeys) rather than
  // converted from the canonical tally — a key from the other domain would silently never match.
  const activeMrKeys = new Set(
    employees
      .filter((employee) => isActiveEmployee(employee) && isMedicalRep(employee))
      .map((employee) => normalizedHrKey(employee.hrId))
      .filter((key): key is string => Boolean(key)),
  );
  // The team's HR ids travel with the summary so the manager profile's "not visited" list names the
  // SAME whole team the coverage figure counts — every rep beneath a DSM, RM or NSM, not only the
  // ones reporting to him directly (owner, 2026-10-20). Mapped back from this key domain to the
  // directory's own HR id, so the client can re-key it however it likes.
  const hrIdByTeamKey = new Map<string, string>();
  for (const employee of employees) {
    const key = normalizedHrKey(employee.hrId);
    if (key && !hrIdByTeamKey.has(key)) hrIdByTeamKey.set(key, employee.hrId);
  }
  const teamMrKeysMemo = new Map<string, Set<string>>();
  const teamMrKeysFor = (managerNormKey: string) => {
    if (!managerNormKey) return new Set<string>();
    const cached = teamMrKeysMemo.get(managerNormKey);
    if (cached) return cached;
    const keys = new Set<string>();
    for (const key of descendantHrIds(managerNormKey, employees)) {
      if (key !== managerNormKey && activeMrKeys.has(key)) keys.add(key);
    }
    teamMrKeysMemo.set(managerNormKey, keys);
    return keys;
  };

  // One entry per (visit, manager): a chain visit's second manager is summarised exactly like the first.
  const rowsByVisitor = new Map<string, DoubleVisitDbRow[]>();
  for (const row of perDoubleVisitorRows(rows)) {
    const key = canonicalHrIdKey(row.double_visitor_hr_id);
    if (!key) continue;
    rowsByVisitor.set(key, [...(rowsByVisitor.get(key) ?? []), row]);
  }

  const summaries: DoubleVisitManagerSummary[] = [];
  const visitedKeysByManager = new Map<string, Set<string>>();

  for (const [visitorKey, visitorRows] of rowsByVisitor) {
    const employee = employeesByHrId.get(visitorKey) ?? null;
    const dv = resolveDvRole(employee);

    const totalDvs = visitorRows.reduce((sum, row) => sum + asNumber(row.visit_count), 0);
    const activeDvDays = new Set(visitorRows.map((row) => row.activity_date).filter(Boolean)).size;
    // AM · PM · Pharmacies apart — a pharmacy visit is never one of the PM doctors (count-bucket.ts).
    const visitSplit = sumDoubleVisitSplit(visitorRows, doubleVisitCountBucket, (row) => asNumber(row.visit_count), fromPhoenixRow);
    const amVisits = visitSplit.am;
    const pmVisits = visitSplit.pm;
    const pharmacyVisits = visitSplit.pharmacies;

    const visitedTally = new Map<string, number>();
    const visitedTeamKeys = new Set<string>();
    for (const row of visitorRows) {
      const mrTeamKey = normalizedHrKey(row.visited_employee_hr_id);
      if (mrTeamKey) visitedTeamKeys.add(mrTeamKey);
      const mrKey = canonicalHrIdKey(row.visited_employee_hr_id);
      if (!mrKey) continue;
      visitedTally.set(mrKey, (visitedTally.get(mrKey) ?? 0) + asNumber(row.visit_count));
    }
    const distinctMrs = visitedTally.size;
    visitedKeysByManager.set(visitorKey, new Set(visitedTally.keys()));

    const tallyValues = Array.from(visitedTally.values());
    const visitedSum = tallyValues.reduce((sum, value) => sum + value, 0);
    const avgPerMr = tallyValues.length ? visitedSum / tallyValues.length : 0;
    const top4 = [...tallyValues].sort((a, b) => b - a).slice(0, 4).reduce((sum, value) => sum + value, 0);
    const concentrationPct = totalDvs > 0 ? round((top4 / totalDvs) * 100, 1) : null;
    const overFocusedMrCount = tallyValues.filter((value) => avgPerMr > 0 && value >= Math.max(5, avgPerMr * 2)).length;

    const teamMrKeys = dv && HIERARCHY_ROLE_CODES.has(dv.roleCode) && employee
      ? teamMrKeysFor(normalizedHrKey(employee.hrId) ?? "")
      : null;
    const teamMrCount = teamMrKeys?.size ?? null;
    // Coverage counts only the MRs from the manager's OWN team, because that is the population the
    // denominator describes. Counting every MR they rode along with — another district's rep, or one
    // who has since left — put 11 of the 19 live hierarchy managers above 100% (one at 225%), and a
    // ratio at or above 100% also forces Neglected MRs to 0 while real reps go unvisited.
    const teamMrsVisited = teamMrKeys ? Array.from(teamMrKeys).filter((key) => visitedTeamKeys.has(key)).length : 0;
    const coveragePct = teamMrCount && teamMrCount > 0 ? round((teamMrsVisited / teamMrCount) * 100, 1) : null;
    const neglectedMrCount = teamMrCount && teamMrCount > 0 ? teamMrCount - teamMrsVisited : null;

    const sortedDates = visitorRows.map((row) => row.activity_date).filter(Boolean).sort();
    const firstDvDate = sortedDates.at(0) ?? null;
    const lastDvDate = sortedDates.at(-1) ?? null;

    // Simple composite quality signal (0-100, not a scientific score): coverage of the team,
    // penalized when effort concentrates on a handful of MRs instead of being spread around.
    const effectivenessScore = coveragePct == null
      ? null
      : round(Math.max(0, Math.min(100, coveragePct - (concentrationPct ?? 0) * 0.3)), 1);

    summaries.push({
      activeDvDays,
      amVisits,
      areaName: employee?.areaName ?? nullableText(visitorRows.find((row) => nullableText(row.area_name))?.area_name),
      callsPerActiveDay: activeDvDays > 0 ? round(totalDvs / activeDvDays, 2) : 0,
      concentrationPct,
      coveragePct,
      daysSinceLastDv: daysBetween(lastDvDate, asOfDate),
      distinctMrs,
      effectivenessScore,
      firstDvDate,
      inDirectory: Boolean(employee),
      lastDvDate,
      lineName: employee?.lineName ?? nullableText(visitorRows.find((row) => nullableText(row.line_name))?.line_name),
      managerHrId: visitorKey,
      managerName: nullableText(employee?.displayName) ?? nullableText(visitorRows[0]?.double_visitor_name) ?? visitorKey,
      neglectedMrCount,
      overFocusedMrCount,
      pharmacyVisits,
      ...(visitSplit.phoenix ? { phoenixVisits: visitSplit.phoenix } : {}),
      pmVisits,
      role: dv?.role ?? null,
      roleCode: dv?.roleCode ?? null,
      teamMrCount,
      teamMrHrIds: teamMrKeys
        ? Array.from(teamMrKeys)
            .map((key) => hrIdByTeamKey.get(key))
            .filter((hrId): hrId is string => Boolean(hrId))
        : null,
      totalDvs,
    });
  }

  summaries.sort((left, right) => right.totalDvs - left.totalDvs || left.managerName.localeCompare(right.managerName));
  return { summaries, visitedKeysByManager };
}

export function buildManagerSummaries(rows: DoubleVisitDbRow[], employees: EmployeeDirectoryRow[], asOfDate: string) {
  return buildManagerSummariesDetailed(rows, employees, asOfDate).summaries;
}

/** The coverage numerator, recovered exactly from the pair the summary already carries — see
 * buildManagerSummariesDetailed, where neglected is teamMrCount minus the team MRs actually
 * visited. Insight sentences must quote THIS, not distinctMrs, or the count in the sentence
 * disagrees with the percentage beside it for any manager who rode along outside their team. */
function teamMrsVisitedOf(summary: DoubleVisitManagerSummary): number | null {
  if (summary.teamMrCount == null || summary.neglectedMrCount == null) return null;
  return summary.teamMrCount - summary.neglectedMrCount;
}

function buildDoubleVisitInsights(
  summaries: DoubleVisitManagerSummary[],
  mrScores: DoubleVisitMrScore[],
  kpis: DoubleVisitKpis,
  idleManagers: DoubleVisitIdleManager[],
  scopedEmployees: EmployeeDirectoryRow[],
): DoubleVisitInsight[] {
  const raw: Array<Omit<DoubleVisitInsight, "rank">> = [];

  const topCallRate = summaries
    .filter((summary) => summary.activeDvDays >= 2 && summary.callsPerActiveDay > 0)
    .slice()
    .sort((a, b) => b.callsPerActiveDay - a.callsPerActiveDay)[0];
  if (topCallRate) {
    raw.push({
      category: "performance",
      detail: `${topCallRate.managerName} averaged ${topCallRate.callsPerActiveDay} double visits per active day across ${topCallRate.activeDvDays} days.`,
      id: "top-call-rate",
      managerHrId: topCallRate.managerHrId,
      mrHrId: null,
      severity: "positive",
      title: "Highest call rate per day",
    });
  }

  const biggest = summaries.filter((summary) => summary.totalDvs > 0).slice().sort((a, b) => b.totalDvs - a.totalDvs)[0];
  if (biggest) {
    const share = kpis.totalVisits > 0 ? round((biggest.totalDvs / kpis.totalVisits) * 100, 1) : 0;
    raw.push({
      category: "performance",
      detail: `${biggest.managerName} performed ${biggest.totalDvs} double visits (${share}% of all DV effort).`,
      id: "biggest-contributor",
      managerHrId: biggest.managerHrId,
      mrHrId: null,
      severity: "positive",
      title: "Top double-visit contributor",
    });
  }

  const mostOverFocused = summaries
    .filter((summary) => summary.teamMrCount != null && summary.teamMrCount > 0 && (summary.neglectedMrCount ?? 0) > 0 && summary.concentrationPct != null)
    .slice()
    .sort((a, b) => (b.concentrationPct ?? 0) - (a.concentrationPct ?? 0))[0];
  if (mostOverFocused) {
    raw.push({
      category: "concentration",
      detail: `${mostOverFocused.managerName} put ${mostOverFocused.concentrationPct}% of double visits on ${teamMrsVisitedOf(mostOverFocused)} of ${mostOverFocused.teamMrCount} team MRs — rotation gap.`,
      id: "most-over-focused",
      managerHrId: mostOverFocused.managerHrId,
      mrHrId: null,
      severity: "warning",
      title: "Most concentrated coverage",
    });
  }

  const lowestCoverage = summaries
    .filter((summary) => summary.coveragePct != null && summary.teamMrCount != null)
    .slice()
    .sort((a, b) => (a.coveragePct ?? 0) - (b.coveragePct ?? 0))[0];
  if (lowestCoverage && (lowestCoverage.coveragePct ?? 100) < 70) {
    raw.push({
      category: "coverage",
      detail: `${lowestCoverage.managerName} double-visited only ${teamMrsVisitedOf(lowestCoverage)} of ${lowestCoverage.teamMrCount} team MRs (${lowestCoverage.coveragePct}%).`,
      id: "lowest-coverage",
      managerHrId: lowestCoverage.managerHrId,
      mrHrId: null,
      severity: (lowestCoverage.coveragePct ?? 100) < 40 ? "critical" : "warning",
      title: "Lowest team coverage",
    });
  }

  if (idleManagers.length > 0) {
    const dvRoleEmployeeCount = scopedEmployees.filter((employee) => isActiveEmployee(employee) && resolveDvRole(employee)).length;
    const idleShare = dvRoleEmployeeCount > 0 ? idleManagers.length / dvRoleEmployeeCount : 0;
    raw.push({
      category: "inactivity",
      detail: `${idleManagers.length} manager${idleManagers.length === 1 ? "" : "s"} (DSM/RM/NSM/PM/GPM/TM) performed zero double visits this period.`,
      id: "idle-managers",
      managerHrId: null,
      mrHrId: null,
      severity: idleShare > 0.25 ? "critical" : "warning",
      title: "Managers with zero double visits",
    });
  }

  // The balance compares the doctors' mornings with their afternoons; pharmacy visits are counted
  // apart and never tip it (THE AM · PM · PHARMACIES GOLDEN RULE).
  const am = kpis.amVisitCount;
  const pm = kpis.pmVisitCount;
  const pharmacies = kpis.pharmacyVisitCount;
  const totalPeriod = am + pm;
  if (totalPeriod > 0) {
    const minorityShare = Math.min(am, pm) / totalPeriod;
    const amPct = round((am / totalPeriod) * 100, 0);
    raw.push({
      category: "balance",
      detail: `Field effort splits ${am} AM vs ${pm} PM (${amPct}% AM)${pharmacies > 0 ? `, with ${pharmacies} pharmacy visit${pharmacies === 1 ? "" : "s"} counted apart` : ""}. ${am <= pm ? "Mornings are under-covered." : "Afternoons are under-covered."}`,
      id: "ampm-imbalance",
      managerHrId: null,
      mrHrId: null,
      severity: minorityShare < 0.2 ? "warning" : "info",
      title: "AM · PM balance",
    });
  }

  const worstMr = mrScores
    .slice()
    .sort((a, b) => {
      const av = a.daysSinceLastDv == null ? Number.POSITIVE_INFINITY : a.daysSinceLastDv;
      const bv = b.daysSinceLastDv == null ? Number.POSITIVE_INFINITY : b.daysSinceLastDv;
      return bv - av;
    })[0];
  if (worstMr) {
    const never = worstMr.daysSinceLastDv == null;
    raw.push({
      category: "neglect",
      detail: never
        ? `${worstMr.mrName} has never received a double visit in this snapshot.`
        : `${worstMr.mrName} last received a double visit ${worstMr.daysSinceLastDv} days ago.`,
      id: "longest-mr-gap",
      managerHrId: canonicalHrIdKey(worstMr.managerHrId),
      mrHrId: canonicalHrIdKey(worstMr.hrId),
      severity: worstMr.band === "critical" ? "critical" : "warning",
      title: never ? "MR never double-visited" : "Longest gap since a double visit",
    });
  }

  const severityWeight: Record<DoubleVisitInsightSeverity, number> = { critical: 0, info: 2, positive: 3, warning: 1 };
  return raw
    .map((insight, index) => ({ index, insight }))
    .sort((a, b) => severityWeight[a.insight.severity] - severityWeight[b.insight.severity] || a.index - b.index)
    .slice(0, 8)
    .map(({ insight }, rank) => ({ ...insight, rank }));
}

export function buildExecutiveSummary(
  summaries: DoubleVisitManagerSummary[],
  mrScores: DoubleVisitMrScore[],
  kpis: DoubleVisitKpis,
  scopedEmployees: EmployeeDirectoryRow[],
  visitedKeysByManager: Map<string, Set<string>>,
): DoubleVisitExecutiveSummary {
  const byRole = new Map<DoubleVisitRoleCode, DoubleVisitManagerSummary[]>();
  for (const summary of summaries) {
    if (!summary.roleCode) continue;
    byRole.set(summary.roleCode, [...(byRole.get(summary.roleCode) ?? []), summary]);
  }

  const activeVisitorKeys = new Set(summaries.map((summary) => summary.managerHrId));
  // The team an idle field manager left unvisited, counted exactly as buildManagerSummariesDetailed
  // counts an active one's (same domain, same active-rep rule), so the CEO's double-visit table can
  // show him at 100% neglected instead of a row of blanks (owner, 2026-10-20).
  const activeMrKeys = new Set(
    scopedEmployees
      .filter((employee) => isActiveEmployee(employee) && isMedicalRep(employee))
      .map((employee) => normalizedHrKey(employee.hrId))
      .filter((key): key is string => Boolean(key)),
  );
  const idleManagers: DoubleVisitIdleManager[] = [];
  for (const employee of scopedEmployees) {
    if (!isActiveEmployee(employee)) continue;
    const dv = resolveDvRole(employee);
    if (!dv) continue;
    const key = canonicalHrIdKey(employee.hrId);
    if (!key || activeVisitorKeys.has(key)) continue;
    const normKey = normalizedHrKey(employee.hrId);
    const teamMrCount = HIERARCHY_ROLE_CODES.has(dv.roleCode) && normKey
      ? Array.from(descendantHrIds(normKey, scopedEmployees)).filter((member) => member !== normKey && activeMrKeys.has(member)).length
      : null;
    idleManagers.push({
      areaName: employee.areaName,
      hrId: key,
      lineName: employee.lineName,
      name: employee.displayName || employee.hrId || key,
      role: dv.role,
      roleCode: dv.roleCode,
      teamMrCount,
    });
  }
  idleManagers.sort((left, right) =>
    DV_ROLE_CODE_ORDER.indexOf(left.roleCode) - DV_ROLE_CODE_ORDER.indexOf(right.roleCode) ||
    left.name.localeCompare(right.name));

  const roleRollups: DoubleVisitRoleRollup[] = [];
  for (const roleCode of DV_ROLE_CODE_ORDER) {
    const group = byRole.get(roleCode) ?? [];
    if (group.length === 0) continue;
    const coverageValues = group.map((summary) => summary.coveragePct).filter((value): value is number => value != null);
    const neglectedValues = group.map((summary) => summary.neglectedMrCount).filter((value): value is number => value != null);
    const union = new Set<string>();
    for (const summary of group) {
      for (const key of visitedKeysByManager.get(summary.managerHrId) ?? []) union.add(key);
    }
    roleRollups.push({
      activeManagerCount: group.length,
      amVisits: group.reduce((sum, summary) => sum + summary.amVisits, 0),
      avgCallsPerDay: group.length ? round(group.reduce((sum, summary) => sum + summary.callsPerActiveDay, 0) / group.length, 2) : null,
      avgCoveragePct: coverageValues.length ? round(coverageValues.reduce((sum, value) => sum + value, 0) / coverageValues.length, 1) : null,
      distinctMrs: union.size,
      neglectedMrCount: neglectedValues.length ? neglectedValues.reduce((sum, value) => sum + value, 0) : null,
      pharmacyVisits: group.reduce((sum, summary) => sum + summary.pharmacyVisits, 0),
      ...phoenixVisitsOf(group.reduce((sum, summary) => sum + (summary.phoenixVisits ?? 0), 0)),
      pmVisits: group.reduce((sum, summary) => sum + summary.pmVisits, 0),
      roleCode,
      roleLabel: DV_ROLE_LABELS[roleCode],
      totalActiveDvDays: group.reduce((sum, summary) => sum + summary.activeDvDays, 0),
      totalDvs: group.reduce((sum, summary) => sum + summary.totalDvs, 0),
    });
  }

  const insights = buildDoubleVisitInsights(summaries, mrScores, kpis, idleManagers, scopedEmployees);
  return { idleManagers, insights, roleRollups };
}

// Per (double-visitor × MR) pair: visits + DISTINCT DAYS + span. Answers
// "Saad Salama × Ahmed Ashraf = 29 visits in how many days?". Server analogue of the
// client buildManagerProfile pair computation, used by the Excel export.
export function buildManagerMrPairs(visitLog: DoubleVisitLogEntry[]): DoubleVisitManagerMrPair[] {
  type Acc = {
    area: string | null;
    dates: Set<string>;
    firstDate: string | null;
    lastDate: string | null;
    managerHrId: string;
    managerName: string;
    mrHrId: string | null;
    mrName: string;
    visits: number;
  };
  const pairs = new Map<string, Acc>();
  for (const entry of visitLogPerDoubleVisitor(visitLog)) {
    const managerKey = canonicalHrIdKey(entry.doubleVisitorHrId);
    if (!managerKey) continue;
    const mrKey = canonicalHrIdKey(entry.visitedHrId);
    const pairKey = `${managerKey}|${mrKey ?? `name:${entry.visitedName ?? "unknown"}`}`;
    const day = entry.date.slice(0, 10);
    const existing: Acc = pairs.get(pairKey) ?? {
      area: entry.area,
      dates: new Set<string>(),
      firstDate: null,
      lastDate: null,
      managerHrId: managerKey,
      managerName: entry.doubleVisitorName ?? managerKey,
      mrHrId: entry.visitedHrId,
      mrName: entry.visitedName ?? "Unmapped MR",
      visits: 0,
    };
    existing.visits += entry.visitCount;
    existing.dates.add(day);
    if (!existing.firstDate || entry.date < existing.firstDate) existing.firstDate = entry.date;
    if (!existing.lastDate || entry.date > existing.lastDate) existing.lastDate = entry.date;
    pairs.set(pairKey, existing);
  }
  return Array.from(pairs.values())
    .map((pair) => ({
      area: pair.area,
      days: pair.dates.size,
      firstDate: pair.firstDate,
      lastDate: pair.lastDate,
      managerHrId: pair.managerHrId,
      managerName: pair.managerName,
      mrHrId: pair.mrHrId,
      mrName: pair.mrName,
      visits: pair.visits,
      visitsPerDay: pair.dates.size > 0 ? round(pair.visits / pair.dates.size, 2) : 0,
    }))
    .sort((left, right) => right.visits - left.visits);
}

function buildHeatmapRows(
  scores: DoubleVisitMrScore[],
  field: "areaName" | "lineName",
  allBuckets: string[] = [],
): DoubleVisitBreakdownRow[] {
  const groups = new Map<string, DoubleVisitMrScore[]>();
  for (const score of scores) {
    const key = nullableText(score[field]) ?? "Unmapped";
    groups.set(key, [...(groups.get(key) ?? []), score]);
  }
  for (const bucket of allBuckets) {
    const normalized = text(bucket);
    if (!normalized) continue;
    if (!groups.has(normalized)) groups.set(normalized, []);
  }
  return Array.from(groups.entries()).map(([label, group]) => {
    const mrCount = group.length;
    const healthy = group.filter((score) => score.band === "healthy").length;
    const totalVisits = group.reduce((sum, score) => sum + score.totalDvs, 0);
    const coveragePercent = mrCount ? round((healthy / mrCount) * 100, 1) : 0;
    return {
      coveragePercent,
      label,
      mrCount,
      status: coveragePercent >= 70 ? "healthy" : coveragePercent >= 40 ? "warning" : "critical",
      totalVisits,
    } satisfies DoubleVisitBreakdownRow;
  }).sort((left, right) => (right.coveragePercent ?? 0) - (left.coveragePercent ?? 0) || right.totalVisits - left.totalVisits);
}

function buildKpis(rows: DoubleVisitDbRow[]): DoubleVisitKpis {
  // A chain visit is ONE visit in the company total, and in BOTH managers' days and averages.
  const totalVisits = rows.reduce((sum, row) => sum + asNumber(row.visit_count), 0);
  const visitorRows = perDoubleVisitorRows(rows);
  const visitorVisits = visitorRows.reduce((sum, row) => sum + asNumber(row.visit_count), 0);
  const activeDoubleVisitDays = new Set(visitorRows.map((row) => `${canonicalHrIdKey(row.double_visitor_hr_id)}|${row.activity_date}`)).size;
  const doubleVisitorCount = new Set(visitorRows.map((row) => canonicalHrIdKey(row.double_visitor_hr_id)).filter(Boolean)).size;
  // AM · PM · Pharmacies apart, so the AM : PM ratio below compares doctors' periods only.
  const visitSplit = sumDoubleVisitSplit(rows, doubleVisitCountBucket, (row) => asNumber(row.visit_count), fromPhoenixRow);
  const amVisitCount = visitSplit.am;
  const pmVisitCount = visitSplit.pm;
  const pharmacyVisitCount = visitSplit.pharmacies;
  const activeMappedVisitCount = rows.filter((row) => row.visited_employee_status === "active_mapped").reduce((sum, row) => sum + asNumber(row.visit_count), 0);
  const vacantOrUnmappedVisitCount = totalVisits - activeMappedVisitCount;
  return {
    activeCalendarDays: new Set(rows.map((row) => row.activity_date)).size,
    activeDoubleVisitDays,
    activeMappedVisitCount,
    amPmRatio: pmVisitCount > 0 ? round(amVisitCount / pmVisitCount, 4) : null,
    amVisitCount,
    averageVisitsPerDoubleVisitDay: activeDoubleVisitDays > 0 ? round(visitorVisits / activeDoubleVisitDays, 2) : 0,
    averageVisitsPerDoubleVisitor: doubleVisitorCount > 0 ? round(visitorVisits / doubleVisitorCount, 2) : 0,
    doubleVisitorCount,
    mrCoverageCount: new Set(rows.map((row) => canonicalHrIdKey(row.visited_employee_hr_id)).filter(Boolean)).size,
    pharmacyVisitCount,
    ...(visitSplit.phoenix ? { phoenixVisitCount: visitSplit.phoenix } : {}),
    pmVisitCount,
    totalVisits,
    vacantOrUnmappedShare: totalVisits > 0 ? round((vacantOrUnmappedVisitCount / totalVisits) * 100, 1) : 0,
    vacantOrUnmappedVisitCount,
  };
}

/**
 * The scoped heart of the dashboard — pure, no IO — exported so the downward-rule test drives the
 * SERVICE's own construction rather than a copy of it (a test that rebuilt this pipeline itself is
 * how an earlier attempt stayed green while the idle-manager defect shipped).
 *
 * Every emitter (KPI band, leaderboard, By Manager tab, idle list, MR scores) is built from the one
 * `filteredRows` / `scopedEmployees` pair, which is what keeps the KPI total equal to the
 * leaderboard sum once out-of-scope visitors are removed — with ONE ruled exception: a chain visit is
 * one visit in the KPI total and one in EACH of its two managers' leaderboard rows (owner, 2026-10-08),
 * so the leaderboard sum exceeds the total by exactly the chain visits on the board.
 *
 * `employees` must be the FULL directory (includeInactive: true).
 */
export function buildScopedDoubleVisitDashboardCore(input: {
  access: AccessContext;
  dateTo: string;
  employees: EmployeeDirectoryRow[];
  rows: DoubleVisitDbRow[];
  scopeOptions?: DoubleVisitScopeOptions;
}) {
  const { access, dateTo, employees, rows, scopeOptions } = input;
  const scopedEmployees = filterEmployeesForDoubleVisitAccess(employees, access, scopeOptions);
  const scopedRows = filterRowsForAccess(rows, access, employees, scopeOptions);
  // Visitor ROLE classification reads the FULL directory, never the scope. Built from the scope it
  // failed OPEN for anyone outside it (isAllowedDoubleVisitor(null) is true), so it only ever
  // worked for a scoped viewer while an out-of-scope visitor happened to be readmitted.
  const employeesByAccessKey = new Map(
    employees
      .map((employee) => [normalizedHrKey(employee.hrId), employee])
      .filter((entry): entry is [string, EmployeeDirectoryRow] => Boolean(entry[0])),
  );
  // Manager HR ID keys (DSM/RM/NSM/PM/GPM/TM) to exclude manager-to-manager rows — defense-in-depth
  // alongside the row-level classification in dbRowFromMirrorVisit. An EXCLUSION is built from the
  // full directory, never from the scope: derived from scopedEmployees it silently stops excluding
  // exactly the managers the downward rule removes from scope.
  const managerHrIdKeys = new Set(
    employees
      .filter((e) => resolveDvRole(e) !== null)
      .map((e) => canonicalHrIdKey(e.hrId))
      .filter((k): k is string => Boolean(k)),
  );
  const filteredRows = filterRowsByAllowedDoubleVisitor(scopedRows, employeesByAccessKey).filter((row) => {
    if (!row.visited_employee_hr_id) return true;
    return !managerHrIdKeys.has(canonicalHrIdKey(row.visited_employee_hr_id) ?? "");
  });
  const mrScores = buildMrScores(filteredRows, scopedEmployees, dateTo);
  const executiveReports = buildExecutiveReports(mrScores, scopedEmployees, filteredRows);
  const kpis = buildKpis(filteredRows);
  const { summaries: managerSummaries, visitedKeysByManager } = buildManagerSummariesDetailed(filteredRows, scopedEmployees, dateTo);
  const executiveSummary = buildExecutiveSummary(managerSummaries, mrScores, kpis, scopedEmployees, visitedKeysByManager);
  return { executiveReports, executiveSummary, filteredRows, kpis, managerSummaries, mrScores, scopedEmployees };
}

export async function getDoubleVisitDashboardData(input: {
  access: AccessContext;
  dateFrom?: string | null;
  dateTo?: string | null;
}): Promise<DoubleVisitDashboardData> {
  const month = currentMonthBounds();
  const schemaReady = await isDoubleVisitSchemaReady();
  if (!schemaReady) {
    return emptyDashboard(input.dateFrom || month.start, input.dateTo || month.end);
  }
  const dateFrom = input.dateFrom || month.start;
  const dateTo = input.dateTo || month.end;

  const [employees, scopeOptions] = await Promise.all([
    getEmployeeDirectoryRows({ includeInactive: true }),
    loadDoubleVisitScopeOptions(),
  ]);
  const rows = await getLiveDoubleVisitRows(dateFrom, dateTo, employees);
  const {
    executiveReports,
    executiveSummary,
    filteredRows,
    kpis: kpisValue,
    managerSummaries,
    mrScores,
    scopedEmployees,
  } = buildScopedDoubleVisitDashboardCore({ access: input.access, dateTo, employees, rows, scopeOptions });
  const activeScopeEmployees = scopedEmployees.filter(isActiveEmployee);
  const areaBuckets = Array.from(new Set(activeScopeEmployees.map((employee) => nullableText(employee.areaName)).filter((value): value is string => Boolean(value)))).sort();
  const lineBuckets = Array.from(new Set(activeScopeEmployees.map((employee) => nullableText(employee.lineName)).filter((value): value is string => Boolean(value)))).sort();
  const areas = Array.from(new Set(filteredRows.map((row) => nullableText(row.area_name)).filter((value): value is string => Boolean(value)))).sort();
  const lines = Array.from(new Set(filteredRows.map((row) => nullableText(row.line_name)).filter((value): value is string => Boolean(value)))).sort();
  // A leaver's NAME is never surfaced as a live double-visitor (owner, 2026-09-29: a resigned/
  // terminated employee shows only in the Resignations module). This is DISPLAY-only — the rows,
  // KPIs, heatmap and executive scoring are all built from hr_ids in buildScopedDoubleVisitDashboardCore
  // above and are untouched, so no count changes; only the filter-dropdown option and the log's
  // shown coach name are withheld for a departed visitor.
  const leaverVisitorKeys = leaverVisitorKeySet(employees);
  const isLeaverVisitor = (hrId: string | null | undefined) => isLeaverVisitorHrId(hrId, leaverVisitorKeys);
  const doubleVisitors = Array.from(
    new Set(
      perDoubleVisitorRows(filteredRows)
        .filter((row) => !isLeaverVisitor(row.double_visitor_hr_id))
        .map((row) => nullableText(row.double_visitor_name) ?? nullableText(row.double_visitor_hr_id))
        .filter((value): value is string => Boolean(value)),
    ),
  ).sort();

  const visitLog: DoubleVisitLogEntry[] = filteredRows
    .map((row) => ({
      area: nullableText(row.area_name),
      countBucket: doubleVisitCountBucket(row),
      date: row.activity_date,
      ...(row.from_phoenix ? { fromPhoenix: true } : {}),
      doubleVisitorHrId: nullableText(row.double_visitor_hr_id),
      doubleVisitorName: isLeaverVisitor(row.double_visitor_hr_id) ? null : nullableText(row.double_visitor_name),
      ...(row.double_visitor2_hr_id || row.double_visitor2_name
        ? {
            doubleVisitor2HrId: nullableText(row.double_visitor2_hr_id ?? null),
            doubleVisitor2Name: isLeaverVisitor(row.double_visitor2_hr_id) ? null : nullableText(row.double_visitor2_name ?? null),
          }
        : {}),
      ...(row.double_visitor_more?.length
        ? { doubleVisitorMore: row.double_visitor_more.map((more) => ({ hrId: more.hr_id, name: isLeaverVisitor(more.hr_id) ? null : nullableText(more.name) })) }
        : {}),
      period: row.period,
      visitCount: asNumber(row.visit_count),
      visitedHrId: nullableText(row.visited_employee_hr_id),
      visitedName: nullableText(row.visited_employee_name),
      visitedStatus: row.visited_employee_status as DoubleVisitVisitedEmployeeStatus,
    }))
    .sort((a, b) => b.date.localeCompare(a.date));

  return {
    asOfDate: todayIso(),
    dateFrom,
    dateTo,
    executiveReports,
    executiveSummary,
    filters: { areas, doubleVisitors, lines },
    heatmap: {
      byArea: buildHeatmapRows(mrScores, "areaName", areaBuckets),
      byLine: buildHeatmapRows(mrScores, "lineName", lineBuckets),
    },
    kpis: kpisValue,
    managerSummaries,
    mrScores,
    neglectedMrs: mrScores.filter((score) => score.band !== "healthy"),
    salesComparisonAvailable: false,
    schemaReady: true,
    trend: buildWeeklyTrend(filteredRows),
    visitLog,
  };
}

// ── Portal landing "focus" widgets: personal trend, scope coverage, probation watch ────

const FOCUS_TREND_START_MONTH = "2026-01";
const NEVER_VISITED_FLAG_DAYS = 45;
const FOCUS_NEGLECTED_DISPLAY_LIMIT = 8;
const FOCUS_PROBATION_DISPLAY_LIMIT = 8;

// DV Planner cadence: how far back to look for a rep's most recent double visit, and the
// warning/critical thresholds — reused verbatim from buildMrScores' band (30/60 days) so the
// planner's cadence colours match the DV Analytics + CEO command-center recency bands.
const CADENCE_LOOKBACK_DAYS = 180;

function cadenceBandFromDays(days: number | null): DoubleVisitCadenceBand {
  if (days == null || days > 60) return "critical";
  if (days > 30) return "warning";
  return "healthy";
}

/**
 * THE ONE "HAS STARTED" TEST (owner, 2026-10-26): a rep counts on the DV Planner roster, the Double
 * Visit Report's Never Visited list and sheet, the probation watchlist and every header count only
 * once their hire date is on or before today in Cairo. A future hire is not yet anyone's double
 * visit to owe — counting them dragged coverage down and filled the never-visited list with people
 * who had not started. A missing hire date counts as started (the old behaviour; nothing to wait for).
 */
export function repHasStarted(hireDate: string | null | undefined, today: string): boolean {
  if (!hireDate) return true;
  return hireDate.slice(0, 10) <= today;
}

/**
 * The viewer's app role -> the probation evaluator TIER whose DV requirement the watchlist reports.
 * A role that is absent here (Regional Manager, Super Admin, CEO) owes no probation double visit of
 * its own, and its rows render "N/A" rather than a status it cannot act on.
 *
 * This used to map to `employee_probation`'s four boolean checkbox columns. It now names the tiers
 * of `probation_dv_days` — the live record — because that table is the only one being filled: see
 * the header of dv-progress-lookup.ts for the measurement.
 */
const PROBATION_DV_TIER_BY_ROLE: Partial<Record<string, ProbationEvaluatorRole>> = {
  "District Manager": "dm",
  "Group Product Manager": "pm_gpm",
  "National Sales Manager": "nsm",
  "Product Manager": "pm_gpm",
  "Training Manager": "tm",
};

/**
 * Load DV progress for the watchlist, degrading to "unknown" rather than to "not done".
 *
 * A read failure must never be rendered as a red Pending: that is the exact shape of the bug this
 * replaced, where a dead data source made every probationer look neglected. `null` reaches the UI
 * as N/A, which is honest about the fact that nothing was measured.
 *
 * The map covers every active case, not the viewer's scope — it is a keyed lookup consulted only
 * for rows that have ALREADY passed the scope filters at each call site, so no unscoped
 * probationer can reach a response through it.
 */
async function loadProbationDvProgress(): Promise<Map<string, DvProgress> | null> {
  return getActiveProbationDvProgressByEmployee().catch(() => null);
}

/** Lookup key for an HR_ID. HR ids are MIXED CASE in this database — never compare them raw. */
function probationDvKey(hrId: string | null | undefined): string {
  return String(hrId ?? "").trim().toLowerCase();
}

function resolveProbationDvDone(
  row: Pick<ProbationRow, "hr_id" | "line_name">,
  tier: ProbationEvaluatorRole | undefined,
  progressByHrId: Map<string, DvProgress> | null,
): boolean | null {
  if (!tier || !progressByHrId) return null;
  return dvRequirementMetForRole(progressByHrId.get(probationDvKey(row.hr_id)), tier, row.line_name);
}

function focusMonthBuckets(startMonth: string, asOf = new Date()) {
  const [startYear, startMonthNum] = startMonth.split("-").map(Number);
  const end = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), 1));
  const buckets: { month: string; label: string }[] = [];
  let cursor = new Date(Date.UTC(startYear, startMonthNum - 1, 1));
  while (cursor <= end) {
    buckets.push({
      label: cursor.toLocaleString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" }),
      month: `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}`,
    });
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  }
  return buckets;
}

/** "Regular" for visit_type 0, else the CRM's own label — matches the module's own double-visit
 * filter (visit_type IN (0,-8)), so this only ever distinguishes Regular from Campaign now. Reads the
 * dedicated visit_type / visit_type_description columns rather than the wide raw_payload jsonb (which
 * this module no longer selects — see paginateLiveMirrorVisits). Those two columns are the exact
 * source of the jsonb's visitType / visitTypeDescription fields — proven identical over the full
 * mirror population (113,458 rows, 0 mismatches). */
function deriveVisitKind(row: Pick<DoubleVisitDbRow, "visit_type" | "visit_type_description">): string {
  if (row.visit_type === 0) return "Regular";
  return nullableText(row.visit_type_description) ?? "Non-Regular";
}

// A double visit is always manager -> Medical Rep — a manager's own probation record (e.g. a
// newly-hired Regional Manager) can never carry a DV status and must never appear in a DV-scoped
// probation watchlist. Prefer the canonical isMedicalRep() against the matched directory row;
// ProbationRow only carries a flat job_title, so fall back to the same pattern against that.
function isMedicalRepProbationRow(row: Pick<ProbationRow, "hr_id" | "job_title">, employees: EmployeeDirectoryRow[]) {
  const key = canonicalHrIdKey(row.hr_id);
  const employee = key ? employees.find((e) => canonicalHrIdKey(e.hrId) === key) : undefined;
  if (employee) return isMedicalRep(employee);
  return /medical\s*rep|medical\s*representative/i.test(row.job_title ?? "");
}

function buildScopeSummarySentence(total: number, covered: number, neglected: DoubleVisitFocusRosterEntry[]) {
  if (total === 0) return "No medical reps are currently mapped to your scope.";
  const neglectedCount = neglected.length;
  if (neglectedCount === 0) return `All ${total} of your ${total === 1 ? "rep has" : "reps have"} been double-visited by you.`;
  const overdue = neglected.filter((entry) => entry.flagged).length;
  const base = `${neglectedCount} of ${total} team member${total === 1 ? "" : "s"} haven't been double-visited by you yet`;
  return overdue === 0
    ? `${base}.`
    : `${base} — ${overdue} ${overdue === 1 ? "is" : "are"} overdue (hired ${NEVER_VISITED_FLAG_DAYS}+ days ago).`;
}

export async function getDoubleVisitPortalFocus(access: AccessContext): Promise<DoubleVisitPortalFocus | null> {
  const role = access.role ?? "";
  if (!DV_ROLE_CODES[role]) return null;
  if (!(await isDoubleVisitSchemaReady())) return null;

  const employees = await getEmployeeDirectoryRows({ includeInactive: true });
  const viewerKey = normalizedHrKey(resolveEmployeeIdentityId(access) ?? access.hrId ?? access.loginId);
  const viewer = viewerKey ? employees.find((employee) => normalizedHrKey(employee.hrId) === viewerKey) ?? null : null;
  // Canonical (alias-table + symbol-stripped) key — NOT a raw .toUpperCase() equality check,
  // matching every other reader in this file (filterRowsForAccess, buildManagerSummariesDetailed).
  const viewerCanonicalKey = canonicalHrIdKey(viewer?.hrId ?? access.hrId ?? null);

  const buckets = focusMonthBuckets(FOCUS_TREND_START_MONTH);
  const trendStart = `${buckets[0].month}-01`;
  const periodTo = todayIso();

  const [probationRows, probationDvProgress] = await Promise.all([
    getProbationRows(access).catch(() => []),
    loadProbationDvProgress(),
  ]);
  // The probation watchlist must live inside the SAME double-visit scope as the coverage roster
  // below. getProbationRows is intentionally broader for some roles (e.g. an NSM gets his whole
  // line, while his DV scope is only the reporting chain resolved in resolveDoubleVisitAccessScope),
  // so intersect on the DV-scoped set — otherwise a viewer sees probation alarms for reps outside
  // his double-visit scope (a cross-scope leak the coverage/trend blocks never had).
  const scopedEmployees = filterEmployeesForDoubleVisitAccess(employees, access);
  const scopedHrKeys = new Set(
    scopedEmployees.map((employee) => canonicalHrIdKey(employee.hrId)).filter((key): key is string => Boolean(key)),
  );
  const medicalRepProbationRows = probationRows.filter((row) => {
    if (!isMedicalRepProbationRow(row, employees)) return false;
    const key = canonicalHrIdKey(row.hr_id);
    return key ? scopedHrKeys.has(key) : false;
  });
  // Block 3's order is settled before the read (a stable sort, as it always was): only the first
  // FOCUS_PROBATION_DISPLAY_LIMIT probationers are shown, so only theirs is a count the panel needs.
  const probationOrdered = [...medicalRepProbationRows].sort((a, b) => a.days_remaining - b.days_remaining);
  const probationShown = probationOrdered.slice(0, FOCUS_PROBATION_DISPLAY_LIMIT);

  // 🔴 THE PANEL READS ITS PEOPLE'S DAYS, NOT THE COMPANY'S YEAR (2026-10-28, "now fix the
  // double-visit read"). It read every double visit since January — 17,535 rows in 44 requests on
  // every District Manager's and NSM's portal landing — to keep the viewer's own visits and up to eight
  // probationers' counts. Every figure on it comes from a row naming one of those people, or from the
  // rest of that row's day (a chain visit), so those whole days give every figure the whole-window
  // read gives it (see findDoubleVisitCalendarDays for why whole days are enough). Nobody to show →
  // no read; a lookup that fails → the whole window, as before.
  const viewerHrId = viewer?.hrId ?? access.hrId ?? null;
  const focusHrIds = [...(viewerCanonicalKey && viewerHrId ? [viewerHrId] : []), ...probationShown.map((row) => row.hr_id)];
  const focusWindow = { end: periodTo, start: trendStart };
  const focusDays = focusHrIds.length > 0 ? await findDoubleVisitFocusDays(focusHrIds, focusWindow) : null;
  const allDvRows =
    focusHrIds.length === 0
      ? []
      : await getLiveDoubleVisitRows(trendStart, periodTo, employees, {
          shareSettledWeeks: true,
          withoutVisitDetail: true,
          ...(focusDays ? { crmIdentityResolutions: focusDays.resolutions, visitDates: focusDays.days } : {}),
        });
  const { dvCountByHrId, ownRows } = doubleVisitFocusTallies(allDvRows, viewerCanonicalKey);

  // Block 1 — viewer's own monthly DV trend (own performed visits only, per owner decision).
  const countByMonth = new Map<string, number>();
  for (const row of ownRows) {
    if (row.activity_date < trendStart) continue;
    const month = row.activity_date.slice(0, 7);
    countByMonth.set(month, (countByMonth.get(month) ?? 0) + asNumber(row.visit_count));
  }
  const trend: DoubleVisitFocusTrendPoint[] = buckets.map((bucket) => ({
    count: countByMonth.get(bucket.month) ?? 0,
    label: bucket.label,
    month: bucket.month,
  }));

  // Block 2 — scope coverage: which in-scope MRs has the viewer EVER personally double-visited.
  // scopedEmployees was resolved above so the probation watchlist shares this exact DV scope.
  const visitedKeys = new Set(
    ownRows.map((row) => canonicalHrIdKey(row.visited_employee_hr_id)).filter((key): key is string => Boolean(key)),
  );
  const roster = scopedEmployees.filter((employee) => {
    if (!isActiveEmployee(employee) || !isMedicalRep(employee)) return false;
    return normalizedHrKey(employee.hrId) !== viewerKey;
  });

  let scope: DoubleVisitScopeFocus | null = null;
  if (roster.length > 0) {
    const entries: DoubleVisitFocusRosterEntry[] = roster.map((employee) => {
      const key = canonicalHrIdKey(employee.hrId);
      const visited = key ? visitedKeys.has(key) : false;
      const daysSinceHire = daysBetween(employee.hireDate);
      return {
        areaName: employee.areaName,
        daysSinceHire,
        flagged: !visited && daysSinceHire != null && daysSinceHire >= NEVER_VISITED_FLAG_DAYS,
        hireDate: employee.hireDate,
        hrId: employee.hrId,
        name: employee.displayName,
        visited,
      };
    });
    const neglectedAll = entries.filter((entry) => !entry.visited).sort((a, b) => (b.daysSinceHire ?? -1) - (a.daysSinceHire ?? -1));
    const coveredCount = entries.length - neglectedAll.length;
    scope = {
      coveragePct: round((coveredCount / entries.length) * 100, 1),
      coveredCount,
      neglected: neglectedAll.slice(0, FOCUS_NEGLECTED_DISPLAY_LIMIT),
      neglectedCount: neglectedAll.length,
      neglectedTruncated: neglectedAll.length > FOCUS_NEGLECTED_DISPLAY_LIMIT,
      rosterSize: entries.length,
      summarySentence: buildScopeSummarySentence(entries.length, coveredCount, neglectedAll),
    };
  }

  // Block 3 — probation watchlist. "Done" means the viewer's own tier (dm/nsm/pm_gpm/tm) has met
  // its configured DV requirement on that probationer's active case. Regional Manager owes no
  // probation double visit of its own, so it falls back to a raw DV count (any double-visitor,
  // matched the same canonical way as everything else in this function).
  const dvTier = PROBATION_DV_TIER_BY_ROLE[role];
  const probation: DoubleVisitFocusProbationEntry[] = probationShown.map((row) => {
    const key = canonicalHrIdKey(row.hr_id);
    return {
      daysRemaining: row.days_remaining,
      dvCount: key ? dvCountByHrId.get(key) ?? 0 : 0,
      dvDone: resolveProbationDvDone(row, dvTier, probationDvProgress),
      hireDate: row.hire_date,
      hrId: row.hr_id,
      name: row.full_name,
      probationEndDate: row.probation_end_date,
    } satisfies DoubleVisitFocusProbationEntry;
  });

  return {
    periodFrom: trendStart,
    periodTo,
    probation,
    probationTruncated: medicalRepProbationRows.length > FOCUS_PROBATION_DISPLAY_LIMIT,
    reportHref: "/employee-portals/double-visit-report",
    scope,
    trend,
  };
}

/** What the focus panel reads off its double visits: the viewer's own visits (one row per visit he
 * was a double-visitor on, matched by his canonical key) and each visited rep's double-visit count.
 * Over the days read for these people, both are what the whole window gives them; another rep's
 * count may be partial and is never shown. Pure, exported for its unit test. */
export function doubleVisitFocusTallies(rows: DoubleVisitDbRow[], viewerCanonicalKey: string | null) {
  const ownRows = viewerCanonicalKey
    ? perDoubleVisitorRows(rows).filter((row) => canonicalHrIdKey(row.double_visitor_hr_id) === viewerCanonicalKey)
    : [];
  const dvCountByHrId = new Map<string, number>();
  for (const row of rows) {
    const key = canonicalHrIdKey(row.visited_employee_hr_id);
    if (!key) continue;
    dvCountByHrId.set(key, (dvCountByHrId.get(key) ?? 0) + asNumber(row.visit_count));
  }
  return { dvCountByHrId, ownRows };
}

// ── Double Visit Report page: flat, filterable, sortable, exportable drill-down ────

/**
 * Build the DV-scoped probation watchlist (onProbation / dvDone / dvCount per row) for a manager
 * scope. Exported + reused by the weekly digest (Wave 2) so a manager's probationDvPending count
 * in the email matches the live page exactly.
 */
export async function buildDvPlannerProbationEntries(params: {
  access: AccessContext;
  employees: EmployeeDirectoryRow[];
  scopedRows: Pick<DoubleVisitDbRow, "visited_employee_hr_id" | "visit_count">[];
  /** Cairo today; a probationer whose hire date is after it has not started (repHasStarted). */
  today?: string;
}): Promise<DoubleVisitFocusProbationEntry[]> {
  const { access, employees, scopedRows } = params;
  const today = params.today ?? todayIso();
  const [probationRowsAll, probationDvProgress] = await Promise.all([
    getProbationRows(access).catch(() => []),
    loadProbationDvProgress(),
  ]);
  const probationRowsRaw = probationRowsAll.filter(
    (row) => isMedicalRepProbationRow(row, employees) && repHasStarted(row.hire_date, today),
  );
  const dvTier = PROBATION_DV_TIER_BY_ROLE[access.role ?? ""];
  const probationDvCountByKey = new Map<string, number>();
  for (const row of scopedRows) {
    const key = canonicalHrIdKey(row.visited_employee_hr_id);
    if (!key) continue;
    probationDvCountByKey.set(key, (probationDvCountByKey.get(key) ?? 0) + asNumber(row.visit_count));
  }
  return probationRowsRaw.map((row) => {
    const key = canonicalHrIdKey(row.hr_id);
    return {
      daysRemaining: row.days_remaining,
      dvCount: key ? probationDvCountByKey.get(key) ?? 0 : 0,
      dvDone: resolveProbationDvDone(row, dvTier, probationDvProgress),
      hireDate: row.hire_date,
      hrId: row.hr_id,
      name: row.full_name,
      probationEndDate: row.probation_end_date,
    } satisfies DoubleVisitFocusProbationEntry;
  });
}

/**
 * Build the DV Planner roster (one entry per active Medical Rep) from already-scoped inputs.
 * Exported + pure so the weekly digest can reproduce the exact page roster for any manager scope.
 *
 * - `inWindowRows` drives the in-window `visitCount` / `visited` / `lastVisitDate` (selected period).
 * - `cadenceLastVisitByKey` (most recent DV over the wider cadence lookback) drives
 *   `lastVisitDateEver` / `daysSinceLastVisit` / `cadenceBand`. When empty (non-cadence callers) it
 *   falls back to the in-window last date, so `cadenceBand` is never garbage.
 * - `daysSinceHire` is measured from `dateTo` (report-frame recency); cadence from `today`.
 * - A rep who has not started (repHasStarted: hire date after `today`) is left out entirely, so the
 *   roster, the coverage % and every header count leave them out too.
 * - A rep with no double visit in the lookback is overdue only once the days since HIRE (from
 *   `today`) pass the same 30/60 band — a rep hired two days ago is not late for anything.
 */
export function buildDvPlannerRosterEntries(params: {
  activeMedicalReps: EmployeeDirectoryRow[];
  // Only visitedHrId + activityDate are read below — narrowed to a Pick (rather than the full
  // DoubleVisitReportRow) so the weekly digest can feed it directly from the wide DV scan without
  // building the fully-enriched report row (area/region/doubleVisitorRole/visitKind), which it has
  // no other use for.
  inWindowRows: Pick<DoubleVisitReportRow, "visitedHrId" | "activityDate">[];
  cadenceLastVisitByKey: Map<string, string>;
  probation: DoubleVisitFocusProbationEntry[];
  dateTo: string;
  today: string;
}): DoubleVisitRosterEntry[] {
  const { activeMedicalReps, inWindowRows, cadenceLastVisitByKey, probation, dateTo, today } = params;

  const statsByKey = new Map<string, { count: number; lastDate: string | null }>();
  for (const row of inWindowRows) {
    const key = row.visitedHrId ? canonicalHrIdKey(row.visitedHrId) : null;
    if (!key) continue;
    const existing = statsByKey.get(key);
    if (existing) existing.count += 1;
    // inWindowRows is sorted newest-first, so the first occurrence per key is the most recent.
    else statsByKey.set(key, { count: 1, lastDate: row.activityDate });
  }
  const probationByKey = new Map(
    probation
      .map((entry) => [canonicalHrIdKey(entry.hrId), entry] as const)
      .filter((entry): entry is [string, DoubleVisitFocusProbationEntry] => Boolean(entry[0])),
  );

  return activeMedicalReps
    .filter((employee) => repHasStarted(employee.hireDate, today))
    .map((employee) => {
      const key = canonicalHrIdKey(employee.hrId);
      const stats = key ? statsByKey.get(key) : undefined;
      const probationEntry = key ? probationByKey.get(key) : undefined;
      const daysSinceHire = daysBetween(employee.hireDate, dateTo);
      const visited = Boolean(stats && stats.count > 0);
      // Cadence recency: prefer the wide-lookback max; fall back to in-window last date so the band
      // stays sensible for callers that didn't opt into the wider cadence scan.
      const lastVisitDateEver = (key ? cadenceLastVisitByKey.get(key) : undefined) ?? stats?.lastDate ?? null;
      const daysSinceLastVisit = lastVisitDateEver ? daysBetween(lastVisitDateEver, today) : null;
      // Never visited in the lookback: the clock runs from the hire date instead, on the same 30/60
      // band. No hire date on record keeps the old reading (critical).
      const cadenceBand = cadenceBandFromDays(daysSinceLastVisit ?? daysBetween(employee.hireDate, today));
      return {
        areaName: employee.areaName,
        cadenceBand,
        cadenceOverdue: cadenceBand !== "healthy",
        daysSinceHire,
        daysSinceLastVisit,
        flagged: !visited && daysSinceHire != null && daysSinceHire >= NEVER_VISITED_FLAG_DAYS,
        hireDate: employee.hireDate,
        hrId: employee.hrId,
        lastVisitDate: stats?.lastDate ?? null,
        lastVisitDateEver,
        lineName: employee.lineName,
        managerHrId: employee.managerHrId,
        managerName: employee.managerName,
        name: employee.displayName,
        onProbation: Boolean(probationEntry),
        probationDaysRemaining: probationEntry?.daysRemaining ?? null,
        probationDvDone: probationEntry?.dvDone ?? null,
        visitCount: stats?.count ?? 0,
        visited,
      } satisfies DoubleVisitRosterEntry;
    })
    .sort((a, b) => {
      // Alarms first: on-probation, then never-visited, then everyone else — then alphabetical.
      const weight = (entry: DoubleVisitRosterEntry) => (entry.onProbation ? 0 : !entry.visited ? 1 : 2);
      const diff = weight(a) - weight(b);
      return diff !== 0 ? diff : a.name.localeCompare(b.name);
    });
}

export async function getDoubleVisitReportData(input: {
  access: AccessContext;
  dateFrom?: string | null;
  dateTo?: string | null;
  /** DV Planner opt-in: also compute per-rep cadence (days since last DV over CADENCE_LOOKBACK_DAYS,
   * regardless of the selected window). Off by default so the Double Visit Report page + export keep
   * their exact current scan cost — only the planner widens the scan. */
  includeCadence?: boolean;
}): Promise<DoubleVisitReportData> {
  const today = todayIso();
  const dateFrom = input.dateFrom || addDaysIso(today, -90);
  const dateTo = input.dateTo || today;
  const includeCadence = input.includeCadence ?? false;
  // Cadence looks further back than the selected window so "days since last DV" is meaningful even
  // when the last visit predates the window. The scan widens to cover it; the in-window arrays are
  // then derived by filter-back (below) so existing consumers are byte-for-byte unchanged.
  const cadenceFloor = addDaysIso(today, -CADENCE_LOOKBACK_DAYS);
  const scanFrom = includeCadence && cadenceFloor < dateFrom ? cadenceFloor : dateFrom;

  if (!(await isDoubleVisitSchemaReady())) {
    return {
      asOfDate: today,
      dateFrom,
      dateTo,
      filters: { areas: [], doubleVisitorRoles: [], doubleVisitors: [], regions: [], visitKinds: [] },
      neverVisited: [],
      probation: [],
      roster: [],
      rows: [],
      schemaReady: false,
      startingSoon: [],
    };
  }

  // The scope options carry a Product Manager's second line (doctor-coverage line overrides), so the
  // report and the analytics board name the same people (owner, 2026-10-20).
  const [employees, scopeOptions] = await Promise.all([
    getEmployeeDirectoryRows({ includeInactive: true }),
    loadDoubleVisitScopeOptions(),
  ]);
  const scopedEmployees = filterEmployeesForDoubleVisitAccess(employees, input.access, scopeOptions);
  const hireDateByKey = new Map(
    employees
      .map((employee) => [canonicalHrIdKey(employee.hrId), employee.hireDate] as const)
      .filter((entry): entry is [string, string | null] => Boolean(entry[0])),
  );
  const employeeByHrKey = new Map(
    employees
      .map((employee) => [canonicalHrIdKey(employee.hrId), employee] as const)
      .filter((entry): entry is [string, EmployeeDirectoryRow] => Boolean(entry[0])),
  );
  // The DV feed carries no region field — resolve it from the employee directory's own
  // area→region pairing (every employee row already has both), keyed by normalized area name.
  const regionByAreaKey = new Map<string, string>();
  for (const employee of employees) {
    const areaKey = employee.areaName?.trim().toLowerCase();
    if (areaKey && employee.regionName && !regionByAreaKey.has(areaKey)) {
      regionByAreaKey.set(areaKey, employee.regionName);
    }
  }
  // Built from the FULL directory: an exclusion derived from the scope stops excluding exactly the
  // managers the downward rule takes out of scope (see buildScopedDoubleVisitDashboardCore).
  const managerHrIdKeys = new Set(
    employees
      .filter((employee) => resolveDvRole(employee) !== null)
      .map((employee) => canonicalHrIdKey(employee.hrId))
      .filter((key): key is string => Boolean(key)),
  );

  // One scan over [scanFrom, dateTo] (wider than the window only when includeCadence). scopedRowsWide
  // carries the full lookback for cadence; scopedRows is the strict in-window set every existing
  // consumer already reads — derived by filter-back so its contents are identical to before (chain
  // resolution is same-day, access scope is date-independent). NEVER widen scopedRows in place: it
  // feeds probationDvCountByKey, neverVisited, visitCount and the in-window history.
  const rawRows = await getLiveDoubleVisitRows(scanFrom, dateTo, employees);
  const scopedRowsWide = filterRowsForAccess(rawRows, input.access, employees, scopeOptions).filter((row) => {
    if (!row.visited_employee_hr_id) return true;
    return !managerHrIdKeys.has(canonicalHrIdKey(row.visited_employee_hr_id) ?? "");
  });
  const scopedRows =
    includeCadence && scanFrom !== dateFrom
      ? scopedRowsWide.filter((row) => row.activity_date >= dateFrom && row.activity_date <= dateTo)
      : scopedRowsWide;

  // Cadence: most recent DV per rep across the FULL lookback (from scopedRowsWide), days measured
  // from TODAY (not dateTo — see daysSinceHire which deliberately uses dateTo for report recency).
  const cadenceLastVisitByKey = new Map<string, string>();
  if (includeCadence) {
    for (const row of scopedRowsWide) {
      const key = canonicalHrIdKey(row.visited_employee_hr_id);
      if (!key) continue;
      const existing = cadenceLastVisitByKey.get(key);
      if (!existing || row.activity_date > existing) cadenceLastVisitByKey.set(key, row.activity_date);
    }
  }

  // 🔴 THE TIER IS DECIDED HERE, where the reader is known, and NOT in the loader — the same rows feed
  // the scoring engine and the private calendar, which print no column and so need no viewer. A row the
  // reader is himself the rep of reads `none` (phoenixRowSight), which is the owner's 2026-10-02 rule.
  const detailViewer = phoenixDetailViewer(input.access.role, input.access.hrId);

  const rows: DoubleVisitReportRow[] = scopedRows
    .map((row) => {
      const visitedKey = canonicalHrIdKey(row.visited_employee_hr_id);
      const visitedHireDate = visitedKey ? hireDateByKey.get(visitedKey) ?? null : null;
      const doubleVisitorKey = canonicalHrIdKey(row.double_visitor_hr_id);
      const doubleVisitorEmployee = doubleVisitorKey ? employeeByHrKey.get(doubleVisitorKey) ?? null : null;
      const doubleVisitor2Key = canonicalHrIdKey(row.double_visitor2_hr_id ?? null);
      const doubleVisitor2Employee = doubleVisitor2Key ? employeeByHrKey.get(doubleVisitor2Key) ?? null : null;
      const hasSecond = Boolean(row.double_visitor2_hr_id || row.double_visitor2_name);
      const areaName = nullableText(row.area_name);
      const areaKey = areaName?.trim().toLowerCase();
      return {
        activityDate: row.activity_date,
        areaName,
        countBucket: doubleVisitCountBucket(row),
        daysSinceVisitedHire: daysBetween(visitedHireDate, dateTo),
        ...(row.from_phoenix ? { fromPhoenix: true } : {}),
        doubleVisitorHrId: nullableText(row.double_visitor_hr_id),
        doubleVisitorName: nullableText(row.double_visitor_name),
        doubleVisitor2Name: nullableText(row.double_visitor2_name ?? null),
        ...(hasSecond
          ? {
              doubleVisitor2HrId: nullableText(row.double_visitor2_hr_id ?? null),
              doubleVisitor2Role: resolveDvRole(doubleVisitor2Employee)?.role ?? null,
            }
          : {}),
        doubleVisitorRole: resolveDvRole(doubleVisitorEmployee)?.role ?? null,
        phoenix: row.phoenix_detail
          ? phoenixVisitDetail(row.phoenix_detail, phoenixRowSight(detailViewer, row.visited_employee_hr_id))
          : null,
        phoenixColumns: row.phoenix_detail
          ? phoenixVisitDetailColumns(row.phoenix_detail, phoenixRowSight(detailViewer, row.visited_employee_hr_id))
          : null,
        lineName: nullableText(row.line_name),
        period: row.period,
        regionName: areaKey ? regionByAreaKey.get(areaKey) ?? null : null,
        visitCount: asNumber(row.visit_count),
        visitedEmployeeHireDate: visitedHireDate,
        visitedHrId: nullableText(row.visited_employee_hr_id),
        visitedName: nullableText(row.visited_employee_name),
        visitedStatus: row.visited_employee_status as DoubleVisitVisitedEmployeeStatus,
        visitKind: deriveVisitKind(row),
      } satisfies DoubleVisitReportRow;
    })
    .sort((a, b) => b.activityDate.localeCompare(a.activityDate));

  const visitedKeysInRange = new Set(
    rows.map((row) => (row.visitedHrId ? canonicalHrIdKey(row.visitedHrId) : null)).filter((key): key is string => Boolean(key)),
  );
  const activeMedicalRepsInScope = scopedEmployees.filter((employee) => isActiveEmployee(employee) && isMedicalRep(employee));
  const neverVisited: DoubleVisitFocusRosterEntry[] = activeMedicalRepsInScope
    .filter((employee) => repHasStarted(employee.hireDate, today))
    .filter((employee) => {
      const key = canonicalHrIdKey(employee.hrId);
      return key ? !visitedKeysInRange.has(key) : true;
    })
    .map((employee) => {
      const daysSinceHire = daysBetween(employee.hireDate, dateTo);
      return {
        areaName: employee.areaName,
        daysSinceHire,
        flagged: daysSinceHire != null && daysSinceHire >= NEVER_VISITED_FLAG_DAYS,
        hireDate: employee.hireDate,
        hrId: employee.hrId,
        name: employee.displayName,
        visited: false,
      } satisfies DoubleVisitFocusRosterEntry;
    })
    .sort((a, b) => (b.daysSinceHire ?? -1) - (a.daysSinceHire ?? -1));

  const probation = await buildDvPlannerProbationEntries({ access: input.access, employees, scopedRows, today });
  // Reps hired for a date after today: named in a note on the planner, counted nowhere.
  const startingSoon: DoubleVisitStartingSoonEntry[] = activeMedicalRepsInScope
    .filter((employee) => !repHasStarted(employee.hireDate, today))
    .map((employee) => ({ areaName: employee.areaName, hireDate: employee.hireDate ?? "", name: employee.displayName }))
    .sort((a, b) => a.hireDate.localeCompare(b.hireDate) || a.name.localeCompare(b.name));

  // DV Planner roster: every active Medical Rep in scope, one row each. Built by the shared,
  // exported buildDvPlannerRosterEntries so the weekly digest (Wave 2) computes an identical roster
  // for any manager scope. Cadence lastVisit comes from the wide lookback (cadenceLastVisitByKey);
  // in-window count/visited come from `rows`.
  const roster = buildDvPlannerRosterEntries({
    activeMedicalReps: activeMedicalRepsInScope,
    inWindowRows: rows,
    cadenceLastVisitByKey,
    probation,
    dateTo,
    today,
  });

  const areas = Array.from(new Set(rows.map((row) => row.areaName).filter((value): value is string => Boolean(value)))).sort();
  const regions = Array.from(new Set(rows.map((row) => row.regionName).filter((value): value is string => Boolean(value)))).sort();
  // Both managers of a chain visit are in the pickers: either one filters to it (report-filters.ts).
  const doubleVisitors = Array.from(
    new Set(
      rows
        .flatMap((row) => [row.doubleVisitorName ?? row.doubleVisitorHrId, row.doubleVisitor2Name ?? row.doubleVisitor2HrId])
        .filter((value): value is string => Boolean(value)),
    ),
  ).sort();
  const doubleVisitorRoles = Array.from(
    new Set(rows.flatMap((row) => [row.doubleVisitorRole, row.doubleVisitor2Role]).filter((value): value is string => Boolean(value))),
  ).sort();
  const visitKinds = Array.from(new Set(rows.map((row) => row.visitKind))).sort();

  return {
    asOfDate: today,
    dateFrom,
    dateTo,
    filters: { areas, doubleVisitorRoles, doubleVisitors, regions, visitKinds },
    neverVisited,
    probation,
    roster,
    rows,
    schemaReady: true,
    startingSoon,
  };
}

function joinedDistinct(values: Array<string | null | undefined>, fallback: string) {
  const distinct = Array.from(new Set(values.map(nullableText).filter((value): value is string => Boolean(value))));
  return distinct.length > 0 ? distinct.join(", ") : fallback;
}

function calendarItemId(prefix: string, employeeHrId: string, date: string) {
  return `${prefix}-${normalizedHrKey(employeeHrId) ?? employeeHrId}-${date}`;
}

function privateCalendarItem(input: {
  activityKind: PrivateCalendarVisitKind;
  chipLines: string[];
  date: string;
  detailLines: string[];
  employeeHrId: string;
  employeeName: string | null;
  id: string;
  status: string;
  time: string;
  tileAreas: string[];
  tileWith: string[];
  tileWithPeople: NonNullable<PrivateCalendarItem["tileWithPeople"]>;
  title: string;
  visitCounts: PrivateCalendarItem["visitCounts"];
  visitRecords: PrivateCalendarItem["visitRecords"];
}): PrivateCalendarItem {
  return {
    activityKind: input.activityKind,
    // No "read-only context" boilerplate and no description (owner, 2026-10-29: the day details said everything twice):
    // the card is the kind, who with, the counts and the area, each once.
    approvalImpact: null,
    chipLines: input.chipLines,
    description: null,
    detailLines: input.detailLines,
    employeeDepartmentName: null,
    employeeHrId: input.employeeHrId,
    employeeJobTitle: null,
    employeeLineName: null,
    employeeName: input.employeeName,
    endDate: input.date,
    exceptionFlags: [],
    id: input.id,
    managerName: null,
    severity: "success",
    source: "double_visit",
    // The read door, not the raw mirror: from a started team's start these rows are its Phoenix CRM
    // double visits, so naming iReports360 on the evidence card told the reader the wrong system.
    sourceLabel: "Double visits through the CRM read door",
    sourceRecordId: input.id,
    sourceSystem: "Double Visit Analytics",
    sourceTable: CRM_VISITS_UNIFIED_VIEW,
    startDate: input.date,
    status: input.status,
    tileAreas: input.tileAreas,
    tileWith: input.tileWith,
    tileWithPeople: input.tileWithPeople,
    time: input.time,
    title: input.title,
    visitCounts: input.visitCounts,
    visitRecords: input.visitRecords,
  };
}

type ClassifiedCalendarRow = ClassifiedDoubleVisitRow<DoubleVisitDbRow>;

function groupCalendarRows(rows: ClassifiedCalendarRow[], keyFn: (entry: ClassifiedCalendarRow) => string | null) {
  const groups = new Map<string, ClassifiedCalendarRow[]>();
  for (const entry of rows) {
    const key = keyFn(entry);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return groups;
}

function calendarVisitKind(entry: ClassifiedCalendarRow): PrivateCalendarVisitKind {
  return privateCalendarVisitKind(entry.companion);
}

// One double or chain calendar item: the kind (who went — Phoenix's "Double visit" / "Chain visit", never the vendor's
// regular/campaign), who went with the calendar owner, and the visits AM · PM · Pharmacies apart — never a pharmacy
// inside PM. Owner, 2026-10-29: each fact ONCE on the card — the kind is its chip, "With <name>" its title, the counts
// its time, the area its one detail row. No "Line" row: the mirror's line name ("Pedia") is not a Phoenix line name.
function doubleVisitCalendarItem(group: ClassifiedCalendarRow[], side: "performed" | "received") {
  const first = group[0];
  const ownerHrId = side === "performed" ? first.row.double_visitor_hr_id : first.row.visited_employee_hr_id;
  if (!ownerHrId) return null;
  const kind = calendarVisitKind(first);
  const kindLabel = privateCalendarActivityKindLabels[kind];
  const split = emptyVisitCountSplit();
  for (const entry of group) addBucketToSplit(split, entry.bucket, 1, entry.row.from_phoenix === true);
  const companionPeople = group.flatMap((entry) => doubleVisitCompanionPeople(entry, side));
  const companions = companionPeople.map((person) => person.name);
  const withNames = joinedDistinct(companions, "Unmapped or vacant");
  const areaLabel = joinedDistinct(group.map((entry) => entry.row.area_name), "Unmapped");
  // Resolved to a resigned employee -> dbRowFromMirrorVisit already substituted the raw
  // CRM name/area for display, but that identity has not been matched to a current
  // Phoenix employee record (their replacement may not even be onboarded yet) — say so
  // plainly rather than silently presenting an unverified name as confirmed.
  const identityUnverified = side === "performed" && group.some((entry) => entry.row.visited_employee_status === "resigned");
  // The tile's own words, so the day card and its tile never print one day two ways ("AM 0 · PM 8 · PH 3").
  const counts = privateCalendarTileCountsText(split);
  return privateCalendarItem({
    activityKind: kind,
    chipLines: [
      `${kindLabel} with ${withNames}`,
      counts,
      areaLabel,
      ...(identityUnverified ? ["Name from CRM, unmatched to an employee record"] : []),
    ],
    date: first.row.activity_date,
    detailLines: [
      `Area: ${areaLabel}`,
      ...(identityUnverified
        ? ["Note: this name/area comes straight from the CRM sync — it could not be matched to a current Phoenix employee record (the CRM account may have been reassigned to a new hire)."]
        : []),
    ],
    employeeHrId: ownerHrId,
    employeeName: side === "performed" ? first.row.double_visitor_name : first.row.visited_employee_name,
    id: calendarItemId(`double-visit-${side}-${kind}`, ownerHrId, first.row.activity_date),
    status: side,
    // The day tile's own lists (private-calendar/day-tile.ts): real names and areas only, never the "Unmapped" words.
    tileAreas: group.map((entry) => nullableText(entry.row.area_name)).filter((value): value is string => Boolean(value)),
    tileWith: companions.map(nullableText).filter((value): value is string => Boolean(value)),
    tileWithPeople: companionPeople.flatMap((person) => {
      const name = nullableText(person.name);
      return name ? [{ hrId: nullableText(person.hrId), name }] : [];
    }),
    time: counts,
    title: `With ${withNames}`,
    visitCounts: split,
    visitRecords: group.map((entry) => ({
      bucket: entry.bucket,
      id: entry.physicalId,
      ...(entry.row.from_phoenix ? { phoenix: true } : {}),
    })),
  });
}

/** A district manager's team fits in one read; a wider calendar scope reads the whole window. */
export const DOUBLE_VISIT_DAYS_MAX_PEOPLE = 8;
/** One month of days — inside the 50-value house limit for one `in` list. */
export const DOUBLE_VISIT_DAYS_MAX_LISTED = 31;

export type DoubleVisitDayReaders = {
  /** The admin identity overrides ({@link getCrmIdentityResolutions}). */
  resolutions: () => Promise<readonly CrmResolutionRow[]>;
  /** The day of every double visit in the window with one of these people, or accounts, on it. */
  days: (filter: {
    dateFrom: string;
    dateTo: string;
    participantCrmIds?: readonly number[];
    participantHrIds?: readonly string[];
  }) => Promise<string[]>;
};

const DOOR_DAY_READERS: DoubleVisitDayReaders = {
  resolutions: getCrmIdentityResolutions,
  // The same door, double-visit definition and resigned-agent opt-out as the calendar's own read.
  days: async (filter) =>
    (
      await getDoubleVisitRows<{ visit_date: string }>({
        ...filter,
        columns: "visit_date",
        includeResignedAgents: true,
        visitTypes: [...DOUBLE_VISIT_TYPE_CODES],
      })
    ).map((row) => row.visit_date),
};

/** The CRM accounts an admin identity override credits to one of these people (`selected` holds
 * their normalized keys) — the accounts whose visits name someone else's hr id. Pure, exported for
 * its unit test. */
export function crmIdsOverriddenTo(selected: ReadonlySet<string>, resolutions: readonly CrmResolutionRow[]): number[] {
  const ids = resolutions
    .filter((row) => row.status === "mapped" && row.mappedHrId && selected.has(normalizedHrKey(row.mappedHrId) ?? ""))
    .map((row) => Number(row.crmId))
    .filter((id) => Number.isFinite(id));
  return Array.from(new Set(ids)).sort((left, right) => left - right);
}

/**
 * The days of the window the private calendar's double visits must read for these people, and the
 * override snapshot that decided them — or `null`, meaning read the whole window.
 *
 * 🔴 WHY THIS EXISTS (2026-10-01, "speed up the rep's Private Calendar page"). The calendar read the
 * WHOLE company's month of double visits and kept the rep's own: 2,220 September rows for a rep on 5
 * of its 24 days, and 0.7 s of a 0.7 s page (measured on production the same morning).
 *
 * WHY WHOLE DAYS ARE ENOUGH. Every step after the read works inside one day: the duplicate collapse
 * keys on the day, a chain visit is resolved from its day's rows (resolveDoubleVisitChains), its two
 * halves are paired by day (classifyDoubleVisitRows), and items are one per person, day and kind. So
 * a day read whole gives every row on it the same answer the month read gives, in the same id order.
 * A day reaches these people's calendars only through a row naming one of them — as the visited
 * rep, the double-visitor, the rep a chain resolves to (always the agent of a row that same day), or
 * the person an admin override credits the submitting CRM account to. The read below finds every
 * such day; any other day can only hold other people's visits.
 *
 * BOUNDED. More than {@link DOUBLE_VISIT_DAYS_MAX_PEOPLE} people, or more days than one `in` list
 * should carry, reads the whole window as before. A lookup that fails does too — slower, never wrong.
 */
export async function findDoubleVisitCalendarDays(
  employeeHrIds: readonly string[],
  window: { end: string; start: string },
  readers: DoubleVisitDayReaders = DOOR_DAY_READERS,
): Promise<{ days: string[]; resolutions: readonly CrmResolutionRow[] } | null> {
  try {
    return await findDoubleVisitDays(
      employeeHrIds,
      window,
      { maxDays: DOUBLE_VISIT_DAYS_MAX_LISTED, maxPeople: DOUBLE_VISIT_DAYS_MAX_PEOPLE },
      readers,
    );
  } catch (error) {
    logWarning("Private calendar could not find its double-visit days; reading the whole window", {
      labels: { event: "private_calendar_double_visit_days_failed" },
      error,
    });
    return null;
  }
}

/** The portal focus panel's people: its viewer and the probationers it shows a count for. Each hr id
 * travels in up to five spellings (`hrIdLookupKeys`), so nine keep the lookup's `in` lists at 45
 * values, inside the 50-value house limit. */
export const DOUBLE_VISIT_FOCUS_MAX_PEOPLE = 1 + FOCUS_PROBATION_DISPLAY_LIMIT;

/**
 * The days of the window the portal focus panel must read for its viewer and the probationers it
 * shows (see getDoubleVisitPortalFocus), and the override snapshot that decided them — or `null`,
 * meaning read the whole window. The calendar's lookup with no cap on days: the read takes any number
 * of them a week per request (readListedDayRuns). A lookup that fails reads the whole window.
 */
export async function findDoubleVisitFocusDays(
  employeeHrIds: readonly string[],
  window: { end: string; start: string },
  readers: DoubleVisitDayReaders = DOOR_DAY_READERS,
): Promise<{ days: string[]; resolutions: readonly CrmResolutionRow[] } | null> {
  try {
    return await findDoubleVisitDays(
      employeeHrIds,
      window,
      { maxDays: Number.POSITIVE_INFINITY, maxPeople: DOUBLE_VISIT_FOCUS_MAX_PEOPLE },
      readers,
    );
  } catch (error) {
    logWarning("Portal double-visit focus could not find its days; reading the whole window", {
      labels: { event: "portal_focus_double_visit_days_failed" },
      error,
    });
    return null;
  }
}

/** The lookup both wrappers above share (the reasoning is on findDoubleVisitCalendarDays). `null`
 * past either limit, before anything is read; a failed read throws to the wrapper. */
async function findDoubleVisitDays(
  employeeHrIds: readonly string[],
  window: { end: string; start: string },
  limits: { maxDays: number; maxPeople: number },
  readers: DoubleVisitDayReaders,
): Promise<{ days: string[]; resolutions: readonly CrmResolutionRow[] } | null> {
  const hrIds = Array.from(new Set(employeeHrIds.map((hrId) => String(hrId ?? "").trim()).filter(Boolean)));
  const selected = new Set(hrIds.map(normalizedHrKey).filter((key): key is string => Boolean(key)));
  if (selected.size === 0 || hrIds.length > limits.maxPeople) return null;
  const [resolutions, hrDays] = await Promise.all([
    readers.resolutions(),
    readers.days({ dateFrom: window.start, dateTo: window.end, participantHrIds: hrIds }),
  ]);
  const overridden = crmIdsOverriddenTo(selected, resolutions);
  const crmDays =
    overridden.length > 0
      ? await readers.days({ dateFrom: window.start, dateTo: window.end, participantCrmIds: overridden })
      : [];
  const days = Array.from(new Set([...hrDays, ...crmDays])).sort();
  if (days.length > limits.maxDays) return null;
  return { days, resolutions };
}

export async function loadDoubleVisitPrivateCalendarItems(employeeHrIds: string[], start: string, end: string) {
  try {
    const selected = new Set(employeeHrIds.map(normalizedHrKey).filter((value): value is string => Boolean(value)));
    if (selected.size === 0) return { items: [] as PrivateCalendarItem[], ready: true };
    const [employees, calendarDays] = await Promise.all([
      getEmployeeDirectoryRows({ includeInactive: true }),
      findDoubleVisitCalendarDays(employeeHrIds, { end, start }),
    ]);
    // A double visit is real, positive proof the calendar owner did field work that day —
    // that stays true even when the visited party's resolved identity is a resigned
    // employee (dbRowFromMirrorVisit already swaps in the raw CRM name/area for display
    // in that case, since the resolution is frequently just a stale, reused CRM account —
    // see memory crm-resigned-slot-reused-for-new-hire). Never silently hide a real visit.
    const rows = await getLiveDoubleVisitRows(start, end, employees, {
      includeResignedAgents: true,
      ...(calendarDays ? { crmIdentityResolutions: calendarDays.resolutions, visitDates: calendarDays.days } : {}),
    });
    return { items: doubleVisitPrivateCalendarItemsFromRows(rows, selected), ready: true };
  } catch (error) {
    if (schemaMissing(error)) return { items: [] as PrivateCalendarItem[], ready: false };
    throw error;
  }
}

/** One calendar's double and chain visit items, from the window's attributed rows. `selected` holds
 * the calendar people's normalized keys. Pure, exported for its unit test. */
export function doubleVisitPrivateCalendarItemsFromRows(rows: DoubleVisitDbRow[], selected: ReadonlySet<string>): PrivateCalendarItem[] {
  // Pairs a chain visit's two CRM halves (see classifyDoubleVisitRows), so a chain stop is ONE
  // chain visit on every calendar it touches and never a double visit counted twice.
  const classified = classifyDoubleVisitRows(rows);
  const items: PrivateCalendarItem[] = [];

  // Performed: one entry per (visit, manager), so a chain visit's second manager has it on his calendar
  // exactly as the first does — the other manager named beside the rep, as on a vendor chain.
  const performedEntries = classified.flatMap((entry) =>
    doubleVisitorViews(entry.row).map((view, index) =>
      index === 0
        ? entry
        : { ...entry, row: view, seniorName: view.double_visitor2_name ?? null, seniorHrId: view.double_visitor2_hr_id ?? null },
    ),
  );
  const performed = groupCalendarRows(
    performedEntries.filter((entry) => selected.has(normalizedHrKey(entry.row.double_visitor_hr_id) ?? "")),
    (entry) => {
      const key = normalizedHrKey(entry.row.double_visitor_hr_id);
      return key ? `${key}|${entry.row.activity_date}|${calendarVisitKind(entry)}` : null;
    },
  );
  for (const group of performed.values()) {
    const item = doubleVisitCalendarItem(group, "performed");
    if (item) items.push(item);
  }

  // A senior manager's half folded into the rep's row is the same stop — the rep's own row
  // already carries it as a chain visit, so it never reaches the rep's calendar a second time.
  const received = groupCalendarRows(
    classified.filter((entry) => !entry.absorbed && selected.has(normalizedHrKey(entry.row.visited_employee_hr_id) ?? "")),
    (entry) => {
      const key = normalizedHrKey(entry.row.visited_employee_hr_id);
      return key ? `${key}|${entry.row.activity_date}|${calendarVisitKind(entry)}` : null;
    },
  );
  for (const group of received.values()) {
    const item = doubleVisitCalendarItem(group, "received");
    if (item) items.push(item);
  }

  return items;
}

export async function getDoubleVisitExpenseWorkloadEvidence(input: {
  employeeHrId: string | null | undefined;
  tripEndDate: string;
  tripStartDate: string;
}): Promise<DoubleVisitExpenseWorkloadEvidence> {
  const employeeKey = normalizeHrIdForAccess(input.employeeHrId);
  const start = input.tripStartDate.slice(0, 10);
  const end = input.tripEndDate.slice(0, 10);
  const dates = eachDate(start, end);
  if (!employeeKey) {
    return {
      amWorkload: 0,
      dateBreakdown: dates.map((date) => ({ am: 0, date, evidenceRows: 0, pharmacies: 0, pm: 0, total: 0 })),
      importId: null,
      matchedDates: [],
      matchStatus: "no_activity",
      missingDates: dates,
      pharmacyWorkload: 0,
      pmWorkload: 0,
      campaignVisits: 0,
      regularVisits: 0,
      source: "manual",
      sourceLabel: "No employee HR ID available for Double Visit evidence matching.",
    };
  }

  const employees = await getEmployeeDirectoryRows({ includeInactive: true });
  const rows = await getLiveDoubleVisitRows(start, end, employees);
  // Slot 1 only, deliberately: this is outstation TRIP evidence, which money is decided on, and the
  // 2026-10-08 chain-visit ruling was not extended to it. Widening it is the owner's decision.
  const ownRows = rows.filter((row) => normalizeHrIdForAccess(row.double_visitor_hr_id) === employeeKey);
  const dateBreakdown = dates.map((date) => {
    const dayRows = ownRows.filter((row) => row.activity_date === date);
    // THE AM · PM · PHARMACIES GOLDEN RULE: a pharmacy leaves AM/PM for its own figure. `total`
    // still counts every row — a periodless one included, as before — because a pharmacy visit is
    // field work (owner, 2026-09-21) and `total` decides a matched day.
    const split = sumDoubleVisitSplit(dayRows, doubleVisitCountBucket, (row) => asNumber(row.visit_count));
    return {
      am: split.am,
      date,
      evidenceRows: dayRows.length,
      pharmacies: split.pharmacies,
      pm: split.pm,
      total: dayRows.reduce((sum, row) => sum + asNumber(row.visit_count), 0),
    };
  });
  const matchedDates = dateBreakdown.filter((row) => row.total > 0).map((row) => row.date);
  const missingDates = dates.filter((date) => !matchedDates.includes(date));
  const matchStatus = matchedDates.length === 0
    ? "no_activity"
    : missingDates.length > 0
      ? "partial"
      : "matched";
  const campaignVisits = ownRows
    .filter((row) => deriveVisitKind(row) !== "Regular")
    .reduce((sum, row) => sum + asNumber(row.visit_count), 0);
  const regularVisits = ownRows
    .filter((row) => deriveVisitKind(row) === "Regular")
    .reduce((sum, row) => sum + asNumber(row.visit_count), 0);
  return {
    amWorkload: dateBreakdown.reduce((sum, row) => sum + row.am, 0),
    dateBreakdown,
    importId: null,
    matchedDates,
    matchStatus,
    missingDates,
    pharmacyWorkload: dateBreakdown.reduce((sum, row) => sum + row.pharmacies, 0),
    pmWorkload: dateBreakdown.reduce((sum, row) => sum + row.pm, 0),
    campaignVisits,
    regularVisits,
    source: "double_visit_import",
    sourceLabel: "Live iReports360 Visits Report (double-visit mirror).",
  };
}

/** A row of figures as the golden-rule split, with its Phoenix CRM share when it has one. */
function splitOfFigures(am: number, pm: number, pharmacies: number, phoenix: number | undefined): VisitCountSplit {
  return { am, pm, pharmacies, ...(phoenix ? { phoenix } : {}) };
}

/**
 * The "Pharmacy Visits" column of a sheet whose rows were added from `splits`, in order: a row whose
 * double visits were all Phoenix CRM's is BLANK, never 0, and every cell that is not the whole count
 * carries the words in its note (src/lib/crm/visit-count-buckets.ts). Values otherwise untouched.
 */
function notePharmacyCells(sheet: ExcelJS.Worksheet, splits: readonly VisitCountSplit[]) {
  const column = sheet.getColumn("pharmacyVisits").number;
  splits.forEach((split, index) => {
    const note = pharmacyCellNote(split);
    if (!note) return;
    const cell = sheet.getRow(index + 2).getCell(column);
    cell.value = pharmacyCellValue(split);
    cell.note = note;
  });
}

export async function buildDoubleVisitExportWorkbook(data: DoubleVisitDashboardData) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  workbook.created = new Date();

  const summary = workbook.addWorksheet("Executive Summary");
  summary.columns = [
    { header: "Metric", key: "metric", width: 34 },
    { header: "Value", key: "value", width: 24 },
  ];
  summary.addRows([
    { metric: "Date From", value: data.dateFrom },
    { metric: "Date To", value: data.dateTo },
    { metric: "Data Source", value: "Live iReports360 Visits Report (auto-synced)" },
    { metric: "Double Visits", value: data.kpis.totalVisits },
    { metric: "Active Double Visit Days", value: data.kpis.activeDoubleVisitDays },
    { metric: "AM Activity", value: data.kpis.amVisitCount },
    { metric: "PM Activity", value: data.kpis.pmVisitCount },
    { metric: "Pharmacy Activity", value: data.kpis.pharmacyVisitCount },
    { metric: "Average Visits per DV Day", value: data.kpis.averageVisitsPerDoubleVisitDay },
    { metric: "Resigned / Vacant Territory Share", value: `${data.kpis.vacantOrUnmappedShare}%` },
    { metric: "Neglected MRs", value: data.neglectedMrs.length },
  ]);

  const mrSheet = workbook.addWorksheet("MR Support Score");
  mrSheet.columns = [
    { header: "MR", key: "mrName", width: 28 },
    { header: "HR ID", key: "hrId", width: 14 },
    { header: "Hire Date", key: "hireDate", width: 14 },
    { header: "Area", key: "areaName", width: 20 },
    { header: "Line", key: "lineName", width: 12 },
    { header: "Manager", key: "managerName", width: 28 },
    { header: "Last DV", key: "lastDvDate", width: 14 },
    { header: "Days Since Last DV", key: "daysSinceLastDv", width: 18 },
    { header: "DVs Last 90 Days", key: "dvsLast90Days", width: 18 },
    { header: "DVs Prev 90 Days", key: "dvsPrev90Days", width: 18 },
    { header: "Trend", key: "trendDirection", width: 12 },
    { header: "Distinct Visitors", key: "distinctDoubleVisitors", width: 18 },
    { header: "Band", key: "band", width: 12 },
  ];
  mrSheet.addRows(data.mrScores);

  const managers = workbook.addWorksheet("Executive Coverage");
  managers.columns = [
    { header: "Manager", key: "managerName", width: 28 },
    { header: "HR ID", key: "managerHrId", width: 14 },
    { header: "Area", key: "areaName", width: 20 },
    { header: "Line", key: "lineName", width: 12 },
    { header: "Expected MRs", key: "expectedMrCount", width: 14 },
    { header: "Touched MRs", key: "touchedMrCount", width: 14 },
    { header: "Neglected MRs", key: "neglectedMrCount", width: 15 },
    { header: "Over-Focused MRs", key: "overFocusedMrCount", width: 18 },
    { header: "Concentration Ratio", key: "concentrationRatio", width: 20 },
    { header: "Total DVs", key: "totalDvs", width: 12 },
  ];
  managers.addRows(data.executiveReports);

  const activity = workbook.addWorksheet("Manager Activity");
  activity.columns = [
    { header: "Manager", key: "managerName", width: 28 },
    { header: "HR ID", key: "managerHrId", width: 14 },
    { header: "Role", key: "roleCode", width: 10 },
    { header: "Title", key: "role", width: 26 },
    { header: "Area", key: "areaName", width: 20 },
    { header: "Line", key: "lineName", width: 12 },
    { header: "Total DVs", key: "totalDvs", width: 12 },
    { header: "Active DV Days", key: "activeDvDays", width: 16 },
    { header: "Calls / Day", key: "callsPerActiveDay", width: 12 },
    { header: "AM Visits", key: "amVisits", width: 12 },
    { header: "PM Visits", key: "pmVisits", width: 12 },
    { header: "Pharmacy Visits", key: "pharmacyVisits", width: 16 },
    { header: "MRs Visited", key: "distinctMrs", width: 14 },
    { header: "Team Size", key: "teamMrCount", width: 12 },
    { header: "Coverage %", key: "coveragePct", width: 12 },
    { header: "Neglected MRs", key: "neglectedMrCount", width: 15 },
    { header: "Concentration %", key: "concentrationPct", width: 16 },
    { header: "Effectiveness", key: "effectivenessScore", width: 14 },
    { header: "Over-Focused MRs", key: "overFocusedMrCount", width: 18 },
    { header: "First DV", key: "firstDvDate", width: 14 },
    { header: "Last DV", key: "lastDvDate", width: 14 },
    { header: "Days Since Last DV", key: "daysSinceLastDv", width: 18 },
  ];
  activity.addRows(data.managerSummaries);

  const byRole = workbook.addWorksheet("By Role");
  byRole.columns = [
    { header: "Role", key: "roleCode", width: 10 },
    { header: "Role Name", key: "roleLabel", width: 26 },
    { header: "Managers", key: "activeManagerCount", width: 12 },
    { header: "Total DVs", key: "totalDvs", width: 12 },
    { header: "Active DV Days", key: "totalActiveDvDays", width: 16 },
    { header: "Avg Calls / Day", key: "avgCallsPerDay", width: 16 },
    { header: "Avg Coverage %", key: "avgCoveragePct", width: 16 },
    { header: "AM Visits", key: "amVisits", width: 12 },
    { header: "PM Visits", key: "pmVisits", width: 12 },
    { header: "Pharmacy Visits", key: "pharmacyVisits", width: 16 },
    { header: "MRs Covered", key: "distinctMrs", width: 14 },
    { header: "Neglected MRs", key: "neglectedMrCount", width: 15 },
  ];
  byRole.addRows(data.executiveSummary.roleRollups);

  const insights = workbook.addWorksheet("Insights");
  insights.columns = [
    { header: "Severity", key: "severity", width: 12 },
    { header: "Category", key: "category", width: 16 },
    { header: "Finding", key: "title", width: 40 },
    { header: "Detail", key: "detail", width: 64 },
    { header: "Manager HR ID", key: "managerHrId", width: 16 },
    { header: "MR HR ID", key: "mrHrId", width: 14 },
  ];
  insights.addRows(data.executiveSummary.insights);

  const trend = workbook.addWorksheet("Weekly Trend");
  trend.columns = [
    { header: "Week Start", key: "weekStart", width: 14 },
    { header: "Total DVs", key: "totalDvs", width: 12 },
    { header: "AM Visits", key: "amVisits", width: 12 },
    { header: "PM Visits", key: "pmVisits", width: 12 },
    { header: "Pharmacy Visits", key: "pharmacyVisits", width: 16 },
    { header: "MRs Covered", key: "distinctMrs", width: 14 },
  ];
  trend.addRows(data.trend);

  const pairs = workbook.addWorksheet("Manager × MR Pairs");
  pairs.columns = [
    { header: "Manager", key: "managerName", width: 26 },
    { header: "Manager HR ID", key: "managerHrId", width: 16 },
    { header: "MR", key: "mrName", width: 26 },
    { header: "MR HR ID", key: "mrHrId", width: 14 },
    { header: "Area", key: "area", width: 18 },
    { header: "Visits", key: "visits", width: 10 },
    { header: "Distinct Days", key: "days", width: 14 },
    { header: "Visits / Day", key: "visitsPerDay", width: 14 },
    { header: "First Visit", key: "firstDate", width: 14 },
    { header: "Last Visit", key: "lastDate", width: 14 },
  ];
  pairs.addRows(buildManagerMrPairs(data.visitLog));

  // A double visit logged in Phoenix CRM, which records no pharmacy visit: the Pharmacy figure is said
  // in words on the summary and left BLANK, never 0, in a table — with the words in the cell's note.
  const kpiSplit = splitOfFigures(data.kpis.amVisitCount, data.kpis.pmVisitCount, data.kpis.pharmacyVisitCount, data.kpis.phoenixVisitCount);
  if (pharmacyRecordingOf(kpiSplit) !== "recorded") {
    summary.eachRow((row) => {
      if (row.getCell(1).value === "Pharmacy Activity") row.getCell(2).value = pharmacyValueText(kpiSplit);
    });
  }
  notePharmacyCells(activity, data.managerSummaries.map((row) => splitOfFigures(row.amVisits, row.pmVisits, row.pharmacyVisits, row.phoenixVisits)));
  notePharmacyCells(byRole, data.executiveSummary.roleRollups.map((row) => splitOfFigures(row.amVisits, row.pmVisits, row.pharmacyVisits, row.phoenixVisits)));
  notePharmacyCells(trend, data.trend.map((row) => splitOfFigures(row.amVisits, row.pmVisits, row.pharmacyVisits, row.phoenixVisits)));

  for (const sheet of workbook.worksheets) {
    sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    sheet.getRow(1).fill = { fgColor: { argb: "FF0F172A" }, pattern: "solid", type: "pattern" };
    sheet.views = [{ state: "frozen", ySplit: 1 }];
  }

  return workbook;
}

// ── Double Visit Report export (filterable log, "Never Visited", "Probation") ───
//
// Plain-style export matching buildDoubleVisitExportWorkbook above — no charts/KPI-tile
// design — so every export in this module looks and behaves the same way. `filtered` holds
// whatever rows survived the SAME filter functions (src/lib/double-visit-analytics/
// report-filters.ts) the on-screen workspace applies, so the file always matches the screen.
// The KPI list itself comes from buildReportSummaryMetrics (report-filters.ts), shared with
// the PDF builder, so the two export formats can never report different numbers.

export async function buildDoubleVisitReportExportWorkbook(
  data: DoubleVisitReportData,
  filtered: {
    logRows: DoubleVisitReportRow[];
    neverVisitedRows: DoubleVisitFocusRosterEntry[];
    probationRows: DoubleVisitFocusProbationEntry[];
  },
  activeFilters: Record<string, string>,
) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  workbook.created = new Date();

  const summary = workbook.addWorksheet("Executive Summary");
  summary.columns = [
    { header: "Metric", key: "metric", width: 34 },
    { header: "Value", key: "value", width: 40 },
  ];
  summary.addRows([
    { metric: "Date From", value: data.dateFrom },
    { metric: "Date To", value: data.dateTo },
    { metric: "Data Source", value: "Live iReports360 Visits Report (auto-synced)" },
    { metric: "Active Filters", value: formatActiveFilters(activeFilters) },
    ...buildReportSummaryMetrics(filtered),
  ]);

  // THE PHOENIX FIELD SET IS FLAT HERE, one column each. The fits-the-screen rule governs a viewport
  // and a sheet has none, so nothing is merged away and nothing is lost. The headers come off whichever
  // row carries them, because the set was already shaped to this reader's tier — a `distance` reader's
  // sheet simply has fewer columns than the Super Admin's, and never a column full of blanks.
  const phoenixHeaders = Object.keys(filtered.logRows.find((row) => row.phoenixColumns)?.phoenixColumns ?? {});

  const log = workbook.addWorksheet("Visit Log");
  log.columns = [
    { header: "Date", key: "date", width: 14 },
    { header: "Double Visitor", key: "doubleVisitor", width: 26 },
    { header: "And With", key: "doubleVisitor2", width: 26 },
    { header: "Job Title", key: "role", width: 22 },
    { header: "Visited MR", key: "visited", width: 26 },
    { header: "Area", key: "area", width: 18 },
    { header: "Region", key: "region", width: 18 },
    { header: "Line", key: "line", width: 14 },
    { header: "Period", key: "period", width: 10 },
    { header: "Type", key: "kind", width: 12 },
    { header: "Visits", key: "visits", width: 10 },
    ...phoenixHeaders.map((header) => ({ header, key: header, width: 22 })),
  ];
  log.addRows(
    filtered.logRows.map((row) => ({
      ...Object.fromEntries(phoenixHeaders.map((header) => [header, row.phoenixColumns?.[header] ?? ""])),
      area: row.areaName ?? "—",
      date: row.activityDate,
      doubleVisitor: row.doubleVisitorName ?? row.doubleVisitorHrId ?? "—",
      doubleVisitor2: row.doubleVisitor2Name ?? "",
      kind: row.visitKind,
      line: row.lineName ?? "—",
      period: entryPeriodLabel(row),
      region: row.regionName ?? "—",
      role: row.doubleVisitorRole ?? "—",
      visited: row.visitedName ?? row.visitedHrId ?? "—",
      visits: row.visitCount,
    })),
  );

  const neverVisited = workbook.addWorksheet("Never Visited");
  neverVisited.columns = [
    { header: "Name", key: "name", width: 28 },
    { header: "Area", key: "area", width: 20 },
    { header: "Hired", key: "hireDate", width: 14 },
    { header: "Days Since Hire", key: "daysSinceHire", width: 16 },
    { header: "Overdue (45+ Days)", key: "flagged", width: 18 },
  ];
  neverVisited.addRows(
    filtered.neverVisitedRows.map((row) => ({
      area: row.areaName ?? "—",
      daysSinceHire: row.daysSinceHire ?? "—",
      flagged: row.flagged ? "Yes" : "No",
      hireDate: row.hireDate ?? "—",
      name: row.name,
    })),
  );

  const probation = workbook.addWorksheet("Probation Watchlist");
  probation.columns = [
    { header: "Name", key: "name", width: 28 },
    { header: "Hired", key: "hireDate", width: 14 },
    { header: "Probation End", key: "probationEndDate", width: 16 },
    { header: "Days Left", key: "daysRemaining", width: 12 },
    { header: "DV Count", key: "dvCount", width: 12 },
    { header: "DV Status", key: "dvStatus", width: 14 },
  ];
  probation.addRows(
    filtered.probationRows.map((row) => ({
      daysRemaining: row.daysRemaining,
      dvCount: row.dvCount,
      dvStatus: row.dvDone === null ? "N/A" : row.dvDone ? "Done" : "Pending",
      hireDate: row.hireDate,
      name: row.name,
      probationEndDate: row.probationEndDate,
    })),
  );

  for (const sheet of workbook.worksheets) {
    sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    sheet.getRow(1).fill = { fgColor: { argb: "FF0F172A" }, pattern: "solid", type: "pattern" };
    sheet.views = [{ state: "frozen", ySplit: 1 }];
  }

  return workbook;
}

// ── Data Integrity Report (admin-only) ──────────────────────────────────────────
//
// Every double-visit row that could NOT be confidently counted or attributed — so an admin
// can see and decide on each one, instead of it silently vanishing from every manager-facing
// number. Company-wide and unscoped by design (a data-quality audit, not a personal/team view),
// so it is gated to Super Admin only. Since the source is now a single live mirror (not a
// history of discrete imports), importSummaries is always empty — the workspace already hides
// that panel when empty.

const EARLIEST_MIRROR_DATE = "2020-01-01"; // safely before any real iReports360 data.

const INTEGRITY_ISSUE_LABELS: Record<DoubleVisitIntegrityIssueType, string> = {
  double_visitor_unmapped: "Double visitor could not be matched to an employee — who performed this visit is unknown.",
  visited_blank_or_unmapped: "Visited person has no usable HR ID and could not be matched to an employee.",
  visited_is_manager: "Visited person is actually a manager, not a Medical Rep — a double visit is always manager → Medical Rep.",
  visited_resigned: "Visited employee has since resigned.",
  visited_vacant_seat: "Visit was recorded against a vacant seat/territory, not a real employee.",
};

function emptyIntegrityCounts(): Record<DoubleVisitIntegrityIssueType, number> {
  return {
    double_visitor_unmapped: 0,
    visited_blank_or_unmapped: 0,
    visited_is_manager: 0,
    visited_resigned: 0,
    visited_vacant_seat: 0,
  };
}

export async function getDoubleVisitDataIntegrityReport(access: AccessContext): Promise<DoubleVisitIntegrityReport> {
  // The same door as the page and the admin CRM workspace (Super Admin + SFE Manager, owner 2026-08-02).
  // A Super-Admin-only check here let the SFE Manager in through the page and then crashed it under
  // him (System Audit APP-564C1D30, 2 Aug 2026).
  if (!canUseAdminCrmWorkspace(access)) {
    throw new Error("Forbidden: the Double Visit Data Integrity report is for the admin CRM workspace roles.");
  }
  if (!(await isDoubleVisitSchemaReady())) {
    return {
      asOfDate: todayIso(),
      countsByType: emptyIntegrityCounts(),
      importSummaries: [],
      issues: [],
      schemaReady: false,
      totalRowsScanned: 0,
    };
  }

  const employees = await getEmployeeDirectoryRows({ includeInactive: true });
  const rawRows = await getLiveDoubleVisitRows(EARLIEST_MIRROR_DATE, todayIso(), employees);

  const managerHrIdKeys = new Set(
    employees
      .filter((employee) => resolveDvRole(employee) !== null)
      .map((employee) => canonicalHrIdKey(employee.hrId))
      .filter((key): key is string => Boolean(key)),
  );

  const issues: DoubleVisitIntegrityIssue[] = [];
  const countsByType = emptyIntegrityCounts();

  for (const row of rawRows) {
    // A row the same-day chain resolver recovered (see resolveDoubleVisitChains) already carries
    // the real MR in visited_employee_* — it never reaches "visited_is_manager" below, and is
    // surfaced separately in the Visits Report's own Recovered Chains tab, not here.
    const doubleVisitorRaw = nullableText(row.double_visitor_hr_id);
    let issueType: DoubleVisitIntegrityIssueType | null = null;

    if (!doubleVisitorRaw || doubleVisitorRaw.toUpperCase().startsWith("CRM:")) {
      issueType = "double_visitor_unmapped";
    } else if (row.visited_employee_status === "blank_hr_id" || row.visited_employee_status === "unmapped") {
      issueType = "visited_blank_or_unmapped";
    } else if (row.visited_employee_status === "vacant") {
      issueType = "visited_vacant_seat";
    } else if (row.visited_employee_status === "resigned") {
      issueType = "visited_resigned";
    } else {
      // Re-derived regardless of stored status so a directory change since sync still shows up.
      const visitedKey = canonicalHrIdKey(row.visited_employee_hr_id);
      if (row.visited_employee_status === "non_mr" || (visitedKey && managerHrIdKeys.has(visitedKey))) {
        issueType = "visited_is_manager";
      }
    }

    if (!issueType) continue;
    countsByType[issueType] += 1;
    issues.push({
      activityDate: row.activity_date,
      areaName: nullableText(row.area_name),
      doubleVisitorHrIdRaw: doubleVisitorRaw,
      doubleVisitorName: nullableText(row.double_visitor_name),
      id: row.id,
      issueLabel: INTEGRITY_ISSUE_LABELS[issueType],
      issueType,
      lineName: nullableText(row.line_name),
      sourceFilename: "Live iReports360 Visits Report",
      sourceType: row.source_type,
      visitCount: asNumber(row.visit_count),
      visitedHrIdRaw: nullableText(row.visited_employee_hr_id),
      visitedName: nullableText(row.visited_employee_name),
      visitedStatus: row.visited_employee_status as DoubleVisitVisitedEmployeeStatus,
    });
  }
  issues.sort((a, b) => b.activityDate.localeCompare(a.activityDate));

  return {
    asOfDate: todayIso(),
    countsByType,
    importSummaries: [],
    issues,
    schemaReady: true,
    totalRowsScanned: rawRows.length,
  };
}

// ── Recovered Chains (admin-only): double visits the same-day chain resolver re-attributed
// from a manager to the real MR they actually saw (see resolveDoubleVisitChains). Lives on the
// Visits Report page (a raw-CRM-mirror browsing tool) rather than the Data Integrity report,
// since these rows are no longer defects — they're already correctly counted everywhere; this is
// purely an audit trail of what got recovered and how.

export async function getDoubleVisitRecoveredChains(input: {
  access: AccessContext;
  dateFrom: string;
  dateTo: string;
}): Promise<DoubleVisitRecoveredChain[]> {
  if (!canUseAdminCrmWorkspace(input.access)) {
    throw new Error("Forbidden: recovered double-visit chains are for the admin CRM workspace roles.");
  }
  if (!(await isDoubleVisitSchemaReady())) return [];

  const employees = await getEmployeeDirectoryRows({ includeInactive: true });
  const rawRows = await getLiveDoubleVisitRows(input.dateFrom, input.dateTo, employees);

  const recoveredChains: DoubleVisitRecoveredChain[] = [];
  for (const row of rawRows) {
    if (!row.resolved_via_chain) continue;
    recoveredChains.push({
      activityDate: row.activity_date,
      areaName: nullableText(row.area_name),
      customerSample: (row.chain_customer_names ?? []).slice(0, 4),
      higherManagerHrId: nullableText(row.double_visitor_hr_id),
      higherManagerName: nullableText(row.double_visitor_name),
      hingeManagerHrId: nullableText(row.chain_hinge_hr_id),
      hingeManagerName: nullableText(row.chain_hinge_name),
      id: row.id,
      lineName: nullableText(row.line_name),
      period: row.period,
      resolvedMrHrId: nullableText(row.visited_employee_hr_id),
      resolvedMrName: nullableText(row.visited_employee_name),
      visitCount: asNumber(row.visit_count),
    });
  }
  recoveredChains.sort((a, b) => b.activityDate.localeCompare(a.activityDate));
  return recoveredChains;
}
