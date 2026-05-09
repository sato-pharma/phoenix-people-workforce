import { getSupabaseAdmin } from "@/lib/supabase/server";
import { getSalesPeopleLabels, linkSalesRecords, summarizeSalesLinkage } from "@/lib/sales/employees";
import { formatUnits } from "@/lib/sales/format";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { getSalesScope, normalizeHrId, normalizeLineName, resolveEmployeeIdentityId, type AccessContext, type BusinessScope } from "@/lib/auth/permissions";
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
type DbRow = Record<string, unknown>;
type SalesAccessFilter = {
  all: boolean;
  allowedHrIds: Set<string>;
  allowedLine?: string;
};

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

function buildManagerMap(directory: Awaited<ReturnType<typeof getEmployeeDirectory>>) {
  const managerMap = new Map<string, string[]>();
  directory.employees.forEach((employee) => {
    const managerId = normalizeHrId(employee.managerHrId);
    const employeeId = normalizeHrId(employee.hrId);
    if (!employeeId || !managerId) return;
    const list = managerMap.get(managerId) ?? [];
    list.push(employeeId);
    managerMap.set(managerId, list);
  });
  return managerMap;
}

function collectHierarchy(managerMap: Map<string, string[]>, rootHrId: string) {
  const allowedHrIds = new Set<string>();
  const queue: string[] = [rootHrId];
  while (queue.length > 0) {
    const managerId = queue.shift();
    if (!managerId) continue;
    for (const subordinateId of managerMap.get(managerId) ?? []) {
      if (!allowedHrIds.has(subordinateId)) {
        allowedHrIds.add(subordinateId);
        queue.push(subordinateId);
      }
    }
  }
  return allowedHrIds;
}

async function getPersistedSalesScopeOverride(accessContext: AccessContext): Promise<BusinessScope | null> {
  if (!accessContext.loginId) return null;

  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("app_auth_users")
    .select("sales_scope_override")
    .eq("login_id", accessContext.loginId)
    .maybeSingle();

  const raw = String((data as { sales_scope_override?: string | null } | null)?.sales_scope_override ?? "")
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

  const managerMap = buildManagerMap(directory);
  if (salesScope === "TEAM") {
    return { all: false, allowedHrIds: new Set(managerMap.get(currentHrId) ?? []) };
  }

  if (salesScope === "HIERARCHY") {
    return { all: false, allowedHrIds: collectHierarchy(managerMap, currentHrId) };
  }

  if (salesScope === "LINE" && viewer?.lineName) {
    const targetLine = normalizeLineName(viewer.lineName);
    const allowedHrIds = new Set<string>();
    directory.employees.forEach((employee) => {
      if (normalizeLineName(employee.lineName) === targetLine) {
        const employeeId = normalizeHrId(employee.hrId);
        if (employeeId) allowedHrIds.add(employeeId);
      }
    });
    return { all: false, allowedHrIds, allowedLine: targetLine };
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

    // 2. Check if the record is explicitly linked to an allowed employee
    const employeeHrId = normalizeHrId(record.employeeHrId);
    if (employeeHrId && accessFilter.allowedHrIds.has(employeeHrId)) return true;

    // 3. Check if the record is managed by an allowed manager (important for vacant areas)
    const managerHrId = normalizeHrId(record.managerHrId);
    if (managerHrId && accessFilter.allowedHrIds.has(managerHrId)) return true;

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
  const importedSalesValue = sum(records, (record) => record.salesValue);
  const importedTargetValue = sum(records, (record) => record.targetValue);
  const expectedSalesValue = sum(records, (record) =>
    Number.isFinite(record.salesUnits) && Number.isFinite(record.factoryPrice) && record.factoryPrice > 0
      ? record.salesUnits * record.factoryPrice
      : 0
  );
  const expectedTargetValue = sum(records, (record) =>
    Number.isFinite(record.targetUnits) && Number.isFinite(record.factoryPrice) && record.factoryPrice > 0
      ? record.targetUnits * record.factoryPrice
      : 0
  );

  return {
    importedSalesUnits,
    importedTargetUnits,
    importedSalesValue,
    importedTargetValue,
    expectedSalesValue,
    expectedTargetValue,
    salesValueVariance: importedSalesValue - expectedSalesValue,
    targetValueVariance: importedTargetValue - expectedTargetValue,
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
  return target > 0 ? sales / target : 0;
}

function sumTargetValues(items: ScopedRecord[]) {
  return sum(items, (item) => item.targetValue);
}

function aggregate<T>(items: T[], keyBuilder: (item: T) => string) {
  const map = new Map<string, T[]>();
  items.forEach((item) => {
    const key = keyBuilder(item) || "Unassigned";
    map.set(key, [...(map.get(key) ?? []), item]);
  });
  return map;
}

function countLinkedEmployees(records: ScopedRecord[]) {
  return new Set(records.map((record) => record.employeeHrId).filter(Boolean)).size;
}

function dmName(record: ScopedRecord) {
  return record.employeeLookupKey || record.employeeName || "Unassigned";
}

function managerKey(record: ScopedRecord) {
  return record.managerHrId ? `DSM [${record.managerHrId}]` : "Unassigned DSM";
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

function dashboardBatchSortValue(batch: SalesBatch) {
  const statusPriority: Record<string, number> = {
    approved: 3,
    validated: 2,
    needs_review: 1,
    staged: 0,
  };
  return [
    String(statusPriority[batch.status] ?? 0).padStart(2, "0"),
    batch.approvedAt ?? "",
    batch.createdAt,
    String(batch.version).padStart(6, "0"),
  ].join("|");
}

async function readAllSupabaseRows(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  table: string,
  options?: { select?: string; orderBy?: string; ascending?: boolean }
) {
  const pageSize = 1000;
  const rows: Array<Record<string, unknown>> = [];
  let from = 0;

  while (true) {
    let query = supabase.from(table).select(options?.select ?? "*");
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

async function readSalesData(options?: { batchId?: string; approvedOnly?: boolean; includeRecords?: boolean }) {
  const supabase = getSupabaseAdmin();
  const includeRecords = options?.includeRecords ?? true;

  let batchesQuery = supabase.from("sales_import_batches").select("*").order("created_at", { ascending: false });
  let recordsQuery = supabase.from("sales_records").select("*");

  if (options?.batchId) {
    batchesQuery = batchesQuery.eq("id", options.batchId);
    recordsQuery = recordsQuery.eq("batch_id", options.batchId);
  }

  if (options?.approvedOnly) {
    batchesQuery = batchesQuery.eq("status", "approved").is("replaced_by_batch_id", null);
  }

  const [batchResult, recordResult] = await Promise.all([
    options?.batchId ? batchesQuery : readAllSupabaseRows(supabase, "sales_import_batches", { orderBy: "created_at", ascending: false }),
    includeRecords ? (options?.batchId ? recordsQuery : readAllSupabaseRows(supabase, "sales_records")) : Promise.resolve({ data: [] as DbRow[] }),
  ]);

  const batchRows = (Array.isArray(batchResult) ? batchResult : toSafeArray(batchResult.data)) as DbRow[];
  const recordRows = (Array.isArray(recordResult) ? recordResult : toSafeArray(recordResult.data)) as DbRow[];

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
      previewUrl: `/sales/queue/${row.id}`,
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
  const groups = [...aggregate(records, (record) => `${record.product} Â· ${record.territory}`).entries()].map(
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
): Promise<SalesDashboardData> {
  const supabase = getSupabaseAdmin();

  // 1. Get active, non-replaced batches. The dashboard reflects the latest uploaded usable sheet.
  const { data: batchRows, error: batchError } = await supabase
    .from("sales_import_batches")
    .select("*")
    .is("replaced_by_batch_id", null);

  if (batchError) throw batchError;

  const batches: SalesBatch[] = toSafeArray(batchRows).map((row) => ({
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
    previewUrl: `/sales/queue/${row.id}`,
    approvalBlockedReason: null,
  }));

  const activeBatches = batches.filter((batch) => batch.status !== "rejected" && batch.status !== "replaced" && !batch.replacedByBatchId);
  const activeBatchIds = activeBatches.map((batch) => batch.id);

  if (activeBatchIds.length === 0) {
    // Return empty dashboard if no active batches
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

  // 2. Get every active record with pagination. Supabase's default select page is 1,000 rows,
  // and each monthly sales sheet can exceed that by itself.
  const allRecordRows = await readAllSupabaseRows(supabase, "sales_records");
  const activeBatchIdSet = new Set(activeBatchIds);

  let records: ScopedRecord[] = allRecordRows.filter((row) => activeBatchIdSet.has(String(row.batch_id))).map((row) => ({
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
  records = await filterSalesRecordsForAccess(records, accessContext);

  const activeBatchMap = new Map(activeBatches.map((batch) => [batch.id, batch] as const));
  const latestBatchByRecordPeriod = new Map<string, SalesBatch>();

  records.forEach((record) => {
    const batch = activeBatchMap.get(record.batchId);
    if (!batch || record.validationState === "failed") return;

    const key = `${batch.line || record.line}::${record.year}::${record.month}`;
    const current = latestBatchByRecordPeriod.get(key);
    if (!current || dashboardBatchSortValue(batch) > dashboardBatchSortValue(current)) {
      latestBatchByRecordPeriod.set(key, batch);
    }
  });

  const approvedRecords = records.flatMap((record) => {
    const batch = activeBatchMap.get(record.batchId);
    if (!batch) return [];
    if (record.validationState === "failed") return [];
    const key = `${batch.line || record.line}::${record.year}::${record.month}`;
    if (latestBatchByRecordPeriod.get(key)?.id !== batch.id) return [];
    return [{ ...record, line: batch.line || record.line }];
  });

  const productFilter = [...new Set([
    ...toFilterStringList(filters.product),
    ...toFilterStringList(filters.products),
  ].map(normalizeFilterToken).filter(Boolean))];

  const filteredRecords = approvedRecords.filter((record) => {

    if (filters.line && record.line !== filters.line) return false;
    if (filters.period && record.period !== filters.period) return false;
    if (filters.salesType && record.salesType !== filters.salesType) return false;
    if (filters.manager && managerKey(record) !== filters.manager) return false;
    if (filters.territory && record.territory !== filters.territory) return false;
    if (productFilter.length > 0 && !productFilter.includes(normalizeFilterToken(record.product))) return false;
    if (filters.family && record.family !== filters.family) return false;
    return true;
  });

  const totalSales = sum(filteredRecords, (record) => record.salesValue);
  const totalTarget = sumTargetValues(filteredRecords);
  const unitsSold = sum(filteredRecords, (record) => record.salesUnits);
  const periodGroups = aggregate(filteredRecords, (record) => record.period);
  const sortedPeriods = [...periodGroups.keys()].sort();
  const trend = sortedPeriods.map((period) => {
    const items = periodGroups.get(period) ?? [];
    const sales = sum(items, (item) => item.salesValue);
    const target = sumTargetValues(items);
    return { period, sales, target, achievementRate: performanceMetric(sales, target), linkedEmployees: countLinkedEmployees(items) };
  });

  const channelMix = [...aggregate(filteredRecords, (record) => record.salesType).entries()]
    .map(([name, items]) => ({ name, value: sum(items, (item) => item.salesValue) }))
    .sort((left, right) => right.value - left.value);

  const familyGroupsMap = aggregate(filteredRecords, (record) => record.family);
  const familyMatrix = [...familyGroupsMap.entries()].map(([name, items]) => {
    const sales = sum(items, (item) => item.salesValue);
    const target = sumTargetValues(items);
    const achievementRate = performanceMetric(sales, target);
    const status: "green" | "yellow" | "red" | "neutral" =
      target === 0 ? "neutral" : achievementRate >= 1 ? "green" : achievementRate >= 0.8 ? "yellow" : "red";
    return { name, sales, target, achievementRate, units: sum(items, (item) => item.salesUnits), status };
  });

  const productGroupsMap = aggregate(filteredRecords, (record) => record.product);
  const productPerformance = [...productGroupsMap.entries()]
    .map(([product, items]) => {
      const sales = sum(items, (item) => item.salesValue);
      // For products, we still sum all targets because targets are usually per-product
      // if they are listed on the product row. If they are per-employee, this will still double count
      // but there's no way to divide an employee target across products without more info.
      const target = sum(items, (item) => item.targetValue);
      return { product, family: items[0]?.family ?? "Unknown", sales, target, achievementRate: performanceMetric(sales, target) };
    })
    .sort((left, right) => right.sales - left.sales);

  const paretoData = pareto(
    productPerformance
      .slice(0, 20)
      .map((item) => ({ name: item.product, sales: item.sales })),
    totalSales,
  );

  const territoryPerformance = [...aggregate(filteredRecords, (record) => record.territory).entries()]
    .map(([name, items]) => {
      const sales = sum(items, (item) => item.salesValue);
      const target = sumTargetValues(items);
      return { name, sales, target, achievementRate: performanceMetric(sales, target) };
    })
    .sort((left, right) => right.sales - left.sales);

  const linePerformance = [...aggregate(filteredRecords, (record) => record.line).entries()]
    .map(([line, items]) => {
      const sales = sum(items, (item) => item.salesValue);
      const target = sumTargetValues(items);
      return { line, sales, target, achievementRate: performanceMetric(sales, target), linkedEmployees: countLinkedEmployees(items) };
    })
    .sort((left, right) => right.sales - left.sales);

  const peopleLabels = await getSalesPeopleLabels([
    ...filteredRecords.map((record) => record.managerHrId),
    ...filteredRecords.map((record) => record.employeeHrId),
  ]);

  const managerGroupsMap = aggregate(filteredRecords, (record) => personLabel(peopleLabels, record.managerHrId, managerKey(record)));
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
        achievementRate: performanceMetric(sales, target),
        line: items[0]?.line ?? "Unknown",
        topProduct: topProductEntry?.product ?? "Unknown",
        retailSales: sum(retailItems, (item) => item.salesValue),
        storesSales: sum(storesItems, (item) => item.salesValue),
      };
    })
    .sort((left, right) => right.sales - left.sales);

  const transactions = filteredRecords
    .map((record) => ({
      employeeHrId: record.employeeHrId ?? null,
      employeeName: record.employeeHrId
        ? personLabel(peopleLabels, record.employeeHrId, medicalRepKey(record))
        : null,
      employeeSourceName: dmName(record),
      linkStatus: record.linkStatus,
      managerHrId: record.managerHrId ?? null,
      managerName: personLabel(peopleLabels, record.managerHrId, managerKey(record)),
      line: record.line,
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
    }));

  const linkageStats = {
    linked: filteredRecords.filter((record) => record.linkStatus === "linked").length,
    unlinked: filteredRecords.filter((record) => record.linkStatus === "unlinked").length,
    ambiguous: filteredRecords.filter((record) => record.linkStatus === "ambiguous").length,
  };

  const openReviewBatches = batches.filter(
    (batch) => batch.status === "staged" || batch.status === "validated" || batch.status === "needs_review"
  ).length;

  const topManagerEntry = managerPerformance[0];
  const allProducts = new Set(filteredRecords.map((record) => record.product));
  const factoryPrices = filteredRecords.filter((record) => record.factoryPrice > 0).map((record) => record.factoryPrice);
  const avgFactoryPrice = factoryPrices.length > 0 ? factoryPrices.reduce((sum, price) => sum + price, 0) / factoryPrices.length : 0;
  const dashboardLinkage = await summarizeSalesLinkage(filteredRecords);
  const linkedCount = dashboardLinkage.dsmLinked;
  const linkageTotal = dashboardLinkage.dsmTotal;
  const qualityRate = linkageTotal > 0 ? linkedCount / linkageTotal : 1;

  const recentBatches = mapHistoryRows(batches, records).slice(0, 5);

  return {
    summary: {
      totalApprovedSales: totalSales,
      totalApprovedTarget: totalTarget,
      achievementRate: performanceMetric(totalSales, totalTarget),
      approvedRecords: filteredRecords.length,
      dsmLinkedRecords: linkedCount,
      dsmTotalRecords: linkageTotal,
      linkedRecords: linkedCount,
      linkedEmployees: countLinkedEmployees(filteredRecords),
      openReviewBatches,
      activeTargetRecords: 0,
      unitsSold,
      averageFactoryPrice: avgFactoryPrice,
      activeProducts: allProducts.size,
      topManager: topManagerEntry?.manager ?? "-",
      dataQualityRate: qualityRate,
    },
    filters: {
      lines: uniq(records.map((record) => record.line)),
      periods: uniq(records.map((record) => record.period)),
      salesTypes: uniq(records.map((record) => record.salesType)),
      managers: uniq(records.map((record) => managerKey(record))),
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
    recentBatches,
  };
}

export async function createSalesImport(payload: SalesImportPayload) {
  const supabase = getSupabaseAdmin();
  const linked = await linkSalesRecords(payload.records);
  const linkageBreakdown = await summarizeSalesLinkage(linked);
  const linkedCount = linkageBreakdown.dsmLinked;
  const linkageRate = linkageBreakdown.dsmTotal > 0 ? linkageBreakdown.dsmLinked / linkageBreakdown.dsmTotal : 0;
  const failedRecords = linked.filter((record) => record.validationState === "failed").length;

  const existingResult = await supabase
    .from("sales_import_batches")
    .select("id")
    .eq("duplicate_hash", payload.batch.duplicateHash)
    .maybeSingle();

  const isDuplicate = Boolean(existingResult.data);

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
    throw batchInsert.error;
  }

  if (linked.length > 0) {
    const recordInserts = linked.map((record) => ({
      batch_id: payload.batch.id,
      row_number: record.rowNumber,
      employee_hr_id: record.employeeHrId ?? null,
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

    for (let i = 0; i < recordInserts.length; i += 500) {
      const recordInsert = await supabase.from("sales_records").insert(recordInserts.slice(i, i + 500));
      if (recordInsert.error) {
        throw recordInsert.error;
      }
    }
  }

  return {
    ...payload.batch,
    linkedRecords: linkedCount,
    linkageRate,
    isDuplicate,
    canApprove: failedRecords === 0 && !isDuplicate,
    approvalBlockedReason: isDuplicate ? "This batch is a duplicate of an existing upload." : failedRecords > 0 ? "This batch contains failed rows." : null,
    previewUrl: `/sales/queue/${payload.batch.id}`,
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
  const updateData: Record<string, unknown> = { status, updated_at: new Date().toISOString() };

  if (status === "approved") {
    updateData.approved_by = actorUsername;
    updateData.approved_at = new Date().toISOString();
  } else if (status === "rejected") {
    updateData.rejected_by = actorUsername;
    updateData.rejected_at = new Date().toISOString();
  }

  const { data } = await supabase
    .from("sales_import_batches")
    .update(updateData)
    .eq("id", batchId)
    .select()
    .maybeSingle();

  if (!data) return null;

  await supabase.from("sales_audit_logs").insert({
    action: status === "approved" ? "import.approved" : "import.rejected",
    batch_id: batchId,
    actor_username: actorUsername,
    actor_display_name: actorDisplayName,
    line: String(data.line),
    period: String(data.period),
  });

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

  await supabase.from("sales_import_batches").update({ status: "replaced", replaced_by_batch_id: replacementId, updated_at: now }).eq("id", originalId);
  await supabase.from("sales_import_batches").update({ status: "approved", replacement_for_batch_id: originalId, approved_by: actorUsername, approved_at: now, updated_at: now }).eq("id", replacementId);

  await supabase.from("sales_audit_logs").insert({
    action: "import.replaced",
    batch_id: originalId,
    actor_username: actorUsername,
    actor_display_name: actorDisplayName,
    metadata: { replacementId },
  });

  return getSalesBatchDetail(replacementId);
}

export async function deleteSalesBatch(batchId: string, actorUsername: string, actorDisplayName: string) {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase.from("sales_import_batches").select("line, period").eq("id", batchId).maybeSingle();
  if (!data) return null;

  await supabase.from("sales_import_batches").delete().eq("id", batchId);
  await supabase.from("sales_audit_logs").insert({
    action: "import.deleted",
    batch_id: batchId,
    actor_username: actorUsername,
    actor_display_name: actorDisplayName,
    line: String(data.line),
    period: String(data.period),
  });

  return true;
}
