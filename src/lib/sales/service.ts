import { unstable_cache } from "next/cache.js";

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { SalesWorkflowError, isPostgresUniqueViolation } from "@/lib/sales/contracts";
import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { invalidateExecutiveDashboardCache } from "@/lib/dashboard/invalidation";
import { getSalesPeopleLabels, linkSalesRecords, summarizeSalesLinkage } from "@/lib/sales/employees";
import { isDisposableSalesBatchRow, isDisposableSalesRecordRow } from "@/lib/fixture-hygiene";
import { formatUnits } from "@/lib/sales/format";
import { isSalesOthersBucket } from "@/lib/sales/others";
import { roundCurrency } from "@/lib/payroll/money";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { getSalesScope, normalizeHrId, normalizeHrIdForAccess, normalizeLineName, resolveEmployeeIdentityId, type AccessContext, type BusinessScope } from "@/lib/auth/permissions";
import { getUserSalesScopeOverrideRaw } from "@/lib/auth/scope-visibility";
import { salesRoleOverrideForHrId } from "@/lib/sales/role-mapping";
import {
  canViewRestrictedProducts,
  restrictedProductNameSet,
  stripRestrictedRowsByName,
} from "@/lib/sales/access-scope";
import { loadCanonicalDashboardRecords } from "@/lib/sales/dashboard-canonical";
import { loadAchievementCacheStamp } from "@/lib/sales/vs-target";
import { salesAchievementRate } from "@/lib/sales/metrics";
import {
  buildSalesOwnershipContext,
  classifySalesOwnership,
  isSalesVacancyAreaCode,
  salesOwnershipLabel,
  type SalesOwnershipContext,
  type SalesOwnershipResult,
} from "@/lib/workforce-classification";
import { isWithinManagerHierarchy, reportsToManagerSeat, sameWorkforceLine } from "@/lib/workforce/hierarchy-resolver";
import {
  type SalesBatch,
  type SalesBatchDetail,
  type SalesBatchIssue,
  type SalesBatchReconciliation,
  type SalesDashboardData,
  type SalesDashboardFilters,
  type SalesHistoryRow,
  type SalesImportPayload,
  type SalesLinkStatus,
  type SalesRecordInput,
  type SalesValidationState,
} from "@/lib/sales/types";

type ScopedRecord = SalesRecordInput & { batchId: string; period: string };
type ClassifiedScopedRecord = ScopedRecord & {
  ownership: SalesOwnershipResult;
  ownershipClassification: SalesOwnershipResult["classification"];
  derivedTeamKey: string | null;
};
type DbRow = Record<string, unknown>;
type SalesAccessFilter = {
  all: boolean;
  allowedHrIds: Set<string>;
  allowedLine?: string;
  includeManagerOwnedHrId?: string;
};
const SALES_DASHBOARD_TRANSACTION_LIMIT = 500;

function toSafeArray<T = unknown>(value: readonly T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function toFilterStringList(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => (typeof item === "string" ? item.split(",") : [])).map((item) => item.trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function normalizeFilterToken(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

// Seat-continuity-aware TEAM / HIERARCHY resolution, delegating to the canonical
// workforce resolver (src/lib/workforce/hierarchy-resolver.ts) instead of a private
// naive `manager_hr_id` adjacency walk. The naive walk was correct only because a DB
// trigger writes `manager_hr_id` + `pending_manager_replacement_for_hr_id` atomically;
// when a manager seat is vacant/reassigned it would attach reports to the wrong seat.
// The resolver additionally recognizes the departed manager's vacant seat, so a report
// orphaned upward after a resignation still resolves to the correct owner. Behaviour is
// unchanged for today's data (no pending marker) — it only becomes correct on vacancy.

/** Canonical hrId -> employee row, for isWithinManagerHierarchy's byCanonicalHrId input. */
function buildCanonicalHrIdIndex(
  directory: Awaited<ReturnType<typeof getEmployeeDirectory>>,
): Map<string, EmployeeDirectoryRow> {
  const byCanonicalHrId = new Map<string, EmployeeDirectoryRow>();
  directory.employees.forEach((employee) => {
    const key = normalizeHrIdForAccess(employee.hrId);
    if (key) byCanonicalHrId.set(key, employee);
  });
  return byCanonicalHrId;
}

/** Direct reports of the viewer's seat — TEAM scope. Seat-continuity aware. */
export function collectDirectReports(
  directory: Awaited<ReturnType<typeof getEmployeeDirectory>>,
  viewerCanonicalHrId: string,
): Set<string> {
  const allowed = new Set<string>();
  if (!viewerCanonicalHrId) return allowed;
  directory.employees.forEach((employee) => {
    if (reportsToManagerSeat({ employee, viewerCanonicalHrId, canonicalize: normalizeHrIdForAccess })) {
      const id = normalizeHrId(employee.hrId);
      if (id) allowed.add(id);
    }
  });
  return allowed;
}

/** Every employee in the viewer's full downward chain — HIERARCHY scope. Cycle-safe. */
export function collectHierarchy(
  directory: Awaited<ReturnType<typeof getEmployeeDirectory>>,
  viewerCanonicalHrId: string,
): Set<string> {
  const allowed = new Set<string>();
  if (!viewerCanonicalHrId) return allowed;
  const byCanonicalHrId = buildCanonicalHrIdIndex(directory);
  directory.employees.forEach((employee) => {
    if (isWithinManagerHierarchy({ employee, byCanonicalHrId, viewerCanonicalHrId, canonicalize: normalizeHrIdForAccess })) {
      const id = normalizeHrId(employee.hrId);
      if (id) allowed.add(id);
    }
  });
  return allowed;
}

async function getPersistedSalesScopeOverride(accessContext: AccessContext): Promise<BusinessScope | null> {
  if (!accessContext.loginId) return null;

  // The same per-request login-row read access-scope.ts uses, so the two never disagree.
  const raw = String((await getUserSalesScopeOverrideRaw(accessContext.loginId)) ?? "")
    .trim()
    .toUpperCase();

  return ["SELF", "TEAM", "HIERARCHY", "LINE", "COMPANY", "NONE"].includes(raw)
    ? (raw as BusinessScope)
    : null;
}

async function resolveSalesAccessFilter(accessContext?: AccessContext | null): Promise<SalesAccessFilter> {
  if (!accessContext) {
    return { all: true, allowedHrIds: new Set() };
  }

  const currentHrId = resolveEmployeeIdentityId(accessContext);
  const salesScope = accessContext.scope === "system"
    ? "COMPANY"
    : getSalesScope({
        role: accessContext.role,
        salesScopeOverride: await getPersistedSalesScopeOverride(accessContext),
      });

  if (salesScope === "COMPANY") {
    return { all: true, allowedHrIds: new Set() };
  }

  if (salesScope === "NONE" || !currentHrId) {
    return { all: false, allowedHrIds: new Set() };
  }

  const directory = await getEmployeeDirectory();
  const directoryByHrId = new Map(
    directory.employees.map((employee) => [normalizeHrId(employee.hrId), employee]),
  );
  const viewer = currentHrId ? directoryByHrId.get(currentHrId) : undefined;
  if (salesScope === "SELF") {
    return { all: false, allowedHrIds: new Set([currentHrId]) };
  }

  const canonicalViewerId = normalizeHrIdForAccess(currentHrId) ?? "";
  if (salesScope === "TEAM") {
    return {
      all: false,
      allowedHrIds: collectDirectReports(directory, canonicalViewerId),
      includeManagerOwnedHrId: currentHrId,
    };
  }

  if (salesScope === "HIERARCHY") {
    return {
      all: false,
      allowedHrIds: collectHierarchy(directory, canonicalViewerId),
      includeManagerOwnedHrId: currentHrId,
    };
  }

  // LINE scope (NSM / Product Manager / Group Product Manager). Resolve the line by line_id
  // first (line-name fallback) via sameWorkforceLine: in production manager records frequently
  // have line_name null while line_id is set, so matching on line-name alone returned an empty
  // set and the viewer saw NOTHING. A viewer with neither line_id nor line_name fails closed.
  if (salesScope === "LINE" && viewer && (viewer.lineId != null || viewer.lineName)) {
    const allowedHrIds = new Set<string>();
    directory.employees.forEach((employee) => {
      if (sameWorkforceLine(viewer, employee)) {
        const employeeId = normalizeHrId(employee.hrId);
        if (employeeId) allowedHrIds.add(employeeId);
      }
    });
    // allowedLine still carries the viewer's line NAME (when known) so record-level matching on
    // the sales sheet's `line` text column keeps working alongside the line_id-resolved HR set.
    const allowedLine = viewer.lineName ? normalizeLineName(viewer.lineName) : undefined;
    return { all: false, allowedHrIds, allowedLine };
  }

  return { all: false, allowedHrIds: new Set() };
}

async function filterSalesRecordsForAccess(
  records: ScopedRecord[],
  accessContext?: AccessContext | null,
) {
  const accessFilter = await resolveSalesAccessFilter(accessContext);
  if (accessFilter.all) return records;
  
  const hasLineFilter = Boolean(accessFilter.allowedLine);
  if (accessFilter.allowedHrIds.size === 0 && !hasLineFilter) return [];

  return records.filter((record) => {
    // 1. If we have a line-level filter, it takes precedence for all records in that line
    if (hasLineFilter && record.line) {
      if (normalizeLineName(record.line) === accessFilter.allowedLine) return true;
    }

    // Others buckets are line/company totals only. They should not become visible
    // just because the sheet carries a manager HR ID for reconciliation context.
    if (isSalesOthersBucket(record)) return false;

    // 2. Check if the record is explicitly linked to an allowed employee
    const employeeHrId = normalizeHrId(record.employeeHrId);
    if (employeeHrId && accessFilter.allowedHrIds.has(employeeHrId)) return true;

    // 3. Check if the record is managed by an allowed manager (important for vacant areas)
    const managerHrId = normalizeHrId(record.managerHrId);
    if (managerHrId && accessFilter.allowedHrIds.has(managerHrId)) return true;
    if (managerHrId && accessFilter.includeManagerOwnedHrId === managerHrId) return true;

    return false;
  });
}

function uniq(values: Array<string | null | undefined>) {
  return [...new Set(values.filter(Boolean) as string[])].sort((left, right) => left.localeCompare(right));
}

function sum<T>(items: T[], mapper: (item: T) => number) {
  return items.reduce((total, item) => total + mapper(item), 0);
}

function hasMaterialValueGap(actual: number, expected: number) {
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) return false;
  const tolerance = Math.max(Math.abs(expected) * 0.03, 1);
  return Math.abs(actual - expected) > tolerance;
}

function buildBatchReconciliation(records: ScopedRecord[]): SalesBatchReconciliation {
  const importedSalesUnits = sum(records, (record) => record.salesUnits);
  const importedTargetUnits = sum(records, (record) => record.targetUnits);
  const importedSalesValue = roundCurrency(sum(records, (record) => record.salesValue));
  const importedTargetValue = roundCurrency(sum(records, (record) => record.targetValue));
  const expectedSalesValue = roundCurrency(sum(records, (record) =>
    Number.isFinite(record.salesUnits) && Number.isFinite(record.factoryPrice) && record.factoryPrice > 0
      ? record.salesUnits * record.factoryPrice
      : 0
  ));
  const expectedTargetValue = roundCurrency(sum(records, (record) =>
    Number.isFinite(record.targetUnits) && Number.isFinite(record.factoryPrice) && record.factoryPrice > 0
      ? record.targetUnits * record.factoryPrice
      : 0
  ));

  invalidateExecutiveDashboardCache("sales import created", ["sales"]);
  return {
    importedSalesUnits,
    importedTargetUnits,
    importedSalesValue,
    importedTargetValue,
    expectedSalesValue,
    expectedTargetValue,
    salesValueVariance: roundCurrency(importedSalesValue - expectedSalesValue),
    targetValueVariance: roundCurrency(importedTargetValue - expectedTargetValue),
    salesValueMismatchRows: records.filter((record) =>
      Number.isFinite(record.salesUnits) && Number.isFinite(record.factoryPrice) && record.factoryPrice > 0
        ? hasMaterialValueGap(record.salesValue, record.salesUnits * record.factoryPrice)
        : false
    ).length,
    targetValueMismatchRows: records.filter((record) =>
      Number.isFinite(record.targetUnits) && Number.isFinite(record.factoryPrice) && record.factoryPrice > 0
        ? hasMaterialValueGap(record.targetValue, record.targetUnits * record.factoryPrice)
        : false
    ).length,
    lineMismatchRows: records.filter((record) =>
      record.validationNotes.some((note) => note.toLowerCase().includes("does not match the employee line"))
    ).length,
    unlinkedRows: records.filter((record) => record.linkStatus !== "linked").length,
    warningRows: records.filter((record) => record.validationNotes.length > 0).length,
    failedRows: records.filter((record) => record.validationState === "failed").length,
  };
}

function performanceMetric(sales: number, target: number) {
  return salesAchievementRate(sales, target);
}

function sumTargetValues(items: ScopedRecord[]) {
  return sum(items, (item) => item.targetValue);
}

/**
 * The part of these rows' sales that sits on a key carrying a target.
 *
 * A COVERAGE figure, and no longer the numerator of any achievement on this dashboard — see
 * `sumSalesValues` below for what the percentages divide, and why that changed on 2026-09-05.
 * It is still carried and still exposed (the SFE targets widget computes its own rate from it),
 * so it stays. Falls back to the full sales value when a row shape lacks the field, rather than
 * silently reading as zero.
 */
function sumCoveredSalesValues(items: ScopedRecord[]) {
  return sum(items, (item) =>
    typeof item.coveredSalesValue === "number" ? item.coveredSalesValue : item.salesValue,
  );
}

/**
 * Every pound in these rows — the numerator every achievement % on this dashboard divides.
 *
 * THIS DIVIDED THE COVERED SLICE UNTIL 2026-09-05, and the comment defending it said summing
 * untargeted sales over whatever targets exist "reports an over-achievement nobody earned". The
 * owner ruled otherwise, three times in one day: "THE OLD CLOSING IS THE CORRECT ONE", then
 * "FOLLOW THE OLD MONTHLY CLOSING ... MUST BE 100% IDENTICAL". `closingAchievement`
 * (monthly-closing-matrix-cells.ts) divides all sales and always has, so the covered numerator
 * was the thing disagreeing with the closing, not protecting against it.
 *
 * It mattered because this dashboard feeds the PORTAL HERO CARD — the rep's own headline. Measured
 * on production before the change, over the four months carrying targets, 7 of 85 reps were shown
 * two different numbers for themselves: one read 63.21% on her portal against 93.76% on the
 * closing, a 30.55-point gap straddling the 90% line. That is precisely the failure the owner's
 * first golden rule exists to prevent — never a mismatch of sales for the same person in two
 * places in his account.
 */
function sumSalesValues(items: ScopedRecord[]) {
  return sum(items, (item) => item.salesValue);
}

function aggregate<T>(items: T[], keyBuilder: (item: T) => string) {
  const map = new Map<string, T[]>();
  items.forEach((item) => {
    const key = keyBuilder(item) || "Unassigned";
    map.set(key, [...(map.get(key) ?? []), item]);
  });
  return map;
}

function countPersonalSalesEmployees(records: ClassifiedScopedRecord[]) {
  return new Set(
    records
      .filter((record) => record.ownership.include_in_employee_total)
      .map((record) => record.ownership.owner_employee_hr_id)
      .filter(Boolean),
  ).size;
}

function buildSalesOwnershipContextFromDirectory(
  directory: Awaited<ReturnType<typeof getEmployeeDirectory>>,
): SalesOwnershipContext {
  const lineIdByName = new Map<string, number>();
  const areaIdByName = new Map<string, number>();
  const lineIdByAreaId = new Map<number, number>();
  const normalizeKey = (value: unknown) => String(value ?? "").trim().toLowerCase();

  directory.lookups.lines.forEach((line) => {
    const lineId = Number(line.value);
    if (line.label && Number.isFinite(lineId)) lineIdByName.set(normalizeKey(line.label), lineId);
  });

  directory.lookups.areas.forEach((area) => {
    const areaId = Number(area.value);
    if (area.label && Number.isFinite(areaId)) areaIdByName.set(normalizeKey(area.label), areaId);
    if (Number.isFinite(areaId) && typeof area.lineId === "number") lineIdByAreaId.set(areaId, area.lineId);
  });

  directory.employees.forEach((employee) => {
    if (employee.lineName && typeof employee.lineId === "number") lineIdByName.set(normalizeKey(employee.lineName), employee.lineId);
    if (employee.areaName && typeof employee.areaId === "number") areaIdByName.set(normalizeKey(employee.areaName), employee.areaId);
    if (typeof employee.areaId === "number" && typeof employee.lineId === "number") lineIdByAreaId.set(employee.areaId, employee.lineId);
  });

  return buildSalesOwnershipContext({
    areaIdByName,
    employees: directory.employees.map((employee) => ({
      areaId: employee.areaId,
      areaName: employee.areaName,
      crmId: employee.crmId,
      crmUsername: employee.crmUsername,
      employmentStatus: employee.employmentStatus,
      fullName: employee.fullName,
      hrId: employee.hrId,
      jobTitle: employee.jobTitle,
      lineId: employee.lineId,
      lineName: employee.lineName,
      managerHrId: employee.managerHrId,
      positionTitle: employee.positionTitle,
      workEmail: employee.workEmail,
    })),
    lineIdByAreaId,
    lineIdByName,
    vacancies: directory.lookups.medicalRepVacancies.map((vacancy) => ({
      areaId: vacancy.areaId,
      areaName: vacancy.areaName,
      lineId: vacancy.lineId,
      lineName: vacancy.lineName,
      managerHrId: vacancy.managerHrId,
      status: "open",
      vacancyCode: vacancy.vacancyCode,
      vacancyId: vacancy.vacancyId,
    })),
  });
}

function dmName(record: ScopedRecord) {
  return record.employeeLookupKey || record.employeeName || "Unassigned";
}

function managerKey(record: Pick<ScopedRecord, "employeeHrId" | "employeeLookupKey" | "employeeName" | "line" | "managerHrId">) {
  if (isSalesOthersBucket(record)) return "Unassigned DSM";
  return record.managerHrId ? `DSM [${record.managerHrId}]` : "Unassigned DSM";
}

/**
 * The dashboard's Manager filter. Its VALUE stays `managerKey` — what the filter matches on — and
 * its LABEL is the manager's name, the same one the Manager Performance table prints: the option
 * list used to read "DSM [B-12]" codes (owner, 2026-10-20, names never codes). Sorted by that name.
 */
export function salesManagerFilterOptions(
  records: ReadonlyArray<Pick<ScopedRecord, "employeeHrId" | "employeeLookupKey" | "employeeName" | "line" | "managerHrId">>,
  peopleLabels: Map<string, string>,
): { managers: string[]; managerLabels: Record<string, string> } {
  const managerLabels: Record<string, string> = {};
  for (const record of records) {
    const key = managerKey(record);
    if (key in managerLabels) continue;
    managerLabels[key] = key === "Unassigned DSM" ? key : personLabel(peopleLabels, record.managerHrId, key);
  }
  const managers = Object.keys(managerLabels).sort(
    (left, right) => managerLabels[left].localeCompare(managerLabels[right]) || left.localeCompare(right),
  );
  return { managers, managerLabels };
}

function isNsmDirectoryEmployee(employee: { hrId?: string | null; jobTitle?: string | null; positionTitle?: string | null } | undefined) {
  const override = salesRoleOverrideForHrId(employee?.hrId);
  if (override) return override === "NSM";
  const title = `${employee?.jobTitle ?? ""} ${employee?.positionTitle ?? ""}`.trim().toLowerCase();
  return Boolean(title && (/\bnsm\b/.test(title) || title.includes("national sales manager")));
}

function shouldAttributeRecordToDsm(
  record: ScopedRecord,
  employeeByHrId: Map<string, { hrId: string; jobTitle: string | null; positionTitle: string | null }>,
) {
  const managerHrId = normalizeHrId(record.managerHrId);
  if (!managerHrId) return false;
  if (isSalesOthersBucket(record)) return false;
  if (isNsmDirectoryEmployee(employeeByHrId.get(managerHrId))) return false;
  return true;
}

function medicalRepKey(record: ScopedRecord) {
  if (!record.employeeHrId) return "";
  return `${record.employeeName || record.employeeLookupKey || "Medical Representative"} [${record.employeeHrId}]`;
}

function cleanPersonLabel(value: string) {
  return value.replace(/\s*\[HR\s+[^\]]+\]/gi, "").replace(/\s*\[[^\]]+\]/g, "").trim();
}

function personLabel(labels: Map<string, string>, hrId: string | null | undefined, fallback: string) {
  if (!hrId) return fallback;
  const directoryLabel = labels.get(String(hrId).trim().toLowerCase());
  return directoryLabel ? cleanPersonLabel(directoryLabel) : fallback;
}

function mapIssueField(note: string) {
  const normalized = note.toLowerCase();
  if (normalized.includes("line")) return "line";
  if (normalized.includes("month")) return "month";
  if (normalized.includes("year")) return "year";
  if (normalized.includes("target")) return "target";
  if (normalized.includes("employee")) return "employee";
  if (normalized.includes("product")) return "product";
  if (normalized.includes("family")) return "family";
  if (normalized.includes("factory")) return "factory_price";
  return "row";
}

function approvalBlockedReason(batch: SalesBatch) {
  if (batch.failedRecords > 0) return "This batch contains failed rows.";
  if (batch.status === "approved") return "This batch is already approved.";
  if (batch.status === "rejected") return "Rejected batches must be replaced or re-uploaded.";
  if (batch.status === "replaced") return "Replaced batches cannot be approved.";
  return null;
}

function mapHistoryRows(batches: SalesBatch[], records: ScopedRecord[]): SalesHistoryRow[] {
  return batches
    .slice()
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map((batch) => {
      const batchRecords = records.filter((record) => record.batchId === batch.id);
      const approvedRecords =
        batch.status === "approved" ? batchRecords.filter((record) => record.validationState !== "failed") : [];
      return {
        ...batch,
        approvedSalesValue: sum(approvedRecords, (record) => record.salesValue),
        approvedTargetValue: sumTargetValues(approvedRecords),
        linkageSummary: linkageSummaryForRecords(batchRecords),
      };
    });
}

function cleanIssueMessage(note: string) {
  return note.replace(/^(FAIL:|WARN:)\s*/, "").replace(/^Row \d+,\s*/i, "").trim();
}

function linkageSummaryForRecords(records: ScopedRecord[]) {
  const reasonCounts = new Map<string, number>();
  const sampleRows = records
    .filter((record) => record.linkStatus !== "linked")
    .slice(0, 8)
    .map((record) => ({
      employeeHrId: record.employeeHrId ?? null,
      managerHrId: record.managerHrId ?? null,
      messages: record.validationNotes.map(cleanIssueMessage).filter(Boolean).slice(0, 3),
      rowNumber: record.rowNumber,
      territory: record.territory,
    }));

  records
    .filter((record) => record.linkStatus !== "linked")
    .forEach((record) => {
      const messages = record.validationNotes.map(cleanIssueMessage).filter(Boolean);
      const message = messages[0] ?? "No matching employee linkage was found.";
      reasonCounts.set(message, (reasonCounts.get(message) ?? 0) + 1);
    });

  return {
    ambiguous: records.filter((record) => record.linkStatus === "ambiguous").length,
    linked: records.filter((record) => record.linkStatus === "linked").length,
    reasons: [...reasonCounts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 5)
      .map(([message, count]) => ({ count, message })),
    sampleRows,
    unlinked: records.filter((record) => record.linkStatus === "unlinked").length,
  };
}

function extractIssues(batches: SalesBatch[], records: ScopedRecord[]) {
  const batchMap = new Map(batches.map((batch) => [batch.id, batch]));
  return records.flatMap((record) => {
    const batch = batchMap.get(record.batchId);
    if (!batch) return [];
    return record.validationNotes.map<SalesBatchIssue>((note) => ({
      rowNumber: record.rowNumber,
      severity: note.startsWith("FAIL:") ? "failure" : "warning",
      field: mapIssueField(note),
      message: note.replace(/^(FAIL:|WARN:)\s*/, ""),
      batchId: batch.id,
      fileName: batch.fileName,
      period: batch.period,
      line: batch.line,
      status: batch.status,
    }));
  });
}

function chainForBatch(history: SalesHistoryRow[], batchId: string) {
  const map = new Map(history.map((row) => [row.id, row]));
  const chain: SalesHistoryRow[] = [];
  let current = map.get(batchId);
  while (current) {
    chain.unshift(current);
    if (!current.replacementForBatchId) break;
    current = map.get(current.replacementForBatchId);
  }
  let pointer = map.get(batchId)?.replacedByBatchId ? map.get(map.get(batchId)!.replacedByBatchId!) : null;
  while (pointer) {
    chain.push(pointer);
    pointer = pointer.replacedByBatchId ? map.get(pointer.replacedByBatchId) ?? null : null;
  }
  return chain;
}

async function readAllSupabaseRowsOneBatch(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  table: string,
  options?: {
    ascending?: boolean;
    inFilters?: Array<{ column: string; values: unknown[] }>;
    orderBy?: string;
    select?: string;
  }
) {
  const pageSize = 1000;
  const rows: Array<Record<string, unknown>> = [];
  let from = 0;

  while (true) {
    let query = supabase.from(table).select(options?.select ?? "*");
    options?.inFilters?.forEach((filter) => {
      query = query.in(filter.column, filter.values);
    });
    if (options?.orderBy) {
      query = query.order(options.orderBy, { ascending: options.ascending ?? true });
    }
    const result = await query.range(from, from + pageSize - 1);
    if (result.error) throw result.error;
    const page = toSafeArray(result.data) as unknown as Array<Record<string, unknown>>;
    rows.push(...page);
    if (page.length < pageSize) break;
    from += pageSize;
  }

  return rows;
}

// PostgREST folds every .in() value into the request URL; an unbatched array of a few hundred
// values can push the URL past undici's ~16KB header limit and throw "TypeError: fetch failed" /
// HeadersOverflowError. When an inFilter's values array is large (e.g. every sales_import_batches
// id, unbounded over the table's full history), chunk it and merge pages across chunks.
async function readAllSupabaseRows(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  table: string,
  options?: {
    ascending?: boolean;
    inFilters?: Array<{ column: string; values: unknown[] }>;
    orderBy?: string;
    select?: string;
  }
) {
  const inFilters = options?.inFilters ?? [];
  const chunkIndex = inFilters.findIndex((filter) => filter.values.length > 100);
  if (chunkIndex === -1) return readAllSupabaseRowsOneBatch(supabase, table, options);

  const targetFilter = inFilters[chunkIndex];
  // Accumulate as an array-of-batches and flatten once at the end — NOT `rows.push(...batch)`,
  // which spreads every element as an individual push() argument and throws "RangeError: Maximum
  // call stack size exceeded" once a single batch's row count crosses V8's argument-count ceiling
  // (same bug as master-workbook.ts's selectAll(), see PR #1406).
  const batches: Array<Array<Record<string, unknown>>> = [];
  for (let i = 0; i < targetFilter.values.length; i += 100) {
    const batchValues = targetFilter.values.slice(i, i + 100);
    const batchFilters = inFilters.map((filter, idx) => (idx === chunkIndex ? { ...filter, values: batchValues } : filter));
    batches.push(await readAllSupabaseRowsOneBatch(supabase, table, { ...options, inFilters: batchFilters }));
  }
  return batches.flat();
}

async function readSalesData(options?: { batchId?: string; approvedOnly?: boolean; includeRecords?: boolean }) {
  const supabase = getSupabaseAdmin();
  const includeRecords = options?.includeRecords ?? true;

  let batchesQuery = supabase.from("sales_import_batches").select("*").order("created_at", { ascending: false });

  if (options?.batchId) {
    batchesQuery = batchesQuery.eq("id", options.batchId);
  }

  if (options?.approvedOnly) {
    batchesQuery = batchesQuery.eq("status", "approved").is("replaced_by_batch_id", null);
  }

  const batchResult = options?.batchId
    ? await batchesQuery
    : await readAllSupabaseRows(supabase, "sales_import_batches", { orderBy: "created_at", ascending: false });
  const rawBatchRows = (Array.isArray(batchResult) ? batchResult : toSafeArray(batchResult.data)) as DbRow[];
  const batchRows = options?.batchId
    ? rawBatchRows
    : rawBatchRows.filter((row) => !isDisposableSalesBatchRow(row));
  const batchIds = batchRows.map((row) => String(row.id)).filter(Boolean);
  // Both branches page past PostgREST's 1000-row cap via readAllSupabaseRows — a single batch
  // (e.g. a monthly closing sheet across every product/customer/rep) can easily exceed it, and the
  // single-batch path used to skip the ceiling with a raw, unpaged `.select("*")`.
  const recordResult = includeRecords
    ? options?.batchId
      ? await readAllSupabaseRows(supabase, "sales_records", {
          inFilters: [{ column: "batch_id", values: [options.batchId] }],
        })
      : batchIds.length > 0
        ? await readAllSupabaseRows(supabase, "sales_records", {
            inFilters: [{ column: "batch_id", values: batchIds }],
          })
        : []
    : ([] as DbRow[]);
  const rawRecordRows = recordResult as DbRow[];
  const recordRows = options?.batchId
    ? rawRecordRows
    : rawRecordRows.filter((row) => !isDisposableSalesRecordRow(row));

  const batches = batchRows.map((row) => {
    const batch: SalesBatch = {
      id: String(row.id),
      fileName: String(row.file_name),
      line: String(row.line),
      month: Number(row.month),
      year: Number(row.year),
      period: String(row.period),
      status: String(row.status) as SalesBatch["status"],
      schemaType: (row.schema_type as SalesBatch["schemaType"]) || "closing_sheet",
      totalRecords: Number(row.total_records ?? 0),
      validRecords: Number(row.valid_records ?? 0),
      warningRecords: Number(row.warning_records ?? 0),
      failedRecords: Number(row.failed_records ?? 0),
      linkedRecords: Number(row.linked_records ?? 0),
      linkageRate: Number(row.linkage_rate ?? 0),
      uploadedBy: String(row.uploaded_by ?? "system"),
      createdAt: new Date(String(row.created_at)).toISOString(),
      version: Number(row.version ?? 1),
      duplicateHash: String(row.duplicate_hash ?? ""),
      isDuplicate: Boolean(row.is_duplicate),
      canApprove: false,
      replacementForBatchId: row.replacement_for_batch_id ? String(row.replacement_for_batch_id) : null,
      replacedByBatchId: row.replaced_by_batch_id ? String(row.replaced_by_batch_id) : null,
      approvedBy: row.approved_by ? String(row.approved_by) : null,
      approvedAt: row.approved_at ? new Date(String(row.approved_at)).toISOString() : null,
      rejectedBy: row.rejected_by ? String(row.rejected_by) : null,
      rejectedAt: row.rejected_at ? new Date(String(row.rejected_at)).toISOString() : null,
      previewUrl: `/sales/import?tab=approvals&batch=${row.id}`,
      approvalBlockedReason: null,
    };
    batch.approvalBlockedReason = approvalBlockedReason(batch);
    batch.canApprove = batch.approvalBlockedReason === null;
    return batch;
  });

  const records = recordRows.map((row) => ({
    batchId: String(row.batch_id),
    period: `${row.year}-${String(row.month).padStart(2, "0")}`,
    rowNumber: Number(row.row_number),
    employeeHrId: row.employee_hr_id ? String(row.employee_hr_id) : null,
    employeeCrmId: row.employee_crm_id ? String(row.employee_crm_id) : null,
    employeeLookupKey: row.employee_lookup_key ? String(row.employee_lookup_key) : null,
    employeeName: row.employee_name ? String(row.employee_name) : null,
    managerHrId: row.manager_hr_id ? String(row.manager_hr_id) : null,
    line: String(row.line),
    territory: String(row.territory),
    salesType: String(row.sales_type),
    family: String(row.family),
    product: String(row.product),
    factoryPrice: Number(row.factory_price ?? 0),
    month: Number(row.month),
    year: Number(row.year),
    salesUnits: Number(row.sales_units ?? 0),
    salesValue: Number(row.sales_value ?? 0),
    targetUnits: Number(row.target_units ?? 0),
    targetValue: Number(row.target_value ?? 0),
    validationState: row.validation_state as SalesValidationState,
    validationNotes: Array.isArray(row.validation_notes) ? row.validation_notes.map(String) : [],
    linkStatus: (row.link_status ?? "unlinked") as SalesLinkStatus,
    linkConfidence: Number(row.link_confidence ?? 0),
  }));

  return { batches, records };
}

export async function listSalesHistory(accessContext?: AccessContext | null) {
  const { batches, records } = await readSalesData();
  const visibleRecords = await filterSalesRecordsForAccess(records, accessContext);
  return mapHistoryRows(batches, visibleRecords);
}

export async function listSalesQueue(accessContext?: AccessContext | null) {
  const { batches, records } = await readSalesData();
  const visibleRecords = await filterSalesRecordsForAccess(records, accessContext);
  const history = mapHistoryRows(batches, visibleRecords);
  return history.sort((left, right) =>
    new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
  );
}

export async function getSalesBatchDetail(
  id: string,
  accessContext?: AccessContext | null,
): Promise<SalesBatchDetail | null> {
  const { batches, records } = await readSalesData({ batchId: id });
  const visibleRecords = await filterSalesRecordsForAccess(records, accessContext);
  const history = mapHistoryRows(batches, visibleRecords);
  const batch = history.find((item) => item.id === id);
  if (!batch) return null;
  const batchRecords = visibleRecords.filter((record) => record.batchId === id);

  return {
    ...batch,
    records: batchRecords,
    issues: extractIssues(batches.filter((item) => item.id === id), batchRecords),
    replacementChain: chainForBatch(history, id),
    reconciliation: buildBatchReconciliation(batchRecords),
  };
}

function pareto(items: Array<{ name: string; sales: number }>, totalSales: number) {
  let running = 0;
  return items.map((item) => {
    running += item.sales;
    return { name: item.name, sales: item.sales, cumulativePercent: totalSales > 0 ? running / totalSales : 0 };
  });
}

function forecastTrend(trend: Array<{ period: string; sales: number }>) {
  const alpha = 0.45;
  let smooth = trend[0]?.sales ?? 0;
  const historical = trend.map((point) => {
    smooth = alpha * point.sales + (1 - alpha) * smooth;
    return { period: point.period, sales: point.sales, forecast: smooth };
  });
  if (trend.length > 0) historical.push({ period: "Next", sales: 0, forecast: smooth });
  return historical;
}

function anomalyInsights(records: ScopedRecord[]) {
  const groups = [...aggregate(records, (record) => `${record.product} / ${record.territory}`).entries()].map(
    ([name, items]) => ({ name, units: Math.abs(sum(items, (item) => item.salesUnits)) })
  );
  const mean = groups.reduce((total, item) => total + item.units, 0) / Math.max(groups.length, 1);
  const variance = groups.reduce((total, item) => total + (item.units - mean) ** 2, 0) / Math.max(groups.length, 1);
  const sd = Math.sqrt(variance) || 1;
  return groups
    .map((item) => ({ ...item, score: (item.units - mean) / sd }))
    .filter((item) => Math.abs(item.score) >= 1.5)
    .sort((left, right) => Math.abs(right.score) - Math.abs(left.score))
    .slice(0, 6)
    .map((item) => ({
      label: item.name,
      detail: `${formatUnits(item.units)} units ${item.score > 0 ? "above" : "below"} normal range`,
      score: item.score,
    }));
}

export async function getSalesDashboard(
  filters: SalesDashboardFilters = {},
  accessContext?: AccessContext | null,
  options?: { transactionLimit?: number },
): Promise<SalesDashboardData> {
  // Sales come from SoS Monthly Closing, not from the closing-sheet import table. Everything
  // below — access scoping, restricted products, ownership classification, the aggregations —
  // is unchanged; only the row source moved. See src/lib/sales/dashboard-canonical.ts.
  const canonicalRecords = await loadCanonicalDashboardRecords();

  if (canonicalRecords.length === 0) {
    // No month has landed yet. An empty dashboard is the honest answer; zeros with a populated
    // filter list would read as "the company sold nothing".
    return {
      summary: {
        totalApprovedSales: 0,
        totalApprovedTarget: 0,
        achievementRate: 0,
        approvedRecords: 0,
        dsmLinkedRecords: 0,
        dsmTotalRecords: 0,
        linkedRecords: 0,
        linkedEmployees: 0,
        openReviewBatches: 0,
        activeTargetRecords: 0,
        unitsSold: 0,
        averageFactoryPrice: 0,
        activeProducts: 0,
        topManager: "-",
        dataQualityRate: 1,
      },
      filters: { lines: [], periods: [], salesTypes: [], managers: [], territories: [], products: [], families: [] },
      trend: [],
      channelMix: [],
      familyMatrix: [],
      pareto: [],
      territories: [],
      linePerformance: [],
      managerPerformance: [],
      productPerformance: [],
      forecast: [],
      anomalies: [],
      transactions: [],
      linkage: { linked: 0, unlinked: 0, ambiguous: 0 },
      recentBatches: [],
    };
  }

  let records: ScopedRecord[] = await filterSalesRecordsForAccess(canonicalRecords, accessContext);

  // Confidential products (LA003 / LA004 — "Lacto Basic 1 & 2") are visible only to CEO /
  // Super Admin. The rows are keyed by product NAME here, so strip by name — before any
  // aggregation — so every downstream total, KPI, chart, table, filter list and transactions
  // feed is automatically clean. A missing accessContext fails closed.
  const canSeeRestrictedProducts = accessContext ? canViewRestrictedProducts(accessContext.role) : false;
  if (!canSeeRestrictedProducts) {
    const restrictedNames = await restrictedProductNameSet();
    records = stripRestrictedRowsByName(records, restrictedNames, (record) => record.product, true);
  }

  // No superseded-batch pass: the canonical engine returns the current truth for every month,
  // so there is no replaced upload to filter out. That selection used to be the dashboard's
  // job precisely because `sales_records` kept every version of every sheet.
  const approvedRecords = records;

  const productFilter = [...new Set([
    ...toFilterStringList(filters.product),
    ...toFilterStringList(filters.products),
  ].map(normalizeFilterToken).filter(Boolean))];
  const periodFilter = [...new Set([
    ...toFilterStringList(filters.period),
    ...toFilterStringList(filters.periods),
  ])];

  const filteredRecords = approvedRecords.filter((record) => {

    if (filters.line && record.line !== filters.line) return false;
    if (periodFilter.length > 0 && !periodFilter.includes(record.period)) return false;
    if (filters.salesType && record.salesType !== filters.salesType) return false;
    if (filters.manager && managerKey(record) !== filters.manager) return false;
    if (filters.territory && record.territory !== filters.territory) return false;
    if (productFilter.length > 0 && !productFilter.includes(normalizeFilterToken(record.product))) return false;
    if (filters.family && record.family !== filters.family) return false;
    return true;
  });

  const directory = await getEmployeeDirectory();
  const ownershipContext = buildSalesOwnershipContextFromDirectory(directory);
  const classifiedRecords: ClassifiedScopedRecord[] = filteredRecords.map((record) => {
    const ownership = classifySalesOwnership(record, ownershipContext);
    return {
      ...record,
      derivedTeamKey: ownership.derived_team_key,
      ownership,
      ownershipClassification: ownership.classification,
    };
  });
  const companyRecords = classifiedRecords.filter((record) => record.ownership.include_in_company_total);

  const totalSales = sum(companyRecords, (record) => record.salesValue);
  const totalTarget = sumTargetValues(companyRecords);
  const unitsSold = sum(companyRecords, (record) => record.salesUnits);
  const periodGroups = aggregate(companyRecords, (record) => record.period);
  const sortedPeriods = [...periodGroups.keys()].sort();
  const trend = sortedPeriods.map((period) => {
    const items = periodGroups.get(period) ?? [];
    const sales = sum(items, (item) => item.salesValue);
    const target = sumTargetValues(items);
    return {
      period,
      sales,
      target,
      achievementRate: performanceMetric(sumSalesValues(items), target),
      linkedEmployees: countPersonalSalesEmployees(items),
    };
  });

  // Only rows that actually carry a sales type. The canonical engine records no Retail/Stores
  // split, so this comes back empty and the chart renders its "No channel data." state rather
  // than one giant "Unassigned" slice claiming to be a channel breakdown.
  const channelMix = [...aggregate(companyRecords.filter((record) => record.salesType), (record) => record.salesType).entries()]
    .map(([name, items]) => ({ name, value: sum(items, (item) => item.salesValue) }))
    .sort((left, right) => right.value - left.value);

  const familyGroupsMap = aggregate(companyRecords, (record) => record.family);
  const familyMatrix = [...familyGroupsMap.entries()].map(([name, items]) => {
    const sales = sum(items, (item) => item.salesValue);
    const target = sumTargetValues(items);
    const achievementRate = performanceMetric(sumSalesValues(items), target);
    const status: "green" | "yellow" | "red" | "neutral" =
      target === 0 ? "neutral" : achievementRate >= 1 ? "green" : achievementRate >= 0.8 ? "yellow" : "red";
    return { name, sales, target, achievementRate, units: sum(items, (item) => item.salesUnits), status };
  });

  const productGroupsMap = aggregate(companyRecords, (record) => record.product);
  const productPerformance = [...productGroupsMap.entries()]
    .map(([product, items]) => {
      const sales = sum(items, (item) => item.salesValue);
      const target = sum(items, (item) => item.targetValue);
      return {
        product,
        family: items[0]?.family ?? "Unknown",
        sales,
        target,
        achievementRate: performanceMetric(sumSalesValues(items), target),
      };
    })
    .sort((left, right) => right.sales - left.sales);

  const paretoData = pareto(
    productPerformance
      .slice(0, 20)
      .map((item) => ({ name: item.product, sales: item.sales })),
    totalSales,
  );

  const territoryPerformance = [...aggregate(companyRecords, (record) => record.territory).entries()]
    .map(([name, items]) => {
      const sales = sum(items, (item) => item.salesValue);
      const target = sumTargetValues(items);
      return { name, sales, target, achievementRate: performanceMetric(sumSalesValues(items), target) };
    })
    .sort((left, right) => right.sales - left.sales);

  const linePerformance = [...aggregate(companyRecords.filter((record) => record.ownership.include_in_line_total), (record) => record.line).entries()]
    .map(([line, items]) => {
      const sales = sum(items, (item) => item.salesValue);
      const coveredSales = sumCoveredSalesValues(items);
      const target = sumTargetValues(items);
      return {
        line,
        sales,
        // Carried so a consumer computing its own rate (the SFE targets widget) divides the
        // same numerator this row's achievementRate does.
        coveredSales,
        target,
        achievementRate: performanceMetric(coveredSales, target),
        linkedEmployees: countPersonalSalesEmployees(items),
      };
    })
    .sort((left, right) => right.sales - left.sales);

  const employeeByHrId = new Map<string, { hrId: string; jobTitle: string | null; positionTitle: string | null }>();
  directory.employees.forEach((employee) => {
    const hrId = normalizeHrId(employee.hrId);
    if (!hrId) return;
    employeeByHrId.set(hrId, {
      hrId: employee.hrId,
      jobTitle: employee.jobTitle,
      positionTitle: employee.positionTitle,
    });
  });
  const dsmAttributableRecords = companyRecords.filter((record) =>
    record.ownership.include_in_manager_total && shouldAttributeRecordToDsm(record, employeeByHrId)
  );

  const peopleLabels = await getSalesPeopleLabels([
    ...companyRecords.map((record) => record.ownership.owner_manager_hr_id ?? record.managerHrId),
    ...companyRecords.map((record) => record.ownership.owner_employee_hr_id ?? record.employeeHrId),
    // Every manager the filter offers, not only those inside the current slice.
    ...records.map((record) => record.managerHrId),
  ]);
  const managerFilter = salesManagerFilterOptions(records, peopleLabels);

  const managerGroupsMap = aggregate(dsmAttributableRecords, (record) =>
    personLabel(peopleLabels, record.ownership.owner_manager_hr_id ?? record.managerHrId, managerKey(record))
  );
  const managerPerformance = [...managerGroupsMap.entries()]
    .filter(([name]) => name !== "Unassigned")
    .map(([manager, items]) => {
      const sales = sum(items, (item) => item.salesValue);
      const target = sumTargetValues(items);
      const retailItems = items.filter((item) => item.salesType?.toLowerCase().includes("retail"));
      const storesItems = items.filter((item) => item.salesType?.toLowerCase().includes("store"));
      const topProductEntry = [...aggregate(items, (item) => item.product).entries()]
        .map(([product, prodItems]) => ({ product, sales: sum(prodItems, (item) => item.salesValue) }))
        .sort((left, right) => right.sales - left.sales)[0];
      return {
        manager,
        sales,
        target,
        achievementRate: performanceMetric(sumSalesValues(items), target),
        line: items[0]?.line ?? "Unknown",
        topProduct: topProductEntry?.product ?? "Unknown",
        retailSales: sum(retailItems, (item) => item.salesValue),
        storesSales: sum(storesItems, (item) => item.salesValue),
      };
    })
    .sort((left, right) => right.sales - left.sales);

  const transactions = companyRecords
    .map((record) => {
      const hasDsmAttribution = shouldAttributeRecordToDsm(record, employeeByHrId);
      const ownerEmployeeHrId = record.ownership.owner_employee_hr_id;
      const ownerManagerHrId = record.ownership.owner_manager_hr_id;
      return {
        derivedTeamKey: record.derivedTeamKey,
        employeeHrId: ownerEmployeeHrId,
        employeeName: ownerEmployeeHrId
          ? personLabel(peopleLabels, ownerEmployeeHrId, medicalRepKey(record))
          : null,
        employeeSourceName: dmName(record),
        linkStatus: record.linkStatus,
        managerHrId: hasDsmAttribution ? ownerManagerHrId ?? null : null,
        managerName: hasDsmAttribution ? personLabel(peopleLabels, ownerManagerHrId, managerKey(record)) : null,
        line: record.line,
        ownershipClassification: record.ownershipClassification,
        ownershipLabel: salesOwnershipLabel(record.ownershipClassification),
        includeInVacancyDashboard: record.ownership.include_in_vacancy_dashboard,
        territory: record.territory,
        salesType: record.salesType,
        family: record.family,
        factoryPrice: record.factoryPrice,
        product: record.product,
        period: record.period,
        salesUnits: record.salesUnits,
        salesValue: record.salesValue,
        targetValue: record.targetValue,
        achievementRate: performanceMetric(record.salesValue, record.targetValue),
      };
    })
    .slice(0, options?.transactionLimit ?? SALES_DASHBOARD_TRANSACTION_LIMIT);

  const linkageStats = {
    linked: companyRecords.filter((record) => record.linkStatus === "linked").length,
    unlinked: companyRecords.filter((record) => record.linkStatus === "unlinked").length,
    ambiguous: companyRecords.filter((record) => record.linkStatus === "ambiguous").length,
  };

  const topManagerEntry = managerPerformance[0];
  const allProducts = new Set(companyRecords.map((record) => record.product));
  const factoryPrices = companyRecords.filter((record) => record.factoryPrice > 0).map((record) => record.factoryPrice);
  const avgFactoryPrice = factoryPrices.length > 0 ? factoryPrices.reduce((sum, price) => sum + price, 0) / factoryPrices.length : 0;
  const dashboardLinkage = await summarizeSalesLinkage(companyRecords);
  const linkedCount = dashboardLinkage.dsmLinked;
  const linkageTotal = dashboardLinkage.dsmTotal;
  const qualityRate = linkageTotal > 0 ? linkedCount / linkageTotal : 1;
  const ownershipBreakdown = Object.fromEntries(
    [
      "assigned_employee_sales",
      "vacant_territory_sales",
      "non_assignable_territory_sales",
      "line_level_sales",
      "others_unassigned_sales",
      "unresolved_sales_exception",
    ].map((classification) => [
      classification,
      {
        records: classifiedRecords.filter((record) => record.ownershipClassification === classification).length,
        salesValue: sum(
          classifiedRecords.filter((record) => record.ownershipClassification === classification),
          (record) => record.salesValue,
        ),
      },
    ]),
  );

  return {
    summary: {
      totalApprovedSales: totalSales,
      totalApprovedTarget: totalTarget,
      // These three now divide: sales over target IS the rate beside them. Until 2026-09-05 the
      // rate came from the covered slice while the sales figure above it was every pound, so the
      // summary contradicted itself — and this is the object the PORTAL HERO CARD reads, which is
      // how a rep came to see 63.21% for a month the closing scored 93.76%.
      achievementRate: performanceMetric(totalSales, totalTarget),
      approvedRecords: companyRecords.length,
      dsmLinkedRecords: linkedCount,
      dsmTotalRecords: linkageTotal,
      linkedRecords: linkedCount,
      linkedEmployees: countPersonalSalesEmployees(companyRecords),
      // Both belong to the closing-sheet import queue, which no longer feeds this dashboard.
      // Batch provenance lives on /sales/import, where it can still be acted on; repeating a
      // frozen ledger beside SoS numbers would claim a lineage these figures do not have.
      openReviewBatches: 0,
      activeTargetRecords: 0,
      unitsSold,
      averageFactoryPrice: avgFactoryPrice,
      activeProducts: allProducts.size,
      topManager: topManagerEntry?.manager ?? "-",
      dataQualityRate: qualityRate,
      salesOwnership: ownershipBreakdown,
    },
    filters: {
      lines: uniq(records.map((record) => record.line)),
      periods: uniq(records.map((record) => record.period)),
      salesTypes: uniq(records.map((record) => record.salesType)),
      managers: managerFilter.managers,
      managerLabels: managerFilter.managerLabels,
      territories: uniq(records.map((record) => record.territory)),
      products: uniq(records.map((record) => record.product)),
      families: uniq(records.map((record) => record.family)),
    },
    trend,
    channelMix,
    familyMatrix,
    pareto: paretoData,
    territories: territoryPerformance,
    linePerformance,
    managerPerformance,
    productPerformance,
    forecast: forecastTrend(trend),
    anomalies: anomalyInsights(filteredRecords),
    transactions,
    linkage: linkageStats,
    recentBatches: [],
  };
}

/**
 * Cached across requests, keyed on the achievement cache stamp AND the viewer's access context.
 *
 * These seven numbers are the whole payload, but producing them rebuilds the full monthly
 * dashboard — every canonical closing row since the history floor (7,129 on 2026-09-21), ownership
 * classification, linkage — and /admin asks for it three times per render. The stamp changes the
 * key whenever actuals, targets or seat occupancy move (see loadAchievementCacheStamp), so a hit can
 * never serve stale sales; the TTL only bounds an employee-directory edit, which moves the ownership
 * split. A null stamp builds live, never from cache. The context is in the key, so a scoped viewer
 * never reads another viewer's figures. Same shape as the Business Review bundle cache.
 */
const SALES_PLATFORM_METRICS_CACHE_TTL_SECONDS = 300;

export async function getSalesPlatformMetrics(accessContext?: AccessContext | null) {
  const context = accessContext ?? null;
  const stamp = await loadAchievementCacheStamp();
  if (!stamp) return buildSalesPlatformMetrics(context);
  const cached = unstable_cache(
    () => buildSalesPlatformMetrics(context),
    ["sales-platform-metrics", stamp, JSON.stringify(context)],
    { revalidate: SALES_PLATFORM_METRICS_CACHE_TTL_SECONDS },
  );
  return cached();
}

async function buildSalesPlatformMetrics(accessContext: AccessContext | null) {
  const sales = await getSalesDashboard({}, accessContext);
  return {
    achievementRate: Number(sales.summary.achievementRate ?? 0),
    activeProducts: Number(sales.summary.activeProducts ?? 0),
    dataQualityRate: Number(sales.summary.dataQualityRate ?? 1),
    // Linkage over the CANONICAL closing: rows the engine tied to an occupied seat, out of every
    // row it reported. The Command Center's Sales health card used to divide sales_records by
    // link_status, which measured a table no sales surface reads any more.
    linkedRecords: Number(sales.summary.linkedRecords ?? 0),
    totalRecords: Number(sales.summary.approvedRecords ?? 0),
    salesValue: Number(sales.summary.totalApprovedSales ?? 0),
    targetValue: Number(sales.summary.totalApprovedTarget ?? 0),
  };
}

/**
 * The legacy closing-sheet import is CLOSED TO NEW WRITES. Flip to `false` to reopen it.
 *
 * `createSalesImport` is the only code path that writes `sales_records`, and no sales surface
 * reads that table any more: the monthly dashboard, its API and export, the /admin KPIs, the CEO
 * and SFE tiles, the portal, the reconciliation view and the data-health audit all read SoS
 * Monthly Closing. An upload accepted here would take a real workbook, spend real minutes
 * validating it, report a confident success — and change nothing anyone can see. That failure is
 * silent, and silent is the expensive kind.
 *
 * What is NOT frozen: the 11,267 existing rows stay (they are the record of what H1 was actually
 * paid on), and approving, rejecting or replacing a batch already in the queue still works. Only
 * new rows are refused.
 */
const LEGACY_SALES_IMPORT_FROZEN = true;

const LEGACY_SALES_IMPORT_FROZEN_MESSAGE =
  "Monthly closing sheets are no longer imported here. Every sales screen now reads Source of Sales Monthly Closing, so a sheet uploaded on this page would change nothing. Upload the distributor files under Sales > Source of Sales instead.";

/** Throws a 410 when the legacy closing-sheet import is frozen. Called at both write entries. */
export function assertLegacySalesImportOpen() {
  if (LEGACY_SALES_IMPORT_FROZEN) {
    throw new SalesWorkflowError("legacy_sales_import_frozen", LEGACY_SALES_IMPORT_FROZEN_MESSAGE, 410);
  }
}

export async function createSalesImport(payload: SalesImportPayload) {
  // Defence in depth: runSalesImportWorkflow refuses first, but this is the function that
  // actually inserts, so it must refuse on its own account too.
  assertLegacySalesImportOpen();
  const supabase = getSupabaseAdmin();
  const linked = await linkSalesRecords(payload.records);
  const linkageBreakdown = await summarizeSalesLinkage(linked);
  const linkedCount = linkageBreakdown.dsmLinked;
  const linkageRate = linkageBreakdown.dsmTotal > 0 ? linkageBreakdown.dsmLinked / linkageBreakdown.dsmTotal : 0;
  const failedRecords = linked.filter((record) => record.validationState === "failed").length;

  const existingResult = await supabase
    .from("sales_import_batches")
    .select("id,status")
    .eq("duplicate_hash", payload.batch.duplicateHash)
    .not("status", "in", "(replaced,rejected)");

  if (existingResult.error) {
    throw existingResult.error;
  }

  let isDuplicate = false;
  for (const existingBatch of existingResult.data ?? []) {
    const existingRecords = await supabase
      .from("sales_records")
      .select("id", { count: "exact", head: true })
      .eq("batch_id", existingBatch.id);
    if (existingRecords.error) {
      throw existingRecords.error;
    }
    if ((existingRecords.count ?? 0) > 0) {
      isDuplicate = true;
      break;
    }
  }

  const batchInsert = await supabase.from("sales_import_batches").insert({
    id: payload.batch.id,
    file_name: payload.batch.fileName,
    line: payload.batch.line,
    month: payload.batch.month,
    year: payload.batch.year,
    period: payload.batch.period,
    status: payload.batch.status,
    schema_type: payload.batch.schemaType,
    total_records: linked.length,
    valid_records: linked.filter((record) => record.validationState === "valid").length,
    warning_records: linked.filter((record) => record.validationState === "warning").length,
    failed_records: failedRecords,
    linked_records: linkedCount,
    linkage_rate: linkageRate,
    uploaded_by: payload.batch.uploadedBy,
    version: payload.batch.version,
    duplicate_hash: payload.batch.duplicateHash,
    is_duplicate: isDuplicate,
  });
  if (batchInsert.error) {
    // The partial unique index on duplicate_hash (WHERE status NOT IN replaced/rejected) is the
    // atomic backstop for the SELECT-then-INSERT duplicate check above: under two concurrent uploads
    // of the same sheet both SELECTs can miss (the first batch's records are inserted in a separate
    // later statement, so the second upload's record-count check sees 0), leaving both flagged
    // non-duplicate and both approvable. With the index, only one INSERT wins; the loser hits 23505
    // here. Surface it as a clean "already uploaded" 409 (the upload route maps SalesWorkflowError to
    // its status) instead of a raw 500 — matching how the SoS pipeline handles its own unique index.
    if (isPostgresUniqueViolation(batchInsert.error)) {
      throw new SalesWorkflowError(
        "duplicate_sales_batch",
        "This sales sheet has already been uploaded for this line and period. Delete or replace the existing batch, then re-upload.",
        409,
      );
    }
    throw batchInsert.error;
  }

  if (linked.length > 0) {
    const recordInserts = linked.map((record) => ({
      batch_id: payload.batch.id,
      row_number: record.rowNumber,
      employee_hr_id: record.linkStatus === "linked" || isSalesVacancyAreaCode(record.employeeHrId)
        ? (record.employeeHrId ?? null)
        : null,
      employee_crm_id: record.employeeCrmId ?? null,
      employee_lookup_key: record.employeeLookupKey ?? null,
      employee_name: record.employeeName ?? null,
      manager_hr_id: record.managerHrId ?? null,
      line: record.line,
      territory: record.territory,
      sales_type: record.salesType,
      family: record.family,
      product: record.product,
      factory_price: record.factoryPrice,
      month: record.month,
      year: record.year,
      sales_units: record.salesUnits,
      sales_value: record.salesValue,
      target_units: record.targetUnits,
      target_value: Number.isFinite(record.targetValue) ? record.targetValue : 0,
      validation_state: record.validationState,
      validation_notes: record.validationNotes,
      link_status: record.linkStatus ?? "unlinked",
      link_confidence: record.linkConfidence ?? 0,
    }));

    try {
      for (let i = 0; i < recordInserts.length; i += 500) {
        const recordInsert = await supabase.from("sales_records").insert(recordInserts.slice(i, i + 500));
        if (recordInsert.error) {
          throw recordInsert.error;
        }
      }
    } catch (error) {
      await supabase.from("sales_records").delete().eq("batch_id", payload.batch.id);
      await supabase.from("sales_import_batches").delete().eq("id", payload.batch.id);
      throw error;
    }
  }

  return {
    ...payload.batch,
    linkedRecords: linkedCount,
    linkageRate,
    isDuplicate,
    canApprove: failedRecords === 0 && !isDuplicate,
    approvalBlockedReason: isDuplicate ? "This batch is a duplicate of an existing upload." : failedRecords > 0 ? "This batch contains failed rows." : null,
    previewUrl: `/sales/import?tab=approvals&batch=${payload.batch.id}`,
    blockingReasons: [],
    topFailureReasons: [],
    topWarningReasons: [],
    reconciliation: null,
    linkageBreakdown,
  };
}

export async function updateSalesBatchStatus(
  batchId: string,
  status: "approved" | "rejected",
  actorUsername: string,
  actorDisplayName: string
) {
  const supabase = getSupabaseAdmin();
  const { data: existing, error: existingError } = await supabase
    .from("sales_import_batches")
    .select("id,status,failed_records,is_duplicate,line,period")
    .eq("id", batchId)
    .maybeSingle();
  if (existingError) throw existingError;
  if (!existing) return null;

  const currentStatus = String(existing.status ?? "");
  if (currentStatus === "replaced") {
    throw new Error("Replaced sales batches cannot be changed.");
  }
  if (status === "approved") {
    if (currentStatus === "approved") throw new Error("This sales batch is already approved.");
    if (currentStatus === "rejected") throw new Error("Rejected sales batches must be replaced or re-uploaded.");
    if (Number(existing.failed_records ?? 0) > 0 || existing.is_duplicate === true) {
      throw new Error("Sales batch cannot be approved while it has failed rows or duplicate status.");
    }
  }

  const now = new Date().toISOString();
  const updateData: Record<string, unknown> = { status, updated_at: now };

  if (status === "approved") {
    updateData.approved_by = actorUsername;
    updateData.approved_at = now;
  } else if (status === "rejected") {
    updateData.rejected_by = actorUsername;
    updateData.rejected_at = now;
  }

  const { data, error } = await supabase
    .from("sales_import_batches")
    .update(updateData)
    .eq("id", batchId)
    .eq("status", currentStatus)
    .select()
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) throw new Error("Sales batch state changed. Refresh and retry.");

  const auditResult = await supabase.from("sales_audit_logs").insert({
    action: status === "approved" ? "import.approved" : "import.rejected",
    batch_id: batchId,
    actor_username: actorUsername,
    actor_display_name: actorDisplayName,
    line: String(data.line),
    period: String(data.period),
  });
  if (auditResult.error) {
    throw auditResult.error;
  }

  await writeRequiredAuditLog({
    actorLoginId: actorUsername,
    entityId: batchId,
    entityType: "sales_import_batch",
    newValues: {
      actorDisplayName,
      line: String(data.line),
      period: String(data.period),
      status,
    },
    oldValues: { status: currentStatus },
    summary: status === "approved" ? "Sales import approved." : "Sales import rejected.",
  });

  invalidateExecutiveDashboardCache("sales import status updated", ["sales"]);
  return getSalesBatchDetail(batchId);
}

export async function replaceSalesBatch(
  originalId: string,
  replacementId: string,
  actorUsername: string,
  actorDisplayName: string
) {
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();

  const originalUpdate = await supabase.from("sales_import_batches").update({ status: "replaced", replaced_by_batch_id: replacementId, updated_at: now }).eq("id", originalId);
  if (originalUpdate.error) {
    throw originalUpdate.error;
  }

  const replacementUpdate = await supabase.from("sales_import_batches").update({ status: "approved", replacement_for_batch_id: originalId, approved_by: actorUsername, approved_at: now, updated_at: now }).eq("id", replacementId);
  if (replacementUpdate.error) {
    throw replacementUpdate.error;
  }

  const auditResult = await supabase.from("sales_audit_logs").insert({
    action: "import.replaced",
    batch_id: originalId,
    actor_username: actorUsername,
    actor_display_name: actorDisplayName,
    metadata: { replacementId },
  });
  if (auditResult.error) {
    throw auditResult.error;
  }

  await writeRequiredAuditLog({
    actorLoginId: actorUsername,
    entityId: originalId,
    entityType: "sales_import_batch",
    newValues: {
      actorDisplayName,
      replacementId,
      replacementStatus: "approved",
      status: "replaced",
    },
    oldValues: { replacementId: null },
    summary: "Sales import replaced.",
  });

  invalidateExecutiveDashboardCache("sales import replaced", ["sales"]);
  return getSalesBatchDetail(replacementId);
}

/**
 * Refuses to delete a batch while it still holds `sales_records` rows.
 *
 * The Rule #1 freeze revoked service_role's DELETE on `sales_records`, but that revoke does NOT
 * protect the table here: `sales_records_batch_id_fkey` is `ON DELETE CASCADE`, and a referential
 * cascade executes with the TABLE OWNER's rights, not the caller's. Measured on staging (identical
 * schema and grants), as service_role:
 *
 *   delete from sales_records         -> ERROR 42501 permission denied for table sales_records
 *   delete from sales_import_batches  -> succeeded, and the child sales_records row went with it
 *
 * So deleting a batch is a back door around the freeze. Three batches hold all 11,267 rows — the
 * only record of what Semester 1 2026 was actually paid on — and production runs without PITR (daily
 * snapshots only), so a single delete here is not recoverable in place.
 *
 * Rejecting or replacing a batch still works; both leave the rows alone.
 */
async function assertSalesBatchHoldsNoFrozenRecords(batchId: string) {
  const supabase = getSupabaseAdmin();
  const { count, error } = await supabase
    .from("sales_records")
    .select("id", { count: "exact", head: true })
    .eq("batch_id", batchId);
  if (error) {
    throw error;
  }

  const frozenRowCount = count ?? 0;
  if (frozenRowCount > 0) {
    throw new SalesWorkflowError(
      "sales_batch_holds_frozen_records",
      `This closing sheet still holds ${frozenRowCount.toLocaleString("en-US")} imported records, and deleting the sheet would delete those records with it. They are the only record of what Semester 1 2026 was actually paid on, so the sheet cannot be deleted. Reject or replace it instead.`,
      409,
      { batchId, frozenRowCount },
    );
  }
}

export async function deleteSalesBatch(batchId: string, actorUsername: string, actorDisplayName: string) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("sales_import_batches").select("line, period").eq("id", batchId).maybeSingle();
  if (error) {
    throw error;
  }
  if (!data) return null;

  await assertSalesBatchHoldsNoFrozenRecords(batchId);

  const deleteResult = await supabase.from("sales_import_batches").delete().eq("id", batchId);
  if (deleteResult.error) {
    throw deleteResult.error;
  }

  const auditResult = await supabase.from("sales_audit_logs").insert({
    action: "import.deleted",
    batch_id: batchId,
    actor_username: actorUsername,
    actor_display_name: actorDisplayName,
    line: String(data.line),
    period: String(data.period),
  });
  if (auditResult.error) {
    throw auditResult.error;
  }

  await writeRequiredAuditLog({
    actorLoginId: actorUsername,
    entityId: batchId,
    entityType: "sales_import_batch",
    newValues: { deleted: true },
    oldValues: {
      actorDisplayName,
      line: String(data.line),
      period: String(data.period),
    },
    summary: "Sales import deleted.",
  });

  invalidateExecutiveDashboardCache("sales import deleted", ["sales"]);
  return true;
}
