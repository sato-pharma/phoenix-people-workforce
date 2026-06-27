import {
  type AccessContext,
  normalizeHrId,
  normalizeLineName,
} from "@/lib/auth/permissions";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { applyOrganogramMirrorSafety } from "@/lib/reports/organogram-safety";
import {
  getVacancyReport,
  type VacancyReportData,
  type VacancyReportDiagnostic,
} from "@/lib/reports/vacancies";

export type OrganogramScopeMode = "company" | "line";

export type OrganogramReportOptions = {
  lineName?: string | null;
  mode: OrganogramScopeMode;
};

const emptyReport = (
  diagnostic?: VacancyReportDiagnostic,
): VacancyReportData => ({
  ...(diagnostic ? { diagnostic } : {}),
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
    access.role === "CEO" ||
    access.role === "Marketing Manager" ||
    access.role === "Training Manager"
  );
}

export function isPortalOrganogramRole(access: AccessContext) {
  return access.role === "National Sales Manager";
}

export function isLineScopedOrganogramRole(access: AccessContext) {
  // Marketing Manager is intentionally NOT here: it has company-wide oversight via
  // canAccessCompanyOrganogram, so a line-scoped entry was dead code that misrepresented
  // its scope. (Head-of-department company-wide org visibility is the intended behavior.)
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
    return emptyReport({
      code: "line_unresolved",
      message:
        "We couldn't resolve your line scope. Ask HR to set your `line_name` on the employee record so the organogram can render your team.",
    });
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
    return emptyReport({
      code: "company_scope_denied",
      message:
        "Your role does not have company-wide organogram access. This is enforced server-side; navigation visibility is not the security boundary.",
    });
  }

  if (options.mode === "line" && !isLineScopedOrganogramRole(access)) {
    return emptyReport({
      code: "line_scope_denied",
      message:
        "Your role is not configured for line-scoped organogram access. Contact HR governance if this looks wrong.",
    });
  }

  if (options.mode === "line" && !options.lineName) {
    return emptyReport({
      code: "line_unresolved",
      message:
        "We couldn't resolve your line scope. Ask HR to set your `line_name` on the employee record so the organogram can render your team.",
    });
  }

  const report = await getVacancyReport();
  return scopeOrganogramReportData(report, options);
}
