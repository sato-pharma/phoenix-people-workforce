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
  iReports360GetVisits,
  iReports360Login,
  type IReports360Visit,
} from "@/lib/field-workforce-compliance/ireports360-client";
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

export type IReports360ResolvedAgent = {
  fullName: string | null;
  hireDateIso: string | null;
  hrId: string;
};

export type IReports360AgentResolver = {
  resolve(agentId: number, agentName: string | null): IReports360ResolvedAgent | null;
};

export type IReports360UnresolvedAgent = {
  agentId: number;
  agentName: string | null;
  visitCount: number;
};

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

/** Builds a resolver from the employee directory: CRM id (primary) then CRM username. */
export function buildAgentResolver(directory: DirectoryRow[]): IReports360AgentResolver {
  const byCrmId = new Map<string, DirectoryRow>();
  const byCrmUsername = new Map<string, DirectoryRow>();

  for (const employee of directory) {
    const crmId = employee.crmId == null ? "" : String(employee.crmId).trim();
    if (crmId && !byCrmId.has(crmId)) byCrmId.set(crmId, employee);

    const usernameKey = normalizeAgentName(employee.crmUsername);
    if (usernameKey && !byCrmUsername.has(usernameKey)) byCrmUsername.set(usernameKey, employee);
  }

  return {
    resolve(agentId, agentName) {
      const match =
        byCrmId.get(String(agentId)) ??
        (agentName ? byCrmUsername.get(normalizeAgentName(agentName)) : undefined);
      if (!match) return null;
      return {
        fullName: match.fullName ?? null,
        hireDateIso: match.hireDate ? String(match.hireDate).slice(0, 10) : null,
        hrId: match.hrId,
      };
    },
  };
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
 * Builds the Field Workforce Compliance matrix (header row + one row per agent) from
 * a month of iReports360 visits. The output is consumed by the existing
 * parseFieldWorkforceComplianceMatrix, so dateColumns/validation stay identical.
 */
export function buildIReports360FieldWorkforceMatrix(input: {
  month: number;
  resolver: IReports360AgentResolver;
  todayIso?: string | null;
  visits: IReports360Visit[];
  year: number;
}): { matrix: unknown[][]; unresolvedAgents: IReports360UnresolvedAgent[] } {
  const { month, resolver, visits, year } = input;
  const todayIso = input.todayIso ?? null;
  const monthPrefix = `${year}-${pad2(month)}`;
  const dayCount = daysInMonth(year, month);
  const dateIsos = Array.from({ length: dayCount }, (_, index) => `${monthPrefix}-${pad2(index + 1)}`);

  const visitsByAgent = new Map<number, IReports360Visit[]>();
  const agentNameById = new Map<number, string | null>();
  for (const visit of visits) {
    const dayIso = (visit.visitDate ?? "").slice(0, 10);
    if (!dayIso.startsWith(monthPrefix)) continue;
    if (!visitsByAgent.has(visit.agentID)) {
      visitsByAgent.set(visit.agentID, []);
      agentNameById.set(visit.agentID, visit.agentName ?? null);
    }
    visitsByAgent.get(visit.agentID)!.push(visit);
  }

  const header: unknown[] = ["TM", "HR ID", "Hiring Date", "Month", "Year", ...dateIsos];
  const matrix: unknown[][] = [header];
  const unresolvedAgents: IReports360UnresolvedAgent[] = [];

  const agentIds = [...visitsByAgent.keys()].sort((left, right) => left - right);
  for (const agentId of agentIds) {
    const agentVisits = visitsByAgent.get(agentId) ?? [];
    const agentName = agentNameById.get(agentId) ?? null;
    const resolved = resolver.resolve(agentId, agentName);
    if (!resolved) {
      unresolvedAgents.push({ agentId, agentName, visitCount: agentVisits.length });
    }

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
      resolved?.fullName ?? agentName ?? "",
      resolved?.hrId ?? "",
      resolved?.hireDateIso ?? "",
      month,
      year,
      ...dayCells,
    ]);
  }

  return { matrix, unresolvedAgents };
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

  const resolver = buildAgentResolver(directory);
  const { matrix } = buildIReports360FieldWorkforceMatrix({
    month,
    resolver,
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
