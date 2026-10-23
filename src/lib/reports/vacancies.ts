import { getRequiredEnv } from "@/lib/env";
import { offerSeatKeyForVacancy, type SeatOfferOut } from "@/lib/offers/seat-offer-label";
import { loadOfferOutBySeat } from "@/lib/offers/seat-offers";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { getMergedAreaName } from "@/lib/sales/closing-area-merges";
import { quotedInList } from "@/lib/supabase/search-filter";

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
  nickname?: string | null;
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
  /**
   * The offer already out against this open seat, when there is one — so the report's hire
   * action can open Add Employee pre-filled from an ACCEPTED letter (candidate, agreed salary,
   * generated id), exactly as the organogram popup does. Null on every row with no live offer,
   * which is what every row was before this existed. A LABEL, never a state: the seat stays
   * vacant and open; the hire is still what fills it.
   */
  pendingOffer?: SeatOfferOut | null;
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

/**
 * WORK-ONLY employee fields carried on an organogram row.
 *
 * These exist so the structure export and the "copy emails" picker can read a person's
 * work identity without a second round trip. They are deliberately the SAFE subset —
 * exactly the Identity / Placement / Reporting / Contact sections every organogram
 * viewer can already open on a node (organogram-employee-detail.ts), minus the mobile
 * number. **Never widen this with a personal or compensation field** (national ID,
 * birth date, gender, address, bank, salary): the row is shipped to the browser for
 * every viewer of the chart and lands in a downloadable sheet, so anything added here
 * becomes a bulk disclosure, not a one-person popup gated by
 * canViewOrganogramSensitiveFields. Owner instruction, 2026-08-22: "work fields only".
 *
 * All optional — the legacy position_vacancies path never populates them, and a vacant
 * seat has no employee to populate them from.
 */
export type OrganogramWorkFields = {
  contractRenewalDate?: string | null;
  /**
   * Whether this person's stored mobile resolves to a dialable WhatsApp chat — a
   * BOOLEAN, never the number. It exists so the chart can hide the WhatsApp button on
   * the 28 of 175 people (measured 2026-08-22) who would otherwise get one that leads
   * nowhere: 26 with no number on file and 2 whose number cannot be read confidently.
   *
   * This is deliberately not a widening of the rule above. A flag cannot be harvested
   * into a contact list, carries nothing about the person beyond "reachable", and is
   * absent from ORGANOGRAM_EXPORT_COLUMNS so it never reaches the sheet. **The number
   * itself must never be added here** — the button links to
   * /api/reports/organogram/whatsapp/[hrId], which resolves it server-side per press, so no
   * viewer's browser ever holds the mobile numbers of everyone on their chart.
   */
  hasWhatsApp?: boolean;
  contractType?: string | null;
  /** employees.department_name / employees.team_name. Deliberately NOT written into the
   *  row's own `departmentName` / `teamName`, which stay null on the seat path: those two
   *  feed chart classification (isSalesDepartment, the position slot key, the Cairo-market
   *  check), so filling them would quietly change what the organogram DRAWS. These
   *  export-only twins give the sheet its columns and touch nothing else. */
  employeeDepartmentName?: string | null;
  employeeTeamName?: string | null;
  /** employees.job_title — the HR record's own title, which can differ from the seat
   *  tier title in `jobTitle`/`positionTitle` (an acting DM is titled a rep). */
  employeeJobTitle?: string | null;
  employmentStatus?: string | null;
  nameAr?: string | null;
  workEmail?: string | null;
};

export type OrganogramReportRow = OrganogramWorkFields & {
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
  /**
   * The product line a Head Office row's person actually works, when it is a sales line — a Product
   * or Group Product Manager pulled into the Head Office branch by manager chain. Set only there,
   * and null on every other row. `lineName` stays "Head Office" (the gates key off it); a line chart
   * reads this to keep the marketer, and the Head Office managers above him, on his own line
   * (owner, 2026-10-20 — organogram-head-office.ts).
   */
  ownLineName?: string | null;
  managerHrId: string | null;
  managerReplacementForHrId?: string | null;
  managerName: string | null;
  /**
   * The offer already out against this seat, when there is one. Set on VACANCY rows only — an
   * occupied chair has nothing pending — and null everywhere else, which is what every row was
   * before this existed.
   *
   * A LABEL, never a state. The seat stays vacant and open; the hire is still what fills it.
   */
  pendingOffer?: SeatOfferOut | null;
  positionId: number | null;
  positionTitle: string | null;
  regionName: string | null;
  replacementForHrId?: string | null;
  // au seat identity when the row comes from the seat model. Part of rowKey so two
  // seats held by one person render as two visible boxes instead of one silently
  // deduplicated away (the 2026-08-01 AI-0005 "seat vanished" incident).
  seatId?: string | null;
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
  return `in.(${quotedInList(values)})`;
}

const TRANSIENT_SERVER_ERRORS = [502, 503, 504];
const databaseQueryMaxAttempts = 3;

async function supabaseRest<T>(path: string): Promise<T> {
  const url = getRequiredEnv("NEXT_PUBLIC_SUPABASE_URL").replace(/\/+$/g, "");
  const serviceRoleKey = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  let lastError: unknown;

  for (let attempt = 0; attempt < databaseQueryMaxAttempts; attempt++) {
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
        if (TRANSIENT_SERVER_ERRORS.includes(response.status) && attempt < databaseQueryMaxAttempts - 1) {
          lastError = new Error(message);
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }
        throw new Error(message);
      }

      return payload as T;
    } catch (error) {
      lastError = error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Supabase request timed out.");
      }
      if (attempt < databaseQueryMaxAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Supabase request failed.");
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

/**
 * `id -> name` AND `id -> code` for a lookup table that carries both (`areas`, `lines`), from ONE
 * request. They were two requests over the same ids and the same rows — one asking for the name, one
 * for the code — and every request crosses the Atlantic. The name is read exactly as `loadLookup`
 * reads it (`String(name ?? "")`), the code as it always was (trimmed).
 */
async function loadNameAndCodeLookup(table: string, idsToLoad: number[]) {
  const names = new Map<number, string>();
  const codes = new Map<number, string>();
  if (idsToLoad.length === 0) {
    return { codes, names };
  }

  const params = new URLSearchParams({
    select: "id,name,code",
    id: inFilter(idsToLoad),
  });
  const rows = await supabaseRest<Array<{ id: number; name?: string | null; code?: string | null }>>(
    `${table}?${params}`,
  );

  for (const row of rows) {
    names.set(row.id, String(row.name ?? ""));
    codes.set(row.id, String(row.code ?? "").trim());
  }
  return { codes, names };
}

async function loadEmployeeNames(hrIds: string[]) {
  if (hrIds.length === 0) {
    return new Map<string, string>();
  }

  const params = new URLSearchParams({
    select: "hr_id,full_name,nickname",
    hr_id: textInFilter(hrIds),
  });
  const rows = await supabaseRest<EmployeeLookupRow[]>(`employees?${params}`);

  return new Map(
    rows.map((row) => [String(row.hr_id), resolveEmployeeDisplayName(String(row.full_name ?? ""), row.nickname)]),
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

type VacancyRowFilter = {
  /** Ask the database for `status = open` rows only (the vacancy list's light read). */
  openOnly?: boolean;
};

async function loadVacancyRows(filter: VacancyRowFilter = {}) {
  const baseSelect =
    "id,vacancy_code,department_id,line_id,area_id,team_id,position_id,job_title,source_row_number,status,note,created_at";
  const vacancyParams = (select: string) =>
    new URLSearchParams({
      select,
      order: "created_at.desc",
      ...(filter.openOnly ? { status: "eq.open" } : {}),
    });
  const params = vacancyParams(
    `${baseSelect},manager_hr_id,manager_name,manager_replacement_for_hr_id,region_name,replacement_for_hr_id`,
  );

  try {
    return await supabaseRest<VacancyDbRow[]>(`position_vacancies?${params}`);
  } catch (error) {
    if (!isMissingManagerColumns(error)) {
      throw error;
    }

    const managerOnlyParams = vacancyParams(`${baseSelect},manager_hr_id,manager_name,region_name`);

    try {
      return await supabaseRest<VacancyDbRow[]>(
        `position_vacancies?${managerOnlyParams}`,
      );
    } catch (fallbackError) {
      if (!isMissingManagerColumns(fallbackError)) {
        throw fallbackError;
      }

      const fallbackParams = vacancyParams(baseSelect);

      return supabaseRest<VacancyDbRow[]>(
        `position_vacancies?${fallbackParams}`,
      );
    }
  }
}

/** The vacancy rows plus the names they point at — the half of the report the vacancy LIST needs. */
async function loadVacancyRowsWithLookups(filter: VacancyRowFilter = {}) {
  const rows = await loadVacancyRows(filter);
  const [departmentNames, lines, areas, teamNames, positionTitles, managerNames] = await Promise.all([
    loadLookup("departments", ids(rows, "department_id")),
    loadNameAndCodeLookup("lines", ids(rows, "line_id")),
    loadNameAndCodeLookup("areas", ids(rows, "area_id")),
    loadLookup("teams", ids(rows, "team_id")),
    loadLookup("positions", ids(rows, "position_id"), "title"),
    loadEmployeeNames(textValues(rows, "manager_hr_id")),
  ]);
  return {
    lookups: { areas, departmentNames, lines, managerNames, positionTitles, teamNames },
    rows,
  };
}

type VacancyLookups = Awaited<ReturnType<typeof loadVacancyRowsWithLookups>>["lookups"];

function mapVacancyReportRow(
  row: VacancyDbRow,
  { areas, departmentNames, lines, managerNames, positionTitles, teamNames }: VacancyLookups,
  offerOutBySeat: ReadonlyMap<string, SeatOfferOut>,
): VacancyReportRow {
  return {
    areaId: row.area_id,
    // Ismailia and Suez are ONE area on Anti Infective from 2026-09 (owner, 2026-09-19), so the
    // Delta (3) seat reads "Ismailia and Suez", not "Suez"; every other line keeps the plain name.
    areaName: row.area_id
      ? (row.line_id && areas.codes.get(row.area_id)
          ? getMergedAreaName(lines.codes.get(row.line_id), areas.codes.get(row.area_id) ?? "")
          : null) ?? areas.names.get(row.area_id) ?? null
      : null,
    createdAt: row.created_at,
    departmentId: row.department_id,
    departmentName: row.department_id
      ? departmentNames.get(row.department_id) ?? null
      : null,
    id: row.id,
    jobTitle: row.job_title,
    lineId: row.line_id,
    lineName: row.line_id ? lines.names.get(row.line_id) ?? null : null,
    managerHrId: row.manager_hr_id ?? null,
    managerReplacementForHrId: row.manager_replacement_for_hr_id ?? null,
    managerName: row.manager_hr_id
      ? managerNames.get(row.manager_hr_id) ?? row.manager_name ?? null
      : row.manager_name ?? null,
    note: row.note,
    // An accepted/sent letter on this open seat, looked up by the vacancy's own id. Only open
    // vacancies carry a key in the map, so a filled or cancelled row reads null here.
    pendingOffer: offerOutBySeat.get(offerSeatKeyForVacancy(row.id)) ?? null,
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
  };
}

const NO_OFFERS: ReadonlyMap<string, SeatOfferOut> = new Map();

/**
 * The vacancy LIST alone: the report's `rows`, mapped and de-duplicated exactly as getVacancyReport
 * builds them, without the three reads only the report's organogram half and its hire button need —
 * the whole employee directory, every employee's pending manager replacement (one `in.(…)` naming
 * every hr_id) and the offers out against seats. `pendingOffer` is therefore null on every row.
 *
 * Why it exists: the Recruitment page's new-requisition list was built from the full report, and on
 * 19 Oct 2026 it missed its eight-second deadline at 10:37 and timed out at 11:42 Cairo, so the page
 * said "Not loaded: the open vacancy list" while the rows it needed were a few dozen open seats.
 *
 * `openOnly` filters in the database. The open rows that come back are the same ones the report's
 * `rows.filter(status === "open")` gives: dedupeVacancyReportRows lets an open row speak for its seat
 * whatever non-open rows sit beside it, and keeps the first (newest) of two open rows either way.
 */
export async function getVacancyListRows(filter: VacancyRowFilter = {}): Promise<VacancyReportRow[]> {
  const { lookups, rows } = await loadVacancyRowsWithLookups(filter);
  const listed = dedupeVacancyReportRows(rows.map((row) => mapVacancyReportRow(row, lookups, NO_OFFERS)));
  return filter.openOnly ? listed.filter((row) => row.status === "open") : listed;
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
  // THREE INDEPENDENT CHAINS, run side by side. They used to be four serial stages — vacancy rows,
  // then their lookups, then the pending-replacement read, then the offers read — although only the
  // lookups wait on the vacancy rows and only the replacement read waits on the directory. Each
  // chain keeps its own order, so every value below is the one the serial version produced.
  const [
    { lookups: vacancyLookups, rows: vacancyRows },
    [employeeDirectory, pendingManagerReplacements],
    offerOutBySeat,
  ] = await Promise.all([
    loadVacancyRowsWithLookups(),
    (async () => {
      const directory = await getEmployeeDirectory();
      const replacements = await loadEmployeePendingManagerReplacements(
        directory.employees.map((employee) => employee.hrId),
      );
      return [directory, replacements] as const;
    })(),
    // Which open seats already have a letter out against them — so the report's "Add employee to
    // this seat" action can open Add Employee pre-filled from an ACCEPTED offer, the same one-press
    // hire the organogram popup gives. Keyed by the vacancy's own id (offerSeatKeyForVacancy), which
    // is this row's `id`. Returns an empty map on any failure, so an offers read that fails can never
    // be the reason the vacancy report will not build.
    loadOfferOutBySeat(),
  ]);

  const mappedRows = vacancyRows.map((row) => mapVacancyReportRow(row, vacancyLookups, offerOutBySeat));
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
    // Carried from the list row so the report's embedded chart labels and routes an accepted
    // offer the same way the standalone organogram does.
    pendingOffer: row.pendingOffer ?? null,
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
