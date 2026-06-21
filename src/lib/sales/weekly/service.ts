import { normalizeRole } from "@/lib/auth/permissions";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { canonicalHrIdForDisplay, canonicalHrIdKey } from "@/lib/hr-id";
import { loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import {
  applyWeeklyAccessScope,
  listWeeklyProductScopeAssignments,
  type WeeklyAccessScope,
} from "@/lib/sales/weekly/access";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { loadBranchRegionIndex } from "@/lib/sales/weekly/branch-region-map";
import {
  WEEKLY_DISTRIBUTORS,
  canonicalWeeklyDistributorCode,
  weeklyDistributorByCode,
} from "@/lib/sales/weekly/distributors";
import { parseWeeklyWorkbookBuffer } from "@/lib/sales/weekly/parser";
import { resolveWeeklyContractWithSource } from "@/lib/sales/weekly/weekly-column-profile-store";
import { loadProductAliasIndex } from "@/lib/sales/weekly/product-aliases";
import { weeklyTemplateDistributorFallbackName } from "@/lib/sales/weekly/templates";
import type {
  WeeklyBatch,
  WeeklyBranchComparisonRow,
  WeeklyDashboard,
  WeeklyDelta,
  WeeklyDistributorOption,
  WeeklyFilterMode,
  WeeklyMissingProduct,
  WeeklyParsedRow,
  WeeklyProductScopeAdmin,
  WeeklyRanked,
  WeeklySalesValidationResult,
} from "@/lib/sales/weekly/types";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// ── distributor dropdown (only distributors with a registered weekly template) ─────────────────

export async function listWeeklyDistributors(): Promise<WeeklyDistributorOption[]> {
  // The canonical distributor registry (distributors.ts) is the single source of truth for which
  // distributors the weekly module ingests — not the old header-template helpers. We still prefer
  // the master reference's display name when one exists, falling back to the registry name.
  const references = await loadSalesReferenceData({ includeCustomerBricks: false }).catch(() => null);
  const masterNameByCode = new Map<string, string>();
  for (const distributor of references?.distributors ?? []) {
    masterNameByCode.set(distributor.code.toUpperCase(), distributor.name);
  }
  return WEEKLY_DISTRIBUTORS.map((distributor) => ({
    code: distributor.code,
    name:
      masterNameByCode.get(distributor.code.toUpperCase()) ??
      distributor.name ??
      weeklyTemplateDistributorFallbackName(distributor.code) ??
      distributor.code,
  })).sort((left, right) => left.name.localeCompare(right.name));
}

// ── upload → validate → store ──────────────────────────────────────────────────────────────────

export async function importWeeklySalesFile(input: {
  distributorCode: string;
  /** combined / single workbook (everyone except PS). Kept for the existing single-file API. */
  file?: File;
  /** PS two-file form: sales matrix file */
  salesFile?: File;
  /** PS two-file form: stock matrix file */
  stockFile?: File;
  uploadedBy: string;
  /** explicit period (YYYY-MM-DD) for undated / multi-dated files */
  periodDate?: string | null;
  /** when true, parse + validate but never persist — used by the validate-only step */
  dryRun?: boolean;
}): Promise<WeeklySalesValidationResult> {
  const rawCode = (input.distributorCode ?? "").trim();
  if (!rawCode) throw new SalesWorkflowError("invalid_request", "Pick a distributor before uploading.", 400);

  let distributorCode: string;
  try {
    distributorCode = canonicalWeeklyDistributorCode(rawCode);
  } catch {
    throw new SalesWorkflowError("unsupported_template", `Unknown weekly distributor "${rawCode}".`, 422);
  }

  const references = await loadSalesReferenceData({ includeCustomerBricks: false });
  const distributorName =
    references.distributors.find((row) => row.code.toUpperCase() === distributorCode.toUpperCase())?.name ??
    weeklyDistributorByCode(distributorCode)?.name ??
    distributorCode;

  const [aliasIndex, branchMapIndex, resolved] = await Promise.all([
    loadProductAliasIndex(),
    loadBranchRegionIndex(distributorCode),
    resolveWeeklyContractWithSource(distributorCode),
  ]);
  const { contract, source: contractSource } = resolved;

  // PS ships a separate sales + stock matrix; everyone else ships one combined workbook.
  const isPS = distributorCode === "PS";
  const fileNameParts: string[] = [];
  const buffer = input.file ? await input.file.arrayBuffer() : undefined;
  const salesBuffer = input.salesFile ? await input.salesFile.arrayBuffer() : isPS ? buffer : undefined;
  const stockBuffer = input.stockFile ? await input.stockFile.arrayBuffer() : undefined;
  if (input.file) fileNameParts.push(input.file.name);
  if (input.salesFile) fileNameParts.push(input.salesFile.name);
  if (input.stockFile) fileNameParts.push(input.stockFile.name);
  const fileName = fileNameParts.join(" + ") || `${distributorCode}.xlsx`;

  const parsed = await parseWeeklyWorkbookBuffer({
    buffer: isPS ? undefined : buffer,
    salesBuffer: isPS ? salesBuffer : undefined,
    stockBuffer: isPS ? stockBuffer : undefined,
    distributorCode,
    distributorName,
    fileName,
    references,
    aliasIndex,
    branchMapIndex,
    periodDate: input.periodDate ?? null,
    contract,
  });

  if (!parsed.ok) {
    const status = parsed.error.code === "unsupported_template" ? 422 : 400;
    throw new SalesWorkflowError(parsed.error.code, parsed.error.message, status);
  }
  // Stamp which column contract parsed this batch (built-in vs in-app override) for traceability.
  parsed.result.contractSource = contractSource;

  // Only persist a clean (validated) batch; blocked files are returned for the user to fix.
  // dryRun=true skips persistence so the validate step can show tables without storing anything.
  if (!input.dryRun && parsed.result.status === "validated") {
    const { batchId, createdAt } = await persistWeeklyUpload(parsed.rows, parsed.result, input.uploadedBy);
    return { ...parsed.result, batchId, createdAt };
  }
  return parsed.result;
}

async function persistWeeklyUpload(
  rows: WeeklyParsedRow[],
  result: WeeklySalesValidationResult,
  uploadedBy: string,
): Promise<{ batchId: string; createdAt: string }> {
  const supabase = getSupabaseAdmin();

  // Duplicate guard: one validated batch per distributor per week (also enforced by a partial unique
  // index, but checked here for a friendly 409 instead of a raw constraint error).
  if (result.weekStart) {
    const existing = await supabase
      .from("weekly_sales_batches")
      .select("id")
      .eq("distributor_code", result.distributor.code)
      .eq("week_start", result.weekStart)
      .eq("status", "validated")
      .limit(1);
    if (!existing.error && (existing.data?.length ?? 0) > 0) {
      throw new SalesWorkflowError(
        "duplicate_week",
        `A validated upload already exists for ${result.distributor.name} — week of ${result.weekStart}. Delete it first to re-upload.`,
        409,
      );
    }
  }

  const batchInsert = await supabase
    .from("weekly_sales_batches")
    .insert({
      distributor_code: result.distributor.code,
      distributor_name: result.distributor.name,
      template_key: result.templateKey,
      file_name: result.fileName,
      sheet_name: result.sheetName,
      week_start: result.weekStart,
      status: result.status,
      total_rows: result.rowCount,
      importable_rows: result.importableRows,
      failed_rows: result.failedRows,
      warning_rows: result.warningRows,
      total_sales_qty: result.totals.salesQty,
      total_return_qty: result.totals.returnQty,
      total_net_qty: result.totals.netQty,
      total_bonus_qty: 0,
      total_sales_value: result.totals.salesValue,
      total_stock_qty: result.totals.stockQty,
      blocking_reasons: result.blockingReasons,
      uploaded_by: uploadedBy,
      column_contract_source: result.contractSource ?? "code",
    })
    .select("id, created_at")
    .single();
  if (batchInsert.error || !batchInsert.data) {
    throw new SalesWorkflowError("persist_failed", batchInsert.error?.message ?? "Could not save the weekly batch.", 500);
  }
  const batchId = String(batchInsert.data.id);

  const rowsPayload = rows.map((row) => ({
    batch_id: batchId,
    row_number: row.rowNumber,
    week_start: row.weekStart,
    distributor_code: row.distributorCode,
    distributor_name: row.distributorName,
    region_code: row.regionCode,
    region_name: row.regionName,
    branch_code: row.branchCode,
    branch_name: row.branchName,
    item_code: row.itemCode,
    product_code: row.productCode,
    product_name: row.productName,
    official_line: row.officialLine,
    sales_qty: row.salesQty,
    return_qty: row.returnQty,
    net_qty: row.netQty,
    bonus_qty: 0,
    sales_value: row.salesValue,
    stock_qty: row.stockQty,
    validation_state: row.validationState,
    validation_issues: row.validationIssues,
    raw_row: row.rawRow,
  }));
  // Insert in chunks to stay under PostgREST payload limits.
  const chunkSize = 500;
  for (let i = 0; i < rowsPayload.length; i += chunkSize) {
    const chunk = rowsPayload.slice(i, i + chunkSize);
    const insert = await supabase.from("weekly_sales_rows").insert(chunk);
    if (insert.error) {
      // Roll back the header so a partial batch never lingers.
      await supabase.from("weekly_sales_batches").delete().eq("id", batchId);
      throw new SalesWorkflowError("persist_failed", insert.error.message, 500);
    }
  }

  return { batchId, createdAt: String(batchInsert.data.created_at) };
}

// ── missing product resolution ────────────────────────────────────────────────────────────────

export async function loadWeeklyMissingProducts(): Promise<WeeklyMissingProduct[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("weekly_sales_rows")
    .select("distributor_code, distributor_name, item_code, product_name, batch_id, stock_qty, week_start, validation_issues")
    .eq("validation_state", "warning");
  if (error) throw new SalesWorkflowError("load_failed", error.message, 500);

  // Keep only rows whose warning is specifically an unresolved product code.
  type RowShape = { distributor_code: string; distributor_name: string; item_code: string; product_name: string; batch_id: string; stock_qty: number; week_start: string | null; validation_issues: { field: string }[] };
  const productWarnings = (data as RowShape[]).filter((row) =>
    (row.validation_issues ?? []).some((i) => i.field === "productCode"),
  );

  // Aggregate in-memory by (distributor_code, item_code).
  const map = new Map<string, WeeklyMissingProduct>();
  for (const row of productWarnings) {
    const key = `${row.distributor_code}||${row.item_code}`;
    const entry = map.get(key) ?? {
      distributorCode: row.distributor_code,
      distributorName: row.distributor_name,
      itemCode: row.item_code,
      itemName: row.product_name,
      rowCount: 0,
      batchCount: 0,
      totalStock: 0,
      earliestWeek: null,
      latestWeek: null,
      _batchIds: new Set<string>(),
    } as WeeklyMissingProduct & { _batchIds: Set<string> };

    entry.rowCount += 1;
    entry.totalStock += Number(row.stock_qty ?? 0);
    if (row.batch_id) (entry as unknown as { _batchIds: Set<string> })._batchIds.add(row.batch_id);
    if (row.week_start) {
      if (!entry.earliestWeek || row.week_start < entry.earliestWeek) entry.earliestWeek = row.week_start;
      if (!entry.latestWeek || row.week_start > entry.latestWeek) entry.latestWeek = row.week_start;
    }
    map.set(key, entry);
  }

  return [...map.values()].map((entry) => {
    const { _batchIds, ...rest } = entry as WeeklyMissingProduct & { _batchIds: Set<string> };
    return { ...rest, batchCount: _batchIds.size };
  }).sort((a, b) => a.distributorCode.localeCompare(b.distributorCode) || b.totalStock - a.totalStock);
}

// ── upload history ───────────────────────────────────────────────────────────────────────────

export async function listWeeklyBatches(limit = 100): Promise<WeeklyBatch[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("weekly_sales_batches")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new SalesWorkflowError("load_failed", error.message, 500);
  return (data ?? []).map(mapBatch);
}

export async function deleteWeeklyBatch(batchId: string): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("weekly_sales_batches").delete().eq("id", batchId);
  if (error) throw new SalesWorkflowError("delete_failed", error.message, 500);
  return true;
}

function mapBatch(row: Record<string, unknown>): WeeklyBatch {
  return {
    id: String(row.id),
    distributorCode: String(row.distributor_code ?? ""),
    distributorName: String(row.distributor_name ?? ""),
    templateKey: String(row.template_key ?? ""),
    fileName: String(row.file_name ?? ""),
    sheetName: String(row.sheet_name ?? ""),
    weekStart: row.week_start ? String(row.week_start) : null,
    status: (row.status === "validated" ? "validated" : "blocked") as "validated" | "blocked",
    totalRows: Number(row.total_rows ?? 0),
    importableRows: Number(row.importable_rows ?? 0),
    failedRows: Number(row.failed_rows ?? 0),
    warningRows: Number(row.warning_rows ?? 0),
    totalSalesQty: Number(row.total_sales_qty ?? 0),
    totalReturnQty: Number(row.total_return_qty ?? 0),
    totalNetQty: Number(row.total_net_qty ?? row.total_sales_qty ?? 0),
    totalBonusQty: Number(row.total_bonus_qty ?? 0),
    totalSalesValue: Number(row.total_sales_value ?? 0),
    totalStockQty: Number(row.total_stock_qty ?? 0),
    blockingReasons: Array.isArray(row.blocking_reasons) ? (row.blocking_reasons as string[]) : [],
    uploadedBy: row.uploaded_by ? String(row.uploaded_by) : null,
    columnContractSource: row.column_contract_source === "override" ? "override" : "code",
    createdAt: String(row.created_at ?? ""),
  };
}

// ── dashboard ──────────────────────────────────────────────────────────────────────────────────

type FactRow = {
  weekStart: string;
  distributorCode: string;
  distributorName: string;
  regionCode: string;
  regionName: string;
  branchCode: string;
  branchName: string;
  productCode: string;
  productName: string;
  officialLine: string;
  salesValue: number;
  /** gross sales units (audit) */
  salesQty: number;
  /** net units = gross - returns; this is what the dashboard reports as "units" */
  netQty: number;
  stockQty: number;
};

const delta = (current: number, prior: number | null): WeeklyDelta => ({
  current: Number(current.toFixed(2)),
  prior: prior == null ? null : Number(prior.toFixed(2)),
  pct: prior == null || prior === 0 ? null : Number(((current - prior) / prior).toFixed(4)),
});

const normalizeCode = (value: string | null | undefined) => (value ?? "").trim().toUpperCase();
const normalizeText = (value: string | null | undefined) => (value ?? "").trim();
const normalizeComparableLine = (value: string | null | undefined) => normalizeText(value).toUpperCase();

const normalizeWeekList = (values?: string[] | null): string[] => {
  if (!values || values.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const split = normalizeText(raw).split(",");
    for (const week of split) {
      const value = normalizeText(week);
      if (!value || seen.has(value)) continue;
      seen.add(value);
      out.push(value);
    }
  }
  return out;
};

// A resolved multi-value filter. `set` holds normalized codes; `mode` decides include/exclude;
// `has` is the empty-set guard (empty = "all" in BOTH modes); `single` mirrors the legacy single
// field (populated only for a single-code include, so back-compat readers/exports keep working).
type ResolvedMultiFilter = { set: Set<string>; mode: WeeklyFilterMode; has: boolean; single: string | null };

function resolveMultiFilter(
  codes: string[] | null | undefined,
  legacy: string | null | undefined,
  mode: WeeklyFilterMode | null | undefined,
  normalize: (value: string | null | undefined) => string,
): ResolvedMultiFilter {
  const raw = codes && codes.length ? codes : legacy ? [legacy] : [];
  const set = new Set(raw.map((value) => normalize(value)).filter(Boolean));
  const resolvedMode: WeeklyFilterMode = mode === "exclude" ? "exclude" : "include";
  const single = resolvedMode === "include" && set.size === 1 ? [...set][0] : null;
  return { set, mode: resolvedMode, has: set.size > 0, single };
}

// Row passes the filter when: no filter (empty set), or membership matches the mode.
function passesMultiFilter(filter: ResolvedMultiFilter, value: string): boolean {
  if (!filter.has) return true;
  const inSet = filter.set.has(value);
  return filter.mode === "include" ? inSet : !inSet;
}

function rank(rows: FactRow[], keyOf: (row: FactRow) => string, nameOf: (row: FactRow) => string): WeeklyRanked[] {
  const groups = new Map<string, { name: string; salesValue: number; salesUnits: number; stockUnits: number }>();
  let totalValue = 0;
  for (const row of rows) {
    totalValue += row.salesValue;
    const key = keyOf(row);
    // No-group-key rows (e.g. branchless stock fallbacks) stay in the KPI totals and the by-product
    // table but must not form a phantom "—" region/distributor bucket.
    if (!key) continue;
    const current = groups.get(key) ?? { name: nameOf(row) || key, salesValue: 0, salesUnits: 0, stockUnits: 0 };
    current.salesValue += row.salesValue;
    current.salesUnits += row.netQty;
    current.stockUnits += row.stockQty;
    groups.set(key, current);
  }
  return [...groups.entries()]
    .map(([code, group]) => ({
      code,
      name: group.name,
      salesValue: Number(group.salesValue.toFixed(2)),
      salesUnits: Number(group.salesUnits.toFixed(2)),
      stockUnits: Number(group.stockUnits.toFixed(2)),
      share: totalValue > 0 ? Number((group.salesValue / totalValue).toFixed(4)) : 0,
    }))
    .sort((left, right) => right.salesValue - left.salesValue || left.name.localeCompare(right.name));
}

function rankBranches(rows: FactRow[]): WeeklyBranchComparisonRow[] {
  const groups = new Map<
    string,
    { name: string; regionName: string; salesValue: number; salesUnits: number; stockUnits: number }
  >();
  let totalValue = 0;
  for (const row of rows) {
    totalValue += row.salesValue;
    const key = row.branchCode || row.branchName;
    // Branchless rows stay in totals + by-product, never a phantom "-" branch.
    if (!key) continue;
    const current = groups.get(key) ?? {
      name: row.branchName || key,
      regionName: row.regionName || "-",
      salesValue: 0,
      salesUnits: 0,
      stockUnits: 0,
    };
    current.salesValue += row.salesValue;
    current.salesUnits += row.netQty;
    current.stockUnits += row.stockQty;
    if (!current.regionName || current.regionName === "-") current.regionName = row.regionName || "-";
    groups.set(key, current);
  }
  return [...groups.entries()]
    .map(([code, group]) => ({
      code,
      name: group.name,
      regionName: group.regionName,
      salesValue: Number(group.salesValue.toFixed(2)),
      salesUnits: Number(group.salesUnits.toFixed(2)),
      stockUnits: Number(group.stockUnits.toFixed(2)),
      share: totalValue > 0 ? Number((group.salesValue / totalValue).toFixed(4)) : 0,
    }))
    .sort(
      (left, right) =>
        right.salesValue - left.salesValue ||
        right.stockUnits - left.stockUnits ||
        left.name.localeCompare(right.name),
    );
}

export async function loadWeeklyDashboard(filters?: {
  weekStart?: string | null;
  weekStarts?: string[] | null;
  allWeeks?: boolean;
  /** Legacy single-value filters (still accepted; mapped to a single-code include). */
  distributorCode?: string | null;
  regionCode?: string | null;
  productCode?: string | null;
  line?: string | null;
  /** Multi-value filters + include/exclude mode. Empty array = "all". */
  distributorCodes?: string[] | null;
  distributorFilterMode?: WeeklyFilterMode | null;
  regionCodes?: string[] | null;
  regionFilterMode?: WeeklyFilterMode | null;
  productCodes?: string[] | null;
  productFilterMode?: WeeklyFilterMode | null;
  lineCodes?: string[] | null;
  lineFilterMode?: WeeklyFilterMode | null;
  /** Per-viewer visibility tier (full / product / territory / none). Defaults to full access. */
  accessScope?: WeeklyAccessScope;
}): Promise<WeeklyDashboard> {
  const supabase = getSupabaseAdmin();

  // Validated batches only — blocked uploads never feed the dashboard.
  const batchesResult = await supabase
    .from("weekly_sales_batches")
    .select("id, week_start, distributor_code, distributor_name")
    .eq("status", "validated");
  if (batchesResult.error) throw new SalesWorkflowError("load_failed", batchesResult.error.message, 500);
  const batches = batchesResult.data ?? [];

  const availableWeeks = [...new Set(batches.map((batch) => String(batch.week_start)).filter(Boolean))].sort(
    (left, right) => right.localeCompare(left),
  );
  const availableWeekSet = new Set(availableWeeks);
  const distributors: WeeklyDistributorOption[] = [
    ...new Map(batches.map((batch) => [String(batch.distributor_code), String(batch.distributor_name)])).entries(),
  ]
    .map(([code, name]) => ({ code, name }))
    .sort((left, right) => left.name.localeCompare(right.name));

  const distributor = resolveMultiFilter(
    filters?.distributorCodes,
    filters?.distributorCode,
    filters?.distributorFilterMode,
    normalizeCode,
  );
  const region = resolveMultiFilter(filters?.regionCodes, filters?.regionCode, filters?.regionFilterMode, normalizeCode);
  const product = resolveMultiFilter(filters?.productCodes, filters?.productCode, filters?.productFilterMode, normalizeCode);
  const line = resolveMultiFilter(filters?.lineCodes, filters?.line, filters?.lineFilterMode, normalizeComparableLine);
  const requestedWeekSet = new Set(normalizeWeekList(filters?.weekStarts).filter((week) => availableWeekSet.has(week)));
  const requestedWeeks = availableWeeks.filter((week) => requestedWeekSet.has(week));
  const allWeeksRequested = filters?.allWeeks === true;
  const requestedSingleWeek = normalizeText(filters?.weekStart);
  const selectedWeeks = allWeeksRequested
    ? [...availableWeeks]
    : requestedWeeks.length > 0
      ? requestedWeeks
      : requestedSingleWeek && availableWeekSet.has(requestedSingleWeek)
        ? [requestedSingleWeek]
        : availableWeeks.length > 0
          ? [availableWeeks[0]]
          : [];
  const priorWeek = selectedWeeks.length > 0 ? availableWeeks.find((week) => week < selectedWeeks[0]) ?? null : null;
  const selectedWeekAnchor = selectedWeeks.length > 0 ? selectedWeeks[0] : null;
  const selectedWeekSet = new Set(selectedWeeks);

  const appliedFilters: WeeklyDashboard["appliedFilters"] = {
    weekStart: selectedWeekAnchor,
    weekStarts: selectedWeeks,
    allWeeks: allWeeksRequested,
    distributorCode: distributor.single,
    regionCode: region.single,
    productCode: product.single,
    lineCode: line.single,
    productCodes: [...product.set],
    productFilterMode: product.mode,
    distributorCodes: [...distributor.set],
    distributorFilterMode: distributor.mode,
    regionCodes: [...region.set],
    regionFilterMode: region.mode,
    lineCodes: [...line.set],
    lineFilterMode: line.mode,
  };

  const empty = (): WeeklyDashboard => ({
    weekStart: selectedWeekAnchor,
    priorWeekStart: priorWeek,
    availableWeeks,
    availableLines: [],
    availableRegions: [],
    availableProducts: [],
    distributors,
    appliedFilters,
    kpis: { salesValue: 0, salesUnits: 0, stockUnits: 0, branchCount: 0, regionCount: 0, productCount: 0, distributorCount: 0 },
    compare: { salesValue: delta(0, null), salesUnits: delta(0, null), stockUnits: delta(0, null) },
    regions: [],
    products: [],
    distributorBreakdown: [],
    branchBreakdown: [],
    zeroSalesBranches: [],
    trend: [],
  });

  if (availableWeeks.length === 0) return empty();

  // Fetch validated fact rows (paged) and aggregate in memory — volume is small (hundreds/week).
  const validIds = new Set(batches.map((batch) => String(batch.id)));
  // Push the week filter to DB when a specific week is selected so we only scan 1-2 weeks
  // instead of the full history table. When allWeeks is requested we skip the filter and
  // let validIds (derived from batches) gate what we aggregate.
  const weekDbFilter = allWeeksRequested
    ? ([] as string[])
    : [...selectedWeekSet, ...(priorWeek ? [priorWeek] : [])];
  const allRows: FactRow[] = [];
  const pageSize = 1000;
  let from = 0;
  for (;;) {
    let query = supabase
      .from("weekly_sales_rows")
      .select(
        "batch_id, week_start, distributor_code, distributor_name, region_code, region_name, branch_code, branch_name, product_code, product_name, official_line, sales_value, sales_qty, net_qty, stock_qty",
      )
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    // Distributor narrowing is a safe DB-level optimization (distributor options come from the batch
    // list, not these rows, so they never collapse). Region/product/line are filtered IN MEMORY only
    // so their full option universes stay available for multi-select — and so exclude mode works.
    if (weekDbFilter.length > 0) query = query.in("week_start", weekDbFilter);
    if (distributor.has && distributor.mode === "include") query = query.in("distributor_code", [...distributor.set]);
    const page = await query;
    if (page.error) throw new SalesWorkflowError("load_failed", page.error.message, 500);
    const data = page.data ?? [];
    for (const row of data) {
      if (!validIds.has(String(row.batch_id))) continue; // skip rows from blocked batches
      allRows.push({
        weekStart: String(row.week_start ?? ""),
        distributorCode: String(row.distributor_code ?? ""),
        distributorName: String(row.distributor_name ?? ""),
        regionCode: String(row.region_code ?? ""),
        regionName: String(row.region_name ?? ""),
        branchCode: String(row.branch_code ?? ""),
        branchName: String(row.branch_name ?? ""),
        productCode: String(row.product_code ?? ""),
        productName: String(row.product_name ?? ""),
        officialLine: String(row.official_line ?? ""),
        salesValue: Number(row.sales_value ?? 0),
        salesQty: Number(row.sales_qty ?? 0),
        netQty: Number(row.net_qty ?? row.sales_qty ?? 0),
        stockQty: Number(row.stock_qty ?? 0),
      });
    }
    if (data.length < pageSize) break;
    from += pageSize;
  }

  // Per-viewer visibility: full / product-scoped / territory-scoped / none. Restricted Lacto
  // Basic products are stripped for every tier except a full-access viewer allowed to reveal them.
  const accessScope: WeeklyAccessScope = filters?.accessScope ?? { tier: "full", canViewRestricted: true };
  const visibleRows = applyWeeklyAccessScope(allRows, accessScope);
  // Filters run AFTER access-scope redaction, so include/exclude can only narrow already-visible
  // rows — they can never re-expose the confidential LA003/LA004 products.
  const scopedRows = visibleRows.filter((row) => {
    if (!passesMultiFilter(distributor, normalizeCode(row.distributorCode))) return false;
    if (!passesMultiFilter(region, normalizeCode(row.regionCode))) return false;
    if (!passesMultiFilter(product, normalizeCode(row.productCode))) return false;
    if (!passesMultiFilter(line, normalizeComparableLine(row.officialLine))) return false;
    return true;
  });
  // Filter-option universes. Scoped by the selected weeks + distributor choice ONLY — deliberately
  // NOT by region/product/line — so selecting one value never removes the others from their own
  // dropdown (which would make multi-select impossible). Distributor options come from the batch list.
  const optionRows = visibleRows.filter(
    (row) => selectedWeekSet.has(row.weekStart) && passesMultiFilter(distributor, normalizeCode(row.distributorCode)),
  );
  const dedupeOptions = (rows: FactRow[], codeOf: (row: FactRow) => string, nameOf: (row: FactRow) => string) => {
    const byCode = new Map<string, string>();
    for (const row of rows) {
      const code = normalizeCode(codeOf(row));
      if (!code || byCode.has(code)) continue;
      byCode.set(code, normalizeText(nameOf(row)) || code);
    }
    return [...byCode.entries()]
      .map(([code, name]) => ({ code, name }))
      .sort((left, right) => left.name.localeCompare(right.name));
  };
  const availableRegions = dedupeOptions(optionRows, (row) => row.regionCode, (row) => row.regionName);
  const availableProducts = dedupeOptions(optionRows, (row) => row.productCode, (row) => row.productName);
  const availableLines = [...new Set(optionRows.map((row) => row.officialLine).map(normalizeText).filter(Boolean))].sort(
    (left, right) => left.localeCompare(right),
  );

  const weekRows = scopedRows.filter((row) => selectedWeekSet.has(row.weekStart));
  const priorRows = priorWeek ? scopedRows.filter((row) => row.weekStart === priorWeek) : [];

  const sum = (rows: FactRow[], pick: (row: FactRow) => number) => rows.reduce((acc, row) => acc + pick(row), 0);

  // Zero-sales branches: stock on hand this week but no sales.
  const branchAgg = new Map<string, { branchName: string; regionName: string; salesValue: number; salesUnits: number; stockUnits: number }>();
  for (const row of weekRows) {
    const key = row.branchCode || row.branchName;
    // Skip branchless rows so the zero-sales list never shows a "—" branch.
    if (!key) continue;
    const current = branchAgg.get(key) ?? { branchName: row.branchName || key, regionName: row.regionName, salesValue: 0, salesUnits: 0, stockUnits: 0 };
    current.salesValue += row.salesValue;
    current.salesUnits += row.netQty;
    current.stockUnits += row.stockQty;
    branchAgg.set(key, current);
  }
  const zeroSalesBranches = [...branchAgg.entries()]
    .filter(([, branch]) => branch.salesUnits === 0 && branch.stockUnits > 0)
    .map(([branchCode, branch]) => ({
      branchCode,
      branchName: branch.branchName,
      regionName: branch.regionName,
      salesValue: Number(branch.salesValue.toFixed(2)),
      salesUnits: Number(branch.salesUnits.toFixed(2)),
      stockUnits: Number(branch.stockUnits.toFixed(2)),
    }))
    .sort((left, right) => right.stockUnits - left.stockUnits);

  const trendWeeks = [...availableWeeks].sort(); // ascending for charting
  const trend = trendWeeks.map((week) => {
    const rows = scopedRows.filter((row) => row.weekStart === week);
    const distMap = new Map<string, { name: string; value: number }>();
    for (const row of rows) {
      const entry = distMap.get(row.distributorCode);
      if (entry) entry.value += row.salesValue;
      else distMap.set(row.distributorCode, { name: row.distributorName, value: row.salesValue });
    }
    return {
      weekStart: week,
      salesValue: Number(sum(rows, (row) => row.salesValue).toFixed(2)),
      salesUnits: Number(sum(rows, (row) => row.netQty).toFixed(2)),
      stockUnits: Number(sum(rows, (row) => row.stockQty).toFixed(2)),
      byDistributor: [...distMap.entries()].map(([code, d]) => ({
        distributorCode: code,
        distributorName: d.name,
        salesValue: Number(d.value.toFixed(2)),
      })),
    };
  });

  return {
    weekStart: selectedWeekAnchor,
    priorWeekStart: priorWeek,
    availableWeeks,
    availableLines,
    availableRegions,
    availableProducts,
    distributors,
    appliedFilters,
    kpis: {
      salesValue: Number(sum(weekRows, (row) => row.salesValue).toFixed(2)),
      salesUnits: Number(sum(weekRows, (row) => row.netQty).toFixed(2)),
      stockUnits: Number(sum(weekRows, (row) => row.stockQty).toFixed(2)),
      branchCount: new Set(weekRows.map((row) => row.branchCode || row.branchName)).size,
      regionCount: new Set(weekRows.map((row) => row.regionCode)).size,
      productCount: new Set(weekRows.map((row) => row.productCode || row.productName)).size,
      distributorCount: new Set(weekRows.map((row) => row.distributorCode)).size,
    },
    compare: {
      salesValue: delta(sum(weekRows, (row) => row.salesValue), priorWeek ? sum(priorRows, (row) => row.salesValue) : null),
      salesUnits: delta(sum(weekRows, (row) => row.netQty), priorWeek ? sum(priorRows, (row) => row.netQty) : null),
      stockUnits: delta(sum(weekRows, (row) => row.stockQty), priorWeek ? sum(priorRows, (row) => row.stockQty) : null),
    },
    regions: rank(weekRows, (row) => row.regionCode, (row) => row.regionName),
    products: rank(weekRows, (row) => row.productCode, (row) => row.productName),
    distributorBreakdown: rank(weekRows, (row) => row.distributorCode, (row) => row.distributorName),
    branchBreakdown: rankBranches(weekRows),
    zeroSalesBranches: zeroSalesBranches.slice(0, 100),
    trend,
  };
}

// ── product-scope administration ─────────────────────────────────────────────────────────────

// Roles offered as "assignable to a curated product list" in the admin view. Marketing Manager is
// intentionally excluded: it now defaults to full company-wide weekly access (see weekly/access.ts),
// so it should not be nudged toward a narrowing assignment. An explicit assignment still overrides.
const PRODUCT_SCOPE_ROLES = new Set(["Product Manager", "Group Product Manager"]);

/**
 * Assemble the product-scope admin view: the product master, every current assignment (resolved
 * to a display name + role), and the eligible people (PM/GPM) without a scope yet.
 */
export async function loadWeeklyProductScopeAdmin(): Promise<WeeklyProductScopeAdmin> {
  const [references, directory, assignmentsByHrId] = await Promise.all([
    loadSalesReferenceData({ includeCustomerBricks: false }),
    getEmployeeDirectory(),
    listWeeklyProductScopeAssignments(),
  ]);

  const products = references.products
    .filter((product) => product.productCode)
    .map((product) => ({ code: product.productCode, name: product.productName || product.productCode, line: product.line ?? "" }))
    .sort((left, right) => left.name.localeCompare(right.name));

  // Resolve display name + role for any HR_ID via the directory (canonical key match).
  const byHrKey = new Map<string, { name: string; role: string }>();
  for (const employee of directory.employees) {
    const key = canonicalHrIdKey(employee.hrId);
    if (!key) continue;
    const role = normalizeRole(employee.positionTitle ?? employee.jobTitle);
    byHrKey.set(key, { name: employee.fullName || employee.hrId, role });
  }

  const assignments = [...assignmentsByHrId.entries()]
    .map(([hrKey, codes]) => {
      const info = byHrKey.get(hrKey);
      return {
        hrId: canonicalHrIdForDisplay(hrKey) ?? hrKey,
        name: info?.name ?? (canonicalHrIdForDisplay(hrKey) ?? hrKey),
        role: info?.role ?? "—",
        productCodes: [...codes].sort(),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  const assignedKeys = new Set(assignmentsByHrId.keys());
  const eligibleWithoutScope = [...byHrKey.entries()]
    .filter(([key, info]) => PRODUCT_SCOPE_ROLES.has(info.role) && !assignedKeys.has(key))
    .map(([key, info]) => ({ hrId: canonicalHrIdForDisplay(key) ?? key, name: info.name, role: info.role }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return { products, assignments, eligibleWithoutScope };
}
