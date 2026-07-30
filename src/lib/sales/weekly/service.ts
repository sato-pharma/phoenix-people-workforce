import { asyncPool } from "@/lib/utils/async-pool";
import { normalizeRole } from "@/lib/auth/permissions";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { canonicalHrIdForDisplay, canonicalHrIdKey } from "@/lib/hr-id";
import { loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import {
  applyWeeklyAccessScope,
  listWeeklyProductScopeAssignments,
  type WeeklyAccessScope,
} from "@/lib/sales/weekly/access";
import { SalesWorkflowError, isPostgresUniqueViolation } from "@/lib/sales/contracts";
import { loadBranchRegionIndex } from "@/lib/sales/weekly/branch-region-map";
import {
  WEEKLY_DISTRIBUTORS,
  canonicalWeeklyDistributorCode,
  weeklyDistributorByCode,
} from "@/lib/sales/weekly/distributors";
import { parseWeeklyWorkbookBuffer } from "@/lib/sales/weekly/parser";
import { decumulateRows, suppressGapSpannedValue, weekHasDecumulationGap } from "@/lib/sales/weekly/decumulate";
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
  WeeklyThisWeekOnly,
  WeeklyTotals,
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

// ── week-of-month tagging helpers (cumulative-sheet de-cumulation) ──────────────────────────────
// Distributor weekly sheets are cumulative from the start of the month. Each upload is tagged with a
// cycle_month + week_number (1–4) so the dashboard can de-cumulate true per-week sales. The week is
// auto-suggested from the sheet date and confirmed/overridable by the uploader.

const round2 = (value: number) => Number(value.toFixed(2));

/** Week-of-month 1–4 from a YYYY-MM-DD date (day bucket, capped at 4); null when undated. */
function suggestWeekNumber(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const day = Number(dateStr.slice(8, 10));
  if (!Number.isFinite(day) || day < 1) return null;
  return day <= 7 ? 1 : day <= 14 ? 2 : day <= 21 ? 3 : 4;
}

/** First day of the cycle month (YYYY-MM-01) for a YYYY-MM-DD date; null when undated. */
function cycleMonthFromDate(dateStr: string | null): string | null {
  if (!dateStr || dateStr.length < 7) return null;
  return `${dateStr.slice(0, 7)}-01`;
}

/**
 * De-cumulate this sheet's totals against the previous cumulative sheet of the same month-cycle.
 * Returns the real "this week only" sales (value + net units); stock is a snapshot, returned as-is.
 * When no earlier sheet exists in the cycle, this IS the first week → real = the full current totals.
 */
async function computeThisWeekOnly(
  distributorCode: string,
  cycleMonth: string | null,
  weekStart: string | null,
  totals: WeeklyTotals,
): Promise<WeeklyThisWeekOnly | null> {
  if (!cycleMonth || !weekStart) return null;
  const supabase = getSupabaseAdmin();
  const prior = await supabase
    .from("weekly_sales_batches")
    .select("week_start, week_number, total_sales_value, total_net_qty")
    .eq("distributor_code", distributorCode)
    .eq("cycle_month", cycleMonth)
    .eq("status", "validated")
    .lt("week_start", weekStart)
    .order("week_start", { ascending: false })
    .limit(1);
  if (prior.error || !prior.data || prior.data.length === 0) {
    return {
      priorWeekStart: null,
      priorWeekNumber: null,
      salesValue: round2(totals.salesValue),
      netQty: round2(totals.netQty),
      stockQty: round2(totals.stockQty),
    };
  }
  const p = prior.data[0] as { week_start: string | null; week_number: number | null; total_sales_value: number | null; total_net_qty: number | null };
  return {
    priorWeekStart: p.week_start ? String(p.week_start) : null,
    priorWeekNumber: p.week_number != null ? Number(p.week_number) : null,
    salesValue: round2(totals.salesValue - Number(p.total_sales_value ?? 0)),
    netQty: round2(totals.netQty - Number(p.total_net_qty ?? 0)),
    stockQty: round2(totals.stockQty),
  };
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
  /** confirmed week-of-month 1–4 from the wizard; defaults to the date-derived suggestion when omitted */
  weekNumber?: number | null;
  /** cycle-month override (YYYY-MM-DD, first of month); defaults to the month of weekStart */
  cycleMonth?: string | null;
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

  // Week-of-month tagging: cycle = month of the sheet date (override-able); week = confirmed value
  // from the wizard, else the date-derived suggestion. Both flow through to the stored batch + rows.
  const suggestedWeek = suggestWeekNumber(parsed.result.weekStart);
  const cycleMonth = input.cycleMonth ?? cycleMonthFromDate(parsed.result.weekStart);
  const weekNumber = input.weekNumber ?? suggestedWeek;
  parsed.result.suggestedWeekNumber = suggestedWeek;
  parsed.result.cycleMonth = cycleMonth;
  parsed.result.weekNumber = weekNumber;
  // De-cumulated "this week only" preview vs the previous cumulative sheet of this cycle.
  parsed.result.thisWeekOnly = await computeThisWeekOnly(
    parsed.result.distributor.code,
    cycleMonth,
    parsed.result.weekStart,
    parsed.result.totals,
  );

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

  // Second duplicate guard, on the LOGICAL week slot (cycle_month + week_number + template). The
  // week_start guard above misses a re-upload of the same cycle-week that carries a different
  // week_start date (cycle_month/week_number are operator-tagged and editable), which would insert a
  // phantom extra week into the de-cumulation sequence for that cycle and corrupt the telescoping
  // chain. Also enforced by a partial unique index (see the batch-insert 23505 handling below) so a
  // concurrent race can't slip past this SELECT.
  if (result.cycleMonth && result.weekNumber != null) {
    const existingSlot = await supabase
      .from("weekly_sales_batches")
      .select("id")
      .eq("distributor_code", result.distributor.code)
      .eq("cycle_month", result.cycleMonth)
      .eq("week_number", result.weekNumber)
      .eq("template_key", result.templateKey)
      .eq("status", "validated")
      .limit(1);
    if (!existingSlot.error && (existingSlot.data?.length ?? 0) > 0) {
      throw new SalesWorkflowError(
        "duplicate_week",
        `A validated upload already exists for ${result.distributor.name} — cycle ${result.cycleMonth}, week ${result.weekNumber}. Delete it first to re-upload.`,
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
      cycle_month: result.cycleMonth,
      week_number: result.weekNumber,
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
    // A partial unique index makes the batch INSERT the atomic arbiter for the two duplicate guards
    // above: under a concurrent re-upload race both SELECTs can miss, but only one INSERT wins — the
    // loser hits 23505 here. Surface it as the same friendly 409 instead of a raw 500.
    if (isPostgresUniqueViolation(batchInsert.error)) {
      throw new SalesWorkflowError(
        "duplicate_week",
        `A validated upload already exists for ${result.distributor.name} for this week. Delete it first to re-upload.`,
        409,
      );
    }
    throw new SalesWorkflowError("persist_failed", batchInsert.error?.message ?? "Could not save the weekly batch.", 500);
  }
  const batchId = String(batchInsert.data.id);

  const rowsPayload = rows.map((row) => ({
    batch_id: batchId,
    row_number: row.rowNumber,
    week_start: row.weekStart,
    cycle_month: result.cycleMonth,
    week_number: result.weekNumber,
    distributor_code: row.distributorCode,
    distributor_name: row.distributorName,
    region_code: row.regionCode,
    region_name: row.regionName,
    area_code: row.areaCode,
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

/**
 * Re-tag a batch's month-cycle + week-of-month. Used to correct boundary sheets (e.g. a sheet dated
 * on the 1st that actually closes the prior month) so de-cumulation pairs them with the right cycle.
 * Updates the batch header and all of its rows together.
 */
export async function retagWeeklyBatch(input: {
  batchId: string;
  cycleMonth: string;
  weekNumber: number;
}): Promise<boolean> {
  const batchId = (input.batchId ?? "").trim();
  if (!batchId) throw new SalesWorkflowError("invalid_request", "Missing batch id.", 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.cycleMonth)) {
    throw new SalesWorkflowError("invalid_request", "cycleMonth must be a YYYY-MM-DD date (first of the month).", 400);
  }
  if (![1, 2, 3, 4].includes(input.weekNumber)) {
    throw new SalesWorkflowError("invalid_request", "weekNumber must be 1, 2, 3 or 4.", 400);
  }
  const supabase = getSupabaseAdmin();
  const batchUpdate = await supabase
    .from("weekly_sales_batches")
    .update({ cycle_month: input.cycleMonth, week_number: input.weekNumber })
    .eq("id", batchId)
    .select("id")
    .single();
  if (batchUpdate.error || !batchUpdate.data) {
    throw new SalesWorkflowError("update_failed", batchUpdate.error?.message ?? "Batch not found.", 404);
  }
  const rowsUpdate = await supabase
    .from("weekly_sales_rows")
    .update({ cycle_month: input.cycleMonth, week_number: input.weekNumber })
    .eq("batch_id", batchId);
  if (rowsUpdate.error) throw new SalesWorkflowError("update_failed", rowsUpdate.error.message, 500);
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
    cycleMonth: row.cycle_month ? String(row.cycle_month) : null,
    weekNumber: row.week_number != null ? Number(row.week_number) : null,
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
  /** first day of the month-cycle this row belongs to (YYYY-MM-DD), or "" when untagged */
  cycleMonth: string;
  /** week-of-month 1–4, or null when untagged */
  weekNumber: number | null;
  distributorCode: string;
  distributorName: string;
  regionCode: string;
  regionName: string;
  /** Area from the branch mapping; null when the branch has no area mapping (then region-scoped). */
  areaCode: string | null;
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

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
// "2026-05-01" → "May 2026" (no Date() — pure string parse, timezone-safe).
const monthLabel = (cycleMonth: string) => {
  const [year, month] = (cycleMonth || "").split("-");
  const name = MONTH_NAMES[Number(month) - 1];
  return name ? `${name} ${year}` : cycleMonth || "—";
};

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

// ── Trend helpers ────────────────────────────────────────────────────────────────────────────────

type TrendPoint = {
  weekStart: string;
  /** week-of-month 1–4 of this point (for "W1 May" axis labels), or null when untagged */
  weekNumber: number | null;
  /** cycle month (YYYY-MM-DD) of this point, or null when untagged */
  cycleMonth: string | null;
  salesValue: number;
  salesUnits: number;
  stockUnits: number;
  byDistributor: { distributorCode: string; distributorName: string; salesValue: number }[];
};

function daysBetweenWeeks(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000);
}

function absorbTrendPoint(base: TrendPoint, thin: TrendPoint): TrendPoint {
  const distMap = new Map<string, { distributorName: string; salesValue: number }>();
  for (const d of [...base.byDistributor, ...thin.byDistributor]) {
    const ex = distMap.get(d.distributorCode);
    if (ex) ex.salesValue += d.salesValue;
    else distMap.set(d.distributorCode, { distributorName: d.distributorName, salesValue: d.salesValue });
  }
  return {
    weekStart: base.weekStart,
    weekNumber: base.weekNumber,
    cycleMonth: base.cycleMonth,
    salesValue: Number((base.salesValue + thin.salesValue).toFixed(2)),
    salesUnits: Number((base.salesUnits + thin.salesUnits).toFixed(2)),
    stockUnits: Number((base.stockUnits + thin.stockUnits).toFixed(2)),
    byDistributor: [...distMap.entries()].map(([distributorCode, d]) => ({
      distributorCode,
      distributorName: d.distributorName,
      salesValue: Number(d.salesValue.toFixed(2)),
    })),
  };
}

function mergeThinWeeks(raw: TrendPoint[], minDays = 5): TrendPoint[] {
  if (raw.length <= 1) return raw;
  const working = [...raw];
  const result: TrendPoint[] = [];
  for (let i = 0; i < working.length; i++) {
    const point = working[i];
    const next = working[i + 1];
    const coverage = next ? daysBetweenWeeks(point.weekStart, next.weekStart) : 7;
    if (coverage < minDays) {
      if (result.length > 0) {
        result[result.length - 1] = absorbTrendPoint(result[result.length - 1], point);
      } else if (next) {
        working[i + 1] = absorbTrendPoint(next, point);
      } else {
        result.push(point);
      }
    } else {
      result.push(point);
    }
  }
  return result;
}

function computeWeekGroups(weeks: string[], minDays = 5): { canonical: string; members: string[] }[] {
  const sorted = [...weeks].filter(Boolean).sort();
  if (!sorted.length) return [];
  const groups: { canonical: string; members: string[] }[] = [{ canonical: sorted[0], members: [sorted[0]] }];
  for (let i = 1; i < sorted.length; i++) {
    const lastGroup = groups[groups.length - 1];
    const lastMember = lastGroup.members[lastGroup.members.length - 1];
    if (daysBetweenWeeks(lastMember, sorted[i]) < minDays) { lastGroup.members.push(sorted[i]); }
    else { groups.push({ canonical: sorted[i], members: [sorted[i]] }); }
  }
  return groups;
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
  /** Cycle-month filter (YYYY-MM-DD first-of-month values) + mode. Empty = all months. */
  cycleMonths?: string[] | null;
  cycleMonthMode?: WeeklyFilterMode | null;
  /** Week-of-month filter (1–4) + mode. Empty = all weeks. */
  weekNumbers?: number[] | null;
  weekNumberMode?: WeeklyFilterMode | null;
  /** Per-viewer visibility tier (full / product / territory / none). Defaults to full access. */
  accessScope?: WeeklyAccessScope;
  /** Export only: drop rows whose product is unmapped (no master / no line) from EVERY aggregate. */
  excludeUnmapped?: boolean;
  /** Export only: also return the row-level fact grain (factRows) for the BI workbook's Data sheet. */
  includeFactRows?: boolean;
}): Promise<WeeklyDashboard> {
  const supabase = getSupabaseAdmin();

  // Validated batches — ordered newest-first; limit to 200 in the common case (200 ÷ 8 distributors
  // ≈ 25 weeks of dropdown history). allWeeks skips the limit so the full history stays available.
  let batchQuery = supabase
    .from("weekly_sales_batches")
    .select("id, week_start, cycle_month, week_number, distributor_code, distributor_name, file_name")
    .eq("status", "validated")
    .order("week_start", { ascending: false });
  if (!filters?.allWeeks) batchQuery = batchQuery.limit(200);
  const batchesResult = await batchQuery;
  if (batchesResult.error) throw new SalesWorkflowError("load_failed", batchesResult.error.message, 500);
  const batches = batchesResult.data ?? [];

  const rawAvailableWeeks = [...new Set(batches.map((batch) => String(batch.week_start)).filter(Boolean))].sort(
    (left, right) => right.localeCompare(left),
  );
  const weekGroups = computeWeekGroups(rawAvailableWeeks);
  const weekGroupMap = new Map<string, string[]>(weekGroups.map((g) => [g.canonical, g.members]));
  const memberToCanonical = new Map<string, string>();
  for (const g of weekGroups) for (const m of g.members) memberToCanonical.set(m, g.canonical);
  const availableWeeks = weekGroups.map((g) => g.canonical).reverse();
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
  const cycleMonthFilter = resolveMultiFilter(filters?.cycleMonths, null, filters?.cycleMonthMode, normalizeText);
  const weekNumberFilter = resolveMultiFilter(
    filters?.weekNumbers?.map((value) => String(value)),
    null,
    filters?.weekNumberMode,
    normalizeText,
  );
  const requestedWeekSet = new Set(
    normalizeWeekList(filters?.weekStarts)
      .map((w) => memberToCanonical.get(w) ?? w)
      .filter((w) => availableWeekSet.has(w)),
  );
  const requestedWeeks = availableWeeks.filter((week) => requestedWeekSet.has(week));
  const allWeeksRequested = filters?.allWeeks === true;
  const rawRequestedSingle = normalizeText(filters?.weekStart);
  const requestedSingleWeek = rawRequestedSingle
    ? (memberToCanonical.get(rawRequestedSingle) ?? (availableWeekSet.has(rawRequestedSingle) ? rawRequestedSingle : null))
    : null;
  const selectedCanonicals = allWeeksRequested
    ? [...availableWeeks]
    : requestedWeeks.length > 0
      ? requestedWeeks
      : requestedSingleWeek && availableWeekSet.has(requestedSingleWeek)
        ? [requestedSingleWeek]
        // No explicit date-week request: default to ALL weeks. The dashboard no longer has a date-week
        // selector — week scoping is done with the Month + Week-of-month (W1–W4) filters — so the
        // un-filtered view should show everything, not just the latest week.
        : [...availableWeeks];
  const selectedWeeks = selectedCanonicals.flatMap((can) => weekGroupMap.get(can) ?? [can]);
  const selectedWeekAnchor = selectedCanonicals.length > 0 ? selectedCanonicals[0] : null;
  const selectedWeekSet = new Set(selectedWeeks);
  // Prior-week comparison only makes sense when exactly ONE week is in scope; for an all-weeks (or
  // multi-week) view a "vs prior week" delta would compare a single prior week against a multi-week
  // total, which is misleading — so suppress it.
  const priorCanonical =
    selectedCanonicals.length === 1 ? availableWeeks.find((w) => w < selectedCanonicals[0]) ?? null : null;
  const priorWeekSet = new Set(priorCanonical ? (weekGroupMap.get(priorCanonical) ?? [priorCanonical]) : []);

  const appliedFilters: WeeklyDashboard["appliedFilters"] = {
    weekStart: selectedWeekAnchor,
    weekStarts: selectedCanonicals,
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
    cycleMonths: [...cycleMonthFilter.set],
    cycleMonthMode: cycleMonthFilter.mode,
    weekNumbers: [...weekNumberFilter.set].map((value) => Number(value)).filter((value) => Number.isFinite(value)),
    weekNumberMode: weekNumberFilter.mode,
  };

  const weekGroupMembersObj = Object.fromEntries(weekGroupMap);

  // Metadata scope for the early-return branches below, before any rows have been fetched: a
  // restricted (non-full) tier that hits one of these "nothing to show" shortcuts has no visible
  // rows to derive an in-scope distributor set from, so it must see an empty catalog here rather
  // than the raw company-wide list — otherwise these shortcuts would leak it right back.
  const distributorsForEmpty = (filters?.accessScope?.tier ?? "full") === "full" ? distributors : [];

  const empty = (): WeeklyDashboard => ({
    weekStart: selectedWeekAnchor,
    priorWeekStart: priorCanonical,
    availableWeeks,
    weekGroupMembers: weekGroupMembersObj,
    availableLines: [],
    availableRegions: [],
    availableProducts: [],
    availableMonths: [],
    availableWeekNumbers: [],
    distributors: distributorsForEmpty,
    appliedFilters,
    kpis: { salesValue: 0, salesUnits: 0, stockUnits: 0, branchCount: 0, regionCount: 0, productCount: 0, distributorCount: 0 },
    compare: { salesValue: delta(0, null), salesUnits: delta(0, null), stockUnits: delta(0, null) },
    regions: [],
    products: [],
    distributorBreakdown: [],
    branchBreakdown: [],
    zeroSalesBranches: [],
    weekComparison: [],
    sources: [],
    trend: [],
  });

  // PM/GPM with no product codes assigned in weekly_sales_product_scope: flag it explicitly so
  // the UI can show a clear "contact admin" message rather than a silently empty dashboard.
  // Must come BEFORE the availableWeeks guard so the flag is set even when no batches exist yet.
  const scope = filters?.accessScope;
  if (scope?.tier === "product" && scope.productCodes.size === 0) {
    return { ...empty(), scopeEmpty: true };
  }

  if (availableWeeks.length === 0) return empty();

  // Fetch validated fact rows (paged) and aggregate in memory — volume is small (hundreds/week).
  // Narrow to batch_id (the FK, always populated) rather than week_start on the rows table
  // (nullable; may differ from the batch's canonical date for multi-date uploads). Filter to the
  // batches covering the selected week(s) + prior week so we skip irrelevant history, OR to all
  // validated batches when allWeeks is requested.
  //
  // Exception: product-scoped users (PM/GPM) get ALL historical batches so the trend chart covers
  // the full available history rather than just the selected + prior week. Their product universe is
  // small (2–4 codes, ~hundreds of rows) so loading all history is safe. Full/territory scopes are
  // kept at the 2-week window because their row counts can be orders of magnitude larger.
  const scopeIsBoundedProduct =
    filters?.accessScope?.tier === "product" &&
    (filters.accessScope as Extract<WeeklyAccessScope, { tier: "product" }>).productCodes.size > 0;
  // Widen to 8 recent weeks so the trend chart always has enough points for merging.
  const recentWeekSet = new Set(availableWeeks.slice(0, 8).flatMap((can) => weekGroupMap.get(can) ?? [can]));
  // De-cumulation needs every week of a touched month-cycle loaded (to subtract the previous week),
  // so widen the window from "selected/prior/recent weeks" to the FULL (distributor, cycle_month) of
  // any batch in that window.
  const windowCycleKeys = new Set(
    batches
      .filter((b) => {
        const ws = String(b.week_start ?? "");
        return selectedWeekSet.has(ws) || priorWeekSet.has(ws) || recentWeekSet.has(ws);
      })
      .map((b) => `${b.distributor_code}||${b.cycle_month ?? ""}`),
  );
  const batchIdsForRows = allWeeksRequested || scopeIsBoundedProduct
    ? [...batches.map((b) => String(b.id))]
    : batches
        .filter((b) => windowCycleKeys.has(`${b.distributor_code}||${b.cycle_month ?? ""}`))
        .map((b) => String(b.id));
  if (batchIdsForRows.length === 0) return empty();
  const CONCURRENCY = 6;
  const validIds = new Set(batchIdsForRows);
  const allRows: FactRow[] = [];
  const pageSize = 1000;

  const fetchStart = Date.now();
  // batch_id narrowing is safe: options (weeks, distributors) come from the batch list, not
  // these rows, so filtering here never collapses the filter dropdowns.
  // Region/product/line stay IN MEMORY so exclude-mode and full option lists remain correct.
  // Page 0 uses count:exact so remaining page offsets can be issued concurrently.
  //
  // The distributor_code column is CASE-SENSITIVE and some codes are mixed-case (e.g. "Direct").
  // distributor.set holds normalised (UPPERCASED) codes, so passing it straight into .in() would match
  // nothing for mixed-case distributors (Direct showed zero rows). Map back to the ACTUAL stored codes
  // from the batch list before narrowing. The in-memory filter (passesMultiFilter) stays authoritative.
  const distributorCodesForQuery =
    distributor.has && distributor.mode === "include"
      ? [
          ...new Set(
            batches
              .map((b) => String(b.distributor_code ?? ""))
              .filter((code) => code && distributor.set.has(normalizeCode(code))),
          ),
        ]
      : null;
  // PostgREST folds every .in() value into the request URL; an unbatched array of a few hundred
  // ids can push the URL past undici's ~16KB header limit and throw "TypeError: fetch failed" /
  // HeadersOverflowError — batchIdsForRows is unbounded when allWeeks/product-scoped, so chunk it.
  // Each chunk keeps its own count-exact-first-page + concurrent-remaining-pages fetch; results
  // merge into the same allRows across chunks.
  let totalPagesFetched = 0;
  for (let bi = 0; bi < batchIdsForRows.length; bi += 100) {
    const batchIdBatch = batchIdsForRows.slice(bi, bi + 100);
    let p0Query = supabase
      .from("weekly_sales_rows")
      .select(
        "batch_id, week_start, cycle_month, week_number, distributor_code, distributor_name, region_code, region_name, area_code, branch_code, branch_name, product_code, product_name, official_line, sales_value, sales_qty, net_qty, stock_qty",
        { count: "exact" },
      )
      .order("id", { ascending: true })
      .range(0, pageSize - 1)
      .in("batch_id", batchIdBatch);
    if (distributorCodesForQuery && distributorCodesForQuery.length > 0)
      p0Query = p0Query.in("distributor_code", distributorCodesForQuery);
    const firstPage = await p0Query;
    if (firstPage.error) throw new SalesWorkflowError("load_failed", firstPage.error.message, 500);
    const totalCount = firstPage.count ?? (firstPage.data?.length ?? 0);
    totalPagesFetched += 1;
    for (const row of firstPage.data ?? []) {
      if (!validIds.has(String(row.batch_id))) continue; // skip rows from blocked batches
      allRows.push({
        weekStart: String(row.week_start ?? ""),
        cycleMonth: String(row.cycle_month ?? ""),
        weekNumber: row.week_number != null ? Number(row.week_number) : null,
        distributorCode: String(row.distributor_code ?? ""),
        distributorName: String(row.distributor_name ?? ""),
        regionCode: String(row.region_code ?? ""),
        regionName: String(row.region_name ?? ""),
        areaCode: row.area_code == null || String(row.area_code).trim() === "" ? null : String(row.area_code).trim().toUpperCase(),
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
    const remainingFroms: number[] = [];
    for (let from = pageSize; from < totalCount; from += pageSize) remainingFroms.push(from);
    if (remainingFroms.length > 0) {
      totalPagesFetched += remainingFroms.length;
      const pages = await asyncPool(CONCURRENCY, remainingFroms, async (from) => {
        let q = supabase
          .from("weekly_sales_rows")
          .select(
            "batch_id, week_start, cycle_month, week_number, distributor_code, distributor_name, region_code, region_name, area_code, branch_code, branch_name, product_code, product_name, official_line, sales_value, sales_qty, net_qty, stock_qty",
          )
          .order("id", { ascending: true })
          .range(from, from + pageSize - 1)
          .in("batch_id", batchIdBatch);
        if (distributorCodesForQuery && distributorCodesForQuery.length > 0)
          q = q.in("distributor_code", distributorCodesForQuery);
        const page = await q;
        if (page.error) throw new SalesWorkflowError("load_failed", page.error.message, 500);
        return page.data ?? [];
      });
      for (const pageData of pages) {
        for (const row of pageData) {
          if (!validIds.has(String(row.batch_id))) continue; // skip rows from blocked batches
          allRows.push({
            weekStart: String(row.week_start ?? ""),
            cycleMonth: String(row.cycle_month ?? ""),
            weekNumber: row.week_number != null ? Number(row.week_number) : null,
            distributorCode: String(row.distributor_code ?? ""),
            distributorName: String(row.distributor_name ?? ""),
            regionCode: String(row.region_code ?? ""),
            regionName: String(row.region_name ?? ""),
            areaCode: row.area_code == null || String(row.area_code).trim() === "" ? null : String(row.area_code).trim().toUpperCase(),
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
      }
    }
  }
  console.info(JSON.stringify({
    event: "weekly_sales_rows_fetch",
    totalRows: allRows.length,
    totalPages: totalPagesFetched,
    concurrency: CONCURRENCY,
    fetchMs: Date.now() - fetchStart,
    batchCount: batchIdsForRows.length,
  }));

  // Live price sync: Product Master factory_price is the single source of truth. Recompute each
  // non-Direct row's value from the CURRENT master price (netQty × price) so any price edit in
  // Product Master reflects immediately across every weekly surface (dashboard, export, portal) —
  // without re-uploading. Runs on the cumulative rows BEFORE de-cumulation, so value stays linear in
  // qty and all downstream numbers stay consistent.
  //   • Direct channel keeps its own sheet Value (locked invariant — never recompute from price).
  //   • A missing/zero current master price falls back to the stored value (never zero a row).
  const priceMap = new Map<string, number>();
  const mappedCodes = new Set<string>(); // master products that have a line (i.e. properly mapped)
  try {
    const reference = await loadSalesReferenceData({ includeCustomerBricks: false });
    for (const masterProduct of reference.products) {
      const code = normalizeCode(masterProduct.productCode);
      if (!code) continue;
      const price = Number(masterProduct.factoryPrice);
      if (Number.isFinite(price) && price > 0) priceMap.set(code, price);
      if ((masterProduct.line ?? "").trim()) mappedCodes.add(code);
    }
  } catch {
    // Best-effort: if the master can't be read, keep stored values rather than failing the load.
  }
  if (priceMap.size > 0) {
    for (const row of allRows) {
      if (normalizeCode(row.distributorCode) === "DIRECT") continue; // Direct = sheet's own Value
      const price = priceMap.get(normalizeCode(row.productCode));
      if (price == null) continue; // no current master price → keep the stored value
      row.salesValue = Number((row.netQty * price).toFixed(6));
    }
  }

  // De-cumulate the cumulative sheets into real per-week rows BEFORE anything else, so every number
  // downstream (KPIs, trend, rankings, week-over-week) reflects true weekly sales — not running totals.
  const realRows = decumulateRows(allRows);

  // Per-viewer visibility: full / product-scoped / territory-scoped / none. Restricted Lacto
  // Basic products are stripped for every tier except a full-access viewer allowed to reveal them.
  const accessScope: WeeklyAccessScope = filters?.accessScope ?? { tier: "full", canViewRestricted: true, canViewHeadOffice: false };
  const visibleRows = applyWeeklyAccessScope(realRows, accessScope);
  // Metadata scope: full tier already sees every distributor/batch; every other tier (product /
  // territory / none) is bounded to the distributor codes that actually have at least one row
  // visible after the scope redaction above — so the distributor dropdown and report "sources"
  // list never reveal batches/file names outside the viewer's line/region/product scope.
  const scopeVisibleDistributorCodes =
    accessScope.tier === "full" ? null : new Set(visibleRows.map((row) => normalizeCode(row.distributorCode)));
  // Filters run AFTER access-scope redaction, so include/exclude can only narrow already-visible
  // rows — they can never re-expose the confidential LA003/LA004 products.
  // Export only: when excludeUnmapped is requested, drop rows whose product is not a properly mapped
  // master product (no master / no line). Guarded on mappedCodes.size so a failed master load never
  // wipes every row. Applied here so EVERY downstream aggregate (KPIs, trend, breakdowns, factRows)
  // excludes unmapped products — the exported workbook must never contain them.
  const dropUnmapped = filters?.excludeUnmapped === true && mappedCodes.size > 0;
  const scopedRows = visibleRows.filter((row) => {
    if (dropUnmapped && !mappedCodes.has(normalizeCode(row.productCode))) return false;
    if (!passesMultiFilter(distributor, normalizeCode(row.distributorCode))) return false;
    if (!passesMultiFilter(region, normalizeCode(row.regionCode))) return false;
    if (!passesMultiFilter(product, normalizeCode(row.productCode))) return false;
    if (!passesMultiFilter(line, normalizeComparableLine(row.officialLine))) return false;
    if (!passesMultiFilter(cycleMonthFilter, normalizeText(row.cycleMonth))) return false;
    if (!passesMultiFilter(weekNumberFilter, row.weekNumber != null ? String(row.weekNumber) : "")) return false;
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
  // Month + week-of-month option universes — independent of the date-week selection (computed from all
  // visible rows for the chosen distributor) so these dropdowns never collapse on selection.
  const monthOptionRows = visibleRows.filter((row) => passesMultiFilter(distributor, normalizeCode(row.distributorCode)));
  const availableMonths = [...new Set(monthOptionRows.map((row) => row.cycleMonth).filter(Boolean))]
    .sort((left, right) => right.localeCompare(left))
    .map((code) => ({ code, name: monthLabel(code) }));
  const availableWeekNumbers = [
    ...new Set(monthOptionRows.map((row) => row.weekNumber).filter((value): value is number => value != null)),
  ].sort((left, right) => left - right);

  // When a month / week-of-month filter is active it defines the time scope, so don't ALSO restrict to
  // the date-week selector (that would conflict). Otherwise keep the existing selected-week scope.
  const timeFilterActive = cycleMonthFilter.has || weekNumberFilter.has;
  const weekRows = timeFilterActive ? scopedRows : scopedRows.filter((row) => selectedWeekSet.has(row.weekStart));
  const priorRows = !timeFilterActive && priorCanonical ? scopedRows.filter((row) => priorWeekSet.has(row.weekStart)) : [];

  // Stock is a point-in-time snapshot, NOT cumulative — summing it across the weeks of a month would
  // multiply on-hand inventory. For the KPI / compare / ranking aggregates, keep stock only from the
  // LATEST in-scope week of each (distributor, cycle_month) and zero it on earlier weeks; sales/units
  // still sum across all weeks. (The trend + week-comparison read each week's own snapshot directly.)
  const latestStockOnly = (rows: FactRow[]): FactRow[] => {
    const latest = new Map<string, string>();
    for (const row of rows) {
      if (!row.cycleMonth) continue;
      const key = `${row.distributorCode}||${row.cycleMonth}`;
      const cur = latest.get(key);
      if (!cur || row.weekStart > cur) latest.set(key, row.weekStart);
    }
    return rows.map((row) =>
      !row.cycleMonth || row.weekStart === latest.get(`${row.distributorCode}||${row.cycleMonth}`)
        ? row
        : { ...row, stockQty: 0 },
    );
  };
  const weekRowsAdj = latestStockOnly(weekRows);
  const priorRowsAdj = latestStockOnly(priorRows);

  const sum = (rows: FactRow[], pick: (row: FactRow) => number) => rows.reduce((acc, row) => acc + pick(row), 0);

  // Zero-sales branches: stock on hand this week but no sales.
  const branchAgg = new Map<string, { branchName: string; regionName: string; salesValue: number; salesUnits: number; stockUnits: number }>();
  for (const row of weekRowsAdj) {
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

  const trendWeeks = [...rawAvailableWeeks].sort();
  // flatMap: return [] for weeks with no loaded rows (empty historical batches), [point] otherwise.
  // Checking rows.length avoids falsely dropping weeks where returns exceed sales (net-negative
  // salesValue/salesUnits) which a >0 value filter would incorrectly discard.
  const rawTrend = trendWeeks.flatMap((week) => {
    const rows = scopedRows.filter((row) => row.weekStart === week);
    if (rows.length === 0) return [];
    const distMap = new Map<string, { name: string; value: number }>();
    for (const row of rows) {
      const entry = distMap.get(row.distributorCode);
      if (entry) entry.value += row.salesValue;
      else distMap.set(row.distributorCode, { name: row.distributorName, value: row.salesValue });
    }
    // Week-of-month label source: take the (cycleMonth, weekNumber) from this week's tagged rows.
    const tagged = rows.find((row) => row.cycleMonth && row.weekNumber != null);
    return [{
      weekStart: week,
      weekNumber: tagged?.weekNumber ?? null,
      cycleMonth: tagged?.cycleMonth ?? null,
      salesValue: Number(sum(rows, (row) => row.salesValue).toFixed(2)),
      salesUnits: Number(sum(rows, (row) => row.netQty).toFixed(2)),
      stockUnits: Number(sum(rows, (row) => row.stockQty).toFixed(2)),
      byDistributor: [...distMap.entries()].map(([code, d]) => ({
        distributorCode: code,
        distributorName: d.name,
        salesValue: Number(d.value.toFixed(2)),
      })),
    }];
  });
  const trend = mergeThinWeeks(rawTrend);

  // Week-by-week comparison (de-cumulated real weeks), grouped by cycle month + week number. The
  // delta is vs the previous week number within the SAME month-cycle (W2−W1, W3−W2, …).
  const wcMap = new Map<
    string,
    { cycleMonth: string; weekNumber: number; weekStart: string; salesValue: number; salesUnits: number; stockUnits: number }
  >();
  for (const row of scopedRows) {
    if (!row.cycleMonth || row.weekNumber == null) continue;
    const key = `${row.cycleMonth}||${row.weekNumber}`;
    const cur = wcMap.get(key) ?? {
      cycleMonth: row.cycleMonth,
      weekNumber: row.weekNumber,
      weekStart: row.weekStart,
      salesValue: 0,
      salesUnits: 0,
      stockUnits: 0,
    };
    cur.salesValue += row.salesValue;
    cur.salesUnits += row.netQty;
    cur.stockUnits += row.stockQty;
    if (row.weekStart && (!cur.weekStart || row.weekStart < cur.weekStart)) cur.weekStart = row.weekStart;
    wcMap.set(key, cur);
  }
  const wcSorted = [...wcMap.values()].sort(
    (a, b) => a.cycleMonth.localeCompare(b.cycleMonth) || a.weekNumber - b.weekNumber,
  );
  const weekComparison = wcSorted.map((w, i) => {
    const prev = i > 0 && wcSorted[i - 1].cycleMonth === w.cycleMonth ? wcSorted[i - 1] : null;
    // M6: a gap in the uploaded weeks (previous present week number is >1 behind this one) means
    // de-cumulation subtracted against a non-adjacent week, so this week's figure spans the missing
    // week(s) and is NOT a true single-week value. weekHasDecumulationGap centralizes the check so it
    // stays unit-tested; suppressGapSpannedValue then nulls the inflated figures at the source (fix:
    // "suppress + flag") so no consumer can render the misleading number. Stock is a snapshot and
    // stays real even across a gap; month totals telescope from the raw sheets, not these figures.
    const spansGap = weekHasDecumulationGap(prev?.weekNumber ?? null, w.weekNumber);
    const deltaValuePct = prev && prev.salesValue !== 0 ? Number(((w.salesValue - prev.salesValue) / prev.salesValue).toFixed(4)) : null;
    return {
      cycleMonth: w.cycleMonth,
      weekNumber: w.weekNumber,
      weekStart: w.weekStart || null,
      salesValue: suppressGapSpannedValue(spansGap, Number(w.salesValue.toFixed(2))),
      salesUnits: suppressGapSpannedValue(spansGap, Number(w.salesUnits.toFixed(2))),
      stockUnits: Number(w.stockUnits.toFixed(2)),
      deltaValuePct: suppressGapSpannedValue(spansGap, deltaValuePct),
      spansGap,
    };
  });

  // Report sources: the validated sheets that fed this report (the export's "Report Sources" block).
  // Scoped by the time + distributor filters (the sheets actually read); region/product/line are
  // row-level refinements listed separately as applied filters.
  const sources = batches
    .filter((batch) => {
      if (
        scopeVisibleDistributorCodes &&
        !scopeVisibleDistributorCodes.has(normalizeCode(String(batch.distributor_code ?? "")))
      )
        return false;
      if (!passesMultiFilter(distributor, normalizeCode(String(batch.distributor_code ?? "")))) return false;
      if (timeFilterActive) {
        if (!passesMultiFilter(cycleMonthFilter, normalizeText(String(batch.cycle_month ?? "")))) return false;
        if (!passesMultiFilter(weekNumberFilter, batch.week_number != null ? String(batch.week_number) : "")) return false;
        return true;
      }
      return selectedWeekSet.has(String(batch.week_start ?? ""));
    })
    .map((batch) => ({
      distributorCode: String(batch.distributor_code ?? ""),
      distributorName: String(batch.distributor_name ?? ""),
      cycleMonth: batch.cycle_month ? String(batch.cycle_month) : null,
      weekNumber: batch.week_number != null ? Number(batch.week_number) : null,
      weekStart: batch.week_start ? String(batch.week_start) : null,
      fileName: String(batch.file_name ?? ""),
    }))
    .sort(
      (a, z) =>
        a.distributorName.localeCompare(z.distributorName) ||
        String(a.cycleMonth).localeCompare(String(z.cycleMonth)) ||
        (a.weekNumber ?? 0) - (z.weekNumber ?? 0),
    );

  return {
    weekStart: selectedWeekAnchor,
    priorWeekStart: priorCanonical,
    availableWeeks,
    weekGroupMembers: weekGroupMembersObj,
    availableLines,
    availableRegions,
    availableProducts,
    availableMonths,
    availableWeekNumbers,
    distributors: scopeVisibleDistributorCodes
      ? distributors.filter((d) => scopeVisibleDistributorCodes.has(normalizeCode(d.code)))
      : distributors,
    appliedFilters,
    kpis: {
      salesValue: Number(sum(weekRowsAdj, (row) => row.salesValue).toFixed(2)),
      salesUnits: Number(sum(weekRowsAdj, (row) => row.netQty).toFixed(2)),
      stockUnits: Number(sum(weekRowsAdj, (row) => row.stockQty).toFixed(2)),
      branchCount: new Set(weekRowsAdj.map((row) => row.branchCode || row.branchName)).size,
      regionCount: new Set(weekRowsAdj.map((row) => row.regionCode)).size,
      productCount: new Set(weekRowsAdj.map((row) => row.productCode || row.productName)).size,
      distributorCount: new Set(weekRowsAdj.map((row) => row.distributorCode)).size,
    },
    compare: {
      salesValue: delta(sum(weekRowsAdj, (row) => row.salesValue), !timeFilterActive && priorCanonical ? sum(priorRowsAdj, (row) => row.salesValue) : null),
      salesUnits: delta(sum(weekRowsAdj, (row) => row.netQty), !timeFilterActive && priorCanonical ? sum(priorRowsAdj, (row) => row.netQty) : null),
      stockUnits: delta(sum(weekRowsAdj, (row) => row.stockQty), !timeFilterActive && priorCanonical ? sum(priorRowsAdj, (row) => row.stockQty) : null),
    },
    regions: rank(weekRowsAdj, (row) => row.regionCode, (row) => row.regionName),
    products: rank(weekRowsAdj, (row) => row.productCode, (row) => row.productName),
    distributorBreakdown: rank(weekRowsAdj, (row) => row.distributorCode, (row) => row.distributorName),
    branchBreakdown: rankBranches(weekRowsAdj),
    zeroSalesBranches: zeroSalesBranches.slice(0, 100),
    weekComparison,
    sources,
    trend,
    // Row-level grain for the BI export (hidden Data sheet → pivots/charts/formulas). Mirrors the exact
    // rows behind the on-screen aggregates (weekRowsAdj: time-scoped, latest-stock-only) so the workbook's
    // pivots/formulas reconcile to the dashboard. Only built when requested (export path).
    factRows: filters?.includeFactRows
      ? weekRowsAdj.map((row) => ({
          distributorCode: row.distributorCode,
          distributorName: row.distributorName,
          productCode: row.productCode,
          productName: row.productName,
          line: row.officialLine,
          regionCode: row.regionCode,
          regionName: row.regionName,
          branchCode: row.branchCode,
          branchName: row.branchName,
          cycleMonth: row.cycleMonth,
          weekNumber: row.weekNumber,
          weekStart: row.weekStart,
          salesValue: Number(row.salesValue.toFixed(2)),
          salesUnits: Number(row.netQty.toFixed(2)),
          stockUnits: Number(row.stockQty.toFixed(2)),
        }))
      : undefined,
  };
}

// ── product-scope administration ─────────────────────────────────────────────────────────────

// Roles offered as "assignable to a curated product list" in the admin view.
const PRODUCT_SCOPE_ROLES = new Set(["Product Manager", "Group Product Manager", "Marketing Manager"]);

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
    byHrKey.set(key, { name: employee.displayName || employee.hrId, role });
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
