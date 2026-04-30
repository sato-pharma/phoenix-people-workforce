import { getSupabaseAdmin } from "@/lib/supabase/server";
import { linkSalesRecords, linkTargetRecords } from "@/lib/sales/employees";
import { formatUnits } from "@/lib/sales/format";
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
  type TargetBatch,
  type TargetRecord,
  type TargetUploadPayload,
} from "@/lib/sales/types";

type ScopedRecord = SalesRecordInput & { batchId: string; period: string };

function toSafeArray<T>(value: T[] | null | undefined) {
  return Array.isArray(value) ? value : [];
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
        approvedTargetValue: sum(approvedRecords, (record) => record.targetValue),
      };
    });
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

function approvedBatchSortValue(batch: SalesBatch) {
  return [batch.approvedAt ?? "", batch.createdAt, String(batch.version).padStart(6, "0")].join("|");
}

function latestApprovedBatchesByPeriod(batches: SalesBatch[]) {
  const latest = new Map<string, SalesBatch>();
  batches
    .filter((batch) => batch.status === "approved" && !batch.replacedByBatchId)
    .forEach((batch) => {
      const key = `${batch.line}::${batch.year}::${batch.month}`;
      const current = latest.get(key);
      if (!current || approvedBatchSortValue(batch) > approvedBatchSortValue(current)) {
        latest.set(key, batch);
      }
    });
  return [...latest.values()];
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

async function readSalesData() {
  const supabase = getSupabaseAdmin();

  const [batchRows, recordRows, targetBatchRows, targetRecordRows] = await Promise.all([
    readAllSupabaseRows(supabase, "sales_import_batches", { orderBy: "created_at", ascending: false }),
    readAllSupabaseRows(supabase, "sales_records"),
    readAllSupabaseRows(supabase, "sales_target_batches", { orderBy: "created_at", ascending: false }),
    readAllSupabaseRows(supabase, "sales_targets"),
  ]);

  const batches = batchRows.map((row) => {
    const batch: SalesBatch = {
      id: String(row.id),
      fileName: String(row.file_name),
      line: String(row.line),
      month: Number(row.month),
      year: Number(row.year),
      period: String(row.period),
      status: String(row.status) as SalesBatch["status"],
      schemaType: (row.schema_type as SalesBatch["schemaType"]) || "raw_sales",
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

  const targetBatches = targetBatchRows.map((row) => ({
    id: String(row.id),
    fileName: String(row.file_name),
    month: Number(row.month),
    year: Number(row.year),
    status: row.status as TargetBatch["status"],
    totalRecords: Number(row.total_records ?? 0),
    validRecords: Number(row.valid_records ?? 0),
    failedRecords: Number(row.failed_records ?? 0),
    createdAt: new Date(String(row.created_at)).toISOString(),
  }));

  const targetRecords = targetRecordRows.map((row) => ({
    id: String(row.id),
    batchId: String(row.batch_id),
    employeeHrId: row.employee_hr_id ? String(row.employee_hr_id) : null,
    employeeCrmId: row.employee_crm_id ? String(row.employee_crm_id) : null,
    employeeLookupKey: row.employee_lookup_key ? String(row.employee_lookup_key) : null,
    employeeName: row.employee_name ? String(row.employee_name) : null,
    line: String(row.line),
    month: Number(row.month),
    year: Number(row.year),
    targetUnits: Number(row.target_units ?? 0),
    targetValue: Number(row.target_value ?? 0),
    status: row.status as TargetRecord["status"],
    validationNotes: Array.isArray(row.validation_notes) ? row.validation_notes.map(String) : [],
    createdAt: new Date(String(row.created_at)).toISOString(),
  }));

  return { batches, records, targetBatches, targetRecords };
}

export async function listSalesHistory() {
  const { batches, records } = await readSalesData();
  return mapHistoryRows(batches, records);
}

export async function listSalesQueue() {
  const history = await listSalesHistory();
  return history.filter(
    (batch) => batch.status === "staged" || batch.status === "validated" || batch.status === "needs_review"
  );
}

export async function getSalesBatchDetail(id: string): Promise<SalesBatchDetail | null> {
  const { batches, records } = await readSalesData();
  const history = mapHistoryRows(batches, records);
  const batch = history.find((item) => item.id === id);
  if (!batch) return null;
  const batchRecords = records.filter((record) => record.batchId === id);

  return {
    ...batch,
    records: batchRecords,
    issues: extractIssues(batches.filter((item) => item.id === id), batchRecords),
    replacementChain: chainForBatch(history, id),
    reconciliation: buildBatchReconciliation(batchRecords),
  };
}

export async function listTargetBatches() {
  const { targetBatches } = await readSalesData();
  return targetBatches.slice().sort((left, right) => right.createdAt.localeCompare(left.createdAt));
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

export async function getSalesDashboard(filters: SalesDashboardFilters = {}): Promise<SalesDashboardData> {
  const { batches, records } = await readSalesData();
  const dashboardBatches = latestApprovedBatchesByPeriod(batches);
  const approvedBatchMap = new Map(dashboardBatches.map((batch) => [batch.id, batch] as const));
  const approvedRecords = records.flatMap((record) => {
    const batch = approvedBatchMap.get(record.batchId);
    if (!batch) return [];
    return [{ ...record, line: batch.line || record.line, month: batch.month || record.month, year: batch.year || record.year, period: batch.period || record.period }];
  });

  const filteredRecords = approvedRecords.filter((record) => {
    if (filters.line && record.line !== filters.line) return false;
    if (filters.period && record.period !== filters.period) return false;
    if (filters.salesType && record.salesType !== filters.salesType) return false;
    if (filters.manager && dmName(record) !== filters.manager) return false;
    if (filters.territory && record.territory !== filters.territory) return false;
    if (filters.product && record.product !== filters.product) return false;
    if (filters.family && record.family !== filters.family) return false;
    return true;
  });

  const totalSales = sum(filteredRecords, (record) => record.salesValue);
  const totalTarget = sum(filteredRecords, (record) => record.targetValue);
  const unitsSold = sum(filteredRecords, (record) => record.salesUnits);
  const linkedCount = filteredRecords.filter((record) => record.linkStatus === "linked").length;

  const periodGroups = aggregate(filteredRecords, (record) => record.period);
  const sortedPeriods = [...periodGroups.keys()].sort();
  const trend = sortedPeriods.map((period) => {
    const items = periodGroups.get(period) ?? [];
    const sales = sum(items, (item) => item.salesValue);
    const target = sum(items, (item) => item.targetValue);
    return { period, sales, target, achievementRate: performanceMetric(sales, target), linkedEmployees: countLinkedEmployees(items) };
  });

  const channelMix = [...aggregate(filteredRecords, (record) => record.salesType).entries()]
    .map(([name, items]) => ({ name, value: sum(items, (item) => item.salesValue) }))
    .sort((left, right) => right.value - left.value);

  const familyGroupsMap = aggregate(filteredRecords, (record) => record.family);
  const familyMatrix = [...familyGroupsMap.entries()].map(([name, items]) => {
    const sales = sum(items, (item) => item.salesValue);
    const target = sum(items, (item) => item.targetValue);
    const achievementRate = performanceMetric(sales, target);
    const status: "green" | "yellow" | "red" | "neutral" =
      target === 0 ? "neutral" : achievementRate >= 1 ? "green" : achievementRate >= 0.8 ? "yellow" : "red";
    return { name, sales, target, achievementRate, units: sum(items, (item) => item.salesUnits), status };
  });

  const productGroupsMap = aggregate(filteredRecords, (record) => record.product);
  const productPerformance = [...productGroupsMap.entries()]
    .map(([product, items]) => {
      const sales = sum(items, (item) => item.salesValue);
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
      const target = sum(items, (item) => item.targetValue);
      return { name, sales, target, achievementRate: performanceMetric(sales, target) };
    })
    .sort((left, right) => right.sales - left.sales);

  const linePerformance = [...aggregate(filteredRecords, (record) => record.line).entries()]
    .map(([line, items]) => {
      const sales = sum(items, (item) => item.salesValue);
      const target = sum(items, (item) => item.targetValue);
      return { line, sales, target, achievementRate: performanceMetric(sales, target), linkedEmployees: countLinkedEmployees(items) };
    })
    .sort((left, right) => right.sales - left.sales);

  const managerGroupsMap = aggregate(filteredRecords, (record) => dmName(record));
  const managerPerformance = [...managerGroupsMap.entries()]
    .filter(([name]) => name !== "Unassigned")
    .map(([manager, items]) => {
      const sales = sum(items, (item) => item.salesValue);
      const target = sum(items, (item) => item.targetValue);
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
    .slice(0, 200)
    .map((record) => ({
      employeeName: dmName(record),
      line: record.line,
      territory: record.territory,
      salesType: record.salesType,
      family: record.family,
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
  const qualityRate = filteredRecords.length > 0 ? linkedCount / filteredRecords.length : 1;

  const recentBatches = mapHistoryRows(batches, records).slice(0, 5);

  return {
    summary: {
      totalApprovedSales: totalSales,
      totalApprovedTarget: totalTarget,
      achievementRate: performanceMetric(totalSales, totalTarget),
      approvedRecords: filteredRecords.length,
      linkedRecords: linkedCount,
      linkedEmployees: countLinkedEmployees(filteredRecords),
      openReviewBatches,
      activeTargetRecords: 0,
      unitsSold,
      averageFactoryPrice: avgFactoryPrice,
      activeProducts: allProducts.size,
      topManager: topManagerEntry?.manager ?? "â€”",
      dataQualityRate: qualityRate,
    },
    filters: {
      lines: uniq(records.map((record) => record.line)),
      periods: uniq(records.map((record) => record.period)),
      salesTypes: uniq(records.map((record) => record.salesType)),
      managers: uniq(records.map((record) => dmName(record))),
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
  const linkedCount = linked.filter((record) => record.linkStatus === "linked").length;
  const linkageRate = linked.length > 0 ? linkedCount / linked.length : 0;
  const failedRecords = linked.filter((record) => record.validationState === "failed").length;

  const existingResult = await supabase
    .from("sales_import_batches")
    .select("id")
    .eq("duplicate_hash", payload.batch.duplicateHash)
    .maybeSingle();

  const isDuplicate = Boolean(existingResult.data);

  await supabase.from("sales_import_batches").insert({
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

  if (linked.length > 0) {
    const recordInserts = linked.map((record) => ({
      batch_id: payload.batch.id,
      row_number: record.rowNumber,
      employee_hr_id: record.employeeHrId ?? null,
      employee_crm_id: record.employeeCrmId ?? null,
      employee_lookup_key: record.employeeLookupKey ?? null,
      employee_name: record.employeeName ?? null,
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
      await supabase.from("sales_records").insert(recordInserts.slice(i, i + 500));
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
  };
}

export async function createTargetBatch(payload: TargetUploadPayload) {
  const supabase = getSupabaseAdmin();
  const linked = await linkTargetRecords(payload.records);
  const failedCount = linked.filter((record) => record.status === "failed").length;

  await supabase.from("sales_target_batches").insert({
    id: payload.batch.id,
    file_name: payload.batch.fileName,
    month: payload.batch.month,
    year: payload.batch.year,
    status: failedCount > 0 ? "uploaded" : "validated",
    total_records: linked.length,
    valid_records: linked.filter((record) => record.status === "valid").length,
    failed_records: failedCount,
  });

  if (linked.length > 0) {
    const inserts = linked.map((record) => ({
      batch_id: payload.batch.id,
      employee_hr_id: record.employeeHrId ?? null,
      employee_crm_id: record.employeeCrmId ?? null,
      employee_lookup_key: record.employeeLookupKey ?? null,
      employee_name: record.employeeName ?? null,
      line: record.line,
      month: record.month,
      year: record.year,
      target_units: record.targetUnits,
      target_value: record.targetValue,
      status: record.status,
      validation_notes: record.validationNotes,
    }));

    for (let i = 0; i < inserts.length; i += 500) {
      await supabase.from("sales_targets").insert(inserts.slice(i, i + 500));
    }
  }

  return {
    ...payload.batch,
    failedRecords: failedCount,
    blockingReasons: [],
    topFailureReasons: [],
    topWarningReasons: [],
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
