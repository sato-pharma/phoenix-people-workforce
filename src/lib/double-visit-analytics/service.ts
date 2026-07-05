import ExcelJS from "exceljs";

import { type AccessContext, normalizeHrIdForAccess, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isTerminalEmploymentStatus } from "@/lib/auth/session-lifecycle";
import { getEmployeeDirectoryRows, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { resolveJobFunctionRole } from "@/lib/employees/job-function";
import { getProbationRows } from "@/lib/probation/service";
import type { ProbationDvState, ProbationRow } from "@/lib/probation/types";
import { sameWorkforceLine } from "@/lib/workforce/hierarchy-resolver";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { PrivateCalendarItem } from "@/lib/private-calendar/logic";
import type {
  DoubleVisitBreakdownRow,
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
  DoubleVisitScopeFocus,
  DoubleVisitSourceType,
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
const visitsTable = "ireports360_visits";
const DOUBLE_VISIT_TYPE_CODES = [0, -8] as const;

type JsonRecord = Record<string, unknown>;

type DoubleVisitDbRow = {
  activity_date: string;
  area_name: string | null;
  double_visitor_hr_id: string | null;
  double_visitor_name: string | null;
  id: string;
  line_name: string | null;
  period: "AM" | "PM" | "UNKNOWN";
  raw_payload: JsonRecord | null;
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
};

function text(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

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
  const { error } = await getSupabaseAdmin().from(visitsTable).select("id", { count: "exact", head: true }).limit(1);
  return !schemaMissing(error);
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

function todayIso() {
  return new Date().toISOString().slice(0, 10);
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

export function resolveDoubleVisitAccessScope(access: AccessContext, employees: EmployeeDirectoryRow[]) {
  if (
    access.scope === "system" ||
    access.role === "CEO" ||
    access.role === "Super Admin" ||
    access.role === "National Sales Manager" ||
    access.role === "SFE Manager" ||
    access.role === "Training Manager" ||
    // Marketing Manager: executive company-wide READ oversight of double-visit analytics.
    access.role === "Marketing Manager"
  ) {
    return { all: true as const };
  }

  const viewerKey = normalizedHrKey(resolveEmployeeIdentityId(access) ?? access.hrId ?? access.loginId);
  const viewer = viewerKey
    ? employees.find((employee) => normalizedHrKey(employee.hrId) === viewerKey) ?? null
    : null;
  const allowedHrIds = viewerKey ? descendantHrIds(viewerKey, employees) : new Set<string>();
  const allowedAreas = new Set<string>();
  const allowedLines = new Set<string>();

  if (access.role === "Regional Manager" && viewer?.regionName) {
    for (const employee of employees) {
      if (normalizeLabelKey(employee.regionName) !== normalizeLabelKey(viewer.regionName)) continue;
      const key = normalizedHrKey(employee.hrId);
      if (key) allowedHrIds.add(key);
      const area = normalizeLabelKey(employee.areaName);
      const line = normalizeLabelKey(employee.lineName);
      if (area) allowedAreas.add(area);
      if (line) allowedLines.add(line);
    }
  }

  // GPM and PM oversee their entire product LINE, not just their reporting chain. In
  // production the employee directory keys lines by numeric line_id (line_name is null on
  // the manager records), and the DV feed labels lines with an unrelated text code — so
  // matching on line_name alone never fires. Resolve the full line with the canonical
  // sameWorkforceLine (line_id preferred, line-name fallback) and add every line member to
  // allowedHrIds, so a DV is in scope whenever the double-visitor OR the visited MR sits on
  // the line. Without this a GPM saw only their direct chain (≈30 of ≈1,900 line visits).
  if (
    (access.role === "Product Manager" ||
     access.role === "Group Product Manager") &&
    viewer &&
    (viewer.lineId != null || viewer.lineName)
  ) {
    for (const employee of employees) {
      if (!sameWorkforceLine(viewer, employee)) continue;
      const key = normalizedHrKey(employee.hrId);
      if (key) allowedHrIds.add(key);
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
  };
}

function filterRowsForAccess(rows: DoubleVisitDbRow[], access: AccessContext, employees: EmployeeDirectoryRow[]) {
  const scope = resolveDoubleVisitAccessScope(access, employees);
  if (scope.all) return rows;
  return rows.filter((row) => {
    const doubleVisitorKey = normalizedHrKey(row.double_visitor_hr_id);
    const visitedKey = normalizedHrKey(row.visited_employee_hr_id);
    if (doubleVisitorKey && scope.allowedHrIds.has(doubleVisitorKey)) return true;
    if (visitedKey && scope.allowedHrIds.has(visitedKey)) return true;
    if (row.area_name && scope.allowedAreas.has(normalizeLabelKey(row.area_name))) return true;
    if (row.line_name && scope.allowedLines.has(normalizeLabelKey(row.line_name))) return true;
    return false;
  });
}

function filterEmployeesForDoubleVisitAccess(employees: EmployeeDirectoryRow[], access: AccessContext) {
  const scope = resolveDoubleVisitAccessScope(access, employees);
  if (scope.all) return employees;
  return employees.filter((employee) => {
    const key = normalizedHrKey(employee.hrId);
    if (key && scope.allowedHrIds.has(key)) return true;
    if (employee.areaName && scope.allowedAreas.has(normalizeLabelKey(employee.areaName))) return true;
    if (employee.lineName && scope.allowedLines.has(normalizeLabelKey(employee.lineName))) return true;
    return false;
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

type MirrorVisitRow = {
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
  raw_payload: JsonRecord | null;
  visit_date: string;
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

async function paginateLiveMirrorVisits(dateFrom: string, dateTo: string): Promise<MirrorVisitRow[]> {
  const pageSize = 1000;
  const rows: MirrorVisitRow[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await getSupabaseAdmin()
      .from(visitsTable)
      .select("id, crm_visit_id, visit_date, agent_hr_id, agent_name, contact_name, customer_name, double_crm_id, double_hr_id, double_name, ampm, raw_payload")
      .not("double_crm_id", "is", null)
      .neq("double_crm_id", 0)
      .in("visit_type", [...DOUBLE_VISIT_TYPE_CODES])
      .gte("visit_date", dateFrom)
      .lte("visit_date", dateTo)
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) {
      if (schemaMissing(error)) break;
      throw new Error(error.message);
    }
    const page = (data ?? []) as MirrorVisitRow[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

function dbRowFromMirrorVisit(
  visit: MirrorVisitRow,
  employeeByHrKey: Map<string, EmployeeDirectoryRow>,
  managerHrIdKeys: Set<string>,
  resolution: DoubleVisitChainResolution | null,
): DoubleVisitDbRow {
  // When the same-day chain resolves this "manager-visited" row down to the real MR, the visited
  // party becomes that MR (the whole convoy actually saw them); otherwise it stays the recorded
  // agent. Everything downstream — coverage, MR scores, calendar — then credits the real MR.
  const effectiveVisitedHrId = resolution ? resolution.mrHrId : visit.agent_hr_id;
  const visitedKey = canonicalHrIdKey(effectiveVisitedHrId);
  const visitedEmployee = visitedKey ? employeeByHrKey.get(visitedKey) ?? null : null;
  const doubleKey = canonicalHrIdKey(visit.double_hr_id);
  const doubleEmployee = doubleKey ? employeeByHrKey.get(doubleKey) ?? null : null;
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

  return {
    activity_date: visit.visit_date,
    area_name: visitedEmployee?.areaName ?? label.areaName,
    double_visitor_hr_id: visit.double_hr_id ?? (visit.double_crm_id ? `CRM:${visit.double_crm_id}` : null),
    double_visitor_name: doubleEmployee?.fullName ?? visit.double_name ?? null,
    id: visit.id,
    line_name: visitedEmployee?.lineName ?? label.lineName,
    period: periodFromAmpm(visit.ampm),
    raw_payload: visit.raw_payload,
    source_record_id: String(visit.crm_visit_id),
    source_type: "ireports360",
    visit_count: 1,
    visited_employee_hr_id: effectiveVisitedHrId,
    visited_employee_name: visitedEmployee?.fullName ?? label.name ?? (resolution ? resolution.mrName : visit.agent_name),
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
): Promise<DoubleVisitDbRow[]> {
  const mirrorRows = await paginateLiveMirrorVisits(dateFrom, dateTo);
  if (mirrorRows.length === 0) return [];
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
    dbRowFromMirrorVisit(visit, employeeByHrKey, managerHrIdKeys, chainResolutions.get(visit.id) ?? null),
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
  const byWeek = new Map<string, { am: number; mrs: Set<string>; pm: number; total: number }>();
  for (const row of rows) {
    const week = isoWeekStart(row.activity_date);
    const bucket = byWeek.get(week) ?? { am: 0, mrs: new Set<string>(), pm: 0, total: 0 };
    const count = asNumber(row.visit_count);
    bucket.total += count;
    if (row.period === "AM") bucket.am += count;
    if (row.period === "PM") bucket.pm += count;
    const visitedKey = canonicalHrIdKey(row.visited_employee_hr_id);
    if (visitedKey) bucket.mrs.add(visitedKey);
    byWeek.set(week, bucket);
  }
  return Array.from(byWeek.entries())
    .map(([weekStart, bucket]) => ({
      amVisits: bucket.am,
      distinctMrs: bucket.mrs.size,
      pmVisits: bucket.pm,
      totalDvs: bucket.total,
      weekStart,
    }))
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

function isActiveEmployee(employee: EmployeeDirectoryRow) {
  const status = text(employee.employmentStatus).toLowerCase();
  return status === "active" || status === "on_leave";
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

function isMedicalRep(employee: EmployeeDirectoryRow) {
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
  return rows.filter((row) => {
    const doubleVisitorKey = normalizedHrKey(row.double_visitor_hr_id);
    if (!doubleVisitorKey) return true;
    return isAllowedDoubleVisitor(employeeByHrId.get(doubleVisitorKey) ?? null);
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
    const distinctVisitors = new Set(mrRows.map((row) => canonicalHrIdKey(row.double_visitor_hr_id)).filter(Boolean));
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
      mrName: employee.fullName,
      totalDvs: mrRows.reduce((sum, row) => sum + asNumber(row.visit_count), 0),
      trendDirection,
    } satisfies DoubleVisitMrScore;
  }).sort((left, right) => {
    const bandRank = { critical: 0, warning: 1, healthy: 2 };
    return bandRank[left.band] - bandRank[right.band] || left.mrName.localeCompare(right.mrName);
  });
}

const functionalDoubleVisitorRoles = ["Product Manager", "Group Product Manager", "Marketing Manager", "Training Manager"] as const;

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
  const doubleVisitorKeys = new Set(rows.map((row) => canonicalHrIdKey(row.double_visitor_hr_id)).filter(Boolean));
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
      jobRole === "Product Manager" ||
      jobRole === "Group Product Manager" ||
      jobRole === "Marketing Manager" ||
      jobRole === "Training Manager";

    // PM/GPM/MM/TM have no fixed org-chart team, so scope their executive report to
    // exactly the MRs they actually visited. This is self-scoping: a PM covering two
    // lines (e.g. Pedia + Anti Inf) automatically gets both sets of MR scores, and a
    // TM does not get incorrectly assigned the entire MR universe.
    const dvVisitedMrKeys = isLineScopedRole
      ? new Set(
          rows
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
      managerName: group.manager.fullName || group.manager.hrId || managerHrId,
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

  // Team-MR denominator lives in the descendantHrIds normalization domain
  // (normalizeHrIdForAccess), which is DISTINCT from canonicalHrIdKey. We only ever
  // COUNT across the two domains — never intersect sets — so mixing is safe here.
  const activeMrKeys = new Set(
    employees
      .filter((employee) => isActiveEmployee(employee) && isMedicalRep(employee))
      .map((employee) => normalizedHrKey(employee.hrId))
      .filter((key): key is string => Boolean(key)),
  );
  const teamMrCountMemo = new Map<string, number>();
  const teamMrCountFor = (managerNormKey: string) => {
    if (!managerNormKey) return 0;
    const cached = teamMrCountMemo.get(managerNormKey);
    if (cached != null) return cached;
    let count = 0;
    for (const key of descendantHrIds(managerNormKey, employees)) {
      if (key !== managerNormKey && activeMrKeys.has(key)) count += 1;
    }
    teamMrCountMemo.set(managerNormKey, count);
    return count;
  };

  const rowsByVisitor = new Map<string, DoubleVisitDbRow[]>();
  for (const row of rows) {
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
    const amVisits = visitorRows.filter((row) => row.period === "AM").reduce((sum, row) => sum + asNumber(row.visit_count), 0);
    const pmVisits = visitorRows.filter((row) => row.period === "PM").reduce((sum, row) => sum + asNumber(row.visit_count), 0);

    const visitedTally = new Map<string, number>();
    for (const row of visitorRows) {
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

    const teamMrCount = dv && HIERARCHY_ROLE_CODES.has(dv.roleCode) && employee
      ? teamMrCountFor(normalizedHrKey(employee.hrId) ?? "")
      : null;
    const coveragePct = teamMrCount && teamMrCount > 0 ? round((distinctMrs / teamMrCount) * 100, 1) : null;
    const neglectedMrCount = teamMrCount && teamMrCount > 0 ? Math.max(0, teamMrCount - distinctMrs) : null;

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
      managerName: nullableText(employee?.fullName) ?? nullableText(visitorRows[0]?.double_visitor_name) ?? visitorKey,
      neglectedMrCount,
      overFocusedMrCount,
      pmVisits,
      role: dv?.role ?? null,
      roleCode: dv?.roleCode ?? null,
      teamMrCount,
      totalDvs,
    });
  }

  summaries.sort((left, right) => right.totalDvs - left.totalDvs || left.managerName.localeCompare(right.managerName));
  return { summaries, visitedKeysByManager };
}

export function buildManagerSummaries(rows: DoubleVisitDbRow[], employees: EmployeeDirectoryRow[], asOfDate: string) {
  return buildManagerSummariesDetailed(rows, employees, asOfDate).summaries;
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
    .filter((summary) => summary.teamMrCount != null && summary.teamMrCount > 0 && summary.distinctMrs < summary.teamMrCount && summary.concentrationPct != null)
    .slice()
    .sort((a, b) => (b.concentrationPct ?? 0) - (a.concentrationPct ?? 0))[0];
  if (mostOverFocused) {
    raw.push({
      category: "concentration",
      detail: `${mostOverFocused.managerName} put ${mostOverFocused.concentrationPct}% of double visits on ${mostOverFocused.distinctMrs} of ${mostOverFocused.teamMrCount} team MRs — rotation gap.`,
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
      detail: `${lowestCoverage.managerName} double-visited only ${lowestCoverage.distinctMrs} of ${lowestCoverage.teamMrCount} team MRs (${lowestCoverage.coveragePct}%).`,
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

  const am = kpis.amVisitCount;
  const pm = kpis.pmVisitCount;
  const totalPeriod = am + pm;
  if (totalPeriod > 0) {
    const minorityShare = Math.min(am, pm) / totalPeriod;
    const amPct = round((am / totalPeriod) * 100, 0);
    raw.push({
      category: "balance",
      detail: `Field effort splits ${am} AM vs ${pm} PM (${amPct}% AM). ${am <= pm ? "Mornings are under-covered." : "Afternoons are under-covered."}`,
      id: "ampm-imbalance",
      managerHrId: null,
      mrHrId: null,
      severity: minorityShare < 0.2 ? "warning" : "info",
      title: "AM / PM balance",
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
  const idleManagers: DoubleVisitIdleManager[] = [];
  for (const employee of scopedEmployees) {
    if (!isActiveEmployee(employee)) continue;
    const dv = resolveDvRole(employee);
    if (!dv) continue;
    const key = canonicalHrIdKey(employee.hrId);
    if (!key || activeVisitorKeys.has(key)) continue;
    idleManagers.push({
      areaName: employee.areaName,
      hrId: key,
      lineName: employee.lineName,
      name: employee.fullName || employee.hrId || key,
      role: dv.role,
      roleCode: dv.roleCode,
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
  for (const entry of visitLog) {
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
  const totalVisits = rows.reduce((sum, row) => sum + asNumber(row.visit_count), 0);
  const activeDoubleVisitDays = new Set(rows.map((row) => `${canonicalHrIdKey(row.double_visitor_hr_id)}|${row.activity_date}`)).size;
  const doubleVisitorCount = new Set(rows.map((row) => canonicalHrIdKey(row.double_visitor_hr_id)).filter(Boolean)).size;
  const amVisitCount = rows.filter((row) => row.period === "AM").reduce((sum, row) => sum + asNumber(row.visit_count), 0);
  const pmVisitCount = rows.filter((row) => row.period === "PM").reduce((sum, row) => sum + asNumber(row.visit_count), 0);
  const activeMappedVisitCount = rows.filter((row) => row.visited_employee_status === "active_mapped").reduce((sum, row) => sum + asNumber(row.visit_count), 0);
  const vacantOrUnmappedVisitCount = totalVisits - activeMappedVisitCount;
  return {
    activeCalendarDays: new Set(rows.map((row) => row.activity_date)).size,
    activeDoubleVisitDays,
    activeMappedVisitCount,
    amPmRatio: pmVisitCount > 0 ? round(amVisitCount / pmVisitCount, 4) : null,
    amVisitCount,
    averageVisitsPerDoubleVisitDay: activeDoubleVisitDays > 0 ? round(totalVisits / activeDoubleVisitDays, 2) : 0,
    averageVisitsPerDoubleVisitor: doubleVisitorCount > 0 ? round(totalVisits / doubleVisitorCount, 2) : 0,
    doubleVisitorCount,
    mrCoverageCount: new Set(rows.map((row) => canonicalHrIdKey(row.visited_employee_hr_id)).filter(Boolean)).size,
    pmVisitCount,
    totalVisits,
    vacantOrUnmappedShare: totalVisits > 0 ? round((vacantOrUnmappedVisitCount / totalVisits) * 100, 1) : 0,
    vacantOrUnmappedVisitCount,
  };
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

  const employees = await getEmployeeDirectoryRows({ includeInactive: true });
  const rows = await getLiveDoubleVisitRows(dateFrom, dateTo, employees);
  const scopedEmployees = filterEmployeesForDoubleVisitAccess(employees, input.access);
  const scopedRows = filterRowsForAccess(rows, input.access, employees);
  const scopedEmployeesByHrId = new Map(
    scopedEmployees
      .map((employee) => [normalizedHrKey(employee.hrId), employee])
      .filter((entry): entry is [string, EmployeeDirectoryRow] => Boolean(entry[0])),
  );
  // Build a set of manager HR ID keys (DSM/RM/NSM/PM/GPM/TM) to exclude manager-to-manager
  // rows — defense-in-depth alongside the row-level classification in dbRowFromMirrorVisit.
  const managerHrIdKeys = new Set(
    scopedEmployees
      .filter((e) => resolveDvRole(e) !== null)
      .map((e) => canonicalHrIdKey(e.hrId))
      .filter((k): k is string => Boolean(k)),
  );
  const filteredRows = filterRowsByAllowedDoubleVisitor(scopedRows, scopedEmployeesByHrId).filter((row) => {
    if (!row.visited_employee_hr_id) return true;
    return !managerHrIdKeys.has(canonicalHrIdKey(row.visited_employee_hr_id) ?? "");
  });
  const mrScores = buildMrScores(filteredRows, scopedEmployees, dateTo);
  const executiveReports = buildExecutiveReports(mrScores, scopedEmployees, filteredRows);
  const kpisValue = buildKpis(filteredRows);
  const { summaries: managerSummaries, visitedKeysByManager } = buildManagerSummariesDetailed(filteredRows, scopedEmployees, dateTo);
  const executiveSummary = buildExecutiveSummary(managerSummaries, mrScores, kpisValue, scopedEmployees, visitedKeysByManager);
  const activeScopeEmployees = scopedEmployees.filter(isActiveEmployee);
  const areaBuckets = Array.from(new Set(activeScopeEmployees.map((employee) => nullableText(employee.areaName)).filter((value): value is string => Boolean(value)))).sort();
  const lineBuckets = Array.from(new Set(activeScopeEmployees.map((employee) => nullableText(employee.lineName)).filter((value): value is string => Boolean(value)))).sort();
  const areas = Array.from(new Set(filteredRows.map((row) => nullableText(row.area_name)).filter((value): value is string => Boolean(value)))).sort();
  const lines = Array.from(new Set(filteredRows.map((row) => nullableText(row.line_name)).filter((value): value is string => Boolean(value)))).sort();
  const doubleVisitors = Array.from(new Set(filteredRows.map((row) => nullableText(row.double_visitor_name) ?? nullableText(row.double_visitor_hr_id)).filter((value): value is string => Boolean(value)))).sort();

  const visitLog: DoubleVisitLogEntry[] = filteredRows
    .map((row) => ({
      area: nullableText(row.area_name),
      date: row.activity_date,
      doubleVisitorHrId: nullableText(row.double_visitor_hr_id),
      doubleVisitorName: nullableText(row.double_visitor_name),
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

const PROBATION_DV_FIELD_BY_ROLE: Partial<Record<string, keyof ProbationDvState>> = {
  "District Manager": "dm_dv_done",
  "Group Product Manager": "pm_gpm_dv_done",
  "National Sales Manager": "nsm_dv_done",
  "Product Manager": "pm_gpm_dv_done",
  "Training Manager": "tm_dv_done",
};

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

/** "Regular" for visitType 0, else the CRM's own label — matches the module's own double-visit
 * filter (visit_type IN (0,-8)), so this only ever distinguishes Regular from Campaign now. */
function deriveVisitKind(row: Pick<DoubleVisitDbRow, "raw_payload">): string {
  const payload = row.raw_payload as { visitType?: number; visitTypeDescription?: string | null } | null;
  if (payload?.visitType === 0) return "Regular";
  return nullableText(payload?.visitTypeDescription ?? null) ?? "Non-Regular";
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

  const [allDvRows, probationRows] = await Promise.all([
    getLiveDoubleVisitRows(trendStart, todayIso(), employees),
    getProbationRows(access).catch(() => []),
  ]);
  const medicalRepProbationRows = probationRows.filter((row) => isMedicalRepProbationRow(row, employees));
  const ownRows = viewerCanonicalKey
    ? allDvRows.filter((row) => canonicalHrIdKey(row.double_visitor_hr_id) === viewerCanonicalKey)
    : [];

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
  const visitedKeys = new Set(
    ownRows.map((row) => canonicalHrIdKey(row.visited_employee_hr_id)).filter((key): key is string => Boolean(key)),
  );
  const scopedEmployees = filterEmployeesForDoubleVisitAccess(employees, access);
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
        name: employee.fullName,
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

  // Block 3 — probation watchlist. dv_state reflects the viewer's own tier (dm/nsm/pm_gpm/tm);
  // Regional Manager has no dedicated probation DV checkbox, so it falls back to a raw DV count
  // (any double-visitor, matched the same canonical way as everything else in this function).
  const dvField = PROBATION_DV_FIELD_BY_ROLE[role];
  const dvCountByHrId = new Map<string, number>();
  for (const row of allDvRows) {
    const key = canonicalHrIdKey(row.visited_employee_hr_id);
    if (!key) continue;
    dvCountByHrId.set(key, (dvCountByHrId.get(key) ?? 0) + asNumber(row.visit_count));
  }
  const probationAll: DoubleVisitFocusProbationEntry[] = medicalRepProbationRows
    .map((row) => {
      const key = canonicalHrIdKey(row.hr_id);
      return {
        daysRemaining: row.days_remaining,
        dvCount: key ? dvCountByHrId.get(key) ?? 0 : 0,
        dvDone: dvField ? Boolean(row.dv_state?.[dvField]) : null,
        hireDate: row.hire_date,
        hrId: row.hr_id,
        name: row.full_name,
        probationEndDate: row.probation_end_date,
      } satisfies DoubleVisitFocusProbationEntry;
    })
    .sort((a, b) => a.daysRemaining - b.daysRemaining);

  return {
    probation: probationAll.slice(0, FOCUS_PROBATION_DISPLAY_LIMIT),
    probationTruncated: probationAll.length > FOCUS_PROBATION_DISPLAY_LIMIT,
    reportHref: "/employee-portals/double-visit-report",
    scope,
    trend,
  };
}

// ── Double Visit Report page: flat, filterable, sortable, exportable drill-down ────

export async function getDoubleVisitReportData(input: {
  access: AccessContext;
  dateFrom?: string | null;
  dateTo?: string | null;
}): Promise<DoubleVisitReportData> {
  const today = todayIso();
  const dateFrom = input.dateFrom || addDaysIso(today, -90);
  const dateTo = input.dateTo || today;

  if (!(await isDoubleVisitSchemaReady())) {
    return {
      asOfDate: today,
      dateFrom,
      dateTo,
      filters: { areas: [], doubleVisitors: [], lines: [], visitKinds: [] },
      neverVisited: [],
      probation: [],
      rows: [],
      schemaReady: false,
    };
  }

  const employees = await getEmployeeDirectoryRows({ includeInactive: true });
  const scopedEmployees = filterEmployeesForDoubleVisitAccess(employees, input.access);
  const hireDateByKey = new Map(
    employees
      .map((employee) => [canonicalHrIdKey(employee.hrId), employee.hireDate] as const)
      .filter((entry): entry is [string, string | null] => Boolean(entry[0])),
  );
  const managerHrIdKeys = new Set(
    scopedEmployees
      .filter((employee) => resolveDvRole(employee) !== null)
      .map((employee) => canonicalHrIdKey(employee.hrId))
      .filter((key): key is string => Boolean(key)),
  );

  const rawRows = await getLiveDoubleVisitRows(dateFrom, dateTo, employees);
  const scopedRows = filterRowsForAccess(rawRows, input.access, employees).filter((row) => {
    if (!row.visited_employee_hr_id) return true;
    return !managerHrIdKeys.has(canonicalHrIdKey(row.visited_employee_hr_id) ?? "");
  });

  const rows: DoubleVisitReportRow[] = scopedRows
    .map((row) => {
      const visitedKey = canonicalHrIdKey(row.visited_employee_hr_id);
      const visitedHireDate = visitedKey ? hireDateByKey.get(visitedKey) ?? null : null;
      return {
        activityDate: row.activity_date,
        areaName: nullableText(row.area_name),
        daysSinceVisitedHire: daysBetween(visitedHireDate, dateTo),
        doubleVisitorHrId: nullableText(row.double_visitor_hr_id),
        doubleVisitorName: nullableText(row.double_visitor_name),
        lineName: nullableText(row.line_name),
        period: row.period,
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
  const neverVisited: DoubleVisitFocusRosterEntry[] = scopedEmployees
    .filter((employee) => isActiveEmployee(employee) && isMedicalRep(employee))
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
        name: employee.fullName,
        visited: false,
      } satisfies DoubleVisitFocusRosterEntry;
    })
    .sort((a, b) => (b.daysSinceHire ?? -1) - (a.daysSinceHire ?? -1));

  const probationRowsRaw = (await getProbationRows(input.access).catch(() => [])).filter((row) =>
    isMedicalRepProbationRow(row, employees),
  );
  const dvField = PROBATION_DV_FIELD_BY_ROLE[input.access.role ?? ""];
  const probationDvCountByKey = new Map<string, number>();
  for (const row of scopedRows) {
    const key = canonicalHrIdKey(row.visited_employee_hr_id);
    if (!key) continue;
    probationDvCountByKey.set(key, (probationDvCountByKey.get(key) ?? 0) + asNumber(row.visit_count));
  }
  const probation: DoubleVisitFocusProbationEntry[] = probationRowsRaw.map((row) => {
    const key = canonicalHrIdKey(row.hr_id);
    return {
      daysRemaining: row.days_remaining,
      dvCount: key ? probationDvCountByKey.get(key) ?? 0 : 0,
      dvDone: dvField ? Boolean(row.dv_state?.[dvField]) : null,
      hireDate: row.hire_date,
      hrId: row.hr_id,
      name: row.full_name,
      probationEndDate: row.probation_end_date,
    } satisfies DoubleVisitFocusProbationEntry;
  });

  const areas = Array.from(new Set(rows.map((row) => row.areaName).filter((value): value is string => Boolean(value)))).sort();
  const lines = Array.from(new Set(rows.map((row) => row.lineName).filter((value): value is string => Boolean(value)))).sort();
  const doubleVisitors = Array.from(
    new Set(rows.map((row) => row.doubleVisitorName ?? row.doubleVisitorHrId).filter((value): value is string => Boolean(value))),
  ).sort();
  const visitKinds = Array.from(new Set(rows.map((row) => row.visitKind))).sort();

  return {
    asOfDate: today,
    dateFrom,
    dateTo,
    filters: { areas, doubleVisitors, lines, visitKinds },
    neverVisited,
    probation,
    rows,
    schemaReady: true,
  };
}

function joinedDistinct(values: Array<string | null | undefined>, fallback: string) {
  const distinct = Array.from(new Set(values.map(nullableText).filter((value): value is string => Boolean(value))));
  return distinct.length > 0 ? distinct.join(", ") : fallback;
}

function workloadTime(rows: DoubleVisitDbRow[]) {
  const am = rows.filter((row) => row.period === "AM").reduce((sum, row) => sum + asNumber(row.visit_count), 0);
  const pm = rows.filter((row) => row.period === "PM").reduce((sum, row) => sum + asNumber(row.visit_count), 0);
  return [am > 0 ? `AM ${am}` : null, pm > 0 ? `PM ${pm}` : null].filter(Boolean).join(" / ") || "Double Visit";
}

function calendarItemId(prefix: string, employeeHrId: string, date: string) {
  return `${prefix}-${normalizedHrKey(employeeHrId) ?? employeeHrId}-${date}`;
}

function privateCalendarItem(input: {
  date: string;
  description: string;
  detailLines: string[];
  employeeHrId: string;
  employeeName: string | null;
  id: string;
  status: string;
  time: string;
  title: string;
}): PrivateCalendarItem {
  return {
    approvalImpact: "Double Visit evidence is read-only field activity context. It does not mutate attendance, leave, deductions, payroll, or compliance decisions.",
    description: input.description,
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
    sourceLabel: "Live iReports360 double-visit mirror",
    sourceRecordId: input.id,
    sourceSystem: "Double Visit Analytics",
    sourceTable: visitsTable,
    startDate: input.date,
    status: input.status,
    time: input.time,
    title: input.title,
  };
}

function groupCalendarRows(rows: DoubleVisitDbRow[], keyFn: (row: DoubleVisitDbRow) => string | null) {
  const groups = new Map<string, DoubleVisitDbRow[]>();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return groups;
}

export async function loadDoubleVisitPrivateCalendarItems(employeeHrIds: string[], start: string, end: string) {
  try {
    const selected = new Set(employeeHrIds.map(normalizedHrKey).filter((value): value is string => Boolean(value)));
    if (selected.size === 0) return { items: [] as PrivateCalendarItem[], ready: true };
    const employees = await getEmployeeDirectoryRows({ includeInactive: true });
    const rows = await getLiveDoubleVisitRows(start, end, employees);
    const items: PrivateCalendarItem[] = [];

    const performed = groupCalendarRows(
      rows.filter((row) => selected.has(normalizedHrKey(row.double_visitor_hr_id) ?? "")),
      (row) => {
        const key = normalizedHrKey(row.double_visitor_hr_id);
        return key ? `${key}|${row.activity_date}` : null;
      },
    );

    for (const group of performed.values()) {
      const first = group[0];
      if (!first?.double_visitor_hr_id) continue;
      const total = group.reduce((sum, row) => sum + asNumber(row.visit_count), 0);
      items.push(privateCalendarItem({
        date: first.activity_date,
        description: `${total} Double Visit activity count from the live iReports360 visit mirror.`,
        detailLines: [
          `AM/PM: ${workloadTime(group)}`,
          `Area: ${joinedDistinct(group.map((row) => row.area_name), "Unmapped")}`,
          `Line: ${joinedDistinct(group.map((row) => row.line_name), "Unmapped")}`,
          `Visited: ${joinedDistinct(group.map((row) => row.visited_employee_name), "Unmapped or vacant")}`,
        ],
        employeeHrId: first.double_visitor_hr_id,
        employeeName: first.double_visitor_name,
        id: calendarItemId("double-visit-performed", first.double_visitor_hr_id, first.activity_date),
        status: "performed",
        time: workloadTime(group),
        title: "Performed Double Visits",
      }));
    }

    const received = groupCalendarRows(
      rows.filter((row) => selected.has(normalizedHrKey(row.visited_employee_hr_id) ?? "")),
      (row) => {
        const key = normalizedHrKey(row.visited_employee_hr_id);
        return key ? `${key}|${row.activity_date}` : null;
      },
    );

    for (const group of received.values()) {
      const first = group[0];
      if (!first?.visited_employee_hr_id) continue;
      const total = group.reduce((sum, row) => sum + asNumber(row.visit_count), 0);
      items.push(privateCalendarItem({
        date: first.activity_date,
        description: `${total} Double Visit received from the live iReports360 visit mirror.`,
        detailLines: [
          `AM/PM: ${workloadTime(group)}`,
          `Double visitor: ${joinedDistinct(group.map((row) => row.double_visitor_name), "Unmapped")}`,
          `Area: ${joinedDistinct(group.map((row) => row.area_name), "Unmapped")}`,
          `Line: ${joinedDistinct(group.map((row) => row.line_name), "Unmapped")}`,
        ],
        employeeHrId: first.visited_employee_hr_id,
        employeeName: first.visited_employee_name,
        id: calendarItemId("double-visit-received", first.visited_employee_hr_id, first.activity_date),
        status: "received",
        time: workloadTime(group),
        title: "Received Double Visit",
      }));
    }

    return { items, ready: true };
  } catch (error) {
    if (schemaMissing(error)) return { items: [] as PrivateCalendarItem[], ready: false };
    throw error;
  }
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
      dateBreakdown: dates.map((date) => ({ am: 0, date, evidenceRows: 0, pm: 0, total: 0 })),
      importId: null,
      matchedDates: [],
      matchStatus: "no_activity",
      missingDates: dates,
      pmWorkload: 0,
      source: "manual",
      sourceLabel: "No employee HR ID available for Double Visit evidence matching.",
    };
  }

  const employees = await getEmployeeDirectoryRows({ includeInactive: true });
  const rows = await getLiveDoubleVisitRows(start, end, employees);
  const ownRows = rows.filter((row) => normalizeHrIdForAccess(row.double_visitor_hr_id) === employeeKey);
  const dateBreakdown = dates.map((date) => {
    const dayRows = ownRows.filter((row) => row.activity_date === date);
    const am = dayRows.filter((row) => row.period === "AM").reduce((sum, row) => sum + asNumber(row.visit_count), 0);
    const pm = dayRows.filter((row) => row.period === "PM").reduce((sum, row) => sum + asNumber(row.visit_count), 0);
    return {
      am,
      date,
      evidenceRows: dayRows.length,
      pm,
      total: am + pm + dayRows.filter((row) => row.period === "UNKNOWN").reduce((sum, row) => sum + asNumber(row.visit_count), 0),
    };
  });
  const matchedDates = dateBreakdown.filter((row) => row.total > 0).map((row) => row.date);
  const missingDates = dates.filter((date) => !matchedDates.includes(date));
  const matchStatus = matchedDates.length === 0
    ? "no_activity"
    : missingDates.length > 0
      ? "partial"
      : "matched";
  return {
    amWorkload: dateBreakdown.reduce((sum, row) => sum + row.am, 0),
    dateBreakdown,
    importId: null,
    matchedDates,
    matchStatus,
    missingDates,
    pmWorkload: dateBreakdown.reduce((sum, row) => sum + row.pm, 0),
    source: "double_visit_import",
    sourceLabel: "Live iReports360 Visits Report (double-visit mirror).",
  };
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
  if (access.role !== "Super Admin") {
    throw new Error("Forbidden: only Super Admin can view the Double Visit Data Integrity report.");
  }
  if (!(await isDoubleVisitSchemaReady())) {
    return {
      asOfDate: todayIso(),
      countsByType: emptyIntegrityCounts(),
      importSummaries: [],
      issues: [],
      recoveredChains: [],
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
  const recoveredChains: DoubleVisitRecoveredChain[] = [];
  const countsByType = emptyIntegrityCounts();

  for (const row of rawRows) {
    // A row that the same-day chain recovered is no longer a "visited-is-manager" defect — it is
    // now credited to the real MR (in visited_employee_*). Surface it as an auditable recovery
    // instead of an issue.
    if (row.resolved_via_chain) {
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
      continue;
    }

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
  recoveredChains.sort((a, b) => b.activityDate.localeCompare(a.activityDate));

  return {
    asOfDate: todayIso(),
    countsByType,
    importSummaries: [],
    issues,
    recoveredChains,
    schemaReady: true,
    totalRowsScanned: rawRows.length,
  };
}
