import { getRequiredEnv } from "@/lib/env";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";

import {
  applyOrganogramMirrorSafety,
  classifyOrganogramStructureLevel,
  publicVacancyLabel,
} from "@/lib/reports/organogram-safety";
import { dedupeVacancyReportRows } from "@/lib/reports/vacancy-report-safety";

type LookupRow = {
  id: number;
  name?: string | null;
  title?: string | null;
};

type EmployeeLookupRow = {
  full_name: string | null;
  hr_id: string;
};

type EmployeeReplacementOwnerRow = {
  hr_id: string;
  pending_manager_replacement_for_hr_id?: string | null;
};

type VacancyDbRow = {
  area_id: number | null;
  created_at: string;
  department_id: number | null;
  id: number;
  job_title: string | null;
  line_id: number | null;
  manager_hr_id?: string | null;
  manager_replacement_for_hr_id?: string | null;
  manager_name?: string | null;
  note: string | null;
  position_id: number | null;
  region_name?: string | null;
  replacement_for_hr_id?: string | null;
  source_row_number: number | null;
  status: string;
  team_id?: number | null;
  vacancy_code: string;
};

export type VacancyReportRow = {
  areaId: number | null;
  areaName: string | null;
  createdAt: string;
  departmentId: number | null;
  departmentName: string | null;
  id: number;
  jobTitle: string | null;
  lineId: number | null;
  lineName: string | null;
  managerHrId: string | null;
  managerReplacementForHrId?: string | null;
  managerName: string | null;
  note: string | null;
  positionId: number | null;
  positionTitle: string | null;
  regionName: string | null;
  replacementForHrId?: string | null;
  sourceRowNumber: number | null;
  status: string;
  teamId: number | null;
  teamName: string | null;
  vacancyCode: string;
};

export type OrganogramReportRow = {
  areaId: number | null;
  areaName: string | null;
  departmentId: number | null;
  departmentName: string | null;
  displayName: string;
  fullName: string;
  hireDate: string | null;
  hrId: string;
  jobTitle: string | null;
  lineId: number | null;
  lineName: string | null;
  managerHrId: string | null;
  managerReplacementForHrId?: string | null;
  managerName: string | null;
  positionId: number | null;
  positionTitle: string | null;
  regionName: string | null;
  replacementForHrId?: string | null;
  sourceRowNumber: number | null;
  status: string;
  teamId: number | null;
  teamName: string | null;
  type: "employee" | "vacancy";
  vacancyCode?: string | null;
};

export type VacancyReportDiagnosticCode =
  | "line_unresolved"
  | "company_scope_denied"
  | "line_scope_denied"
  | "team_unresolved"
  | "vacancy_scope_denied";

export type VacancyReportDiagnostic = {
  code: VacancyReportDiagnosticCode;
  message: string;
};

export type VacancyReportData = {
  diagnostic?: VacancyReportDiagnostic;
  organogramRows: OrganogramReportRow[];
  rows: VacancyReportRow[];
  summary: {
    areasAffected: number;
    linesAffected: number;
    openVacancies: number;
    positionsAffected: number;
    totalVacancies: number;
  };
};

const databaseQueryTimeoutMs = 5000;


export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function isSupabaseEnvMissing(error: unknown) {
  const message = errorMessage(error);

  return (
    message.includes("NEXT_PUBLIC_SUPABASE_URL is required") ||
    message.includes("SUPABASE_SERVICE_ROLE_KEY is required")
  );
}

export function isDatabaseSchemaMissing(error: unknown) {
  const message = errorMessage(error).toLowerCase();

  return (
    message.includes("could not find the table") ||
    message.includes("schema cache") ||
    (message.includes("relation") && message.includes("does not exist"))
  );
}

export function isSupabaseTimeout(error: unknown) {
  return errorMessage(error).toLowerCase().includes("timed out");
}

function uniqueCount(values: Array<string | null>) {
  return new Set(values.filter(Boolean)).size;
}

export function isEmployeeVisibleInOrganogram(status: string | null | undefined) {
  const normalizedStatus = String(status ?? "active").trim().toLowerCase();

  return (
    normalizedStatus === "active" ||
    normalizedStatus === "on_leave"
  );
}

function ids(rows: VacancyDbRow[], key: keyof VacancyDbRow) {
  return Array.from(
    new Set(
      rows
        .map((row) => row[key])
        .filter((value): value is number => typeof value === "number"),
    ),
  );
}

function textValues(rows: VacancyDbRow[], key: keyof VacancyDbRow) {
  return Array.from(
    new Set(
      rows
        .map((row) => row[key])
        .filter((value): value is string => typeof value === "string" && value.length > 0),
    ),
  );
}

function inFilter(idsToLoad: number[]) {
  return `in.(${idsToLoad.join(",")})`;
}

function textInFilter(values: string[]) {
  return `in.(${values.map((value) => `"${value.replace(/"/g, '\\"')}"`).join(",")})`;
}

async function supabaseRest<T>(path: string): Promise<T> {
  const url = getRequiredEnv("NEXT_PUBLIC_SUPABASE_URL").replace(/\/+$/g, "");
  const serviceRoleKey = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    databaseQueryTimeoutMs,
  );

  try {
    const response = await fetch(`${url}/rest/v1/${path}`, {
      cache: "no-store",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;

    if (!response.ok) {
      const message =
        typeof payload?.message === "string"
          ? payload.message
          : `Supabase request failed with ${response.status}.`;
      throw new Error(message);
    }

    return payload as T;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Supabase request timed out.");
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function loadLookup(table: string, idsToLoad: number[], label = "name") {
  if (idsToLoad.length === 0) {
    return new Map<number, string>();
  }

  const params = new URLSearchParams({
    select: `id,${label}`,
    id: inFilter(idsToLoad),
  });
  const rows = await supabaseRest<LookupRow[]>(`${table}?${params}`);

  return new Map(
    rows.map((row) => [
      row.id,
      String(label === "title" ? row.title ?? "" : row.name ?? ""),
    ]),
  );
}

async function loadEmployeeNames(hrIds: string[]) {
  if (hrIds.length === 0) {
    return new Map<string, string>();
  }

  const params = new URLSearchParams({
    select: "hr_id,full_name",
    hr_id: textInFilter(hrIds),
  });
  const rows = await supabaseRest<EmployeeLookupRow[]>(`employees?${params}`);

  return new Map(
    rows.map((row) => [String(row.hr_id), String(row.full_name ?? "")]),
  );
}

function isMissingManagerColumns(error: unknown) {
  const message = errorMessage(error).toLowerCase();

  return (
    message.includes("manager_hr_id") ||
    message.includes("manager_replacement_for_hr_id") ||
    message.includes("manager_name") ||
    message.includes("pending_manager_replacement_for_hr_id") ||
    message.includes("replacement_for_hr_id") ||
    message.includes("region_name")
  );
}

async function loadVacancyRows() {
  const baseSelect =
    "id,vacancy_code,department_id,line_id,area_id,team_id,position_id,job_title,source_row_number,status,note,created_at";
  const params = new URLSearchParams({
    select: `${baseSelect},manager_hr_id,manager_name,manager_replacement_for_hr_id,region_name,replacement_for_hr_id`,
    order: "created_at.desc",
  });

  try {
    return await supabaseRest<VacancyDbRow[]>(`position_vacancies?${params}`);
  } catch (error) {
    if (!isMissingManagerColumns(error)) {
      throw error;
    }

    const managerOnlyParams = new URLSearchParams({
      select: `${baseSelect},manager_hr_id,manager_name,region_name`,
      order: "created_at.desc",
    });

    try {
      return await supabaseRest<VacancyDbRow[]>(
        `position_vacancies?${managerOnlyParams}`,
      );
    } catch (fallbackError) {
      if (!isMissingManagerColumns(fallbackError)) {
        throw fallbackError;
      }

      const fallbackParams = new URLSearchParams({
        select: baseSelect,
        order: "created_at.desc",
      });

      return supabaseRest<VacancyDbRow[]>(
        `position_vacancies?${fallbackParams}`,
      );
    }
  }
}

async function loadEmployeePendingManagerReplacements(hrIds: string[]) {
  if (hrIds.length === 0) {
    return new Map<string, string | null>();
  }

  const params = new URLSearchParams({
    select: "hr_id,pending_manager_replacement_for_hr_id",
    hr_id: textInFilter(hrIds),
  });

  try {
    const rows = await supabaseRest<EmployeeReplacementOwnerRow[]>(`employees?${params}`);
    return new Map(
      rows.map((row) => [
        String(row.hr_id),
        row.pending_manager_replacement_for_hr_id ?? null,
      ]),
    );
  } catch (error) {
    if (isMissingManagerColumns(error)) {
      return new Map<string, string | null>();
    }

    throw error;
  }
}

export async function getVacancyReport(): Promise<VacancyReportData> {
  const [vacancyRows, employeeDirectory] = await Promise.all([
    loadVacancyRows(),
    getEmployeeDirectory(),
  ]);
  const [departmentNames, lineNames, areaNames, teamNames, positionTitles, managerNames] =
    await Promise.all([
      loadLookup("departments", ids(vacancyRows, "department_id")),
      loadLookup("lines", ids(vacancyRows, "line_id")),
      loadLookup("areas", ids(vacancyRows, "area_id")),
      loadLookup("teams", ids(vacancyRows, "team_id")),
      loadLookup("positions", ids(vacancyRows, "position_id"), "title"),
      loadEmployeeNames(textValues(vacancyRows, "manager_hr_id")),
    ]);
  const pendingManagerReplacements = await loadEmployeePendingManagerReplacements(
    employeeDirectory.employees.map((employee) => employee.hrId),
  );

  const mappedRows = vacancyRows.map((row): VacancyReportRow => ({
    areaId: row.area_id,
    areaName: row.area_id ? areaNames.get(row.area_id) ?? null : null,
    createdAt: row.created_at,
    departmentId: row.department_id,
    departmentName: row.department_id
      ? departmentNames.get(row.department_id) ?? null
      : null,
    id: row.id,
    jobTitle: row.job_title,
    lineId: row.line_id,
    lineName: row.line_id ? lineNames.get(row.line_id) ?? null : null,
    managerHrId: row.manager_hr_id ?? null,
    managerReplacementForHrId: row.manager_replacement_for_hr_id ?? null,
    managerName:
      row.manager_name ??
      (row.manager_hr_id ? managerNames.get(row.manager_hr_id) ?? null : null),
    note: row.note,
    positionId: row.position_id,
    positionTitle: row.position_id
      ? positionTitles.get(row.position_id) ?? null
      : null,
    regionName: row.region_name ?? null,
    replacementForHrId: row.replacement_for_hr_id ?? null,
    sourceRowNumber: row.source_row_number,
    status: row.status,
    teamId: row.team_id ?? null,
    teamName: row.team_id ? teamNames.get(row.team_id) ?? null : null,
    vacancyCode: row.vacancy_code,
  }));
  const rows = dedupeVacancyReportRows(mappedRows);
  const openRows = rows.filter((row) => row.status === "open");

  // Organogram display uses raw vacancy rows and its own strict slot safety
  // (applyOrganogramMirrorSafety), which decides filled-vs-vacant by live
  // occupancy. Keep every vacancy that maps to a known structural seat —
  // including non-open Medical-Rep seats. The org structure per line is fixed:
  // an area seat must not disappear because a stale import record wrongly marks
  // it "filled". Whether it renders as vacant is decided downstream by whether
  // an active employee actually occupies it, not by the mutable status here.
  const organogramVacancyRows = mappedRows.filter((row) => {
    if (row.status === "open") return true;
    return classifyOrganogramStructureLevel(row) !== null;
  });

  const employeeOrganogramRows: OrganogramReportRow[] =
    employeeDirectory.employees
      .filter((employee) =>
        // Organogram visibility is an org-structure concept, not a compensation
        // one: an active, org-visible employee who is payroll-ineligible (e.g. an
        // externally-paid secondee) still belongs on the chart so their reports
        // don't orphan. Intentional hiding is expressed via `organogram_visible`.
        isEmployeeVisibleInOrganogram(employee.employmentStatus) &&
        employee.organogramVisible !== false,
      )
      .map((employee) => ({
        areaId: employee.areaId,
        areaName: employee.areaName,
        departmentId: employee.departmentId,
        departmentName: employee.departmentName,
        displayName: employee.displayName,
        fullName: employee.fullName,
        hireDate: employee.hireDate,
        hrId: employee.hrId,
        jobTitle: employee.jobTitle,
        lineId: employee.lineId,
        lineName: employee.lineName,
        managerHrId: employee.managerHrId,
        managerReplacementForHrId: pendingManagerReplacements.get(employee.hrId) ?? null,
        managerName: employee.managerName,
        positionId: employee.positionId,
        positionTitle: employee.positionTitle,
        regionName: employee.regionName,
        replacementForHrId: null,
        sourceRowNumber: null,
        status: employee.employmentStatus ?? "active",
        teamId: employee.teamId,
        teamName: employee.teamName,
        type: "employee",
        vacancyCode: null,
      }));
  const vacancyOrganogramRows: OrganogramReportRow[] = organogramVacancyRows.map((row) => ({
    areaId: row.areaId,
    areaName: row.areaName,
    departmentId: row.departmentId,
    departmentName: row.departmentName,
    displayName: "Vacant",
    fullName: "Vacant",
    hireDate: null,
    hrId: vacancyLabelForReport(row.vacancyCode),
    jobTitle: row.jobTitle,
    lineId: row.lineId,
    lineName: row.lineName,
    managerHrId: row.managerHrId,
    managerReplacementForHrId: row.managerReplacementForHrId ?? null,
    managerName: row.managerName,
    positionId: row.positionId,
    positionTitle: row.positionTitle,
    regionName: row.regionName,
    replacementForHrId: row.replacementForHrId ?? null,
    sourceRowNumber: row.sourceRowNumber,
    status: row.status,
    teamId: row.teamId,
    teamName: row.teamName,
    type: "vacancy",
    vacancyCode: row.vacancyCode,
  }));

  return {
    organogramRows: applyOrganogramMirrorSafety([
      ...employeeOrganogramRows,
      ...vacancyOrganogramRows,
    ]),
    rows,
    summary: {
      areasAffected: uniqueCount(openRows.map((row) => row.areaName)),
      linesAffected: uniqueCount(openRows.map((row) => row.lineName)),
      openVacancies: openRows.length,
      positionsAffected: uniqueCount(
        openRows.map((row) => row.positionTitle ?? row.jobTitle),
      ),
      totalVacancies: rows.length,
    },
  };
}

function vacancyLabelForReport(vacancyCode: string) {
  return publicVacancyLabel(vacancyCode);
}
