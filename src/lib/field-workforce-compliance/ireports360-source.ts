/**
 * iReports360 data source for Field Workforce Compliance.
 *
 * This module replaces the manual monthly Excel upload with a live pull from the
 * iReports360 CRM. It builds the SAME in-memory matrix the Excel parser consumes, so
 * the existing parser + classifier + archive + recommendations pipeline runs
 * unchanged on real visit data.
 *
 * Day-cell mapping (owner-confirmed default; the parity test validates it):
 *   - Regular visit (visitType 0)        -> numeric count for that day (VISITS)
 *   - Annual Vacation (-4), Health (-15) -> "AV" (leave / absence signal)
 *   - Campaign (-8), Conference (-1),
 *     Group Meeting (-2), Training (-9),
 *     Meeting (-11), Traveling (-12)     -> "CP" (worked day, non-numeric activity)
 *   - eligible working day with no record -> "N" (no-activity candidate)
 *   - Friday                              -> left blank (classifier ignores Fridays)
 *   - future day (current month)          -> left blank (not yet occurred)
 */

import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { googleRouteThroughStops } from "@/lib/google-maps/server";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { buildFieldWorkforceCompliancePreview } from "@/lib/field-workforce-compliance/classifier";
import {
  daysInMonth,
  parseFieldWorkforceComplianceMatrix,
} from "@/lib/field-workforce-compliance/parser";
import { FieldWorkforcePreviewError } from "@/lib/field-workforce-compliance/preview";
import type {
  FieldWorkforceEmployeeReference,
  FieldWorkforceHoliday,
  FieldWorkforcePreviewResult,
} from "@/lib/field-workforce-compliance/types";
import {
  getIReports360Config,
} from "@/lib/field-workforce-compliance/ireports360-config";
import {
  iReports360GetCheckins,
  iReports360GetVisits,
  iReports360Login,
  type IReports360Checkin,
  type IReports360Visit,
} from "@/lib/field-workforce-compliance/ireports360-client";
import { isFieldWorkforceComplianceEligibleTitle } from "@/lib/field-workforce-compliance/eligibility";
import { getEgyptianNationalHolidays } from "@/lib/vacation/national-holidays";

type DirectoryRow = Awaited<ReturnType<typeof getEmployeeDirectoryRows>>[number];

const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Non-regular visit types -> compliance status. Regular (0) is handled as a count. */
const VISIT_TYPE_TO_STATUS = new Map<number, "AV" | "CP">([
  [-1, "CP"], // Conference
  [-2, "CP"], // Group Meeting
  [-4, "AV"], // Annual Vacation
  [-8, "CP"], // Campaign (Prospection)
  [-9, "CP"], // Training
  [-11, "CP"], // Meeting
  [-12, "CP"], // Traveling
  [-15, "AV"], // Health Day
]);

/** Subset of the employee directory that the matrix builder reads. */
export type FieldWorkforceEmployeeInput = Pick<
  DirectoryRow,
  | "crmId"
  | "crmUsername"
  | "employmentStatus"
  | "fullName"
  | "hireDate"
  | "hrId"
  | "jobTitle"
  | "positionTitle"
>;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function isFridayIso(dateIso: string): boolean {
  return new Date(`${dateIso}T00:00:00Z`).getUTCDay() === 5;
}

/** Strips the "( Area / Line )" annotation and normalises "First.Last" -> "first last". */
export function normalizeAgentName(name: string | null | undefined): string {
  return String(name ?? "")
    .split("(")[0]
    .replace(/\./g, " ")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/** Employees who have left the company are not rendered in the monthly report. */
function isDepartedStatus(status: string | null | undefined): boolean {
  const normalized = String(status ?? "").trim().toLowerCase();
  return normalized === "terminated" || normalized === "resigned" || normalized === "inactive";
}

/** Maps a single agent-day's visit records to a compliance cell value. */
function dayCellValue(visits: IReports360Visit[]): number | "AV" | "CP" {
  const regular = visits.reduce((count, visit) => count + (visit.visitType === 0 ? 1 : 0), 0);
  if (regular > 0) return regular;

  let hasCp = false;
  let hasAv = false;
  for (const visit of visits) {
    const mapped = VISIT_TYPE_TO_STATUS.get(visit.visitType) ?? "CP";
    if (mapped === "AV") hasAv = true;
    else hasCp = true;
  }
  return hasCp ? "CP" : hasAv ? "AV" : "CP";
}

/**
 * Builds the Field Workforce Compliance matrix (header row + one row per EMPLOYEE) for a
 * month of iReports360 visits. The report is **employee-driven**: every eligible, active
 * Phoenix employee gets a row even with zero visits, so fully-absent reps and non-visiting
 * managers still appear (and can be reviewed for deductions). Agents in the visit feed that
 * map to no eligible employee are ignored. The output is consumed by the existing
 * parseFieldWorkforceComplianceMatrix, so dateColumns/validation stay identical.
 */
export function buildIReports360FieldWorkforceMatrix(input: {
  employees: FieldWorkforceEmployeeInput[];
  month: number;
  todayIso?: string | null;
  visits: IReports360Visit[];
  year: number;
}): { matrix: unknown[][] } {
  const { employees, month, visits, year } = input;
  const todayIso = input.todayIso ?? null;
  const monthPrefix = `${year}-${pad2(month)}`;
  const dayCount = daysInMonth(year, month);
  const dateIsos = Array.from({ length: dayCount }, (_, index) => `${monthPrefix}-${pad2(index + 1)}`);

  // Credit each visit to BOTH its primary agent AND its joint/"double" partner, indexing
  // ids by normalized name (a username fallback for employees with a CRM username but no
  // CRM id). Managers and senior staff often only ride along on reps' visits as the
  // doubleID, so without this they would wrongly show zero worked days.
  const visitsByParticipant = new Map<number, IReports360Visit[]>();
  const agentIdByName = new Map<string, number>();
  const creditVisit = (participantId: number, name: string | null, visit: IReports360Visit) => {
    if (!visitsByParticipant.has(participantId)) visitsByParticipant.set(participantId, []);
    visitsByParticipant.get(participantId)!.push(visit);
    const nameKey = normalizeAgentName(name);
    if (nameKey && !agentIdByName.has(nameKey)) agentIdByName.set(nameKey, participantId);
  };
  for (const visit of visits) {
    const dayIso = (visit.visitDate ?? "").slice(0, 10);
    if (!dayIso.startsWith(monthPrefix)) continue;
    creditVisit(visit.agentID, visit.agentName, visit);
    if (visit.doubleID != null && visit.doubleID !== visit.agentID) {
      creditVisit(visit.doubleID, visit.doubleName, visit);
    }
  }

  const header: unknown[] = ["TM", "HR ID", "Hiring Date", "Month", "Year", ...dateIsos];
  const matrix: unknown[][] = [header];

  const eligible = employees
    .filter((employee) => isFieldWorkforceComplianceEligibleTitle(employee.jobTitle, employee.positionTitle))
    .filter((employee) => !isDepartedStatus(employee.employmentStatus))
    .sort((left, right) =>
      String(left.hrId).localeCompare(String(right.hrId), undefined, { numeric: true }));

  for (const employee of eligible) {
    const crmId = employee.crmId == null ? "" : String(employee.crmId).trim();
    let agentId = crmId && /^\d+$/.test(crmId) ? Number(crmId) : Number.NaN;
    if (!Number.isFinite(agentId)) {
      const byName = agentIdByName.get(normalizeAgentName(employee.crmUsername));
      if (byName != null) agentId = byName;
    }
    const agentVisits = Number.isFinite(agentId) ? visitsByParticipant.get(agentId) ?? [] : [];

    const byDay = new Map<string, IReports360Visit[]>();
    for (const visit of agentVisits) {
      const dayIso = (visit.visitDate ?? "").slice(0, 10);
      if (!byDay.has(dayIso)) byDay.set(dayIso, []);
      byDay.get(dayIso)!.push(visit);
    }

    const dayCells = dateIsos.map((dateIso) => {
      const dayVisits = byDay.get(dateIso);
      if (dayVisits && dayVisits.length > 0) return dayCellValue(dayVisits);
      if (isFridayIso(dateIso)) return null;
      if (todayIso && dateIso > todayIso) return null;
      return "N";
    });

    matrix.push([
      employee.fullName ?? "",
      employee.hrId,
      employee.hireDate ? String(employee.hireDate).slice(0, 10) : "",
      month,
      year,
      ...dayCells,
    ]);
  }

  return { matrix };
}

function toEmployeeReference(employee: DirectoryRow): FieldWorkforceEmployeeReference {
  return {
    areaName: employee.areaName,
    departmentName: employee.departmentName,
    employmentStatus: employee.employmentStatus,
    fullName: employee.fullName,
    hireDate: employee.hireDate,
    hrId: employee.hrId,
    jobTitle: employee.jobTitle,
    lineName: employee.lineName,
    managerName: employee.managerName,
    roleName: employee.positionTitle ?? employee.jobTitle,
    teamName: employee.teamName,
  };
}

async function loadHolidays(month: number, year: number): Promise<{
  connected: boolean;
  holidays: FieldWorkforceHoliday[];
  message: string | null;
  sourceLabel: string;
}> {
  try {
    const result = await getEgyptianNationalHolidays({ month, year });
    return {
      connected: result.connected,
      holidays: result.holidays.map((holiday) => ({
        endDate: holiday.endDate,
        name: holiday.name,
        startDate: holiday.startDate,
      })),
      message: result.message,
      sourceLabel: result.sourceLabel,
    };
  } catch (error) {
    return {
      connected: false,
      holidays: [],
      message: error instanceof Error ? error.message : "National holiday lookup failed.",
      sourceLabel: "Egypt public holidays",
    };
  }
}

/**
 * Live-data equivalent of buildFieldWorkforceCompliancePreviewFromWorkbook: fetches a
 * month of iReports360 visits, maps them onto the compliance matrix, and runs the
 * existing classifier to produce the same FieldWorkforcePreviewResult.
 */
export async function buildFieldWorkforceCompliancePreviewFromIReports360(input: {
  month: number;
  todayIso?: string | null;
  year: number;
}): Promise<FieldWorkforcePreviewResult> {
  const { month, year } = input;
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new FieldWorkforcePreviewError({
      code: "invalid_month",
      message: "Select a month between 1 and 12.",
      status: 400,
    });
  }
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new FieldWorkforcePreviewError({
      code: "invalid_year",
      message: "Select a valid year.",
      status: 400,
    });
  }

  const config = getIReports360Config();
  const token = await iReports360Login(config);
  const startDate = `${year}-${pad2(month)}-01`;
  const endDate = `${year}-${pad2(month)}-${pad2(daysInMonth(year, month))}`;

  const [visits, directory] = await Promise.all([
    iReports360GetVisits(config, token, startDate, endDate),
    getEmployeeDirectoryRows({ includeInactive: true }),
  ]);

  const { matrix } = buildIReports360FieldWorkforceMatrix({
    employees: directory,
    month,
    todayIso: input.todayIso ?? null,
    visits,
    year,
  });

  const parsed = parseFieldWorkforceComplianceMatrix({
    fileName: `iReports360 ${MONTH_LABELS[month - 1]} ${year}`,
    matrix,
    sheetName: "iReports360 Visits",
  });

  const holidays = await loadHolidays(month, year);

  return buildFieldWorkforceCompliancePreview({
    employeeReferences: directory.map(toEmployeeReference),
    holidayConnected: holidays.connected,
    holidayMessage: holidays.message,
    holidaySourceLabel: holidays.sourceLabel,
    holidays: holidays.holidays,
    parsed,
  });
}

/** Readable partner name for display: strips the "( Area / Line )" annotation and dots, keeps case. */
function cleanAgentDisplayName(name: string | null | undefined): string | null {
  const cleaned = String(name ?? "").split("(")[0].replace(/\./g, " ").replace(/\s+/g, " ").trim();
  return cleaned || null;
}

export type IReports360RepDayVisit = IReports360Visit & {
  kind: "campaign" | "regular";
  mode: "single" | "double";
  partnerName: string | null;
  role: "primary" | "double";
};

export type IReports360DayRouteLeg = {
  distanceKm: number | null;
  durationMinutes: number | null;
};

export type IReports360DayRoute = {
  encodedPolyline: string | null;
  legs: IReports360DayRouteLeg[];
};

// In-memory cache of computed driving routes, keyed by rep + day + the exact ordered
// check-in coordinates (so corrected GPS recomputes under a new key). A historical
// rep-day's route never changes, so each unique rep-day costs at most ONE Google Routes
// API call per server process — keeping usage well inside the free monthly tier. Mirrors
// the in-memory holiday cache pattern in national-holidays.ts.
const routeCache = new Map<string, IReports360DayRoute>();
const ROUTE_CACHE_MAX = 5000;

function routeCacheKey(hrId: string, day: string, stops: Array<{ lat: number; lng: number }>): string {
  const coords = stops.map((stop) => `${stop.lat.toFixed(5)},${stop.lng.toFixed(5)}`).join("|");
  return `${hrId}::${day}::${coords}`;
}

/**
 * Driving route through the day's check-ins, cached so a given rep-day hits the Google
 * Routes API at most once. Failures are NOT cached, so it retries automatically once the
 * Maps key is allowed to call the Routes API.
 */
async function getCachedDrivingRoute(
  hrId: string,
  day: string,
  stops: Array<{ lat: number; lng: number }>,
): Promise<IReports360DayRoute | null> {
  if (stops.length < 2) return null;
  const cacheKey = routeCacheKey(hrId, day, stops);
  const cached = routeCache.get(cacheKey);
  if (cached) return cached;

  const drivingRoute = await googleRouteThroughStops(stops);
  if (!drivingRoute) return null;

  const route: IReports360DayRoute = {
    encodedPolyline: drivingRoute.encodedPolyline,
    legs: drivingRoute.legs.map((leg) => ({
      distanceKm: leg.distanceMeters != null ? Math.round((leg.distanceMeters / 1000) * 10) / 10 : null,
      durationMinutes: leg.durationSeconds != null ? Math.round(leg.durationSeconds / 60) : null,
    })),
  };
  if (routeCache.size >= ROUTE_CACHE_MAX) routeCache.clear();
  routeCache.set(cacheKey, route);
  return route;
}

/**
 * Read-only drill-down for the "click a visit day" page: the visit records AND the GPS
 * check-ins one rep logged on one day. Resolves the rep's crm_id from the directory, pulls
 * that single day from iReports360 (one login, visits + check-ins in parallel), and keeps the
 * records where the rep is the primary agent OR the joined double-visit partner. Each visit is
 * annotated with kind (campaign/regular), the rep's role, single/double mode, and the partner.
 * Check-ins are sorted by time so the page can draw the rep's route in order.
 */
export async function getIReports360RepDayVisits(input: { date: string; hrId: string }): Promise<{
  checkins: IReports360Checkin[];
  rep: { crmId: string | null; fullName: string | null; hrId: string } | null;
  route: IReports360DayRoute | null;
  visits: IReports360RepDayVisit[];
}> {
  const day = input.date.slice(0, 10);
  const directory = await getEmployeeDirectoryRows();
  const key = canonicalHrIdKey(input.hrId);
  const employee = directory.find((row) => canonicalHrIdKey(row.hrId) === key) ?? null;
  if (!employee) return { checkins: [], rep: null, route: null, visits: [] };

  const rep = {
    crmId: employee.crmId == null ? null : String(employee.crmId),
    fullName: employee.fullName ?? null,
    hrId: employee.hrId,
  };
  if (!rep.crmId) return { checkins: [], rep, route: null, visits: [] };

  const config = getIReports360Config();
  const token = await iReports360Login(config);
  const agentId = Number(rep.crmId);
  // Visits are required for this page; GPS check-ins are a best-effort overlay, so a
  // check-ins API problem must never break the core visit drill-down.
  const [allVisits, allCheckins] = await Promise.all([
    iReports360GetVisits(config, token, day, day),
    iReports360GetCheckins(config, token, day, day).catch(() => [] as IReports360Checkin[]),
  ]);
  // Include records where the rep is the primary agent OR the double-visit partner, and
  // annotate each so the table can show campaign/regular + single/double + with whom.
  const visits: IReports360RepDayVisit[] = allVisits
    .filter(
      (visit) =>
        (visit.agentID === agentId || visit.doubleID === agentId) &&
        (visit.visitDate ?? "").slice(0, 10) === day,
    )
    .map((visit) => {
      const role: "primary" | "double" = visit.agentID === agentId ? "primary" : "double";
      const hasPartner = visit.doubleID != null && visit.doubleID !== 0;
      const partnerName = hasPartner
        ? cleanAgentDisplayName(role === "primary" ? visit.doubleName : visit.agentName)
        : null;
      return {
        ...visit,
        kind: (visit.contactName ?? "").trim() ? "regular" : "campaign",
        mode: hasPartner ? "double" : "single",
        partnerName,
        role,
      };
    });
  const checkins = allCheckins
    .filter((checkin) => checkin.agentID === agentId && (checkin.checkDate ?? "").slice(0, 10) === day)
    .sort((left, right) => String(left.checkDate).localeCompare(String(right.checkDate)));

  // Cached Google driving route through the coordinate-bearing check-ins (in time order),
  // aligned to the same filter+sort the map uses so leg[i] is stop[i] -> stop[i+1].
  const stops = checkins
    .filter((checkin) => Number.isFinite(checkin.lat) && Number.isFinite(checkin.lon))
    .map((checkin) => ({ lat: checkin.lat as number, lng: checkin.lon as number }));
  const route = await getCachedDrivingRoute(rep.hrId, day, stops);

  return { checkins, rep, route, visits };
}
