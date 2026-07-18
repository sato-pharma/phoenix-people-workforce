import {
  type AccessContext,
  normalizeHrId,
  normalizeHrIdForAccess,
  normalizeLineName,
} from "@/lib/auth/permissions";
import { resolveViewerAllowedLines } from "@/lib/auth/scope-visibility";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { applyOrganogramMirrorSafety } from "@/lib/reports/organogram-safety";
import {
  getVacancyReport,
  isEmployeeVisibleInOrganogram,
  type OrganogramReportRow,
  type VacancyReportData,
  type VacancyReportDiagnostic,
} from "@/lib/reports/vacancies";
import { buildOrganogramSeatReport, scopeAuOrganogramRows } from "@/lib/reports/organogram-au-source";

export type OrganogramScopeMode = "company" | "line";

export type OrganogramReportOptions = {
  lineName?: string | null;
  /** Multi-line override: when set, all named lines are shown instead of a single lineName. */
  lineNames?: string[] | null;
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

export function canAccessHeadOffice(access: AccessContext) {
  return access.role === "Super Admin" || access.role === "CEO" || access.scope === "system";
}

// Head Office (line_id = 4) serves all lines and is CEO/Super-Admin-only. Detect
// it by the canonical numeric line_id first (rename-safe), falling back to the
// line-name variants for rows whose id isn't populated.
const HEAD_OFFICE_LINE_ID = 4;
export function isHeadOfficeRow(row: { lineId?: number | null; lineName: string | null | undefined }) {
  if (row.lineId === HEAD_OFFICE_LINE_ID) return true;
  const line = row.lineName?.trim().toLowerCase();
  return line === "office" || line === "head office";
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

// Shared Head Office suppression so the organogram and the vacancies report apply
// the exact same boundary for non-privileged company viewers.
function stripHeadOfficeRows(report: VacancyReportData): VacancyReportData {
  const filtered = {
    ...report,
    organogramRows: report.organogramRows.filter((row) => !isHeadOfficeRow(row)),
    rows: report.rows.filter((row) => !isHeadOfficeRow(row)),
  };

  return { ...filtered, summary: recalculateSummary(filtered) };
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

// Talent Acquisition holds `vacancies` permission for company-wide recruiting but is not
// an organogram-visibility role, so it sits outside canAccessCompanyOrganogram.
export function canAccessCompanyVacancies(access: AccessContext) {
  return canAccessCompanyOrganogram(access) || access.role === "Talent Acquisition";
}

// District Manager sees only vacancies reporting directly to them (their own team's open
// seats), matching getEmployeePortalVacancies' manager_hr_id scoping.
export function isTeamScopedVacancyRole(access: AccessContext) {
  return access.role === "District Manager";
}

function scopeVacancyReportToTeam(
  report: VacancyReportData,
  access: AccessContext,
): VacancyReportData {
  const managerKey = normalizeHrIdForAccess(access.hrId);
  if (!managerKey) {
    return emptyReport({
      code: "team_unresolved",
      message: "We couldn't resolve your HR ID to scope vacancy reports to your team.",
    });
  }

  const matchesManager = (managerHrId: string | null | undefined) =>
    normalizeHrIdForAccess(managerHrId) === managerKey;

  const scopedReport = {
    ...report,
    organogramRows: applyOrganogramMirrorSafety(
      report.organogramRows.filter((row) => matchesManager(row.managerHrId)),
    ),
    rows: report.rows.filter((row) => matchesManager(row.managerHrId)),
  };

  return { ...scopedReport, summary: recalculateSummary(scopedReport) };
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

  // Multi-line override path: when lineNames is provided with ≥1 entry, show all
  // matching lines (e.g. Ahmed Sharaf spanning Pedia + Anti infective).
  if (options.lineNames && options.lineNames.length > 0) {
    const allowedNormalized = options.lineNames.map((l) => normalizeLineName(l)).filter(Boolean);
    const matchesAny = (rowLine: string | null | undefined) => {
      const n = normalizeLineName(rowLine);
      return Boolean(n && allowedNormalized.includes(n));
    };

    // Keep the allowed-line employees AND their management chain upward, so the reporting
    // hierarchy stays connected to the top even when a manager sits on another line — e.g. a
    // Product Manager spanning Pedia + Anti infective still shows his Group Product Manager and,
    // above that, the Marketing Manager who sits on the Head Office line. Without this the line
    // filter orphans the subtree at the first cross-line manager.
    const rowByHrId = new Map<string, OrganogramReportRow>();
    for (const row of report.organogramRows) {
      const key = normalizeHrIdForAccess(row.hrId);
      if (key && !rowByHrId.has(key)) rowByHrId.set(key, row);
    }
    const ancestorHrIds = new Set<string>();
    for (const row of report.organogramRows) {
      if (!matchesAny(row.lineName)) continue;
      let managerKey = normalizeHrIdForAccess(row.managerHrId);
      while (managerKey && !ancestorHrIds.has(managerKey)) {
        ancestorHrIds.add(managerKey);
        const managerRow = rowByHrId.get(managerKey);
        managerKey = managerRow ? normalizeHrIdForAccess(managerRow.managerHrId) : null;
      }
    }
    const keepOrganogramRow = (row: OrganogramReportRow) =>
      matchesAny(row.lineName) || ancestorHrIds.has(normalizeHrIdForAccess(row.hrId) ?? "");

    const scopedReport = {
      ...report,
      organogramRows: applyOrganogramMirrorSafety(
        report.organogramRows.filter(keepOrganogramRow),
      ),
      rows: report.rows.filter((row) => matchesAny(row.lineName)),
    };
    return { ...scopedReport, summary: recalculateSummary(scopedReport) };
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
      isEmployeeVisibleInOrganogram(employee.employmentStatus) &&
      employee.organogramVisible !== false,
  );

  return currentEmployee?.lineName?.trim() || null;
}

/**
 * Like resolveOrganogramLineForEmployee but returns an array when the user has a
 * line_scope_override (e.g. Ahmed Sharaf spanning two lines). Returns null when the
 * role does not use line-scoped organogram access.
 */
export async function resolveOrganogramLinesForEmployee(
  access: AccessContext,
): Promise<string[] | null> {
  if (!access.hrId || !isLineScopedOrganogramRole(access)) return null;

  const [lineOverride, singleLine] = await Promise.all([
    resolveViewerAllowedLines(access),
    resolveOrganogramLineForEmployee(access),
  ]);

  if (lineOverride && lineOverride.length > 0) return lineOverride;
  if (singleLine) return [singleLine];
  return null;
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

  const hasLineScope =
    (options.lineNames && options.lineNames.length > 0) || Boolean(options.lineName);
  if (options.mode === "line" && !hasLineScope) {
    return emptyReport({
      code: "line_unresolved",
      message:
        "We couldn't resolve your line scope. Ask HR to set your `line_name` on the employee record so the organogram can render your team.",
    });
  }

  // Area-unification rebuild: organogram rows now come from the seat model (au),
  // not the manager_hr_id + job-title heuristics. Access scoping + Head Office
  // stripping are preserved.
  const seatReport = await buildOrganogramSeatReport();
  let scopedRows = scopeAuOrganogramRows(seatReport.organogramRows, options);

  if (options.mode === "company" && !canAccessHeadOffice(access)) {
    scopedRows = scopedRows.filter((row) => !isHeadOfficeRow(row));
  }

  return { organogramRows: scopedRows, rows: [], summary: seatReport.summary };
}

/**
 * The single scoped entry point for the vacancy report (`app/api/reports/vacancies`,
 * the admin vacancies page, and the admin-shell workspace vacancies page). Classifies
 * the caller's role into company-wide / line-scoped / team-scoped and filters
 * accordingly — mirrors the getOrganogramReport pattern above, extended with the two
 * roles unique to the `vacancies` permission (Talent Acquisition, District Manager).
 */
export async function getScopedVacancyReport(access: AccessContext): Promise<VacancyReportData> {
  if (canAccessCompanyVacancies(access)) {
    const report = await getVacancyReport();
    // Mirror the organogram's Head Office boundary: company-org roles without
    // head-office access (Marketing / Training Manager) must not see Head Office
    // vacancies either. Talent Acquisition recruits for Head Office, so it is
    // unaffected; privileged roles (CEO / Super Admin / system) see everything.
    if (canAccessCompanyOrganogram(access) && !canAccessHeadOffice(access)) {
      return stripHeadOfficeRows(report);
    }
    return report;
  }

  if (isLineScopedOrganogramRole(access)) {
    const [report, lineNames] = await Promise.all([
      getVacancyReport(),
      resolveOrganogramLinesForEmployee(access),
    ]);

    if (!lineNames || lineNames.length === 0) {
      return emptyReport({
        code: "line_unresolved",
        message:
          "We couldn't resolve your line scope. Ask HR to set your `line_name` on the employee record so vacancies can be scoped to your line.",
      });
    }

    return scopeOrganogramReportData(report, { lineNames, mode: "line" });
  }

  if (isTeamScopedVacancyRole(access)) {
    const report = await getVacancyReport();
    return scopeVacancyReportToTeam(report, access);
  }

  return emptyReport({
    code: "vacancy_scope_denied",
    message:
      "Your role is not configured for vacancy report access. This is enforced server-side; navigation visibility is not the security boundary.",
  });
}
