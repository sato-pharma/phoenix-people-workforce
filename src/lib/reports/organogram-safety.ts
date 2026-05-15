import type { AccessContext } from "@/lib/auth/permissions";
import type {
  OrganogramReportRow,
  VacancyReportData,
  VacancyReportRow,
} from "@/lib/reports/vacancies";

export type OrganogramDiagnostic = {
  code: "circular_manager" | "missing_manager" | "self_manager";
  count: number;
};

export type OrganogramKpiBreakdown = {
  actual: number;
  total: number;
  vacant: number;
};

export type OrganogramStructureKpis = {
  dsms: OrganogramKpiBreakdown;
  medicalReps: OrganogramKpiBreakdown;
  nsms: OrganogramKpiBreakdown;
  rsms: OrganogramKpiBreakdown;
  totalLineStructure: OrganogramKpiBreakdown;
};

function normalizeKey(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeHrId(value: string | null | undefined) {
  return normalizeKey(value).toUpperCase();
}

function normalizeTitle(value: string | null | undefined) {
  return normalizeKey(value).replace(/\s+/g, " ");
}

function emptyKpiBreakdown(): OrganogramKpiBreakdown {
  return {
    actual: 0,
    total: 0,
    vacant: 0,
  };
}

function structureLevelForTitle(row: OrganogramReportRow) {
  const title = normalizeTitle(row.positionTitle ?? row.jobTitle);

  if (title.includes("medical representative") || title.includes("medical rep")) {
    return "medicalReps" as const;
  }

  if (
    title.includes("district sales manager") ||
    title.includes("district manager") ||
    title === "dsm"
  ) {
    return "dsms" as const;
  }

  if (title.includes("national sales manager") || title === "nsm") {
    return "nsms" as const;
  }

  if (title.includes("regional sales manager") || title === "rsm") {
    return "rsms" as const;
  }

  return null;
}

export function calculateOrganogramStructureKpis(
  rows: OrganogramReportRow[],
): OrganogramStructureKpis {
  const kpis: OrganogramStructureKpis = {
    dsms: emptyKpiBreakdown(),
    medicalReps: emptyKpiBreakdown(),
    nsms: emptyKpiBreakdown(),
    rsms: emptyKpiBreakdown(),
    totalLineStructure: emptyKpiBreakdown(),
  };

  for (const row of rows) {
    const level = structureLevelForTitle(row);

    if (!level) {
      continue;
    }

    const target = kpis[level];

    if (row.type === "vacancy") {
      target.vacant += 1;
      kpis.totalLineStructure.vacant += 1;
    } else {
      target.actual += 1;
      kpis.totalLineStructure.actual += 1;
    }
  }

  for (const breakdown of [
    kpis.medicalReps,
    kpis.dsms,
    kpis.nsms,
    kpis.rsms,
    kpis.totalLineStructure,
  ]) {
    breakdown.total = breakdown.actual + breakdown.vacant;
  }

  return kpis;
}

type SlotIdentity = {
  areaId?: number | null;
  areaName?: string | null;
  departmentId?: number | null;
  departmentName?: string | null;
  jobTitle?: string | null;
  lineId?: number | null;
  lineName?: string | null;
  managerHrId?: string | null;
  positionId?: number | null;
  positionTitle?: string | null;
  teamId?: number | null;
  teamName?: string | null;
};

function idOrName(id: number | null | undefined, name: string | null | undefined) {
  if (typeof id === "number" && Number.isFinite(id)) {
    return `id:${id}`;
  }

  const normalizedName = normalizeKey(name);
  return normalizedName ? `name:${normalizedName}` : null;
}

function strictPositionSlotKey(row: SlotIdentity) {
  const managerHrId = normalizeHrId(row.managerHrId);
  const line = idOrName(row.lineId, row.lineName);
  const area = idOrName(row.areaId, row.areaName);
  const team = idOrName(row.teamId, row.teamName) ?? "none";
  const position = idOrName(row.positionId, row.positionTitle) ?? normalizeTitle(row.jobTitle);
  const department = idOrName(row.departmentId, row.departmentName) ?? "none";

  if (!managerHrId || !line || !area || !position) {
    return null;
  }

  if (!position) {
    return null;
  }

  return [
    `manager:${managerHrId}`,
    `line:${line}`,
    `area:${area}`,
    `team:${team}`,
    `position:${position}`,
    `department:${department}`,
  ].join("|");
}

function isCompanyWideAccess(access: AccessContext) {
  return (
    access.scope === "system" ||
    access.role === "Super Admin" ||
    access.role === "CEO" ||
    access.role === "HR Specialist"
  );
}

function buildEmployeeMap(rows: OrganogramReportRow[]) {
  const employees = rows.filter((row) => row.type === "employee");

  return new Map(
    employees
      .map((row) => [normalizeHrId(row.hrId), row] as const)
      .filter(([hrId]) => Boolean(hrId)),
  );
}

function collectAncestors(
  employeeByHrId: Map<string, OrganogramReportRow>,
  managerHrId: string | null | undefined,
) {
  const ancestors = new Set<string>();
  let current = normalizeHrId(managerHrId);

  while (current && !ancestors.has(current)) {
    ancestors.add(current);
    current = normalizeHrId(employeeByHrId.get(current)?.managerHrId);
  }

  return ancestors;
}

function collectDescendants(
  employeeByHrId: Map<string, OrganogramReportRow>,
  rootHrId: string,
) {
  const descendants = new Set<string>();
  let frontier = [rootHrId];

  while (frontier.length > 0) {
    const nextFrontier: string[] = [];

    for (const managerHrId of frontier) {
      for (const employee of employeeByHrId.values()) {
        const employeeHrId = normalizeHrId(employee.hrId);

        if (
          employeeHrId &&
          !descendants.has(employeeHrId) &&
          normalizeHrId(employee.managerHrId) === managerHrId
        ) {
          descendants.add(employeeHrId);
          nextFrontier.push(employeeHrId);
        }
      }
    }

    frontier = nextFrontier;
  }

  descendants.delete(rootHrId);
  return descendants;
}

function hasManagerCycle(
  row: OrganogramReportRow,
  employeeByHrId: Map<string, OrganogramReportRow>,
) {
  const rowHrId = normalizeHrId(row.hrId);
  const visited = new Set<string>();
  let managerHrId = normalizeHrId(row.managerHrId);

  while (managerHrId) {
    if (managerHrId === rowHrId || visited.has(managerHrId)) {
      return true;
    }

    visited.add(managerHrId);
    managerHrId = normalizeHrId(employeeByHrId.get(managerHrId)?.managerHrId);
  }

  return false;
}

export function findOrganogramDiagnostics(rows: OrganogramReportRow[]) {
  const employeeByHrId = buildEmployeeMap(rows);
  const diagnostics = new Map<OrganogramDiagnostic["code"], number>();

  const increment = (code: OrganogramDiagnostic["code"]) => {
    diagnostics.set(code, (diagnostics.get(code) ?? 0) + 1);
  };

  for (const row of rows) {
    if (row.type !== "employee") {
      continue;
    }

    const rowHrId = normalizeHrId(row.hrId);
    const managerHrId = normalizeHrId(row.managerHrId);

    if (!managerHrId) {
      continue;
    }

    if (managerHrId === rowHrId) {
      increment("self_manager");
      continue;
    }

    if (!employeeByHrId.has(managerHrId)) {
      increment("missing_manager");
      continue;
    }

    if (hasManagerCycle(row, employeeByHrId)) {
      increment("circular_manager");
    }
  }

  return Array.from(diagnostics.entries()).map(([code, count]) => ({
    code,
    count,
  }));
}

function suppressFilledVacancyRows(rows: OrganogramReportRow[]) {
  const visibleRows = rows.filter((row) => {
    const status = normalizeKey(row.status);

    if (row.type === "vacancy") {
      return status === "open";
    }

    return status !== "resigned" && status !== "terminated" && status !== "inactive";
  });
  const activePositionKeys = new Set(
    visibleRows
      .filter((row) => row.type === "employee")
      .map(strictPositionSlotKey)
      .filter((key): key is string => Boolean(key)),
  );

  return visibleRows.filter((row) => {
    if (row.type !== "vacancy") {
      return true;
    }

    const key = strictPositionSlotKey(row);
    return !key || !activePositionKeys.has(key);
  });
}

function scopeOrganogramRows(
  rows: OrganogramReportRow[],
  access: AccessContext,
) {
  if (isCompanyWideAccess(access)) {
    return rows;
  }

  const employeeByHrId = buildEmployeeMap(rows);
  const viewerHrId = normalizeHrId(access.hrId);
  const viewer = employeeByHrId.get(viewerHrId);

  if (!viewer) {
    return [];
  }

  const visibleEmployeeHrIds = new Set<string>();
  const addWithAncestors = (row: OrganogramReportRow) => {
    const hrId = normalizeHrId(row.hrId);
    if (!hrId) {
      return;
    }

    visibleEmployeeHrIds.add(hrId);
    for (const ancestorHrId of collectAncestors(employeeByHrId, row.managerHrId)) {
      visibleEmployeeHrIds.add(ancestorHrId);
    }
  };

  if (access.scope === "line") {
    const viewerLine = normalizeKey(viewer.lineName);

    for (const row of employeeByHrId.values()) {
      if (viewerLine && normalizeKey(row.lineName) === viewerLine) {
        addWithAncestors(row);
      }
    }
  } else if (access.scope === "team" || access.scope === "hierarchy") {
    addWithAncestors(viewer);
    for (const descendantHrId of collectDescendants(employeeByHrId, viewerHrId)) {
      const descendant = employeeByHrId.get(descendantHrId);
      if (descendant) {
        addWithAncestors(descendant);
      }
    }
  } else {
    addWithAncestors(viewer);
  }

  const viewerLine = normalizeKey(viewer.lineName);

  return rows.filter((row) => {
    if (row.type === "employee") {
      return visibleEmployeeHrIds.has(normalizeHrId(row.hrId));
    }

    const managerVisible = visibleEmployeeHrIds.has(normalizeHrId(row.managerHrId));
    if (managerVisible) {
      return true;
    }

    return access.scope === "line" && viewerLine && normalizeKey(row.lineName) === viewerLine;
  });
}

function summarizeVacancies(rows: OrganogramReportRow[], sourceRows: VacancyReportRow[]) {
  const vacancyRows = rows.filter((row) => row.type === "vacancy");
  const openVacancyRows = sourceRows.filter((row) => row.status === "open");

  return {
    areasAffected: new Set(vacancyRows.map((row) => row.areaName).filter(Boolean)).size,
    linesAffected: new Set(vacancyRows.map((row) => row.lineName).filter(Boolean)).size,
    openVacancies: vacancyRows.length,
    positionsAffected: new Set(
      vacancyRows.map((row) => row.positionTitle ?? row.jobTitle).filter(Boolean),
    ).size,
    totalVacancies: openVacancyRows.length,
  };
}

function scopeVacancyRows(
  rows: VacancyReportRow[],
  organogramRows: OrganogramReportRow[],
) {
  const visibleVacancyCodes = new Set(
    organogramRows
      .filter((row) => row.type === "vacancy")
      .map((row) => normalizeKey(row.vacancyCode))
      .filter(Boolean),
  );
  const visibleVacancyKeys = new Set(
    organogramRows
      .filter((row) => row.type === "vacancy")
      .map(strictPositionSlotKey)
      .filter((key): key is string => Boolean(key)),
  );

  return rows.filter((row) => {
    if (row.status !== "open") {
      return false;
    }

    const key = strictPositionSlotKey(row);
    if (key) {
      return visibleVacancyKeys.has(key);
    }

    return visibleVacancyCodes.has(normalizeKey(row.vacancyCode));
  });
}

export function applyOrganogramMirrorSafety(report: VacancyReportData) {
  const organogramRows = suppressFilledVacancyRows(report.organogramRows);
  const rows = scopeVacancyRows(report.rows, organogramRows);

  return {
    ...report,
    organogramRows,
    rows,
    summary: summarizeVacancies(organogramRows, rows),
  };
}

export function scopeOrganogramReportForAccess(
  report: VacancyReportData,
  access: AccessContext,
) {
  const safeReport = applyOrganogramMirrorSafety(report);
  const organogramRows = scopeOrganogramRows(safeReport.organogramRows, access);
  const rows = scopeVacancyRows(safeReport.rows, organogramRows);

  return {
    ...safeReport,
    organogramRows,
    rows,
    summary: summarizeVacancies(organogramRows, rows),
  };
}
