import {
  type AccessContext,
  normalizeHrId,
  normalizeLineName,
} from "@/lib/auth/permissions";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { applyOrganogramMirrorSafety } from "@/lib/reports/organogram-safety";
import { getVacancyReport, type VacancyReportData } from "@/lib/reports/vacancies";

export type OrganogramScopeMode = "company" | "line";

export type OrganogramReportOptions = {
  lineName?: string | null;
  mode: OrganogramScopeMode;
};

const emptyReport = (): VacancyReportData => ({
  organogramRows: [],
  rows: [],
  summary: {
    areasAffected: 0,
    linesAffected: 0,
    openVacancies: 0,
    positionsAffected: 0,
    totalVacancies: 0,
  },
});

function uniqueCount(values: Array<string | null>) {
  return new Set(values.filter(Boolean)).size;
}

function activeOrganogramStatus(status: string | null | undefined) {
  const normalized = String(status ?? "active").trim().toLowerCase();
  return normalized === "active" || normalized === "on_leave";
}

function lineMatches(actual: string | null | undefined, expected: string | null | undefined) {
  const actualLine = normalizeLineName(actual);
  const expectedLine = normalizeLineName(expected);

  return Boolean(actualLine && expectedLine && actualLine === expectedLine);
}

function recalculateSummary(report: VacancyReportData): VacancyReportData["summary"] {
  const openRows = report.rows.filter((row) => row.status === "open");

  return {
    areasAffected: uniqueCount(openRows.map((row) => row.areaName)),
    linesAffected: uniqueCount(openRows.map((row) => row.lineName)),
    openVacancies: openRows.length,
    positionsAffected: uniqueCount(openRows.map((row) => row.positionTitle ?? row.jobTitle)),
    totalVacancies: report.rows.length,
  };
}

export function canAccessCompanyOrganogram(access: AccessContext) {
  return (
    access.scope === "system" ||
    access.role === "Super Admin" ||
    access.role === "CEO"
  );
}

export function isPortalOrganogramRole(access: AccessContext) {
  return access.role === "National Sales Manager";
}

export function isLineScopedOrganogramRole(access: AccessContext) {
  return (
    access.role === "National Sales Manager" ||
    access.role === "Product Manager" ||
    access.role === "Group Product Manager"
  );
}

export function scopeOrganogramReportData(
  report: VacancyReportData,
  options: OrganogramReportOptions,
): VacancyReportData {
  if (options.mode === "company") {
    const scopedReport = {
      ...report,
      organogramRows: applyOrganogramMirrorSafety(report.organogramRows),
    };

    return {
      ...scopedReport,
      summary: recalculateSummary(scopedReport),
    };
  }

  if (!options.lineName) {
    return emptyReport();
  }

  const scopedReport = {
    ...report,
    organogramRows: applyOrganogramMirrorSafety(
      report.organogramRows.filter((row) => lineMatches(row.lineName, options.lineName)),
    ),
    rows: report.rows.filter((row) => lineMatches(row.lineName, options.lineName)),
  };

  return {
    ...scopedReport,
    summary: recalculateSummary(scopedReport),
  };
}

export async function resolveOrganogramLineForEmployee(access: AccessContext) {
  if (!access.hrId || !isLineScopedOrganogramRole(access)) {
    return null;
  }

  const directory = await getEmployeeDirectory();
  const currentHrId = normalizeHrId(access.hrId);
  const currentEmployee = directory.employees.find(
    (employee) =>
      normalizeHrId(employee.hrId) === currentHrId &&
      activeOrganogramStatus(employee.employmentStatus) &&
      employee.organogramVisible !== false &&
      employee.payrollEligible !== false,
  );

  return currentEmployee?.lineName?.trim() || null;
}

export async function getOrganogramReport(
  access: AccessContext,
  options: OrganogramReportOptions = { mode: "company" },
): Promise<VacancyReportData> {
  if (options.mode === "company" && !canAccessCompanyOrganogram(access)) {
    return emptyReport();
  }

  if (options.mode === "line" && (!isLineScopedOrganogramRole(access) || !options.lineName)) {
    return emptyReport();
  }

  const report = await getVacancyReport();
  return scopeOrganogramReportData(report, options);
}
