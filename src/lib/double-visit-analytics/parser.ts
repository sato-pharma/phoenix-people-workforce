import { createHash } from "node:crypto";

import ExcelJS from "exceljs";

import { isTerminalEmploymentStatus } from "@/lib/auth/session-lifecycle";
import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import type { IReports360Visit } from "@/lib/field-workforce-compliance/ireports360-client";
import { canonicalHrIdForDisplay, canonicalHrIdKey } from "@/lib/hr-id";
import { excelCellText, excelWorksheetToJsonRows, loadExcelWorkbook } from "@/lib/uploads/exceljs-rows";
import type {
  DoubleVisitImportSummary,
  DoubleVisitNormalizedRow,
  DoubleVisitPeriod,
  DoubleVisitPreview,
  DoubleVisitSourceType,
  DoubleVisitValidationIssue,
  DoubleVisitVisitedEmployeeStatus,
} from "@/lib/double-visit-analytics/types";

const requiredExcelHeaders = [
  "Double Visit with",
  "DV HR ID",
  "Employee",
  "HR ID",
  "Date",
  "Count",
  "AM \\ PM",
];

function text(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function nullableText(value: unknown) {
  const valueText = text(value);
  return valueText || null;
}

function lower(value: unknown) {
  return text(value).toLowerCase();
}

function normalizeHeader(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function numberValue(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function normalizeDoubleVisitPeriod(value: unknown): DoubleVisitPeriod {
  const normalized = text(value).toUpperCase();
  if (normalized === "AM") return "AM";
  if (normalized === "PM") return "PM";
  return "UNKNOWN";
}

function toIsoDate(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const raw = text(value);
  if (!raw) return null;

  const isoMatch = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  // Day-first text dates (dd/mm/yyyy, dd-mm-yyyy) — common in localized exports. Only
  // treat as day-first when unambiguous (day > 12); otherwise `new Date` would parse
  // "25/06/2026" as Invalid and the row would be SILENTLY dropped as invalid.
  const dmy = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    if (day > 12 && month >= 1 && month <= 12) {
      return `${dmy[3]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }

  const date = new Date(raw);
  if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
  return null;
}

function rowHash(payload: Record<string, unknown>) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function classifyVisitedEmployeeStatus(hrId: unknown): DoubleVisitVisitedEmployeeStatus {
  const raw = text(hrId);
  if (!raw) return "blank_hr_id";
  const normalized = raw.toLowerCase();
  if (normalized === "vacant") return "vacant";
  if (normalized === "resigned" || normalized === "terminated") return "resigned";
  if (normalized === "#n/a" || normalized === "n/a" || normalized === "na" || normalized === "unmapped") {
    return "unmapped";
  }
  return "active_mapped";
}

function cleanHrId(value: unknown) {
  const status = classifyVisitedEmployeeStatus(value);
  if (status !== "active_mapped") return null;
  return canonicalHrIdForDisplay(text(value));
}

export function extractEmployeeNameAreaLine(value: unknown) {
  const raw = text(value);
  if (!raw) return { areaName: null, lineName: null, name: null, raw: "" };

  const match = raw.match(/^(.*?)\s*\((.*?)\)\s*$/);
  if (!match) return { areaName: null, lineName: null, name: raw, raw };

  const name = text(match[1]) || null;
  const inside = text(match[2]);
  const parts = inside
    .split(/[\/|]/)
    .map((part) => text(part))
    .filter(Boolean);

  const lineName = parts.length > 1 ? parts[parts.length - 1] : null;
  const areaName = parts.length > 1 ? parts.slice(0, -1).join(" / ") : parts[0] ?? null;
  return {
    areaName,
    lineName,
    name: name || raw,
    raw,
  };
}

export function summaryFromRows(rows: DoubleVisitNormalizedRow[], warnings: DoubleVisitValidationIssue[]): DoubleVisitImportSummary {
  const totalVisits = rows.reduce((sum, row) => sum + row.visitCount, 0);
  const activeMappedVisitCount = rows
    .filter((row) => row.visitedEmployeeStatus === "active_mapped")
    .reduce((sum, row) => sum + row.visitCount, 0);
  const vacantOrUnmappedVisitCount = totalVisits - activeMappedVisitCount;
  const doubleVisitors = new Set(rows.map((row) => canonicalHrIdKey(row.doubleVisitorHrId)).filter(Boolean));
  // Only count active_mapped rows — non_mr (manager-to-manager) rows are excluded
  const coveredMrs = new Set(
    rows
      .filter((row) => row.visitedEmployeeStatus === "active_mapped")
      .map((row) => canonicalHrIdKey(row.visitedEmployeeHrId))
      .filter(Boolean),
  );
  const areas = new Set(rows.map((row) => lower(row.areaName)).filter(Boolean));
  const lines = new Set(rows.map((row) => lower(row.lineName)).filter(Boolean));
  return {
    activeMappedVisitCount,
    amVisitCount: rows.filter((row) => row.period === "AM").reduce((sum, row) => sum + row.visitCount, 0),
    areaCount: areas.size,
    dateFrom: rows.map((row) => row.activityDate).sort()[0] ?? new Date().toISOString().slice(0, 10),
    dateTo: rows.map((row) => row.activityDate).sort().at(-1) ?? new Date().toISOString().slice(0, 10),
    doubleVisitorCount: doubleVisitors.size,
    duplicateWarningCount: warnings.filter((warning) => warning.code === "duplicate_source_row").length,
    lineCount: lines.size,
    missingVisitedHrIdCount: rows.filter((row) => row.visitedEmployeeStatus === "blank_hr_id").length,
    mrCoverageCount: coveredMrs.size,
    pmVisitCount: rows.filter((row) => row.period === "PM").reduce((sum, row) => sum + row.visitCount, 0),
    totalRows: rows.length,
    totalVisits,
    vacantOrUnmappedVisitCount,
    warningCount: warnings.length,
  };
}

function buildPreview(input: {
  fileName: string;
  rows: DoubleVisitNormalizedRow[];
  sheetName: string | null;
  sourceType: DoubleVisitSourceType;
  warnings: DoubleVisitValidationIssue[];
}): DoubleVisitPreview {
  return {
    metadata: {
      fileName: input.fileName,
      generatedAt: new Date().toISOString(),
      sheetName: input.sheetName,
      sourceType: input.sourceType,
    },
    rows: input.rows,
    sampleRows: input.rows.slice(0, 25),
    summary: summaryFromRows(input.rows, input.warnings),
    warnings: input.warnings,
  };
}

function hasRequiredHeaders(worksheet: ExcelJS.Worksheet) {
  const headerRow = worksheet.getRow(1);
  const headers = Array.from({ length: worksheet.columnCount }, (_, index) =>
    normalizeHeader(excelCellText(headerRow.getCell(index + 1).value)),
  );
  return requiredExcelHeaders.every((required) => headers.includes(normalizeHeader(required)));
}

export function findDoubleVisitWorksheet(workbook: ExcelJS.Workbook) {
  return workbook.worksheets.find(hasRequiredHeaders) ?? workbook.worksheets[0] ?? null;
}

function valueByHeader(row: Record<string, unknown>, header: string) {
  const wanted = normalizeHeader(header);
  const entry = Object.entries(row).find(([key]) => normalizeHeader(key) === wanted);
  return entry ? entry[1] : "";
}

export function normalizeDoubleVisitExcelRows(input: {
  fileName: string;
  rows: Record<string, unknown>[];
  sheetName: string | null;
}): DoubleVisitPreview {
  const warnings: DoubleVisitValidationIssue[] = [];
  const seen = new Set<string>();
  const normalizedRows: DoubleVisitNormalizedRow[] = [];

  input.rows.forEach((row, index) => {
    const sourceRowNumber = index + 2;
    const activityDate = toIsoDate(valueByHeader(row, "Date"));
    const doubleVisitorHrId = nullableText(valueByHeader(row, "DV HR ID"));
    const visitCount = Math.max(0, Math.round(numberValue(valueByHeader(row, "Count"))));
    const employee = extractEmployeeNameAreaLine(valueByHeader(row, "Employee"));
    const visitedStatus = classifyVisitedEmployeeStatus(valueByHeader(row, "HR ID"));
    const normalized: DoubleVisitNormalizedRow | null =
      activityDate && (doubleVisitorHrId || nullableText(valueByHeader(row, "Double Visit with")))
        ? {
            activityDate,
            areaName: employee.areaName,
            doubleVisitorHrId: doubleVisitorHrId ? canonicalHrIdForDisplay(doubleVisitorHrId) : null,
            doubleVisitorName: nullableText(valueByHeader(row, "Double Visit with")),
            lineName: employee.lineName,
            period: normalizeDoubleVisitPeriod(valueByHeader(row, "AM \\ PM")),
            rawPayload: row,
            sourceHash: "",
            sourceRecordId: null,
            sourceRowNumber,
            sourceType: "excel",
            visitCount,
            visitedEmployeeHrId: cleanHrId(valueByHeader(row, "HR ID")),
            visitedEmployeeName: employee.name,
            visitedEmployeeStatus: visitedStatus,
          }
        : null;

    if (!normalized) {
      warnings.push({
        code: "skipped_invalid_row",
        message: `Row ${sourceRowNumber} is missing a date or double visitor.`,
        rowNumber: sourceRowNumber,
        severity: "warning",
      });
      return;
    }

    normalized.sourceHash = rowHash({
      activityDate: normalized.activityDate,
      doubleVisitorHrId: normalized.doubleVisitorHrId,
      employee: employee.raw,
      period: normalized.period,
      sourceRowNumber,
      visitCount: normalized.visitCount,
      visitedEmployeeHrId: valueByHeader(row, "HR ID"),
    });
    if (seen.has(normalized.sourceHash)) {
      warnings.push({
        code: "duplicate_source_row",
        message: `Row ${sourceRowNumber} looks duplicated inside this import.`,
        rowNumber: sourceRowNumber,
        severity: "warning",
      });
    }
    seen.add(normalized.sourceHash);
    normalizedRows.push(normalized);
  });

  return buildPreview({
    fileName: input.fileName,
    rows: normalizedRows,
    sheetName: input.sheetName,
    sourceType: "excel",
    warnings,
  });
}

// When the sheet's "HR ID" column is Vacant/blank/#N/A but the "Employee" cell exactly
// matches an ACTIVE employee's crm_username, credit the visit to that real MR. The source
// sheet sometimes marks an active rep's seat "Vacant", which otherwise drops their received
// double visits into the unmapped bucket and makes them look like zero-coverage MRs.
// Excel-only: the iReports360 path already maps the visited employee by CRM id.
export function recoverVisitedEmployeesByCrmUsername(
  preview: DoubleVisitPreview,
  employees: EmployeeDirectoryRow[],
): DoubleVisitPreview {
  const byUsername = new Map<string, EmployeeDirectoryRow[]>();
  for (const employee of employees) {
    const status = lower(employee.employmentStatus);
    if (status !== "active" && status !== "on_leave") continue;
    const key = lower(employee.crmUsername);
    if (!key) continue;
    byUsername.set(key, [...(byUsername.get(key) ?? []), employee]);
  }

  let recovered = 0;
  const rows = preview.rows.map((row) => {
    if (row.visitedEmployeeStatus === "active_mapped" || row.visitedEmployeeHrId) return row;
    const employeeCell = lower(valueByHeader(row.rawPayload, "Employee"));
    if (!employeeCell) return row;
    const matches = byUsername.get(employeeCell);
    if (!matches || matches.length !== 1) return row; // exact + unique active match only
    const hrId = canonicalHrIdForDisplay(matches[0].hrId);
    if (!hrId) return row;
    recovered += 1;
    return {
      ...row,
      areaName: row.areaName ?? matches[0].areaName,
      lineName: row.lineName ?? matches[0].lineName,
      visitedEmployeeHrId: hrId,
      visitedEmployeeName: matches[0].fullName ?? row.visitedEmployeeName,
      visitedEmployeeStatus: "active_mapped" as DoubleVisitVisitedEmployeeStatus,
    };
  });

  if (recovered === 0) return preview;
  const warnings: DoubleVisitValidationIssue[] = [
    ...preview.warnings,
    {
      code: "visited_hr_id_recovered",
      message: `${recovered} visit row(s) had a missing/Vacant HR ID but were matched to an active employee by name (crm_username) and credited to that MR.`,
      rowNumber: null,
      severity: "warning",
    },
  ];
  return {
    ...preview,
    rows,
    sampleRows: rows.slice(0, 25),
    summary: summaryFromRows(rows, warnings),
    warnings,
  };
}

export async function buildDoubleVisitPreviewFromWorkbook(input: {
  arrayBuffer: ArrayBuffer;
  fileName: string;
}) {
  const workbook = await loadExcelWorkbook(input.arrayBuffer);
  const worksheet = findDoubleVisitWorksheet(workbook);
  // Fail loudly on a wrong sheet / renamed-or-missing columns instead of silently
  // importing an empty/zero snapshot from the fallback sheet[0].
  if (!worksheet || !hasRequiredHeaders(worksheet)) {
    throw new Error(
      "This workbook is missing the required Double Visit columns (Double Visit with, DV HR ID, Employee, HR ID, Date, Count, AM \\ PM). Check the file and sheet, then re-upload.",
    );
  }
  const rows = excelWorksheetToJsonRows(worksheet, 1);
  return normalizeDoubleVisitExcelRows({
    fileName: input.fileName,
    rows,
    sheetName: worksheet.name,
  });
}

// Flags rows where the visited employee is a manager (DSM/RM/NSM/PM/GPM/TM) rather than
// a Medical Rep. These are CRM data errors — a DV is always manager → MR, never manager
// → manager. The caller (service.ts) builds managerHrIdKeys using resolveDvRole so we
// avoid a circular import here.
export function markManagerVisitedRows(
  preview: DoubleVisitPreview,
  managerHrIdKeys: Set<string>,
): DoubleVisitPreview {
  let flagged = 0;
  const rows = preview.rows.map((row) => {
    if (row.visitedEmployeeStatus !== "active_mapped" || !row.visitedEmployeeHrId) return row;
    const key = canonicalHrIdKey(row.visitedEmployeeHrId) ?? "";
    if (!managerHrIdKeys.has(key)) return row;
    flagged++;
    return { ...row, visitedEmployeeStatus: "non_mr" as DoubleVisitVisitedEmployeeStatus };
  });

  if (flagged === 0) return preview;
  const warnings: DoubleVisitValidationIssue[] = [
    ...preview.warnings,
    {
      code: "visited_employee_is_manager",
      message: `${flagged} row(s) had a visited employee who is a manager (DSM/RM/NSM/PM/GPM/TM), not a Medical Rep — these are CRM data errors and are excluded from DV counts.`,
      rowNumber: null,
      severity: "warning",
    },
  ];
  return {
    ...preview,
    rows,
    sampleRows: rows.slice(0, 25),
    summary: summaryFromRows(rows, warnings),
    warnings,
  };
}

// Reclassifies a row as "resigned" when the visited employee's CURRENT employment_status is
// terminal (resigned/terminated/inactive), rather than only firing on literal "resigned"/
// "terminated" text typed into a manual source sheet (see classifyVisitedEmployeeStatus above —
// that stays as-is for the Excel path). CRM-sourced data has no such manual annotation, so without
// this live check a visit against someone who has since left the company would stay "active_mapped"
// forever.
export function markResignedVisitedRows(
  preview: DoubleVisitPreview,
  employees: EmployeeDirectoryRow[],
): DoubleVisitPreview {
  const employeeByHrId = new Map(
    employees
      .map((employee) => [canonicalHrIdKey(employee.hrId), employee] as const)
      .filter((entry): entry is [string, EmployeeDirectoryRow] => Boolean(entry[0])),
  );

  let flagged = 0;
  const rows = preview.rows.map((row) => {
    if (row.visitedEmployeeStatus !== "active_mapped" || !row.visitedEmployeeHrId) return row;
    const key = canonicalHrIdKey(row.visitedEmployeeHrId);
    const employee = key ? employeeByHrId.get(key) : undefined;
    if (!employee || !isTerminalEmploymentStatus(employee.employmentStatus)) return row;
    flagged++;
    return { ...row, visitedEmployeeStatus: "resigned" as DoubleVisitVisitedEmployeeStatus };
  });

  if (flagged === 0) return preview;
  const warnings: DoubleVisitValidationIssue[] = [
    ...preview.warnings,
    {
      code: "visited_employee_resigned",
      message: `${flagged} row(s) had a visited employee whose current employment status is resigned/terminated — excluded from active DV counts.`,
      rowNumber: null,
      severity: "warning",
    },
  ];
  return {
    ...preview,
    rows,
    sampleRows: rows.slice(0, 25),
    summary: summaryFromRows(rows, warnings),
    warnings,
  };
}

function employeeByCrmId(employees: EmployeeDirectoryRow[]) {
  const byCrmId = new Map<number, EmployeeDirectoryRow>();
  for (const employee of employees) {
    const crmId = Number(text(employee.crmId));
    if (Number.isFinite(crmId)) byCrmId.set(crmId, employee);
  }
  return byCrmId;
}

export function normalizeIReports360DoubleVisits(input: {
  employees: EmployeeDirectoryRow[];
  fileName: string;
  visits: IReports360Visit[];
}) {
  const byCrmId = employeeByCrmId(input.employees);
  const warnings: DoubleVisitValidationIssue[] = [];
  const rows = input.visits.flatMap((visit, index): DoubleVisitNormalizedRow[] => {
    if (visit.doubleID == null || visit.doubleID === 0 || visit.doubleID === visit.agentID) return [];
    const doubleVisitor = byCrmId.get(visit.doubleID) ?? null;
    const visitedEmployee = byCrmId.get(visit.agentID) ?? null;
    const activityDate = toIsoDate(visit.visitDate);
    if (!activityDate) {
      warnings.push({
        code: "ireports360_missing_visit_date",
        message: `iReports360 visit ${visit.id} does not include a valid visit date.`,
        rowNumber: index + 1,
        severity: "warning",
      });
      return [];
    }
    if (!doubleVisitor) {
      warnings.push({
        code: "ireports360_double_visitor_unmapped",
        message: `Double visitor CRM ID ${visit.doubleID} could not be mapped to an HR ID.`,
        rowNumber: index + 1,
        severity: "warning",
      });
    }
    const employeeLabel = extractEmployeeNameAreaLine(visit.agentName ?? visit.contactName ?? visit.customerName);
    const visitedStatus: DoubleVisitVisitedEmployeeStatus = visitedEmployee ? "active_mapped" : "unmapped";
    const rawPayload = visit as unknown as Record<string, unknown>;
    const row: DoubleVisitNormalizedRow = {
      activityDate,
      areaName: visitedEmployee?.areaName ?? employeeLabel.areaName,
      doubleVisitorHrId: doubleVisitor?.hrId ?? `CRM:${visit.doubleID}`,
      doubleVisitorName: doubleVisitor?.fullName ?? visit.doubleName ?? null,
      lineName: visitedEmployee?.lineName ?? employeeLabel.lineName,
      period: normalizeDoubleVisitPeriod(visit.ampm),
      rawPayload,
      sourceHash: rowHash({ id: visit.id, source: "ireports360", visitDate: visit.visitDate }),
      sourceRecordId: String(visit.id),
      sourceRowNumber: index + 1,
      sourceType: "ireports360",
      visitCount: 1,
      visitedEmployeeHrId: visitedEmployee?.hrId ?? null,
      visitedEmployeeName: visitedEmployee?.fullName ?? employeeLabel.name ?? visit.agentName ?? null,
      visitedEmployeeStatus: visitedStatus,
    };
    return [row];
  });

  return buildPreview({
    fileName: input.fileName,
    rows,
    sheetName: "iReports360 Visits",
    sourceType: "ireports360",
    warnings,
  });
}
