import { getSupabaseAdmin } from "@/lib/supabase/server";
import { ACTIVE_EMPLOYMENT_STATUSES_IN_LIST, isTerminalEmploymentStatus } from "@/lib/auth/session-lifecycle";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { canonicalHrIdKey, hrIdsMatch } from "@/lib/hr-id";
import { canonicalSalesLine, isSalesOthersBucket } from "@/lib/sales/others";
import { salesRoleOverrideForHrId } from "@/lib/sales/role-mapping";
import { isSalesVacancyAreaCode } from "@/lib/workforce-classification";
import type { EmployeeDirectoryRow, SalesLinkStatus, SalesRecordInput } from "@/lib/sales/types";

type LinkResult = {
  employeeHrId?: string | null;
  employeeCrmId?: string | null;
  employeeLookupKey?: string | null;
  employeeName?: string | null;
  linkStatus: SalesLinkStatus;
  linkConfidence: number;
  line?: string | null;
  managerHrId?: string | null;
  diagnostics: string[];
};

type VacancyDirectoryRow = {
  areaName: string | null;
  lineName: string | null;
  managerHrId: string | null;
  status: string | null;
  vacancyCode: string | null;
};

function normalize(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

// HR_ID-specific key: routes through the legacy alias table (e.g. aaa -> aa),
// unlike the generic text `normalize()` above used for job titles/status/etc.
function hrIdKey(value: string | null | undefined) {
  return canonicalHrIdKey(value) ?? "";
}

function compact(value: unknown) {
  return String(value ?? "").trim();
}

function isInactiveEmploymentStatus(status: string | null | undefined) {
  return isTerminalEmploymentStatus(status);
}

function employeeLabel(employee: EmployeeDirectoryRow) {
  const name = compact(employee.display_name) || compact(employee.full_name) || "Unknown employee";
  const hrId = compact(employee.hr_id);
  return hrId ? `${name} [HR ${hrId}]` : name;
}

function sourceLabel(hrId: string, fallbackName?: string | null) {
  const name = compact(fallbackName);
  return name ? `${name} [HR ${hrId}]` : `HR ${hrId}`;
}

export async function getSalesPeopleLabels(hrIds: Array<string | null | undefined>) {
  const wanted = new Set(hrIds.map((hrId) => hrIdKey(hrId)).filter(Boolean));
  if (wanted.size === 0) return new Map<string, string>();

  const directory = await loadDirectory();
  const labels = new Map<string, string>();
  directory.forEach((employee) => {
    const hrId = hrIdKey(employee.hr_id);
    if (wanted.has(hrId)) labels.set(hrId, employeeLabel(employee));
  });

  hrIds.forEach((hrId) => {
    const normalized = hrIdKey(hrId);
    if (normalized && !labels.has(normalized)) labels.set(normalized, `HR ${compact(hrId)}`);
  });

  return labels;
}

function roleLabel(employee: EmployeeDirectoryRow | undefined) {
  const override = salesRoleOverrideForHrId(employee?.hr_id);
  if (override) return `${override} override`;
  const title = compact(employee?.job_title) || compact(employee?.position_title);
  return title ? title : "missing job title";
}

function hasMrRole(employee: EmployeeDirectoryRow | undefined) {
  const override = salesRoleOverrideForHrId(employee?.hr_id);
  if (override) return override === "MR" || override === "MR_DSM";
  const title = normalize(compact(employee?.job_title) || compact(employee?.position_title));
  if (!title) return false;
  if (/\b(dsm|nsm)\b/.test(title) || title.includes("manager")) return false;
  return /\bmr\b/.test(title) || title.includes("medical rep") || title.includes("representative") || title.includes("sales rep");
}

function hasDsmRole(employee: EmployeeDirectoryRow | undefined) {
  const override = salesRoleOverrideForHrId(employee?.hr_id);
  if (override) return override === "DSM" || override === "MR_DSM";
  const title = normalize(compact(employee?.job_title) || compact(employee?.position_title));
  if (!title || /\bnsm\b/.test(title) || title.includes("national")) return false;
  return /\bdsm\b/.test(title) || title.includes("district sales manager") || (title.includes("district") && title.includes("manager"));
}

function hasNsmRole(employee: EmployeeDirectoryRow | undefined) {
  const override = salesRoleOverrideForHrId(employee?.hr_id);
  if (override) return override === "NSM";
  const title = normalize(compact(employee?.job_title) || compact(employee?.position_title));
  return Boolean(title && (/\bnsm\b/.test(title) || title.includes("national sales manager")));
}

export function hasLineMatch(employee: EmployeeDirectoryRow | undefined, line: string | null | undefined) {
  if (salesRoleOverrideForHrId(employee?.hr_id)) return true;
  return linesCompatible(line, employee?.line);
}

function roleMismatchLabel(label: string, employee: EmployeeDirectoryRow | undefined, expectedRole: string, line?: string | null) {
  if (!employee) return `${label} - expected ${expectedRole}, HR ID was not found in employee database`;
  const lineNote = hasLineMatch(employee, line) ? "" : `, line ${compact(employee.line) || "missing"}`;
  return `${label} - expected ${expectedRole}, found ${roleLabel(employee)}${lineNote}`;
}

function makeNoMatchMessage(label: string, value: string) {
  return `${label} "${value}" was provided in the sheet, but no employee matched it.`;
}

function isPlaceholderHrId(value: unknown) {
  const normalized = normalize(value);
  return !normalized || normalized === "-" || normalized === "n/a" || normalized === "na" || normalized === "none";
}

function resolvePersistableManagerHrId(
  value: string | null | undefined,
  directory: EmployeeDirectoryRow[],
  diagnostics: string[],
) {
  const managerHrId = compact(value);
  if (!managerHrId) return null;

  if (isPlaceholderHrId(managerHrId) || isVacantAreaCode(managerHrId)) {
    diagnostics.push(`Manager HR ID "${managerHrId}" is a vacancy/placeholder value, so it was not stored as a manager employee ID.`);
    return null;
  }

  const match = directory.find((employee) => hrIdsMatch(employee.hr_id, managerHrId));
  if (!match) {
    diagnostics.push(`Manager HR ID "${managerHrId}" was not found in the employee directory, so it was not stored.`);
    return null;
  }

  return match.hr_id;
}

function isVacantAreaCode(value: unknown) {
  return /^v-[a-z0-9]{1,8}(?:-\d+)?$/i.test(compact(value));
}

function normalizedAreaKey(value: unknown) {
  return normalize(value).replace(/[^a-z0-9]+/g, "");
}

function looseAreaKey(value: unknown) {
  return normalizedAreaKey(value)
    .replace(/q/g, "k")
    .replace(/[aeiou]/g, "");
}

function linesCompatible(sourceLine: string | null | undefined, vacancyLine: string | null | undefined) {
  const source = canonicalSalesLine(sourceLine);
  const vacancy = canonicalSalesLine(vacancyLine);
  if (!source || !vacancy) return true;
  if (source === vacancy) return true;
  if (source === "anti inf" && vacancy === "anti infective") return true;
  if (source === "anti infective" && vacancy === "anti inf") return true;
  return false;
}

function isOpenVacancy(vacancy: VacancyDirectoryRow) {
  const status = normalize(vacancy.status);
  return !status || ["open", "active", "approved"].includes(status);
}

function matchVacancyForSource(
  source: { line?: string | null; territory?: string | null },
  vacancies: VacancyDirectoryRow[],
) {
  const sourceArea = normalizedAreaKey(source.territory);
  if (!sourceArea) return null;

  const compatible = vacancies.filter((vacancy) =>
    isOpenVacancy(vacancy) && linesCompatible(source.line, vacancy.lineName)
  );

  const exact = compatible.filter((vacancy) => normalizedAreaKey(vacancy.areaName) === sourceArea);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;

  const sourceLooseArea = looseAreaKey(source.territory);
  const loose = compatible.filter((vacancy) => looseAreaKey(vacancy.areaName) === sourceLooseArea);
  return loose.length === 1 ? loose[0] : null;
}

function lineMismatchMessage(sourceLine: string | null | undefined, employeeLine: string | null | undefined) {
  const source = compact(sourceLine);
  const employee = compact(employeeLine);
  if (!source || !employee) return null;
  if (canonicalSalesLine(source) === canonicalSalesLine(employee)) return null;
  return `Sheet line "${source}" does not match the employee line "${employee}".`;
}

type DirectoryCache = {
  rows: EmployeeDirectoryRow[];
  expiresAt: number;
};

type VacancyCache = {
  rows: VacancyDirectoryRow[];
  expiresAt: number;
};

const directoryMemory = globalThis as typeof globalThis & {
  __phoenixSalesDirectory?: DirectoryCache;
  __phoenixSalesVacancies?: VacancyCache;
};

function memoryCache() {
  return directoryMemory.__phoenixSalesDirectory;
}

function setMemoryCache(rows: EmployeeDirectoryRow[]) {
  directoryMemory.__phoenixSalesDirectory = {
    rows,
    expiresAt: Date.now() + 5 * 60 * 1000,
  };
}

export function invalidateSalesDirectoryCache() {
  directoryMemory.__phoenixSalesDirectory = undefined;
  directoryMemory.__phoenixSalesVacancies = undefined;
}

async function loadDirectory() {
  const cached = memoryCache();
  if (cached && cached.expiresAt > Date.now()) {
    return cached.rows;
  }

  try {
    const rows = (await getEmployeeDirectoryRows()).map((employee) => ({
      hr_id: employee.hrId,
      crm_id: employee.crmId,
      crm_username: employee.crmUsername,
      display_name: employee.displayName,
      full_name: employee.fullName,
      job_title: employee.jobTitle,
      line: employee.lineName,
      manager_hr_id: employee.managerHrId,
      position_title: employee.positionTitle,
      region: employee.regionName,
      area: employee.areaName,
      employment_status: employee.employmentStatus,
    }));
    setMemoryCache(rows);
    return rows;
  } catch {
    // Fall back to the lean sales lookup if the richer employee directory is unavailable.
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("employees")
    .select("hr_id, crm_id, crm_username, full_name, nickname, employment_status, manager_hr_id, job_title, line_id, area_id")
    .or(`employment_status.is.null,employment_status.in.${ACTIVE_EMPLOYMENT_STATUSES_IN_LIST}`)
    .order("full_name", { ascending: true });

  if (error) return [] as EmployeeDirectoryRow[];

  const rows = (data ?? []).map((row) => ({
    hr_id: String(row.hr_id),
    crm_id: row.crm_id ? String(row.crm_id) : null,
    crm_username: row.crm_username ? String(row.crm_username) : null,
    display_name: resolveEmployeeDisplayName(row.full_name ? String(row.full_name) : "", (row as { nickname?: string | null }).nickname ?? null) || null,
    full_name: row.full_name ? String(row.full_name) : null,
    job_title: row.job_title ? String(row.job_title) : null,
    line: null,
    manager_hr_id: row.manager_hr_id ? String(row.manager_hr_id) : null,
    position_title: null,
    region: null,
    area: null,
    employment_status: row.employment_status ? String(row.employment_status) : null,
  }));

  // NEVER CACHED (cache audit, 2026-10-26). These rows carry no line, region or area, so holding them
  // for the cache's five minutes stamped every import row read in that window "Unassigned". They
  // answer this one call; the next one tries the full directory again.
  return rows;
}

async function loadVacancies() {
  const cached = directoryMemory.__phoenixSalesVacancies;
  if (cached && cached.expiresAt > Date.now()) {
    return cached.rows;
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("position_vacancies")
    .select("vacancy_code,job_title,status,manager_hr_id,areas(name),lines(name),positions(title)")
    .eq("status", "open");

  if (error) return [] as VacancyDirectoryRow[];

  const rows = (data ?? [])
    .filter((row) => {
      const title = String((row.positions as { title?: unknown } | null)?.title ?? "").toLowerCase();
      const jobTitle = String((row as { job_title?: unknown }).job_title ?? "").toLowerCase();
      const combinedTitle = `${title} ${jobTitle}`;
      return combinedTitle.includes("medical representative") || /\bmr\b/.test(combinedTitle);
    })
    .map((row) => ({
      areaName: (row.areas as { name?: unknown } | null)?.name ? String((row.areas as { name?: unknown }).name) : null,
      lineName: (row.lines as { name?: unknown } | null)?.name ? String((row.lines as { name?: unknown }).name) : null,
      managerHrId: row.manager_hr_id ? String(row.manager_hr_id) : null,
      status: row.status ? String(row.status) : null,
      vacancyCode: row.vacancy_code ? String(row.vacancy_code) : null,
    }));

  directoryMemory.__phoenixSalesVacancies = {
    rows,
    expiresAt: Date.now() + 5 * 60 * 1000,
  };
  return rows;
}

export function linkSalesRecordAgainstDirectory(
  source: {
    employeeHrId?: string | null;
    employeeCrmId?: string | null;
    employeeLookupKey?: string | null;
    employeeName?: string | null;
    line?: string | null;
    managerHrId?: string | null;
    territory?: string | null;
  },
  directory: EmployeeDirectoryRow[],
  vacancies: VacancyDirectoryRow[] = [],
): LinkResult {
  const hrId = hrIdKey(source.employeeHrId);
  const crmId = normalize(source.employeeCrmId);
  const lookup = normalize(source.employeeLookupKey);
  const rawHrId = compact(source.employeeHrId);
  const rawCrmId = compact(source.employeeCrmId);
  const rawLookup = compact(source.employeeLookupKey);
  const diagnostics: string[] = [];

  if (!isVacantAreaCode(source.employeeHrId) && isSalesOthersBucket(source)) {
    return {
      employeeHrId: null,
      employeeCrmId: source.employeeCrmId ?? null,
      employeeLookupKey: "Others",
      employeeName: "Others",
      linkStatus: "unlinked",
      linkConfidence: 0,
      line: source.line ?? null,
      diagnostics,
    };
  }

  const withMatchedEmployee = (match: EmployeeDirectoryRow, confidence: number): LinkResult => {
    const mismatch = lineMismatchMessage(source.line, match.line);
    if (mismatch) diagnostics.push(`WARN: ${mismatch}`);
    if (isInactiveEmploymentStatus(match.employment_status)) {
      diagnostics.push(
        `WARN: Linked employee ${employeeLabel(match)} has employment status "${compact(match.employment_status)}".`
      );
    }
    return {
      employeeHrId: match.hr_id,
      employeeCrmId: match.crm_id ?? null,
      employeeLookupKey: match.crm_username ?? source.employeeLookupKey ?? null,
      employeeName: match.display_name ?? match.full_name ?? source.employeeName ?? null,
      linkStatus: "linked",
      linkConfidence: confidence,
      line: match.line ?? source.line ?? null,
      managerHrId: match.manager_hr_id ?? resolvePersistableManagerHrId(source.managerHrId, directory, diagnostics),
      diagnostics,
    };
  };

  if (!hrId && !crmId && !lookup) {
    return {
      employeeHrId: source.employeeHrId ?? null,
      employeeCrmId: source.employeeCrmId ?? null,
      employeeLookupKey: source.employeeLookupKey ?? null,
      employeeName: source.employeeName ?? null,
      linkStatus: "unlinked",
      linkConfidence: 0,
      line: source.line ?? null,
      diagnostics: ["No employee linkage key was provided. Expected one of: hr_id, crm_id, or crm_username."],
    };
  }

  if (hrId) {
    const match = directory.find((employee) => hrIdKey(employee.hr_id) === hrId);
    if (match) return withMatchedEmployee(match, 1);
    if (isVacantAreaCode(rawHrId)) {
      const vacancy = matchVacancyForSource(source, vacancies);
      const managerHrId = vacancy?.managerHrId ?? resolvePersistableManagerHrId(source.managerHrId, directory, diagnostics);
      return {
        employeeHrId: null,
        employeeCrmId: source.employeeCrmId ?? null,
        employeeLookupKey: rawHrId,
        employeeName: source.employeeName ?? rawHrId,
        linkStatus: "unlinked",
        linkConfidence: vacancy ? 0.75 : 0,
        line: vacancy?.lineName ?? source.line ?? null,
        managerHrId,
        diagnostics: [
          ...diagnostics,
          vacancy
            ? `Vacancy area code "${rawHrId}" matched open vacancy ${vacancy.vacancyCode ?? "without code"} for ${compact(vacancy.areaName) || compact(source.territory) || "this territory"}.`
            : `Vacancy area code "${rawHrId}" was provided in the HR ID column. It is treated as a vacant area, not a missing employee.`,
        ],
      };
    }
    return {
      employeeHrId: source.employeeHrId ?? null,
      employeeCrmId: source.employeeCrmId ?? null,
      employeeLookupKey: source.employeeLookupKey ?? null,
      employeeName: source.employeeName ?? null,
      linkStatus: "unlinked",
      linkConfidence: 0,
      line: source.line ?? null,
      managerHrId: resolvePersistableManagerHrId(source.managerHrId, directory, diagnostics),
      diagnostics: [...diagnostics, makeNoMatchMessage("HR ID", rawHrId)],
    };
  }

  if (source.managerHrId) {
    return {
      employeeHrId: source.employeeHrId ?? null,
      employeeCrmId: source.employeeCrmId ?? null,
      employeeLookupKey: source.employeeLookupKey ?? null,
      employeeName: source.employeeName ?? null,
      linkStatus: "unlinked",
      linkConfidence: 0,
      line: source.line ?? null,
      managerHrId: resolvePersistableManagerHrId(source.managerHrId, directory, diagnostics),
      diagnostics: [...diagnostics, "No MR HR ID was provided. This area stays unlinked at MR level and is counted under the manager HR ID."],
    };
  }

  if (crmId) {
    const match = directory.find((employee) => normalize(employee.crm_id) === crmId);
    if (match) return withMatchedEmployee(match, 0.98);
    diagnostics.push(makeNoMatchMessage("CRM ID", rawCrmId));
  }

  if (lookup) {
    const matches = directory.filter((employee) => normalize(employee.crm_username) === lookup);
    if (matches.length === 1) return withMatchedEmployee(matches[0], 0.92);
    if (matches.length > 1) {
      const samples = matches.slice(0, 3).map(employeeLabel).join(", ");
      return {
        employeeHrId: null,
        employeeCrmId: null,
        employeeLookupKey: source.employeeLookupKey ?? null,
        employeeName: source.employeeName ?? null,
        linkStatus: "ambiguous",
        linkConfidence: 0.4,
        line: source.line ?? null,
        diagnostics: [
          `Lookup key "${rawLookup}" matched ${matches.length} employees, so the row was left unlinked.`,
          samples ? `Matched employees: ${samples}${matches.length > 3 ? ", ..." : ""}.` : "",
        ].filter(Boolean),
      };
    }
    diagnostics.push(makeNoMatchMessage("Lookup key", rawLookup));
  }

  return {
    employeeHrId: source.employeeHrId ?? null,
    employeeCrmId: source.employeeCrmId ?? null,
    employeeLookupKey: source.employeeLookupKey ?? null,
    employeeName: source.employeeName ?? null,
    linkStatus: "unlinked",
    linkConfidence: 0,
    line: source.line ?? null,
    managerHrId: resolvePersistableManagerHrId(source.managerHrId, directory, diagnostics),
    diagnostics,
  };
}

export async function linkSalesRecords(records: SalesRecordInput[]) {
  const [directory, vacancies] = await Promise.all([loadDirectory(), loadVacancies()]);
  return records.map((record) => {
    const link = linkSalesRecordAgainstDirectory(record, directory, vacancies);
    return {
      ...record,
      employeeHrId: link.employeeHrId !== undefined ? link.employeeHrId : record.employeeHrId ?? null,
      employeeCrmId: link.employeeCrmId !== undefined ? link.employeeCrmId : record.employeeCrmId ?? null,
      employeeLookupKey: link.employeeLookupKey !== undefined ? link.employeeLookupKey : record.employeeLookupKey ?? null,
      employeeName: link.employeeName !== undefined ? link.employeeName : record.employeeName ?? null,
      managerHrId: link.managerHrId ?? null,
      line: record.line || link.line || "Unassigned",
      linkStatus: link.linkStatus,
      linkConfidence: link.linkConfidence,
      validationNotes:
        link.linkStatus === "linked"
          ? [...record.validationNotes, ...link.diagnostics]
          : [...record.validationNotes, ...link.diagnostics.map((message) => `WARN: ${message}`)],
    };
  });
}

export async function summarizeSalesLinkage(records: SalesRecordInput[]) {
  const directory = await loadDirectory();
  const directoryByHrId = new Map(directory.map((employee) => [hrIdKey(employee.hr_id), employee]));
  const importableRecords = records.filter((record) => record.validationState !== "failed");
  const mrCandidates = new Map<string, { label: string; line: string | null | undefined }>();
  const dsmCandidates = new Map<string, { label: string; line: string | null | undefined }>();
  const labelByHrId = (hrId: string, fallbackName?: string | null) => {
    const employee = directoryByHrId.get(hrIdKey(hrId));
    if (employee) return employeeLabel(employee);
    return sourceLabel(hrId, fallbackName);
  };

  importableRecords.forEach((record) => {
    const mrId = compact(record.employeeHrId);
    if (mrId && !isSalesOthersBucket(record) && !isSalesVacancyAreaCode(mrId)) {
      mrCandidates.set(mrId, { label: labelByHrId(mrId, record.employeeName || record.employeeLookupKey), line: record.line });
    }

    const dsmId = compact(record.managerHrId);
    const dsmCandidate = directoryByHrId.get(hrIdKey(dsmId));
    if (
      dsmId &&
      !hasNsmRole(dsmCandidate) &&
      !isSalesOthersBucket({ employeeHrId: dsmId, employeeLookupKey: record.employeeLookupKey, employeeName: record.employeeName, line: record.line })
    ) {
      dsmCandidates.set(dsmId, { label: labelByHrId(dsmId, record.employeeLookupKey || record.employeeName), line: record.line });
    }
  });

  const mrEntries = [...mrCandidates.entries()].sort((left, right) => left[1].label.localeCompare(right[1].label));
  const dsmEntries = [...dsmCandidates.entries()].sort((left, right) => left[1].label.localeCompare(right[1].label));
  const isValidMr = (hrId: string, line: string | null | undefined) => {
    const employee = directoryByHrId.get(hrIdKey(hrId));
    return hasMrRole(employee) && hasLineMatch(employee, line);
  };
  const isValidDsm = (hrId: string, line: string | null | undefined) => {
    const employee = directoryByHrId.get(hrIdKey(hrId));
    return hasDsmRole(employee) && hasLineMatch(employee, line);
  };
  const linkedDsmIds = dsmEntries.map(([hrId, meta]) => ({ hrId, line: meta.line })).filter(({ hrId, line }) => isValidDsm(hrId, line));
  const nsmIds = new Set(
    linkedDsmIds
      .map(({ hrId }) => compact(directoryByHrId.get(hrIdKey(hrId))?.manager_hr_id))
      .filter(Boolean)
  );
  const nsmMissingNames = linkedDsmIds
    .filter(({ hrId }) => !compact(directoryByHrId.get(hrIdKey(hrId))?.manager_hr_id))
    .map(({ hrId }) => `Missing NSM manager for ${employeeLabel(directoryByHrId.get(hrIdKey(hrId))!)}`);
  const nsmEntries = [...nsmIds]
    .map((hrId) => [hrId, sourceLabel(hrId, directoryByHrId.get(hrIdKey(hrId))?.full_name)] as const)
    .sort((left, right) => left[1].localeCompare(right[1]));

  return {
    dsmLinked: dsmEntries.filter(([hrId, meta]) => isValidDsm(hrId, meta.line)).length,
    dsmLinkedNames: dsmEntries.filter(([hrId, meta]) => isValidDsm(hrId, meta.line)).map(([, meta]) => meta.label),
    dsmNotLinkedNames: dsmEntries
      .filter(([hrId, meta]) => !isValidDsm(hrId, meta.line))
      .map(([hrId, meta]) => roleMismatchLabel(`HR ${hrId} from manager hr id column`, directoryByHrId.get(hrIdKey(hrId)), "DSM", meta.line)),
    dsmTotal: dsmEntries.length,
    mrLinked: mrEntries.filter(([hrId, meta]) => isValidMr(hrId, meta.line)).length,
    mrLinkedNames: mrEntries.filter(([hrId, meta]) => isValidMr(hrId, meta.line)).map(([, meta]) => meta.label),
    mrNotLinkedNames: mrEntries
      .filter(([hrId, meta]) => !isValidMr(hrId, meta.line))
      .map(([hrId, meta]) => roleMismatchLabel(`HR ${hrId} from hr id column`, directoryByHrId.get(hrIdKey(hrId)), "MR", meta.line)),
    mrTotal: mrEntries.length,
    nsmLinked: nsmEntries.filter(([hrId]) => hasNsmRole(directoryByHrId.get(hrIdKey(hrId)))).length,
    nsmLinkedNames: nsmEntries.filter(([hrId]) => hasNsmRole(directoryByHrId.get(hrIdKey(hrId)))).map(([, label]) => label),
    nsmNotLinkedNames: [
      ...nsmEntries
        .filter(([hrId]) => !hasNsmRole(directoryByHrId.get(hrIdKey(hrId))))
        .map(([hrId, label]) => roleMismatchLabel(label, directoryByHrId.get(hrIdKey(hrId)), "NSM")),
      ...nsmMissingNames,
    ],
    nsmTotal: nsmEntries.length + nsmMissingNames.length,
  };
}

export async function filterClosingSheetRollupRecords(records: SalesRecordInput[]) {
  const directory = await loadDirectory();
  const directoryByHrId = new Map(directory.map((employee) => [hrIdKey(employee.hr_id), employee]));

  return records.filter((record) => {
    const employeeHrId = compact(record.employeeHrId);
    if (!employeeHrId) return true;

    const employee = directoryByHrId.get(hrIdKey(employeeHrId));
    if (!employee) return true;

    const managerHrId = compact(record.managerHrId);
    const manager = directoryByHrId.get(hrIdKey(managerHrId));
    const override = salesRoleOverrideForHrId(employeeHrId);
    if (override === "MR_DSM" && hrIdsMatch(employeeHrId, managerHrId)) return true;

    if (hasNsmRole(employee)) return false;
    if (hasDsmRole(employee) && (!managerHrId || hasNsmRole(manager))) return false;
    return true;
  });
}
