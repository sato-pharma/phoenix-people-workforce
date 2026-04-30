import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { EmployeeDirectoryRow, SalesLinkStatus, SalesRecordInput, TargetRecord } from "@/lib/sales/types";

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

function canonicalLine(value: unknown) {
  return normalize(value)
    .replace(/\bline\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function otherBucketForLine(line: string | null | undefined) {
  const normalizedLine = canonicalLine(line);
  if (normalizedLine === "cns") return "O-3";
  if (normalizedLine.includes("anti") && normalizedLine.includes("infective")) return "O-2";
  if (normalizedLine.includes("pedia")) return "O-1";
  return null;
}

function isOthersBucket(source: {
  employeeHrId?: string | null;
  employeeLookupKey?: string | null;
  employeeName?: string | null;
  line?: string | null;
}) {
  const expectedHrId = otherBucketForLine(source.line);
  const hrId = normalize(source.employeeHrId);
  const lookup = normalize(source.employeeLookupKey);
  const name = normalize(source.employeeName);

  return Boolean(
    expectedHrId &&
      (hrId === normalize(expectedHrId) ||
        lookup === "others" ||
        lookup === "other" ||
        name === "others" ||
        name === "other")
  );
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

function makeNoMatchMessage(label: string, value: string) {
  return `${label} "${value}" was provided in the sheet, but no employee matched it.`;
}

function lineMismatchMessage(sourceLine: string | null | undefined, employeeLine: string | null | undefined) {
  const source = compact(sourceLine);
  const employee = compact(employeeLine);
  if (!source || !employee) return null;
  if (canonicalLine(source) === canonicalLine(employee)) return null;
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

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("employees")
    .select("hr_id, crm_id, crm_username, full_name, employment_status, line_id, area_id")
    .order("full_name", { ascending: true });

  if (error) return [] as EmployeeDirectoryRow[];

  const rows = (data ?? []).map((row) => ({
    hr_id: String(row.hr_id),
    crm_id: row.crm_id ? String(row.crm_id) : null,
    crm_username: row.crm_username ? String(row.crm_username) : null,
    full_name: row.full_name ? String(row.full_name) : null,
    line: null,
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

  if (isOthersBucket(source)) {
    const bucketHrId = otherBucketForLine(source.line);
    return {
      employeeHrId: bucketHrId,
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
    diagnostics.push(makeNoMatchMessage("HR ID", rawHrId));
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

export async function linkTargetRecords(records: TargetRecord[]) {
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
      validationNotes:
        link.linkStatus === "linked"
          ? [...record.validationNotes, ...link.diagnostics]
          : [...record.validationNotes, ...link.diagnostics.map((message) => `FAIL: ${message}`)],
      status: link.linkStatus === "linked" ? record.status : "failed",
    };
  });
}
