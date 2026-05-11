import { getSupabaseAdmin } from "@/lib/supabase/server";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { canonicalSalesLine, isSalesOthersBucket } from "@/lib/sales/others";
import { salesRoleOverrideForHrId } from "@/lib/sales/role-mapping";
import type { EmployeeDirectoryRow, SalesLinkStatus, SalesRecordInput } from "@/lib/sales/types";

type LinkResult = {
  employeeHrId?: string | null;
  employeeCrmId?: string | null;
  employeeLookupKey?: string | null;
  employeeName?: string | null;
  linkStatus: SalesLinkStatus;
  linkConfidence: number;
  line?: string | null;
  diagnostics: string[];
};

function normalize(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function compact(value: unknown) {
  return String(value ?? "").trim();
}

function isInactiveEmploymentStatus(status: string | null | undefined) {
  const normalized = normalize(status);
  if (!normalized) return false;
  return ["inactive", "resigned", "terminated", "left", "suspended", "vacant"].some((token) =>
    normalized.includes(token)
  );
}

function employeeLabel(employee: EmployeeDirectoryRow) {
  const name = compact(employee.full_name) || "Unknown employee";
  const hrId = compact(employee.hr_id);
  return hrId ? `${name} [HR ${hrId}]` : name;
}

function sourceLabel(hrId: string, fallbackName?: string | null) {
  const name = compact(fallbackName);
  return name ? `${name} [HR ${hrId}]` : `HR ${hrId}`;
}

export async function getSalesPeopleLabels(hrIds: Array<string | null | undefined>) {
  const wanted = new Set(hrIds.map((hrId) => normalize(hrId)).filter(Boolean));
  if (wanted.size === 0) return new Map<string, string>();

  const directory = await loadDirectory();
  const labels = new Map<string, string>();
  directory.forEach((employee) => {
    const hrId = normalize(employee.hr_id);
    if (wanted.has(hrId)) labels.set(hrId, employeeLabel(employee));
  });

  hrIds.forEach((hrId) => {
    const normalized = normalize(hrId);
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

function hasLineMatch(employee: EmployeeDirectoryRow | undefined, line: string | null | undefined) {
  if (salesRoleOverrideForHrId(employee?.hr_id)) return true;
  const sourceLine = canonicalSalesLine(line);
  const employeeLine = canonicalSalesLine(employee?.line);
  if (!sourceLine || !employeeLine) return true;
  return sourceLine === employeeLine;
}

function roleMismatchLabel(label: string, employee: EmployeeDirectoryRow | undefined, expectedRole: string, line?: string | null) {
  if (!employee) return `${label} - expected ${expectedRole}, HR ID was not found in employee database`;
  const lineNote = hasLineMatch(employee, line) ? "" : `, line ${compact(employee.line) || "missing"}`;
  return `${label} - expected ${expectedRole}, found ${roleLabel(employee)}${lineNote}`;
}

function makeNoMatchMessage(label: string, value: string) {
  return `${label} "${value}" was provided in the sheet, but no employee matched it.`;
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

const directoryMemory = globalThis as typeof globalThis & { __phoenixSalesDirectory?: DirectoryCache };

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
    .select("hr_id, crm_id, crm_username, full_name, employment_status, manager_hr_id, job_title, line_id, area_id")
    .order("full_name", { ascending: true });

  if (error) return [] as EmployeeDirectoryRow[];

  const rows = (data ?? []).map((row) => ({
    hr_id: String(row.hr_id),
    crm_id: row.crm_id ? String(row.crm_id) : null,
    crm_username: row.crm_username ? String(row.crm_username) : null,
    full_name: row.full_name ? String(row.full_name) : null,
    job_title: row.job_title ? String(row.job_title) : null,
    line: null,
    manager_hr_id: row.manager_hr_id ? String(row.manager_hr_id) : null,
    position_title: null,
    region: null,
    area: null,
    employment_status: row.employment_status ? String(row.employment_status) : null,
  }));

  setMemoryCache(rows);
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
  },
  directory: EmployeeDirectoryRow[]
): LinkResult {
  const hrId = normalize(source.employeeHrId);
  const crmId = normalize(source.employeeCrmId);
  const lookup = normalize(source.employeeLookupKey);
  const rawHrId = compact(source.employeeHrId);
  const rawCrmId = compact(source.employeeCrmId);
  const rawLookup = compact(source.employeeLookupKey);
  const diagnostics: string[] = [];

  if (isSalesOthersBucket(source)) {
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
      employeeName: match.full_name ?? source.employeeName ?? null,
      linkStatus: "linked",
      linkConfidence: confidence,
      line: match.line ?? source.line ?? null,
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
    const match = directory.find((employee) => normalize(employee.hr_id) === hrId);
    if (match) return withMatchedEmployee(match, 1);
    return {
      employeeHrId: source.employeeHrId ?? null,
      employeeCrmId: source.employeeCrmId ?? null,
      employeeLookupKey: source.employeeLookupKey ?? null,
      employeeName: source.employeeName ?? null,
      linkStatus: "unlinked",
      linkConfidence: 0,
      line: source.line ?? null,
      diagnostics: [makeNoMatchMessage("HR ID", rawHrId)],
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
      diagnostics: ["No MR HR ID was provided. This area stays unlinked at MR level and is counted under the manager HR ID."],
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
    diagnostics,
  };
}

export async function linkSalesRecords(records: SalesRecordInput[]) {
  const directory = await loadDirectory();
  return records.map((record) => {
    const link = linkSalesRecordAgainstDirectory(record, directory);
    return {
      ...record,
      employeeHrId: link.employeeHrId ?? record.employeeHrId ?? null,
      employeeCrmId: link.employeeCrmId ?? record.employeeCrmId ?? null,
      employeeLookupKey: link.employeeLookupKey ?? record.employeeLookupKey ?? null,
      employeeName: link.employeeName ?? record.employeeName ?? null,
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
  const directoryByHrId = new Map(directory.map((employee) => [normalize(employee.hr_id), employee]));
  const importableRecords = records.filter((record) => record.validationState !== "failed");
  const mrCandidates = new Map<string, { label: string; line: string | null | undefined }>();
  const dsmCandidates = new Map<string, { label: string; line: string | null | undefined }>();
  const labelByHrId = (hrId: string, fallbackName?: string | null) => {
    const employee = directoryByHrId.get(normalize(hrId));
    if (employee) return employeeLabel(employee);
    return sourceLabel(hrId, fallbackName);
  };

  importableRecords.forEach((record) => {
    const mrId = compact(record.employeeHrId);
    if (mrId && !isSalesOthersBucket(record)) {
      mrCandidates.set(mrId, { label: labelByHrId(mrId, record.employeeName || record.employeeLookupKey), line: record.line });
    }

    const dsmId = compact(record.managerHrId);
    const dsmCandidate = directoryByHrId.get(normalize(dsmId));
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
    const employee = directoryByHrId.get(normalize(hrId));
    return hasMrRole(employee) && hasLineMatch(employee, line);
  };
  const isValidDsm = (hrId: string, line: string | null | undefined) => {
    const employee = directoryByHrId.get(normalize(hrId));
    return hasDsmRole(employee) && hasLineMatch(employee, line);
  };
  const linkedDsmIds = dsmEntries.map(([hrId, meta]) => ({ hrId, line: meta.line })).filter(({ hrId, line }) => isValidDsm(hrId, line));
  const nsmIds = new Set(
    linkedDsmIds
      .map(({ hrId }) => compact(directoryByHrId.get(normalize(hrId))?.manager_hr_id))
      .filter(Boolean)
  );
  const nsmMissingNames = linkedDsmIds
    .filter(({ hrId }) => !compact(directoryByHrId.get(normalize(hrId))?.manager_hr_id))
    .map(({ hrId }) => `Missing NSM manager for ${employeeLabel(directoryByHrId.get(normalize(hrId))!)}`);
  const nsmEntries = [...nsmIds]
    .map((hrId) => [hrId, sourceLabel(hrId, directoryByHrId.get(normalize(hrId))?.full_name)] as const)
    .sort((left, right) => left[1].localeCompare(right[1]));

  return {
    dsmLinked: dsmEntries.filter(([hrId, meta]) => isValidDsm(hrId, meta.line)).length,
    dsmLinkedNames: dsmEntries.filter(([hrId, meta]) => isValidDsm(hrId, meta.line)).map(([, meta]) => meta.label),
    dsmNotLinkedNames: dsmEntries
      .filter(([hrId, meta]) => !isValidDsm(hrId, meta.line))
      .map(([hrId, meta]) => roleMismatchLabel(`HR ${hrId} from manager hr id column`, directoryByHrId.get(normalize(hrId)), "DSM", meta.line)),
    dsmTotal: dsmEntries.length,
    mrLinked: mrEntries.filter(([hrId, meta]) => isValidMr(hrId, meta.line)).length,
    mrLinkedNames: mrEntries.filter(([hrId, meta]) => isValidMr(hrId, meta.line)).map(([, meta]) => meta.label),
    mrNotLinkedNames: mrEntries
      .filter(([hrId, meta]) => !isValidMr(hrId, meta.line))
      .map(([hrId, meta]) => roleMismatchLabel(`HR ${hrId} from hr id column`, directoryByHrId.get(normalize(hrId)), "MR", meta.line)),
    mrTotal: mrEntries.length,
    nsmLinked: nsmEntries.filter(([hrId]) => hasNsmRole(directoryByHrId.get(normalize(hrId)))).length,
    nsmLinkedNames: nsmEntries.filter(([hrId]) => hasNsmRole(directoryByHrId.get(normalize(hrId)))).map(([, label]) => label),
    nsmNotLinkedNames: [
      ...nsmEntries
        .filter(([hrId]) => !hasNsmRole(directoryByHrId.get(normalize(hrId))))
        .map(([hrId, label]) => roleMismatchLabel(label, directoryByHrId.get(normalize(hrId)), "NSM")),
      ...nsmMissingNames,
    ],
    nsmTotal: nsmEntries.length + nsmMissingNames.length,
  };
}

export async function filterClosingSheetRollupRecords(records: SalesRecordInput[]) {
  const directory = await loadDirectory();
  const directoryByHrId = new Map(directory.map((employee) => [normalize(employee.hr_id), employee]));

  return records.filter((record) => {
    const employeeHrId = compact(record.employeeHrId);
    if (!employeeHrId) return true;

    const employee = directoryByHrId.get(normalize(employeeHrId));
    if (!employee) return true;

    const managerHrId = compact(record.managerHrId);
    const manager = directoryByHrId.get(normalize(managerHrId));
    const override = salesRoleOverrideForHrId(employeeHrId);
    if (override === "MR_DSM" && normalize(employeeHrId) === normalize(managerHrId)) return true;

    if (hasNsmRole(employee)) return false;
    if (hasDsmRole(employee) && (!managerHrId || hasNsmRole(manager))) return false;
    return true;
  });
}
