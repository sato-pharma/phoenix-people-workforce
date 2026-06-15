import ExcelJS from "exceljs";

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { type AccessContext, normalizeHrIdForAccess, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { getEmployeeDirectoryRows, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import {
  iReports360GetVisits,
  iReports360Login,
} from "@/lib/field-workforce-compliance/ireports360-client";
import { getIReports360Config } from "@/lib/field-workforce-compliance/ireports360-config";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { resolveJobFunctionRole } from "@/lib/employees/job-function";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  buildDoubleVisitPreviewFromWorkbook,
  normalizeIReports360DoubleVisits,
} from "@/lib/double-visit-analytics/parser";
import type { PrivateCalendarItem } from "@/lib/private-calendar/logic";
import type {
  DoubleVisitBreakdownRow,
  DoubleVisitDashboardData,
  DoubleVisitExecutiveManagerReport,
  DoubleVisitExpenseWorkloadEvidence,
  DoubleVisitImportListItem,
  DoubleVisitImportStatus,
  DoubleVisitKpis,
  DoubleVisitMrScore,
  DoubleVisitNormalizedRow,
  DoubleVisitPreview,
  DoubleVisitSourceType,
} from "@/lib/double-visit-analytics/types";

const importsTable = "double_visit_imports";
const rowsTable = "double_visit_rows";
const archiveBatchSize = 500;

type JsonRecord = Record<string, unknown>;

type DoubleVisitImportRow = {
  active_mapped_visit_count: number | null;
  am_visit_count: number | null;
  area_count: number | null;
  date_from: string;
  date_to: string;
  double_visitor_count: number | null;
  duplicate_warning_count: number | null;
  id: string;
  line_count: number | null;
  missing_visited_hr_id_count: number | null;
  mr_coverage_count: number | null;
  pm_visit_count: number | null;
  published_at: string | null;
  published_by: string | null;
  sheet_name: string | null;
  source_filename: string;
  source_type: DoubleVisitSourceType;
  status: DoubleVisitImportStatus;
  total_rows: number | null;
  total_visits: number | null;
  uploaded_at: string;
  uploaded_by: string | null;
  vacant_or_unmapped_visit_count: number | null;
  warning_count: number | null;
};

type DoubleVisitDbRow = {
  activity_date: string;
  area_name: string | null;
  double_visitor_hr_id: string | null;
  double_visitor_name: string | null;
  id: string;
  import_id: string;
  line_name: string | null;
  period: "AM" | "PM" | "UNKNOWN";
  raw_payload: JsonRecord | null;
  source_record_id: string | null;
  source_row_number: number | null;
  source_type: DoubleVisitSourceType;
  visit_count: number | null;
  visited_employee_hr_id: string | null;
  visited_employee_name: string | null;
  visited_employee_status: string;
};

function text(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function nullableText(value: unknown) {
  const normalized = text(value);
  return normalized || null;
}

function asNumber(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round(value: number, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function schemaMissing(error: unknown) {
  const message = error instanceof Error ? error.message : JSON.stringify(error);
  return /double_visit_|schema cache|does not exist|PGRST205|42P01/i.test(message);
}

function throwSchemaMissingError() {
  throw new Error("Double Visit Analytics tables are not provisioned in the connected database. Please apply migration 20260612172427_double_visit_analytics.sql.");
}

function ensureNoSchemaError(error: unknown) {
  if (!error) return;
  if (schemaMissing(error)) throwSchemaMissingError();
  throw new Error(error instanceof Error ? error.message : "Unknown error");
}

function emptyDashboard(dateFrom: string, dateTo: string): DoubleVisitDashboardData {
  return {
    asOfDate: todayIso(),
    dateFrom,
    dateTo,
    executiveReports: [],
    filters: { areas: [], doubleVisitors: [], lines: [] },
    heatmap: { byArea: [], byLine: [] },
    imports: [],
    kpis: {
      activeCalendarDays: 0,
      activeDoubleVisitDays: 0,
      activeMappedVisitCount: 0,
      amPmRatio: null,
      amVisitCount: 0,
      averageVisitsPerDoubleVisitDay: 0,
      averageVisitsPerDoubleVisitor: 0,
      doubleVisitorCount: 0,
      mrCoverageCount: 0,
      pmVisitCount: 0,
      totalVisits: 0,
      vacantOrUnmappedShare: 0,
      vacantOrUnmappedVisitCount: 0,
    },
    mrScores: [],
    publishedImport: null,
    salesComparisonAvailable: false,
    schemaReady: false,
  };
}

async function isDoubleVisitSchemaReady() {
  const supabase = getSupabaseAdmin();
  const [importCheck, rowsCheck] = await Promise.all([
    supabase.from(importsTable).select("id", { count: "exact", head: true }).limit(1),
    supabase.from(rowsTable).select("id", { count: "exact", head: true }).limit(1),
  ]);
  if (schemaMissing(importCheck.error) || schemaMissing(rowsCheck.error)) return false;
  return true;
}

function actorFromAccess(access: AccessContext) {
  return resolveEmployeeIdentityId(access) ?? access.loginId ?? access.hrId ?? "system";
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function addDaysIso(dateIso: string, days: number) {
  const date = new Date(`${dateIso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function eachDate(start: string, end: string) {
  const dates: string[] = [];
  let current = start;
  while (current <= end) {
    dates.push(current);
    current = addDaysIso(current, 1);
  }
  return dates;
}

function daysBetween(start: string | null, end = todayIso()) {
  if (!start) return null;
  const startTime = new Date(`${start}T00:00:00Z`).getTime();
  const endTime = new Date(`${end}T00:00:00Z`).getTime();
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) return null;
  return Math.max(0, Math.round((endTime - startTime) / 86400000));
}

function normalizedHrKey(value: string | null | undefined) {
  return normalizeHrIdForAccess(value);
}

function normalizeLabelKey(value: string | null | undefined) {
  return text(value).toLowerCase();
}

function descendantHrIds(managerKey: string, employees: EmployeeDirectoryRow[]) {
  const childrenByManager = new Map<string, EmployeeDirectoryRow[]>();
  for (const employee of employees) {
    const managerKeyValue = normalizedHrKey(employee.managerHrId);
    if (!managerKeyValue) continue;
    childrenByManager.set(managerKeyValue, [...(childrenByManager.get(managerKeyValue) ?? []), employee]);
  }

  const allowed = new Set<string>([managerKey]);
  const queue = [...(childrenByManager.get(managerKey) ?? [])];
  while (queue.length > 0) {
    const employee = queue.shift();
    const key = normalizedHrKey(employee?.hrId);
    if (!employee || !key || allowed.has(key)) continue;
    allowed.add(key);
    queue.push(...(childrenByManager.get(key) ?? []));
  }
  return allowed;
}

function resolveDoubleVisitAccessScope(access: AccessContext, employees: EmployeeDirectoryRow[]) {
  if (
    access.scope === "system" ||
    access.role === "CEO" ||
    access.role === "Super Admin" ||
    access.role === "National Sales Manager" ||
    access.role === "SFE Manager" ||
    access.role === "Training Manager"
  ) {
    return { all: true as const };
  }

  const viewerKey = normalizedHrKey(resolveEmployeeIdentityId(access) ?? access.hrId ?? access.loginId);
  const viewer = viewerKey
    ? employees.find((employee) => normalizedHrKey(employee.hrId) === viewerKey) ?? null
    : null;
  const allowedHrIds = viewerKey ? descendantHrIds(viewerKey, employees) : new Set<string>();
  const allowedAreas = new Set<string>();
  const allowedLines = new Set<string>();

  if (access.role === "Regional Manager" && viewer?.regionName) {
    for (const employee of employees) {
      if (normalizeLabelKey(employee.regionName) !== normalizeLabelKey(viewer.regionName)) continue;
      const key = normalizedHrKey(employee.hrId);
      if (key) allowedHrIds.add(key);
      const area = normalizeLabelKey(employee.areaName);
      const line = normalizeLabelKey(employee.lineName);
      if (area) allowedAreas.add(area);
      if (line) allowedLines.add(line);
    }
  }

  if ((access.role === "Product Manager" || access.role === "Group Product Manager") && viewer?.lineName) {
    for (const employee of employees) {
      if (normalizeLabelKey(employee.lineName) !== normalizeLabelKey(viewer.lineName)) continue;
      const key = normalizedHrKey(employee.hrId);
      if (key) allowedHrIds.add(key);
      const line = normalizeLabelKey(employee.lineName);
      if (line) allowedLines.add(line);
    }
  }

  return {
    all: false as const,
    allowedAreas,
    allowedHrIds,
    allowedLines,
  };
}

function filterRowsForAccess(rows: DoubleVisitDbRow[], access: AccessContext, employees: EmployeeDirectoryRow[]) {
  const scope = resolveDoubleVisitAccessScope(access, employees);
  if (scope.all) return rows;
  return rows.filter((row) => {
    const doubleVisitorKey = normalizedHrKey(row.double_visitor_hr_id);
    const visitedKey = normalizedHrKey(row.visited_employee_hr_id);
    if (doubleVisitorKey && scope.allowedHrIds.has(doubleVisitorKey)) return true;
    if (visitedKey && scope.allowedHrIds.has(visitedKey)) return true;
    if (row.area_name && scope.allowedAreas.has(normalizeLabelKey(row.area_name))) return true;
    if (row.line_name && scope.allowedLines.has(normalizeLabelKey(row.line_name))) return true;
    return false;
  });
}

function filterEmployeesForDoubleVisitAccess(employees: EmployeeDirectoryRow[], access: AccessContext) {
  const scope = resolveDoubleVisitAccessScope(access, employees);
  if (scope.all) return employees;
  return employees.filter((employee) => {
    const key = normalizedHrKey(employee.hrId);
    if (key && scope.allowedHrIds.has(key)) return true;
    if (employee.areaName && scope.allowedAreas.has(normalizeLabelKey(employee.areaName))) return true;
    if (employee.lineName && scope.allowedLines.has(normalizeLabelKey(employee.lineName))) return true;
    return false;
  });
}

function currentMonthBounds(referenceDate = todayIso()) {
  const date = new Date(`${referenceDate}T00:00:00Z`);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const start = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
  const end = new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10);
  return { end, start };
}

function mapImportRow(row: DoubleVisitImportRow): DoubleVisitImportListItem {
  return {
    activeMappedVisitCount: asNumber(row.active_mapped_visit_count),
    amVisitCount: asNumber(row.am_visit_count),
    areaCount: asNumber(row.area_count),
    dateFrom: row.date_from,
    dateTo: row.date_to,
    doubleVisitorCount: asNumber(row.double_visitor_count),
    duplicateWarningCount: asNumber(row.duplicate_warning_count),
    id: row.id,
    lineCount: asNumber(row.line_count),
    missingVisitedHrIdCount: asNumber(row.missing_visited_hr_id_count),
    mrCoverageCount: asNumber(row.mr_coverage_count),
    pmVisitCount: asNumber(row.pm_visit_count),
    publishedAt: row.published_at,
    publishedBy: row.published_by,
    sheetName: row.sheet_name,
    sourceFilename: row.source_filename,
    sourceType: row.source_type,
    status: row.status,
    totalRows: asNumber(row.total_rows),
    totalVisits: asNumber(row.total_visits),
    uploadedAt: row.uploaded_at,
    uploadedBy: row.uploaded_by ?? "system",
    vacantOrUnmappedVisitCount: asNumber(row.vacant_or_unmapped_visit_count),
    warningCount: asNumber(row.warning_count),
  };
}

function rowInsert(importId: string, row: DoubleVisitNormalizedRow) {
  return {
    activity_date: row.activityDate,
    area_name: row.areaName,
    double_visitor_hr_id: row.doubleVisitorHrId,
    double_visitor_name: row.doubleVisitorName,
    import_id: importId,
    line_name: row.lineName,
    period: row.period,
    raw_payload: row.rawPayload,
    source_hash: row.sourceHash,
    source_record_id: row.sourceRecordId,
    source_row_number: row.sourceRowNumber,
    source_type: row.sourceType,
    visit_count: row.visitCount,
    visited_employee_hr_id: row.visitedEmployeeHrId,
    visited_employee_name: row.visitedEmployeeName,
    visited_employee_status: row.visitedEmployeeStatus,
  };
}

export async function saveDoubleVisitPreview(input: {
  actorLoginId: string;
  preview: DoubleVisitPreview;
}) {
  const supabase = getSupabaseAdmin();
  if (!(await isDoubleVisitSchemaReady())) {
    throwSchemaMissingError();
  }

  const importPayload = {
    active_mapped_visit_count: input.preview.summary.activeMappedVisitCount,
    am_visit_count: input.preview.summary.amVisitCount,
    area_count: input.preview.summary.areaCount,
    date_from: input.preview.summary.dateFrom,
    date_to: input.preview.summary.dateTo,
    double_visitor_count: input.preview.summary.doubleVisitorCount,
    duplicate_warning_count: input.preview.summary.duplicateWarningCount,
    line_count: input.preview.summary.lineCount,
    missing_visited_hr_id_count: input.preview.summary.missingVisitedHrIdCount,
    mr_coverage_count: input.preview.summary.mrCoverageCount,
    pm_visit_count: input.preview.summary.pmVisitCount,
    sheet_name: input.preview.metadata.sheetName,
    source_filename: input.preview.metadata.fileName,
    source_type: input.preview.metadata.sourceType,
    status: "preview",
    total_rows: input.preview.summary.totalRows,
    total_visits: input.preview.summary.totalVisits,
    uploaded_by: input.actorLoginId,
    vacant_or_unmapped_visit_count: input.preview.summary.vacantOrUnmappedVisitCount,
    validation_summary: {
      generatedAt: input.preview.metadata.generatedAt,
      warnings: input.preview.warnings,
    },
    warning_count: input.preview.summary.warningCount,
  };
  const { data, error } = await supabase
    .from(importsTable)
    .insert(importPayload)
    .select("*")
    .single();
  if (error) ensureNoSchemaError(error);

  const importId = String(data.id);
  const inserts = input.preview.rows.map((row) => rowInsert(importId, row));
  for (let index = 0; index < inserts.length; index += archiveBatchSize) {
    const chunk = inserts.slice(index, index + archiveBatchSize);
    const { error: rowsError } = await supabase.from(rowsTable).insert(chunk);
    if (rowsError) ensureNoSchemaError(rowsError);
  }

  await writeRequiredAuditLog({
    actorLoginId: input.actorLoginId,
    entityId: importId,
    entityType: "double_visit_import",
    newValues: {
      dateFrom: input.preview.summary.dateFrom,
      dateTo: input.preview.summary.dateTo,
      sourceFilename: input.preview.metadata.fileName,
      sourceType: input.preview.metadata.sourceType,
      totalRows: input.preview.summary.totalRows,
      totalVisits: input.preview.summary.totalVisits,
      vacantOrUnmappedVisitCount: input.preview.summary.vacantOrUnmappedVisitCount,
    },
    summary: "Double Visit Analytics import preview saved.",
  });

  return mapImportRow(data as DoubleVisitImportRow);
}

export async function buildAndSaveDoubleVisitExcelImport(input: {
  actorLoginId: string;
  arrayBuffer: ArrayBuffer;
  fileName: string;
}) {
  const preview = await buildDoubleVisitPreviewFromWorkbook({
    arrayBuffer: input.arrayBuffer,
    fileName: input.fileName,
  });
  const saved = await saveDoubleVisitPreview({ actorLoginId: input.actorLoginId, preview });
  return { import: saved, preview: { ...preview, importId: saved.id } };
}

export async function buildAndSaveDoubleVisitIReports360Import(input: {
  actorLoginId: string;
  dateFrom: string;
  dateTo: string;
}) {
  const config = getIReports360Config();
  const token = await iReports360Login(config);
  const [visits, employees] = await Promise.all([
    iReports360GetVisits(config, token, input.dateFrom, input.dateTo),
    getEmployeeDirectoryRows({ includeInactive: true }),
  ]);
  const preview = normalizeIReports360DoubleVisits({
    employees,
    fileName: `iReports360 Double Visits ${input.dateFrom} to ${input.dateTo}`,
    visits,
  });
  const saved = await saveDoubleVisitPreview({ actorLoginId: input.actorLoginId, preview });
  return { import: saved, preview: { ...preview, importId: saved.id } };
}

export async function listDoubleVisitImports(limit = 20) {
  const { data, error } = await getSupabaseAdmin()
    .from(importsTable)
    .select("*")
    .order("uploaded_at", { ascending: false })
    .limit(limit);
  if (error) {
    if (schemaMissing(error)) return [];
    throw new Error(error.message);
  }
  return ((data ?? []) as DoubleVisitImportRow[]).map(mapImportRow);
}

export async function publishDoubleVisitImport(input: {
  access: AccessContext;
  importId: string;
}) {
  const actor = actorFromAccess(input.access);
  const supabase = getSupabaseAdmin();
  if (!(await isDoubleVisitSchemaReady())) {
    throwSchemaMissingError();
  }

  const { data: target, error: loadError } = await supabase
    .from(importsTable)
    .select("*")
    .eq("id", input.importId)
    .maybeSingle();
  if (loadError) ensureNoSchemaError(loadError);
  if (!target) throw new Error("Double Visit import was not found.");
  const targetRow = target as DoubleVisitImportRow;

  const { error: supersedeError } = await supabase
    .from(importsTable)
    .update({ status: "superseded", updated_at: new Date().toISOString() })
    .eq("status", "published")
    .neq("id", input.importId);
  if (supersedeError) ensureNoSchemaError(supersedeError);

  const { data, error } = await supabase
    .from(importsTable)
    .update({
      published_at: new Date().toISOString(),
      published_by: actor,
      status: "published",
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.importId)
    .select("*")
    .single();
  if (error) ensureNoSchemaError(error);

  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityId: input.importId,
    entityType: "double_visit_import",
    newValues: {
      dateFrom: targetRow.date_from,
      dateTo: targetRow.date_to,
      sourceFilename: targetRow.source_filename,
      status: "published",
    },
    oldValues: { status: targetRow.status },
    summary: "Double Visit Analytics import published as the official snapshot.",
  });

  return mapImportRow(data as DoubleVisitImportRow);
}

async function getPublishedImportForRange(dateFrom: string, dateTo: string) {
  const { data, error } = await getSupabaseAdmin()
    .from(importsTable)
    .select("*")
    .eq("status", "published")
    .lte("date_from", dateTo)
    .gte("date_to", dateFrom)
    .order("published_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    if (schemaMissing(error)) return null;
    throw new Error(error.message);
  }
  return data ? mapImportRow(data as DoubleVisitImportRow) : null;
}

async function getPublishedRows(dateFrom: string, dateTo: string) {
  const importRow = await getPublishedImportForRange(dateFrom, dateTo);
  if (!importRow) return { importRow: null, rows: [] as DoubleVisitDbRow[] };
  const { data, error } = await getSupabaseAdmin()
    .from(rowsTable)
    .select("*")
    .eq("import_id", importRow.id)
    .gte("activity_date", dateFrom)
    .lte("activity_date", dateTo)
    .order("activity_date", { ascending: true })
    .limit(20000);
  if (error) {
    if (schemaMissing(error)) return { importRow: null, rows: [] as DoubleVisitDbRow[] };
    throw new Error(error.message);
  }
  return { importRow, rows: (data ?? []) as DoubleVisitDbRow[] };
}

function isActiveEmployee(employee: EmployeeDirectoryRow) {
  const status = text(employee.employmentStatus).toLowerCase();
  return status === "active" || status === "on_leave";
}

const allowedDoubleVisitorRoles = [
  "Medical Rep",
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
  "SFE Manager",
  "Training Manager",
] as const;

function isMedicalRep(employee: EmployeeDirectoryRow) {
  return /medical\s*rep|medical\s*representative/i.test(`${employee.positionTitle ?? ""} ${employee.jobTitle ?? ""}`);
}

function isAllowedDoubleVisitor(employee: EmployeeDirectoryRow | null) {
  if (!employee) return true;
  const posRole = resolveJobFunctionRole(employee.positionTitle);
  const jobRole = resolveJobFunctionRole(employee.jobTitle);
  if (posRole === "CEO" || jobRole === "CEO") return false;
  return (
    allowedDoubleVisitorRoles.includes(posRole as (typeof allowedDoubleVisitorRoles)[number]) ||
    allowedDoubleVisitorRoles.includes(jobRole as (typeof allowedDoubleVisitorRoles)[number])
  );
}

function isDisallowedExecutiveManager(employee: EmployeeDirectoryRow | null) {
  if (!employee) return false;
  return (
    resolveJobFunctionRole(employee.positionTitle) === "CEO" ||
    resolveJobFunctionRole(employee.jobTitle) === "CEO"
  );
}

function filterRowsByAllowedDoubleVisitor(rows: DoubleVisitDbRow[], employeeByHrId: Map<string, EmployeeDirectoryRow>) {
  return rows.filter((row) => {
    const doubleVisitorKey = normalizedHrKey(row.double_visitor_hr_id);
    if (!doubleVisitorKey) return true;
    return isAllowedDoubleVisitor(employeeByHrId.get(doubleVisitorKey) ?? null);
  });
}

function buildMrScores(rows: DoubleVisitDbRow[], employees: EmployeeDirectoryRow[], asOfDate: string): DoubleVisitMrScore[] {
  const activeMrs = employees.filter((employee) => isActiveEmployee(employee) && isMedicalRep(employee));
  const rowsByMr = new Map<string, DoubleVisitDbRow[]>();
  for (const row of rows) {
    const key = canonicalHrIdKey(row.visited_employee_hr_id);
    if (!key) continue;
    rowsByMr.set(key, [...(rowsByMr.get(key) ?? []), row]);
  }
  const last90Start = addDaysIso(asOfDate, -90);
  return activeMrs.map((employee) => {
    const key = canonicalHrIdKey(employee.hrId) ?? "";
    const mrRows = rowsByMr.get(key) ?? [];
    const sorted = [...mrRows].sort((left, right) => left.activity_date.localeCompare(right.activity_date));
    const last = sorted.at(-1) ?? null;
    const lastDvDate = last?.activity_date ?? null;
    const days = daysBetween(lastDvDate, asOfDate);
    const dvsLast90Days = mrRows
      .filter((row) => row.activity_date >= last90Start && row.activity_date <= asOfDate)
      .reduce((sum, row) => sum + asNumber(row.visit_count), 0);
    const distinctVisitors = new Set(mrRows.map((row) => canonicalHrIdKey(row.double_visitor_hr_id)).filter(Boolean));
    const band = days == null || days > 60 || dvsLast90Days === 0
      ? "critical"
      : days > 30
        ? "warning"
        : "healthy";
    return {
      areaName: employee.areaName,
      band,
      daysSinceLastDv: days,
      distinctDoubleVisitors: distinctVisitors.size,
      dvsLast90Days,
      employeeStatus: employee.employmentStatus,
      hrId: employee.hrId,
      lastDoubleVisitorName: last?.double_visitor_name ?? null,
      lastDvDate,
      lineName: employee.lineName,
      managerHrId: employee.managerHrId,
      managerName: employee.managerName,
      mrName: employee.fullName,
      totalDvs: mrRows.reduce((sum, row) => sum + asNumber(row.visit_count), 0),
    } satisfies DoubleVisitMrScore;
  }).sort((left, right) => {
    const bandRank = { critical: 0, warning: 1, healthy: 2 };
    return bandRank[left.band] - bandRank[right.band] || left.mrName.localeCompare(right.mrName);
  });
}

function buildExecutiveReports(scores: DoubleVisitMrScore[], employees: EmployeeDirectoryRow[]): DoubleVisitExecutiveManagerReport[] {
  const employeesByHrId = new Map(employees.map((employee) => [canonicalHrIdKey(employee.hrId), employee]));
  const reportsByManager = new Map<string, { manager: EmployeeDirectoryRow; mrs: DoubleVisitMrScore[] }>();

  for (const score of scores) {
    let managerKey = canonicalHrIdKey(score.managerHrId);
    const seen = new Set<string>();
    while (managerKey && !seen.has(managerKey)) {
      seen.add(managerKey);
      const manager = employeesByHrId.get(managerKey);
      if (!manager) break;
      if (isDisallowedExecutiveManager(manager)) break;
      const current = reportsByManager.get(managerKey) ?? { manager, mrs: [] };
      current.mrs.push(score);
      reportsByManager.set(managerKey, current);
      managerKey = canonicalHrIdKey(manager.managerHrId);
    }
  }

  return Array.from(reportsByManager.entries()).map(([managerHrId, group]) => {
    const totalDvs = group.mrs.reduce((sum, mr) => sum + mr.totalDvs, 0);
    const topFour = [...group.mrs].sort((left, right) => right.totalDvs - left.totalDvs).slice(0, 4);
    const topFourDvs = topFour.reduce((sum, mr) => sum + mr.totalDvs, 0);
    const touched = group.mrs.filter((mr) => mr.totalDvs > 0);
    const averageDvs = group.mrs.length ? totalDvs / group.mrs.length : 0;
    const latestDvDate = group.mrs.map((mr) => mr.lastDvDate).filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
    return {
      areaName: group.manager.areaName,
      concentrationRatio: totalDvs > 0 ? round(topFourDvs / totalDvs, 4) : 0,
      criticalMrCount: group.mrs.filter((mr) => mr.band === "critical").length,
      expectedMrCount: group.mrs.length,
      latestDvDate,
      lineName: group.manager.lineName,
      managerHrId: group.manager.hrId || managerHrId,
      managerName: group.manager.fullName || group.manager.hrId || managerHrId,
      neglectedMrCount: group.mrs.filter((mr) => mr.band !== "healthy").length,
      overFocusedMrCount: group.mrs.filter((mr) => averageDvs > 0 && mr.totalDvs >= Math.max(5, averageDvs * 2)).length,
      touchedMrCount: touched.length,
      touchedPercent: group.mrs.length ? round((touched.length / group.mrs.length) * 100, 1) : 0,
      totalDvs,
    } satisfies DoubleVisitExecutiveManagerReport;
  }).filter((report) => report.expectedMrCount > 0)
    .sort((left, right) => right.neglectedMrCount - left.neglectedMrCount || left.managerName.localeCompare(right.managerName));
}

function buildHeatmapRows(
  scores: DoubleVisitMrScore[],
  field: "areaName" | "lineName",
  allBuckets: string[] = [],
): DoubleVisitBreakdownRow[] {
  const groups = new Map<string, DoubleVisitMrScore[]>();
  for (const score of scores) {
    const key = nullableText(score[field]) ?? "Unmapped";
    groups.set(key, [...(groups.get(key) ?? []), score]);
  }
  for (const bucket of allBuckets) {
    const normalized = text(bucket);
    if (!normalized) continue;
    if (!groups.has(normalized)) groups.set(normalized, []);
  }
  return Array.from(groups.entries()).map(([label, group]) => {
    const mrCount = group.length;
    const healthy = group.filter((score) => score.band === "healthy").length;
    const totalVisits = group.reduce((sum, score) => sum + score.totalDvs, 0);
    const coveragePercent = mrCount ? round((healthy / mrCount) * 100, 1) : 0;
    return {
      coveragePercent,
      label,
      mrCount,
      status: coveragePercent >= 70 ? "healthy" : coveragePercent >= 40 ? "warning" : "critical",
      totalVisits,
    } satisfies DoubleVisitBreakdownRow;
  }).sort((left, right) => (right.coveragePercent ?? 0) - (left.coveragePercent ?? 0) || right.totalVisits - left.totalVisits);
}

function buildKpis(rows: DoubleVisitDbRow[]): DoubleVisitKpis {
  const totalVisits = rows.reduce((sum, row) => sum + asNumber(row.visit_count), 0);
  const activeDoubleVisitDays = new Set(rows.map((row) => `${canonicalHrIdKey(row.double_visitor_hr_id)}|${row.activity_date}`)).size;
  const doubleVisitorCount = new Set(rows.map((row) => canonicalHrIdKey(row.double_visitor_hr_id)).filter(Boolean)).size;
  const amVisitCount = rows.filter((row) => row.period === "AM").reduce((sum, row) => sum + asNumber(row.visit_count), 0);
  const pmVisitCount = rows.filter((row) => row.period === "PM").reduce((sum, row) => sum + asNumber(row.visit_count), 0);
  const activeMappedVisitCount = rows.filter((row) => row.visited_employee_status === "active_mapped").reduce((sum, row) => sum + asNumber(row.visit_count), 0);
  const vacantOrUnmappedVisitCount = totalVisits - activeMappedVisitCount;
  return {
    activeCalendarDays: new Set(rows.map((row) => row.activity_date)).size,
    activeDoubleVisitDays,
    activeMappedVisitCount,
    amPmRatio: pmVisitCount > 0 ? round(amVisitCount / pmVisitCount, 4) : null,
    amVisitCount,
    averageVisitsPerDoubleVisitDay: activeDoubleVisitDays > 0 ? round(totalVisits / activeDoubleVisitDays, 2) : 0,
    averageVisitsPerDoubleVisitor: doubleVisitorCount > 0 ? round(totalVisits / doubleVisitorCount, 2) : 0,
    doubleVisitorCount,
    mrCoverageCount: new Set(rows.map((row) => canonicalHrIdKey(row.visited_employee_hr_id)).filter(Boolean)).size,
    pmVisitCount,
    totalVisits,
    vacantOrUnmappedShare: totalVisits > 0 ? round((vacantOrUnmappedVisitCount / totalVisits) * 100, 1) : 0,
    vacantOrUnmappedVisitCount,
  };
}

export async function getDoubleVisitDashboardData(input: {
  access: AccessContext;
  dateFrom?: string | null;
  dateTo?: string | null;
}): Promise<DoubleVisitDashboardData> {
  const month = currentMonthBounds();
  const dateFrom = input.dateFrom || month.start;
  const dateTo = input.dateTo || month.end;
  const schemaReady = await isDoubleVisitSchemaReady();
  if (!schemaReady) {
    return emptyDashboard(dateFrom, dateTo);
  }

  const imports = await listDoubleVisitImports();
  const { importRow, rows } = await getPublishedRows(dateFrom, dateTo);
  const employees = await getEmployeeDirectoryRows({ includeInactive: true });
  const scopedEmployees = filterEmployeesForDoubleVisitAccess(employees, input.access);
  const scopedRows = filterRowsForAccess(rows, input.access, employees);
  const scopedEmployeesByHrId = new Map(
    scopedEmployees
      .map((employee) => [normalizedHrKey(employee.hrId), employee])
      .filter((entry): entry is [string, EmployeeDirectoryRow] => Boolean(entry[0])),
  );
  const filteredRows = filterRowsByAllowedDoubleVisitor(scopedRows, scopedEmployeesByHrId);
  const mrScores = buildMrScores(filteredRows, scopedEmployees, dateTo);
  const executiveReports = buildExecutiveReports(mrScores, scopedEmployees);
  const activeScopeEmployees = scopedEmployees.filter(isActiveEmployee);
  const areaBuckets = Array.from(new Set(activeScopeEmployees.map((employee) => nullableText(employee.areaName)).filter((value): value is string => Boolean(value)))).sort();
  const lineBuckets = Array.from(new Set(activeScopeEmployees.map((employee) => nullableText(employee.lineName)).filter((value): value is string => Boolean(value)))).sort();
  const areas = Array.from(new Set(filteredRows.map((row) => nullableText(row.area_name)).filter((value): value is string => Boolean(value)))).sort();
  const lines = Array.from(new Set(filteredRows.map((row) => nullableText(row.line_name)).filter((value): value is string => Boolean(value)))).sort();
  const doubleVisitors = Array.from(new Set(filteredRows.map((row) => nullableText(row.double_visitor_name) ?? nullableText(row.double_visitor_hr_id)).filter((value): value is string => Boolean(value)))).sort();

  return {
    asOfDate: todayIso(),
    dateFrom,
    dateTo,
    executiveReports,
    filters: { areas, doubleVisitors, lines },
    heatmap: {
      byArea: buildHeatmapRows(mrScores, "areaName", areaBuckets),
      byLine: buildHeatmapRows(mrScores, "lineName", lineBuckets),
    },
    imports,
    kpis: buildKpis(filteredRows),
    mrScores,
    publishedImport: importRow,
    salesComparisonAvailable: false,
    schemaReady: true,
  };
}

function joinedDistinct(values: Array<string | null | undefined>, fallback: string) {
  const distinct = Array.from(new Set(values.map(nullableText).filter((value): value is string => Boolean(value))));
  return distinct.length > 0 ? distinct.join(", ") : fallback;
}

function workloadTime(rows: DoubleVisitDbRow[]) {
  const am = rows.filter((row) => row.period === "AM").reduce((sum, row) => sum + asNumber(row.visit_count), 0);
  const pm = rows.filter((row) => row.period === "PM").reduce((sum, row) => sum + asNumber(row.visit_count), 0);
  return [am > 0 ? `AM ${am}` : null, pm > 0 ? `PM ${pm}` : null].filter(Boolean).join(" / ") || "Double Visit";
}

function calendarItemId(prefix: string, employeeHrId: string, date: string) {
  return `${prefix}-${normalizedHrKey(employeeHrId) ?? employeeHrId}-${date}`;
}

function privateCalendarItem(input: {
  date: string;
  description: string;
  detailLines: string[];
  employeeHrId: string;
  employeeName: string | null;
  id: string;
  status: string;
  time: string;
  title: string;
}): PrivateCalendarItem {
  return {
    approvalImpact: "Double Visit evidence is read-only field activity context. It does not mutate attendance, leave, deductions, payroll, or compliance decisions.",
    description: input.description,
    detailLines: input.detailLines,
    employeeDepartmentName: null,
    employeeHrId: input.employeeHrId,
    employeeJobTitle: null,
    employeeLineName: null,
    employeeName: input.employeeName,
    endDate: input.date,
    exceptionFlags: [],
    id: input.id,
    managerName: null,
    severity: "success",
    source: "double_visit",
    sourceLabel: "Published Double Visit snapshot",
    sourceRecordId: input.id,
    sourceSystem: "Double Visit Analytics",
    sourceTable: rowsTable,
    startDate: input.date,
    status: input.status,
    time: input.time,
    title: input.title,
  };
}

function groupCalendarRows(rows: DoubleVisitDbRow[], keyFn: (row: DoubleVisitDbRow) => string | null) {
  const groups = new Map<string, DoubleVisitDbRow[]>();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return groups;
}

export async function loadDoubleVisitPrivateCalendarItems(employeeHrIds: string[], start: string, end: string) {
  try {
    const selected = new Set(employeeHrIds.map(normalizedHrKey).filter((value): value is string => Boolean(value)));
    if (selected.size === 0) return { items: [] as PrivateCalendarItem[], ready: true };
    const { rows } = await getPublishedRows(start, end);
    const items: PrivateCalendarItem[] = [];

    const performed = groupCalendarRows(
      rows.filter((row) => selected.has(normalizedHrKey(row.double_visitor_hr_id) ?? "")),
      (row) => {
        const key = normalizedHrKey(row.double_visitor_hr_id);
        return key ? `${key}|${row.activity_date}` : null;
      },
    );

    for (const group of performed.values()) {
      const first = group[0];
      if (!first?.double_visitor_hr_id) continue;
      const total = group.reduce((sum, row) => sum + asNumber(row.visit_count), 0);
      items.push(privateCalendarItem({
        date: first.activity_date,
        description: `${total} Double Visit activity count from the official published snapshot.`,
        detailLines: [
          `AM/PM: ${workloadTime(group)}`,
          `Area: ${joinedDistinct(group.map((row) => row.area_name), "Unmapped")}`,
          `Line: ${joinedDistinct(group.map((row) => row.line_name), "Unmapped")}`,
          `Visited: ${joinedDistinct(group.map((row) => row.visited_employee_name), "Unmapped or vacant")}`,
        ],
        employeeHrId: first.double_visitor_hr_id,
        employeeName: first.double_visitor_name,
        id: calendarItemId("double-visit-performed", first.double_visitor_hr_id, first.activity_date),
        status: "performed",
        time: workloadTime(group),
        title: "Performed Double Visits",
      }));
    }

    const received = groupCalendarRows(
      rows.filter((row) => selected.has(normalizedHrKey(row.visited_employee_hr_id) ?? "")),
      (row) => {
        const key = normalizedHrKey(row.visited_employee_hr_id);
        return key ? `${key}|${row.activity_date}` : null;
      },
    );

    for (const group of received.values()) {
      const first = group[0];
      if (!first?.visited_employee_hr_id) continue;
      const total = group.reduce((sum, row) => sum + asNumber(row.visit_count), 0);
      items.push(privateCalendarItem({
        date: first.activity_date,
        description: `${total} Double Visit received from the official published snapshot.`,
        detailLines: [
          `AM/PM: ${workloadTime(group)}`,
          `Double visitor: ${joinedDistinct(group.map((row) => row.double_visitor_name), "Unmapped")}`,
          `Area: ${joinedDistinct(group.map((row) => row.area_name), "Unmapped")}`,
          `Line: ${joinedDistinct(group.map((row) => row.line_name), "Unmapped")}`,
        ],
        employeeHrId: first.visited_employee_hr_id,
        employeeName: first.visited_employee_name,
        id: calendarItemId("double-visit-received", first.visited_employee_hr_id, first.activity_date),
        status: "received",
        time: workloadTime(group),
        title: "Received Double Visit",
      }));
    }

    return { items, ready: true };
  } catch (error) {
    if (schemaMissing(error)) return { items: [] as PrivateCalendarItem[], ready: false };
    throw error;
  }
}

export async function getDoubleVisitExpenseWorkloadEvidence(input: {
  employeeHrId: string | null | undefined;
  tripEndDate: string;
  tripStartDate: string;
}): Promise<DoubleVisitExpenseWorkloadEvidence> {
  const employeeKey = normalizeHrIdForAccess(input.employeeHrId);
  const start = input.tripStartDate.slice(0, 10);
  const end = input.tripEndDate.slice(0, 10);
  const dates = eachDate(start, end);
  if (!employeeKey) {
    return {
      amWorkload: 0,
      dateBreakdown: dates.map((date) => ({ am: 0, date, evidenceRows: 0, pm: 0, total: 0 })),
      importId: null,
      matchedDates: [],
      matchStatus: "no_activity",
      missingDates: dates,
      pmWorkload: 0,
      source: "manual",
      sourceLabel: "No employee HR ID available for Double Visit evidence matching.",
    };
  }

  const { importRow, rows } = await getPublishedRows(start, end);
  if (!importRow) {
    return {
      amWorkload: 0,
      dateBreakdown: dates.map((date) => ({ am: 0, date, evidenceRows: 0, pm: 0, total: 0 })),
      importId: null,
      matchedDates: [],
      matchStatus: "stale_import",
      missingDates: dates,
      pmWorkload: 0,
      source: "manual",
      sourceLabel: "No published Double Visit snapshot covers this expense date range.",
    };
  }

  const ownRows = rows.filter((row) => normalizeHrIdForAccess(row.double_visitor_hr_id) === employeeKey);
  const dateBreakdown = dates.map((date) => {
    const dayRows = ownRows.filter((row) => row.activity_date === date);
    const am = dayRows.filter((row) => row.period === "AM").reduce((sum, row) => sum + asNumber(row.visit_count), 0);
    const pm = dayRows.filter((row) => row.period === "PM").reduce((sum, row) => sum + asNumber(row.visit_count), 0);
    return {
      am,
      date,
      evidenceRows: dayRows.length,
      pm,
      total: am + pm + dayRows.filter((row) => row.period === "UNKNOWN").reduce((sum, row) => sum + asNumber(row.visit_count), 0),
    };
  });
  const matchedDates = dateBreakdown.filter((row) => row.total > 0).map((row) => row.date);
  const missingDates = dates.filter((date) => !matchedDates.includes(date));
  const matchStatus = matchedDates.length === 0
    ? "no_activity"
    : missingDates.length > 0
      ? "partial"
      : "matched";
  return {
    amWorkload: dateBreakdown.reduce((sum, row) => sum + row.am, 0),
    dateBreakdown,
    importId: importRow.id,
    matchedDates,
    matchStatus,
    missingDates,
    pmWorkload: dateBreakdown.reduce((sum, row) => sum + row.pm, 0),
    source: "double_visit_import",
    sourceLabel: `Published Double Visit snapshot: ${importRow.sourceFilename}`,
  };
}

export async function buildDoubleVisitExportWorkbook(data: DoubleVisitDashboardData) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  workbook.created = new Date();

  const summary = workbook.addWorksheet("Executive Summary");
  summary.columns = [
    { header: "Metric", key: "metric", width: 34 },
    { header: "Value", key: "value", width: 24 },
  ];
  summary.addRows([
    { metric: "Date From", value: data.dateFrom },
    { metric: "Date To", value: data.dateTo },
    { metric: "Published Import", value: data.publishedImport?.sourceFilename ?? "No published import" },
    { metric: "Double Visits", value: data.kpis.totalVisits },
    { metric: "Active Double Visit Days", value: data.kpis.activeDoubleVisitDays },
    { metric: "AM Activity", value: data.kpis.amVisitCount },
    { metric: "PM Activity", value: data.kpis.pmVisitCount },
    { metric: "Average Visits per DV Day", value: data.kpis.averageVisitsPerDoubleVisitDay },
    { metric: "Vacant/Unmapped Share", value: `${data.kpis.vacantOrUnmappedShare}%` },
    { metric: "Neglected MRs", value: data.mrScores.filter((score) => score.band !== "healthy").length },
  ]);

  const mrSheet = workbook.addWorksheet("MR Support Score");
  mrSheet.columns = [
    { header: "MR", key: "mrName", width: 28 },
    { header: "HR ID", key: "hrId", width: 14 },
    { header: "Area", key: "areaName", width: 20 },
    { header: "Line", key: "lineName", width: 12 },
    { header: "Manager", key: "managerName", width: 28 },
    { header: "Last DV", key: "lastDvDate", width: 14 },
    { header: "Days Since Last DV", key: "daysSinceLastDv", width: 18 },
    { header: "DVs Last 90 Days", key: "dvsLast90Days", width: 18 },
    { header: "Distinct Visitors", key: "distinctDoubleVisitors", width: 18 },
    { header: "Band", key: "band", width: 12 },
  ];
  mrSheet.addRows(data.mrScores);

  const managers = workbook.addWorksheet("Executive Coverage");
  managers.columns = [
    { header: "Manager", key: "managerName", width: 28 },
    { header: "HR ID", key: "managerHrId", width: 14 },
    { header: "Area", key: "areaName", width: 20 },
    { header: "Line", key: "lineName", width: 12 },
    { header: "Expected MRs", key: "expectedMrCount", width: 14 },
    { header: "Touched MRs", key: "touchedMrCount", width: 14 },
    { header: "Neglected MRs", key: "neglectedMrCount", width: 15 },
    { header: "Over-Focused MRs", key: "overFocusedMrCount", width: 18 },
    { header: "Concentration Ratio", key: "concentrationRatio", width: 20 },
    { header: "Total DVs", key: "totalDvs", width: 12 },
  ];
  managers.addRows(data.executiveReports);

  for (const sheet of workbook.worksheets) {
    sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    sheet.getRow(1).fill = { fgColor: { argb: "FF0F172A" }, pattern: "solid", type: "pattern" };
    sheet.views = [{ state: "frozen", ySplit: 1 }];
  }

  return workbook;
}
