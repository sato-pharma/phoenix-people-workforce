import type { SupabaseClient } from "@supabase/supabase-js";

import { writeAuditLog, type AuditLogInput } from "@/lib/admin/audit";
import { normalizeRole } from "@/lib/auth/permissions";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { canonicalHrIdForDisplay, canonicalHrIdKey } from "@/lib/hr-id";
import { logError } from "@/lib/observability/log";
import { recordTiming } from "@/lib/observability/timings";
import { yieldToEventLoop } from "@/lib/platform/yield-to-event-loop";
import { loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import {
  applyWeeklyAccessScope,
  liftWeeklyGeography,
  listWeeklyProductScopeAssignments,
  requireWeeklyAccessScope,
  type WeeklyAccessScope,
} from "@/lib/sales/weekly/access";
import { SalesWorkflowError, isPostgresUniqueViolation } from "@/lib/sales/contracts";
import { latestNonFuturePeriod } from "@/lib/sales/periods";
import { loadBranchRegionIndex } from "@/lib/sales/weekly/branch-region-map";
import {
  WEEKLY_DISTRIBUTORS,
  canonicalWeeklyDistributorCode,
  directWeeklyUploadRefusal,
  isDirectOrdersWeeklyBatch,
  weeklyDistributorByCode,
  weeklyDistributorIsCumulative,
} from "@/lib/sales/weekly/distributors";
import { parseWeeklyWorkbookBuffer } from "@/lib/sales/weekly/parser";
import { narrowBatchesToCycleMonths } from "@/lib/sales/weekly/batch-scope";
import { bumpWeeklyRowsGeneration, getOrLoadWeeklyRows, weeklyRowCacheKey } from "@/lib/sales/weekly/row-cache";
import { shareDerivedWeeklyRows, weeklyPriceFingerprint } from "@/lib/sales/weekly/derived-rows";
import {
  decumulateProductNet,
  decumulateRows,
  depotWeekGapKeys,
  depotWeekGaps,
  moneySpansDepotGap,
  suppressGapSpannedValue,
  weekHasDecumulationGap,
} from "@/lib/sales/weekly/decumulate";
import { latestStockOnly } from "@/lib/sales/weekly/latest-stock";
import { livePriceMap, liveSalesValue, liveUnitPrice, weeklyRowPeriod } from "@/lib/sales/weekly/live-price";
import { productPeriodPricesFromRows, type ProductPeriodPrices } from "@/lib/sales/product-period-price";
import { narrowWeeklyRowsToOwnAreaShare, type WeeklyOwnAreaShare } from "@/lib/sales/weekly/own-area-share";
import { resolveWeeklyContractWithSource } from "@/lib/sales/weekly/weekly-column-profile-store";
import { loadProductAliasIndex } from "@/lib/sales/weekly/product-aliases";
import { weeklyTemplateDistributorFallbackName } from "@/lib/sales/weekly/templates";
import { groupWeeklyProductsByTrackedLine, notifyWeeklyUploadLines } from "@/lib/sales/weekly/upload-notification";
import {
  applyWeeklyTrackedLineScope,
  weeklyTrackedLineOptions,
  WEEKLY_TRACKED_SCOPE_NOTE,
} from "@/lib/sales/weekly/tracked-lines";
import type {
  WeeklyAreaBasis,
  WeeklyBatch,
  WeeklyBranchComparisonRow,
  WeeklyDashboard,
  WeeklyDashboardUnitView,
  WeeklyDelta,
  WeeklyDistributorOption,
  WeeklyFilterMode,
  WeeklyParsedRow,
  WeeklyProductScopeAdmin,
  WeeklyRanked,
  WeeklySalesValidationResult,
  WeeklyThisWeekOnly,
  WeeklyThisWeekProductNet,
  WeeklyTotals,
  WeeklyUnitFigures,
} from "@/lib/sales/weekly/types";
import { weeklyUnitViewProduct, weeklyWeekKey, weeklyZeroSalesBranches } from "@/lib/sales/weekly/unit-totals";
import { fetchAllRows, fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin, toQueryError } from "@/lib/supabase/server";
import { asyncPool } from "@/lib/utils/async-pool";

/**
 * How many 100-batch chunks of weekly_sales_rows are walked at once in loadWeeklyDashboard. Each
 * chunk is still a serial keyset walk; four keep the PostgREST pool as calm as the other bounded
 * fan-outs in sales. asyncPool clamps it to one in development.
 */
const WEEKLY_ROW_CHUNK_CONCURRENCY = 4;

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
 * The previous sheet's net units, added up per product from its stored rows, keyed the way the sheet's own
 * By product table is (the product code, else its name). Null when the rows cannot be read: the caller then
 * has no per-product figure to print and says so, rather than reading a failure as "nothing to subtract".
 * A sheet runs to a few thousand rows, past the 1,000 a single read returns, so it is paged.
 */
async function loadPriorSheetProductNet(batchId: string): Promise<WeeklyThisWeekProductNet[] | null> {
  type PriorRow = { id: number; product_code: string | null; product_name: string | null; net_qty: number | string | null };
  try {
    const rows = await fetchAllRowsKeyset<PriorRow>(
      () => getSupabaseAdmin().from("weekly_sales_rows").select("id, product_code, product_name, net_qty").eq("batch_id", batchId),
      { cursorColumn: "id", cursorOf: (row) => row.id },
    );
    return rows.map((row) => ({ productCode: row.product_code || row.product_name || "—", netQty: Number(row.net_qty ?? 0) }));
  } catch (error) {
    logError("weekly_this_week_prior_rows_unreadable", {
      error,
      labels: { event: "weekly_this_week_prior_rows_unreadable" },
      context: { batchId },
    });
    return null;
  }
}

/**
 * De-cumulate this sheet's totals against the previous cumulative sheet of the same month-cycle.
 * Returns the real "this week only" sales (value + net units); stock is a snapshot, returned as-is.
 * When no earlier sheet exists in the cycle, this IS the first week → real = the full current totals.
 *
 * The net units are also returned ONE PRODUCT AT A TIME (`productNetQty`), because the sheet-level figure
 * adds every product and units of different products are never added (owner rule, 2026-08-27).
 *
 * A distributor whose sheets are NOT cumulative (Direct) is exempt: its sheet already holds only this
 * week's orders, so there is nothing to subtract and the prior-batch lookup is skipped entirely.
 */
async function computeThisWeekOnly(
  distributorCode: string,
  cycleMonth: string | null,
  weekStart: string | null,
  totals: WeeklyTotals,
  byProduct: readonly WeeklyThisWeekProductNet[],
): Promise<WeeklyThisWeekOnly | null> {
  if (!cycleMonth || !weekStart) return null;
  // Nothing to subtract: each product's own cumulative figure is its week.
  const firstSheet = (): WeeklyThisWeekOnly => ({
    priorWeekStart: null,
    priorWeekNumber: null,
    salesValue: round2(totals.salesValue),
    netQty: round2(totals.netQty),
    stockQty: round2(totals.stockQty),
    productNetQty: decumulateProductNet(byProduct, null),
  });
  if (!weeklyDistributorIsCumulative(distributorCode)) {
    return firstSheet();
  }
  const supabase = getSupabaseAdmin();
  const prior = await supabase
    .from("weekly_sales_batches")
    .select("id, week_start, week_number, total_sales_value, total_net_qty")
    .eq("distributor_code", distributorCode)
    .eq("cycle_month", cycleMonth)
    .eq("status", "validated")
    .lt("week_start", weekStart)
    .order("week_start", { ascending: false })
    .limit(1);
  if (prior.error || !prior.data || prior.data.length === 0) {
    return firstSheet();
  }
  const p = prior.data[0] as {
    id: string;
    week_start: string | null;
    week_number: number | null;
    total_sales_value: number | null;
    total_net_qty: number | null;
  };
  const priorProducts = await loadPriorSheetProductNet(String(p.id));
  return {
    priorWeekStart: p.week_start ? String(p.week_start) : null,
    priorWeekNumber: p.week_number != null ? Number(p.week_number) : null,
    salesValue: round2(totals.salesValue - Number(p.total_sales_value ?? 0)),
    netQty: round2(totals.netQty - Number(p.total_net_qty ?? 0)),
    stockQty: round2(totals.stockQty),
    productNetQty: priorProducts ? decumulateProductNet(byProduct, priorProducts) : null,
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
  /**
   * `false` uploads the sheet without telling the line managers about it — the weekly counterpart
   * of the monthly closing's silent publish, for a correction or a back-fill that nobody needs to
   * be mailed about. Defaults to notifying, which is the owner's asked-for behaviour; only an
   * explicit false suppresses it, so a caller can never inherit a silence it did not ask for.
   */
  notify?: boolean;
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
  // The lines whose managers this upload will email. Stamped on the dry-run too, so the wizard can
  // name the audience on the review screen instead of the operator finding out by having sent it.
  parsed.result.notifiableLines = [...groupWeeklyProductsByTrackedLine(parsed.result.byProduct).byLine.keys()].sort();

  // Week-of-month tagging: cycle = month of the sheet date (override-able); week = confirmed value
  // from the wizard, else the date-derived suggestion. Both flow through to the stored batch + rows.
  const suggestedWeek = suggestWeekNumber(parsed.result.weekStart);
  const cycleMonth = input.cycleMonth ?? cycleMonthFromDate(parsed.result.weekStart);
  const weekNumber = input.weekNumber ?? suggestedWeek;
  parsed.result.suggestedWeekNumber = suggestedWeek;
  parsed.result.cycleMonth = cycleMonth;
  parsed.result.weekNumber = weekNumber;
  // From August 2026 Direct's weekly sales are written from the approved orders themselves; an
  // uploaded sheet would double count them. Refused here — before the dry-run preview as well as the
  // store — so the operator learns it on the review screen, not after confirming.
  const directRefusal = directWeeklyUploadRefusal(parsed.result.distributor.code, cycleMonth, parsed.result.weekStart);
  if (directRefusal) throw new SalesWorkflowError("direct_weekly_from_orders", directRefusal, 409);
  // De-cumulated "this week only" preview vs the previous cumulative sheet of this cycle.
  parsed.result.thisWeekOnly = await computeThisWeekOnly(
    parsed.result.distributor.code,
    cycleMonth,
    parsed.result.weekStart,
    parsed.result.totals,
    parsed.result.byProduct.map((product) => ({ productCode: product.productCode, netQty: product.netQty })),
  );

  // Only persist a clean (validated) batch; blocked files are returned for the user to fix.
  // dryRun=true skips persistence so the validate step can show tables without storing anything.
  if (!input.dryRun && parsed.result.status === "validated") {
    const { batchId, createdAt } = await persistWeeklyUpload(parsed.rows, parsed.result, input.uploadedBy);

    // Tell each tracked line's District Managers and NSM that their products were read from this
    // sheet (owner request, 2026-09-09). Deliberately sited HERE rather than in the upload route:
    // this is the one place a batch actually persists, so the notification cannot fire for a
    // dry-run validate, for a blocked file, or for a duplicate that threw above — every one of
    // which reaches the route as a perfectly ordinary call.
    //
    // Best-effort and un-awaited: the rows are already stored, so an email failure must never turn
    // a successful upload into an error response for the person who uploaded it.
    if (input.notify !== false) {
      notifyWeeklyUploadLines({
        batchId,
        byProduct: parsed.result.byProduct,
        distributorName: parsed.result.distributor.name,
        weekNumber: parsed.result.weekNumber,
        weekStart: parsed.result.weekStart,
      }).catch((notifyError) => {
        logError("weekly_upload_notification_failed", {
          error: notifyError,
          labels: { event: "weekly_upload_notification_failed" },
          context: { batchId, distributorCode: parsed.result.distributor.code },
        });
      });
    }

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
      // Free units. Hard-coded 0 from 2026-06-15 (58d87eda), when no adapter produced a bonus and 0
      // was therefore equivalent. POS bonus parsing landed 8 days later (c5b782f1, "system-wide bonus
      // tracking") and wired bonus through the parser, the totals and WeeklyBatch.totalBonusQty — but
      // never restored these two persist lines, so every POS bonus unit was parsed and then dropped.
      total_bonus_qty: result.totals.bonusQty,
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
    // Read for audit, never priced (see WeeklyParsedRow.bonusQty) — but stored, so it exists to audit.
    bonus_qty: row.bonusQty,
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
      bumpWeeklyRowsGeneration("upload_rolled_back");
      throw new SalesWorkflowError("persist_failed", insert.error.message, 500);
    }
  }
  // The batch was visible as validated while its rows were still landing, so a dashboard read in
  // between may have cached a part of it — drop every cached read now that the whole batch is in.
  bumpWeeklyRowsGeneration("upload");

  return { batchId, createdAt: String(batchInsert.data.created_at) };
}

// ── upload history ───────────────────────────────────────────────────────────────────────────

// Every upload, newest first, paged: the Upload page lists these to be deleted or re-tagged, so a fixed
// window (it was the newest 100, with 94 uploads on production) would put the oldest out of reach.
export async function listWeeklyBatches(): Promise<WeeklyBatch[]> {
  const supabase = getSupabaseAdmin();
  try {
    const data = await fetchAllRows<Record<string, unknown>>(
      () => supabase.from("weekly_sales_batches").select("*").order("created_at", { ascending: false }),
      "id",
    );
    return data.map(mapBatch);
  } catch (error) {
    throw new SalesWorkflowError("load_failed", toQueryError(error).message, 500);
  }
}

// What the audit row keeps of an upload. A delete leaves nothing to read afterwards — the batch goes,
// and every row it stored goes with it (ON DELETE CASCADE) — so this is read BEFORE the change.
const WEEKLY_BATCH_AUDIT_COLUMNS =
  "id,distributor_code,distributor_name,template_key,file_name,week_start,cycle_month,week_number,status,total_rows,total_net_qty,total_sales_value,uploaded_by,created_at";

/**
 * A batch the Direct Orders module wrote is rebuilt from the orders on every change to one. Deleting
 * it would leave the weeks short until the next order moves; re-tagging it would strand it outside
 * the month the rebuild owns, where it would be counted beside its own replacement.
 */
function refuseDirectOrdersBatchEdit(row: Record<string, unknown>, verb: "deleted" | "re-tagged"): void {
  if (!isDirectOrdersWeeklyBatch(row.template_key as string | null | undefined)) return;
  throw new SalesWorkflowError(
    "direct_orders_batch",
    `This weekly batch is written by the Direct Orders module from the orders Finance booked, so it cannot be ${verb} ` +
      `by hand. Change the order (its sales month or collection date) and the batch follows.`,
    409,
  );
}

/**
 * Only tests pass these. The suite runs with production credentials, so a test hands in the fixture
 * client and a recording audit writer, and neither function then builds a real client of its own.
 */
export type WeeklyBatchWriteDependencies = {
  client?: SupabaseClient;
  writeAudit?: (input: AuditLogInput) => Promise<void>;
};

function weeklyBatchAuditSnapshot(row: Record<string, unknown>) {
  return {
    distributorCode: row.distributor_code ?? null,
    distributorName: row.distributor_name ?? null,
    fileName: row.file_name ?? null,
    weekStart: row.week_start ?? null,
    cycleMonth: row.cycle_month ?? null,
    weekNumber: row.week_number ?? null,
    status: row.status ?? null,
    totalRows: row.total_rows ?? null,
    totalNetQty: row.total_net_qty ?? null,
    totalSalesValue: row.total_sales_value ?? null,
    uploadedBy: row.uploaded_by ?? null,
    uploadedAt: row.created_at ?? null,
  };
}

// "week 2 of September 2026". Built and read in UTC, so the server's own time zone can never move
// the first of a month into the month before.
function weeklyBatchWeekLabel(cycleMonth: unknown, weekNumber: unknown): string {
  const match = typeof cycleMonth === "string" ? /^(\d{4})-(\d{2})/.exec(cycleMonth) : null;
  if (!match || weekNumber == null) return "no week tag";
  const month = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)).toLocaleDateString("en-GB", {
    month: "long",
    timeZone: "UTC",
    year: "numeric",
  });
  return `week ${weekNumber} of ${month}`;
}

/**
 * Delete one weekly upload and every row it stored, and record who did it and which upload it was.
 * Returns false, and records nothing, when there is no such batch.
 *
 * The audit row is best-effort (`writeAuditLog`), as for a Source of Sales sheet: it is written after
 * the delete has landed, so failing it would report a finished delete as a failed one. A failed write
 * is still logged as `audit_persistence_failed`.
 */
export async function deleteWeeklyBatch(
  input: { actorLoginId: string; batchId: string },
  dependencies: WeeklyBatchWriteDependencies = {},
): Promise<boolean> {
  const batchId = (input.batchId ?? "").trim();
  if (!batchId) throw new SalesWorkflowError("invalid_request", "Missing batch id.", 400);
  const supabase = dependencies.client ?? getSupabaseAdmin();
  const writeAudit = dependencies.writeAudit ?? writeAuditLog;

  const existing = await supabase
    .from("weekly_sales_batches")
    .select(WEEKLY_BATCH_AUDIT_COLUMNS)
    .eq("id", batchId)
    .maybeSingle();
  if (existing.error) throw new SalesWorkflowError("delete_failed", existing.error.message, 500);
  if (!existing.data) return false;
  refuseDirectOrdersBatchEdit(existing.data as Record<string, unknown>, "deleted");
  const before = weeklyBatchAuditSnapshot(existing.data as Record<string, unknown>);

  const { error } = await supabase.from("weekly_sales_batches").delete().eq("id", batchId);
  if (error) throw new SalesWorkflowError("delete_failed", error.message, 500);
  bumpWeeklyRowsGeneration("delete");

  await writeAudit({
    actorLoginId: input.actorLoginId,
    entityId: batchId,
    entityType: "weekly_sales_batch",
    oldValues: before,
    summary: `Weekly sales upload deleted: ${before.distributorName ?? before.distributorCode}, ${before.fileName}, ${weeklyBatchWeekLabel(before.cycleMonth, before.weekNumber)}.`,
  });
  return true;
}

/**
 * Re-tag a batch's month-cycle + week-of-month. Used to correct boundary sheets (e.g. a sheet dated
 * on the 1st that actually closes the prior month) so de-cumulation pairs them with the right cycle.
 * Updates the batch header and all of its rows together, and records the week it moved from and to.
 */
export async function retagWeeklyBatch(
  input: {
    actorLoginId: string;
    batchId: string;
    cycleMonth: string;
    weekNumber: number;
  },
  dependencies: WeeklyBatchWriteDependencies = {},
): Promise<boolean> {
  const batchId = (input.batchId ?? "").trim();
  if (!batchId) throw new SalesWorkflowError("invalid_request", "Missing batch id.", 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.cycleMonth)) {
    throw new SalesWorkflowError("invalid_request", "cycleMonth must be a YYYY-MM-DD date (first of the month).", 400);
  }
  if (![1, 2, 3, 4].includes(input.weekNumber)) {
    throw new SalesWorkflowError("invalid_request", "weekNumber must be 1, 2, 3 or 4.", 400);
  }
  const supabase = dependencies.client ?? getSupabaseAdmin();
  const writeAudit = dependencies.writeAudit ?? writeAuditLog;

  const existing = await supabase
    .from("weekly_sales_batches")
    .select(WEEKLY_BATCH_AUDIT_COLUMNS)
    .eq("id", batchId)
    .maybeSingle();
  if (existing.error) throw new SalesWorkflowError("update_failed", existing.error.message, 500);
  if (!existing.data) throw new SalesWorkflowError("update_failed", "Batch not found.", 404);
  refuseDirectOrdersBatchEdit(existing.data as Record<string, unknown>, "re-tagged");
  const before = weeklyBatchAuditSnapshot(existing.data as Record<string, unknown>);

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
  bumpWeeklyRowsGeneration("retag");

  // The header has moved by now whether or not its rows followed, so the audit row is written either
  // way and says which: a header on one week with its rows still on another is otherwise invisible.
  const from = weeklyBatchWeekLabel(before.cycleMonth, before.weekNumber);
  const to = weeklyBatchWeekLabel(input.cycleMonth, input.weekNumber);
  await writeAudit({
    actorLoginId: input.actorLoginId,
    entityId: batchId,
    entityType: "weekly_sales_batch",
    newValues: { cycleMonth: input.cycleMonth, rowsRetagged: !rowsUpdate.error, weekNumber: input.weekNumber },
    oldValues: { cycleMonth: before.cycleMonth, weekNumber: before.weekNumber },
    summary: rowsUpdate.error
      ? `Weekly sales upload re-tagged: ${before.distributorName ?? before.distributorCode}, ${before.fileName}, moved from ${from} to ${to}, but its stored rows could not be moved with it.`
      : `Weekly sales upload re-tagged: ${before.distributorName ?? before.distributorCode}, ${before.fileName}, moved from ${from} to ${to}.`,
  });
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

/** One validated upload as the dashboard reads it for its week picker, its sources and its row fetch. */
type DashboardBatch = {
  cycle_month: string | null;
  distributor_code: string | null;
  distributor_name: string | null;
  file_name: string | null;
  id: string;
  week_number: number | null;
  week_start: string | null;
};

type FactRow = {
  /**
   * The upload this row came from (weekly_sales_batches.id).
   *
   * The ONLY safe identity for "the sheet I am looking at". week_start is not: computeWeekGroups
   * collapses dates less than 5 days apart and expands any selection back to the whole group, which
   * is what silently pulled neighbouring weeks into a single-sheet export.
   */
  batchId: string;
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
  /** How the row reached the viewer, on a load that follows his own areas (ownAreaShare) only. */
  areaBasis?: WeeklyAreaBasis;
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

export async function loadWeeklyDashboard(filters: {
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
  /**
   * THE FUTURE-MONTH RULE for a screen's first paint: when no month was asked for, open on the newest
   * uploaded month that has STARTED (Cairo) instead of "All months", and report it in
   * `appliedFilters.cycleMonths` so the screen can show what it is on. Clearing the month on the
   * screen still asks for all months, because the API route never sets this. Ignored when a month was
   * named, and when every uploaded month is still in the future.
   */
  defaultToLatestStartedMonth?: boolean;
  /** Week-of-month filter (1–4) + mode. Empty = all weeks. */
  weekNumbers?: number[] | null;
  weekNumberMode?: WeeklyFilterMode | null;
  /**
   * Restrict to specific uploads by `weekly_sales_batches.id`. Empty/omitted = every upload in scope.
   *
   * This is the only unambiguous way to say "the sheet I am looking at": week_start is not, because
   * computeWeekGroups() collapses dates less than 5 days apart and expands a selection back to the
   * whole group. Applied in memory AFTER de-cumulation — see the filter site for why narrowing the
   * fetch instead would report cumulative figures.
   */
  batchIds?: string[] | null;
  /**
   * Per-viewer visibility tier (full / product / territory / none). REQUIRED, and there is no default.
   *
   * This read runs on the service-role client, which bypasses RLS, so this argument is the only thing
   * between a viewer and the restricted products and the Head Office line. It used to default to "full
   * access, restricted products revealed", which meant a caller that forgot it leaked instead of failing.
   * A missing or unrecognised scope now throws before anything is read (requireWeeklyAccessScope).
   */
  accessScope: WeeklyAccessScope;
  /**
   * Narrow the ROW fetch to these cycle months (first-of-month YYYY-MM-DD), on top of whatever the
   * week window already selected. Empty/omitted = no narrowing (current behaviour).
   *
   * Safe for every aggregate: decumulateRows() groups by (distributorCode, cycleMonth) and those
   * groups are self-contained — the first week of a cycle de-cumulates against itself — so keeping
   * WHOLE months can never split a de-cumulation chain. Batch cycle_month is a faithful stand-in for
   * row cycle_month (verified against production: 0 mismatches across all validated rows).
   *
   * NOT a general substitute for `cycleMonths`. `cycleMonths` filters in memory and therefore leaves
   * the derived option universes (availableMonths / availableWeekNumbers / availableRegions /
   * availableProducts / availableLines) computed over the FULL history, which is what keeps the
   * dashboard's dropdowns from collapsing to the current selection. This narrows the fetch itself, so
   * those option lists come back scoped to the months requested. **Only pass it when the caller
   * discards the option lists** — as computeWeeklyComparison() does, needing only the aggregates.
   */
  narrowRowsToCycleMonths?: string[] | null;
  /** Export only: drop rows whose product is unmapped (no master / no line) from EVERY aggregate. */
  excludeUnmapped?: boolean;
  /** Export only: also return the row-level fact grain (factRows) for the BI workbook's Data sheet. */
  includeFactRows?: boolean;
  /**
   * Depot Detail only: factRows keep their sales value and units unrounded. Every other caller gets them
   * rounded to 2 decimals, as the BI workbook always has. Rows rounded one by one add up to a different
   * figure from `kpis` (EGP 8 over every month), so a screen that totals these rows needs them unrounded.
   */
  factRowsFullPrecision?: boolean;
  /**
   * Weekly Stock only: also return `stockRows` — every scoped row across the fetched weeks, de-cumulated
   * but NOT narrowed to the selected week and NOT latest-stock-adjusted, because the stock builder picks
   * each distributor's own snapshot and sales window itself.
   */
  includeStockRows?: boolean;
  /**
   * Weekly Stock only: build `stockRows` with a territory viewer's REGION and AREA bounds lifted
   * (liftWeeklyGeography) — his line bound, the confidential products and the Head Office strip all
   * stay, and every filter above still applies. Nothing else on the payload moves.
   *
   * The row grain is then WIDER than the viewer may see, so a caller that sets this MUST narrow those
   * rows to his own areas before building any figure from them (admitWeeklyStockRows). No effect on a
   * full, product or none tier, and none alongside `ownAreaShare`, whose rows are already his.
   */
  liftRowGrainGeography?: boolean;
  /**
   * A manager's screens: EVERY figure follows his own areas (owner, 2026-09-17). His rows are read with
   * his region bound lifted and narrowed at once to his own areas' share of each depot, plus the unplaced
   * residue his own scope admits (own-area-share.ts), so the KPIs, trend, rankings, option lists,
   * weekComparison and factRows all agree. A promise, so the caller can read the split and seat indexes
   * alongside the rows; it must not reject. No effect on a viewer who may not lift (mayLiftWeeklyGeography).
   */
  ownAreaShare?: WeeklyOwnAreaShare | Promise<WeeklyOwnAreaShare | null> | null;
  /**
   * The product whose units `unitView` holds — the screen's "Units for" pick. Omitted, or a code this
   * selection no longer holds, reads as the top product by value (weeklyUnitViewProduct).
   */
  unitProductCode?: string | null;
}): Promise<WeeklyDashboard> {
  // First statement, before any read: a caller with no scope gets an error, never "everything".
  const accessScope = requireWeeklyAccessScope(filters?.accessScope);
  const supabase = getSupabaseAdmin();
  const loadStartedAt = Date.now();

  // STARTED HERE, READ BELOW (2026-10-01, "slow to transfer between page and page"): the Product
  // Master behind the live price sync depends on nothing this function reads, so it runs beside the
  // batch list and the row fetch instead of after them. Consumed exactly where it always was, inside
  // the same best-effort try; the guard only keeps an early empty answer from leaving it unhandled.
  const liveReferenceLoad = loadSalesReferenceData({ includeCustomerBricks: false });
  liveReferenceLoad.catch(() => {});

  // Validated batches — ordered newest-first, ALL of them, paged. With no week named the dashboard
  // defaults to every week this list holds, so a fixed window here (it was the newest 200) would drop
  // the oldest weeks out of the totals and the week picker with nothing on screen to say so.
  let batches: DashboardBatch[];
  try {
    batches = await fetchAllRows<DashboardBatch>(
      () =>
        supabase
          .from("weekly_sales_batches")
          .select("id, week_start, cycle_month, week_number, distributor_code, distributor_name, file_name")
          .eq("status", "validated")
          .order("week_start", { ascending: false }),
      "id",
    );
  } catch (error) {
    throw new SalesWorkflowError("load_failed", toQueryError(error).message, 500);
  }

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
  // Did the viewer name a line themselves? That is the escape hatch out of the tracked-line default
  // scope (GOLDEN RULE, see tracked-lines.ts). Include-mode only: "everything except CNS" is not a
  // request for Head Office, and must not quietly pull 78% of the table back in.
  const lineNamedExplicitly = line.has && line.mode === "include";
  const askedForCycleMonths = (filters?.cycleMonths ?? []).some((value) => normalizeText(value));
  const defaultedCycleMonth =
    filters?.defaultToLatestStartedMonth && !askedForCycleMonths
      ? latestNonFuturePeriod(batches.map((batch) => normalizeText(String(batch.cycle_month ?? ""))).filter(Boolean))
      : null;
  const cycleMonthFilter = resolveMultiFilter(
    defaultedCycleMonth ? [defaultedCycleMonth] : filters?.cycleMonths,
    null,
    defaultedCycleMonth ? "include" : filters?.cycleMonthMode,
    normalizeText,
  );
  // Uploads are matched by exact id, so no include/exclude mode and no normalisation — a uuid is a uuid.
  const batchIdFilter = new Set((filters?.batchIds ?? []).map((value) => normalizeText(value)).filter(Boolean));
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
  const distributorsForEmpty = accessScope.tier === "full" ? distributors : [];

  // Upload picker options, newest first. Built from the batch list already in hand, so this costs no
  // extra query. Label is human-readable per the owner's standing rule — never a bare uuid.
  const uploadOption = (batch: (typeof batches)[number]) => ({
    code: String(batch.id),
    name: [
      String(batch.distributor_name ?? batch.distributor_code ?? "—"),
      batch.week_start ? String(batch.week_start) : "undated",
      batch.week_number != null ? `W${batch.week_number}` : null,
    ]
      .filter(Boolean)
      .join(" · "),
  });

  const empty = (): WeeklyDashboard => ({
    weekStart: selectedWeekAnchor,
    priorWeekStart: priorCanonical,
    trackedScope: { active: !lineNamedExplicitly, note: WEEKLY_TRACKED_SCOPE_NOTE },
    availableWeeks,
    weekGroupMembers: weekGroupMembersObj,
    availableLines: [],
    availableRegions: [],
    availableProducts: [],
    availableMonths: [],
    availableWeekNumbers: [],
    // Still offered even when there is nothing to show: the viewer must be able to pick a different
    // upload to get out of an empty view.
    availableUploads: distributorsForEmpty.length > 0 ? batches.map(uploadOption) : [],
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
  if (accessScope.tier === "product" && accessScope.productCodes.size === 0) {
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
  const scopeIsBoundedProduct = accessScope.tier === "product" && accessScope.productCodes.size > 0;
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
  // Opt-in fetch narrowing (see narrowRowsToCycleMonths). Applied AFTER the week-window choice so it
  // only ever removes batches: a caller that wants one month's aggregates stops paying for the whole
  // history. Whole months only — see batch-scope.ts for why that is the one safe unit.
  // Same narrowing, driven by the dashboard's OWN month filter rather than a caller opt-in. Without
  // it every filter change re-pages the entire validated history — measured on production data:
  // 34,838 rows over 35 round trips, 7-20s per load — and because the numbers already on screen are
  // left in place for that whole time, the previous UNFILTERED total is what the user keeps seeing.
  // That is the "period filter does nothing / full value still shows" report, not a filter that
  // fails to apply (the in-memory filters below were verified correct against production).
  // Whole months only, so de-cumulation chains stay intact (see batch-scope.ts).
  // INCLUDE mode only: an exclude selection names the months to DROP, so it cannot become a
  // fetch whitelist. Restricted tiers are left on the old full fetch so the option universes they
  // derive from rows stay bit-for-bit unchanged.
  const narrowToSelectedMonths =
    accessScope.tier === "full" &&
    cycleMonthFilter.has &&
    cycleMonthFilter.mode === "include"
      ? [...cycleMonthFilter.set]
      : null;
  const batchIdsForRows = narrowBatchesToCycleMonths(
    narrowBatchesToCycleMonths(
      allWeeksRequested || scopeIsBoundedProduct
        ? batches
        : batches.filter((b) => windowCycleKeys.has(`${b.distributor_code}||${b.cycle_month ?? ""}`)),
      filters?.narrowRowsToCycleMonths,
    ),
    narrowToSelectedMonths,
  ).map((b) => String(b.id));
  if (batchIdsForRows.length === 0) return empty();
  const validIds = new Set(batchIdsForRows);
  const allRows: FactRow[] = [];
  const pageSize = 1000;

  const fetchStart = Date.now();
  // batch_id narrowing is safe: options (weeks, distributors) come from the batch list, not
  // these rows, so filtering here never collapses the filter dropdowns.
  // Region/product/line stay IN MEMORY so exclude-mode and full option lists remain correct.
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
  // `id` is fetched ONLY as the keyset cursor (below); it is never mapped into FactRow.
  const rowColumns =
    "id, batch_id, week_start, cycle_month, week_number, distributor_code, distributor_name, region_code, region_name, area_code, branch_code, branch_name, product_code, product_name, official_line, sales_value, sales_qty, net_qty, stock_qty";
  // PostgREST folds every .in() value into the request URL; an unbatched array of a few hundred
  // ids can push the URL past undici's ~16KB header limit and throw "TypeError: fetch failed" /
  // HeadersOverflowError — batchIdsForRows is unbounded when allWeeks/product-scoped, so chunk it.
  //
  // Within each chunk we page by KEYSET (WHERE id > lastId ORDER BY id), not OFFSET. The old
  // count-exact + concurrent-OFFSET paging made every page re-scan the whole batch window and
  // re-sort it by id — no index yields `batch_id = ANY(...)` already in id order — so a 36-page
  // load paid an ~81ms full scan+sort 36 times over (measured on prod: this statement was 84% of
  // all weekly_sales_rows DB time). Keyset lets the PK index scan resume where the previous page
  // ended and stop after pageSize matches: ~2.4ms/page, identical rows in the identical id order.
  // The exact row count is gone with it — it only ever drove the OFFSET math.
  //
  // CHUNKS WALKED FOUR AT A TIME (2026-10-01, "slow to transfer between page and page"), where they
  // used to go one after another. Each chunk still pages by keyset inside itself, and the chunks'
  // rows are joined back in CHUNK order — asyncPool keeps input order — so `allRows` holds the
  // identical rows in the identical order the one-by-one walk produced, which is what de-cumulation
  // and every figure below read. Serial in development, by asyncPool's own clamp.
  // CACHED SINCE 2026-10-04 (row-cache.ts): the same rows for the same batches are served from memory
  // for up to 60 s, until any weekly write bumps the generation. Only the RAW rows are kept — the live
  // re-pricing and de-cumulation below still run on every call, on copies.
  const loadRawRows = async (): Promise<{ rows: FactRow[]; pages: number }> => {
    const fetchedRows: FactRow[] = [];
    let fetchedPages = 0;
    const batchIdChunks: string[][] = [];
    for (let bi = 0; bi < batchIdsForRows.length; bi += 100) batchIdChunks.push(batchIdsForRows.slice(bi, bi + 100));
    const chunkResults = await asyncPool(WEEKLY_ROW_CHUNK_CONCURRENCY, batchIdChunks, async (batchIdBatch) => {
      const chunkRows: FactRow[] = [];
      let chunkPages = 0;
      let cursor: number | null = null;
      for (;;) {
        let q = supabase
          .from("weekly_sales_rows")
          .select(rowColumns)
          .order("id", { ascending: true })
          .limit(pageSize)
          .in("batch_id", batchIdBatch);
        if (cursor !== null) q = q.gt("id", cursor);
        if (distributorCodesForQuery && distributorCodesForQuery.length > 0)
          q = q.in("distributor_code", distributorCodesForQuery);
        const page = await q;
        if (page.error) throw new SalesWorkflowError("load_failed", page.error.message, 500);
        const rows = page.data ?? [];
        chunkPages += 1;
        for (const row of rows) {
          if (!validIds.has(String(row.batch_id))) continue; // skip rows from blocked batches
          chunkRows.push({
            batchId: String(row.batch_id ?? ""),
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
        if (rows.length < pageSize) break; // short page ⇒ chunk exhausted
        cursor = Number(rows[rows.length - 1].id); // advance by last FETCHED id (before validIds filter)
      }
      return { rows: chunkRows, pages: chunkPages };
    });
    for (const chunk of chunkResults) {
      for (const row of chunk.rows) fetchedRows.push(row);
      fetchedPages += chunk.pages;
    }
    return { rows: fetchedRows, pages: fetchedPages };
  };
  const rawRows = await getOrLoadWeeklyRows(
    weeklyRowCacheKey({ batches, batchIds: batchIdsForRows, distributorCodes: distributorCodesForQuery }),
    loadRawRows,
  );
  for (const row of rawRows.rows) allRows.push(row);
  const totalPagesFetched = rawRows.pages;
  console.info(JSON.stringify({
    event: "weekly_sales_rows_fetch",
    totalRows: allRows.length,
    totalPages: totalPagesFetched,
    pagination: "keyset",
    cache: rawRows.cache,
    fetchMs: Date.now() - fetchStart,
    batchCount: batchIdsForRows.length,
  }));

  // Live price sync: Product Master factory_price is the single source of truth. Recompute each
  // non-Direct row's value from the CURRENT master price (netQty × price) so any price edit in
  // Product Master reflects immediately across every weekly surface (dashboard, export, portal) —
  // without re-uploading. Runs on the cumulative rows BEFORE de-cumulation, so value stays linear in
  // qty and all downstream numbers stay consistent. The rule lives in live-price.ts, which the
  // Upload screen's Combined Report reads too:
  //   • Direct channel keeps its own sheet Value (locked invariant — never recompute from price).
  //   • A missing/zero current master price falls back to the stored value (never zero a row).
  //   • A dated price covers its own months (Saginko: 170.52 from 2026-10 while the master stays
  //     111.15), read off the row's cycle month — one month per de-cumulation group, so linear still.
  let priceMap = new Map<string, number>();
  let datedPrices: Pick<ProductPeriodPrices, "priceFor"> | undefined;
  const mappedCodes = new Set<string>(); // master products that have a line (i.e. properly mapped)
  // product_code -> family NAME. Deliberately the name, not family_code: the code is NOT unique —
  // "DO" is shared by both Dopaminict and Dolabactin, so grouping on it would merge two families.
  const familyByCode = new Map<string, string>();
  // What the re-pricing below reads, as one string — the derived rows are shared only while it is the same.
  let priceFingerprint = weeklyPriceFingerprint(null, null);
  try {
    const reference = await liveReferenceLoad;
    priceMap = livePriceMap(reference.products);
    priceFingerprint = weeklyPriceFingerprint(reference.products, reference.productPriceOverrides ?? []);
    datedPrices = productPeriodPricesFromRows(reference.products, reference.productPriceOverrides ?? []);
    for (const masterProduct of reference.products) {
      const code = normalizeCode(masterProduct.productCode);
      if (!code) continue;
      if ((masterProduct.line ?? "").trim()) mappedCodes.add(code);
      const family = (masterProduct.family ?? "").trim();
      if (family) familyByCode.set(code, family);
    }
  } catch {
    // Best-effort: if the master can't be read, keep stored values rather than failing the load.
  }
  // Re-price and de-cumulate. Neither depends on the viewer — only on these rows and the prices — so it
  // runs ONCE per cached load and price list, and every viewer gets copies (derived-rows.ts). Nine reps
  // opening Weekly Stock together used to do it nine times over the same 66,526 rows and froze the
  // server for 3.1 s (12 Nov 2026). The pauses let the server answer everyone else between the steps.
  const derived = await shareDerivedWeeklyRows<FactRow>(rawRows.source, priceFingerprint, async () => {
    await yieldToEventLoop();
    if (priceMap.size > 0) {
      for (const row of allRows) {
        row.salesValue = liveSalesValue(
          {
            distributorCode: row.distributorCode,
            productCode: row.productCode,
            netQty: row.netQty,
            storedValue: row.salesValue,
            period: weeklyRowPeriod(row.cycleMonth, row.weekStart),
          },
          priceMap,
          datedPrices,
        );
      }
    }
    await yieldToEventLoop();
    // De-cumulate the cumulative sheets into real per-week rows BEFORE anything else, so every number
    // downstream (KPIs, trend, rankings, week-over-week) reflects true weekly sales — not running totals.
    const realRows = decumulateRows(allRows);
    // Read over every loaded row, before any scope or filter, because that is the set decumulateRows
    // subtracted from: a depot's week spans a gap only when the depot sent no sheet at all for the week
    // before it, whatever lines or regions this viewer may see.
    const depotGaps = depotWeekGaps(allRows);
    return { realRows, depotGaps };
  });
  const realRows = derived.realRows;
  const depotGaps = derived.depotGaps;
  const depotGapKeys = depotWeekGapKeys(depotGaps);
  await yieldToEventLoop();

  // Per-viewer visibility: full / product-scoped / territory-scoped / none. Restricted Lacto
  // Basic products are stripped for every tier except a full-access viewer allowed to reveal them.
  // The scope was resolved and checked at the top of this function; there is no fallback to fall open to.
  // A manager's own areas' share, when the caller asked for it: the one place his rows are chosen, so
  // every aggregate and option list below is built from the same rows.
  const ownAreaShare = filters?.ownAreaShare ? await filters.ownAreaShare : null;
  const visibleRows = ownAreaShare
    ? narrowWeeklyRowsToOwnAreaShare(realRows, accessScope, ownAreaShare)
    : applyWeeklyAccessScope(realRows, accessScope);
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
  // GOLDEN RULE — see tracked-lines.ts. Weekly Sales is CNS / Anti Infective / Pedia; Head Office is
  // used in neither weekly nor monthly sales, so it is out of scope here AND out of the Line filter
  // (2026-08-30, the owner: "remove head office from the line filter"). availableLines below is
  // therefore run through weeklyTrackedLineOptions. An explicit ?line= on the API still reaches
  // untracked rows via includeUntracked, so the import and admin checks keep a way in; what changed
  // is that no screen can select it, which is the whole point — before this, one click on a dropdown
  // entry turned a 4M report into a 41M one with nothing on the page saying which had happened.
  const trackedRows = applyWeeklyTrackedLineScope(visibleRows, { includeUntracked: lineNamedExplicitly });
  // Named, because the lifted row grain below must pass exactly the same filters.
  const passesRowFilters = (row: FactRow): boolean => {
    if (dropUnmapped && !mappedCodes.has(normalizeCode(row.productCode))) return false;
    if (!passesMultiFilter(distributor, normalizeCode(row.distributorCode))) return false;
    if (!passesMultiFilter(region, normalizeCode(row.regionCode))) return false;
    if (!passesMultiFilter(product, normalizeCode(row.productCode))) return false;
    if (!passesMultiFilter(line, normalizeComparableLine(row.officialLine))) return false;
    if (!passesMultiFilter(cycleMonthFilter, normalizeText(row.cycleMonth))) return false;
    if (!passesMultiFilter(weekNumberFilter, row.weekNumber != null ? String(row.weekNumber) : "")) return false;
    // Upload selection. Applied HERE, on de-cumulated rows — never to the batch fetch above. Fetching
    // only the chosen batch would strip the earlier weeks of its month, and de-cumulation subtracts
    // each week from the one before, so the sheet would report its CUMULATIVE figure instead of the
    // week's own sale (Royafloxacin June W3 would read 945 rather than 428).
    if (batchIdFilter.size > 0 && !batchIdFilter.has(row.batchId)) return false;
    return true;
  };
  const scopedRows = trackedRows.filter(passesRowFilters);
  await yieldToEventLoop();
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
  const availableLines = weeklyTrackedLineOptions(
    [...new Set(optionRows.map((row) => row.officialLine).map(normalizeText).filter(Boolean))].sort((left, right) =>
      left.localeCompare(right),
    ),
  );
  // Month + week-of-month option universes — independent of the date-week selection (computed from all
  // visible rows for the chosen distributor) so these dropdowns never collapse on selection.
  // When the fetch was narrowed to the selected months, the rows no longer span the full history, so
  // these two universes must NOT come from rows — that would collapse the Month dropdown to the month
  // already chosen and leave no way to switch. Take them from the batch list instead: it is always
  // loaded in full, and its cycle_month / week_number are a faithful stand-in for the rows' own
  // (re-verified against production: 0 mismatches across all 34,838 validated rows).
  const monthOptionRows = visibleRows.filter((row) => passesMultiFilter(distributor, normalizeCode(row.distributorCode)));
  const optionBatches = batches.filter(
    (batch) =>
      passesMultiFilter(distributor, normalizeCode(String(batch.distributor_code ?? ""))) &&
      (!scopeVisibleDistributorCodes ||
        scopeVisibleDistributorCodes.has(normalizeCode(String(batch.distributor_code ?? "")))),
  );
  const availableMonths = (
    narrowToSelectedMonths
      ? [...new Set(optionBatches.map((batch) => normalizeText(String(batch.cycle_month ?? ""))).filter(Boolean))]
      : [...new Set(monthOptionRows.map((row) => row.cycleMonth).filter(Boolean))]
  )
    .sort((left, right) => right.localeCompare(left))
    .map((code) => ({ code, name: monthLabel(code) }));
  const availableWeekNumbers = (
    narrowToSelectedMonths
      ? [
          ...new Set(
            optionBatches
              .map((batch) => (batch.week_number != null ? Number(batch.week_number) : null))
              .filter((value): value is number => value != null),
          ),
        ]
      : [...new Set(monthOptionRows.map((row) => row.weekNumber).filter((value): value is number => value != null))]
  ).sort((left, right) => left - right);

  // When a month / week-of-month filter is active it defines the time scope, so don't ALSO restrict to
  // the date-week selector (that would conflict). Otherwise keep the existing selected-week scope.
  const timeFilterActive = cycleMonthFilter.has || weekNumberFilter.has;
  const weekRows = timeFilterActive ? scopedRows : scopedRows.filter((row) => selectedWeekSet.has(row.weekStart));
  const priorRows = !timeFilterActive && priorCanonical ? scopedRows.filter((row) => priorWeekSet.has(row.weekStart)) : [];

  // Stock is a point-in-time snapshot, NOT cumulative — summing it across weeks would multiply on-hand
  // inventory. For the KPI / compare / ranking aggregates (and the factRows both Excel books total),
  // latestStockOnly (latest-stock.ts) keeps stock only on each distributor's LATEST in-scope week — its
  // latest cycle month, then that month's latest week — and zeroes it on every other week, so a scope
  // spanning months reads what is on hand rather than one month-end per month. Sales/units still sum
  // across all weeks. (The trend + week-comparison read each week's own snapshot directly.)
  const weekRowsAdj = latestStockOnly(weekRows);
  const priorRowsAdj = latestStockOnly(priorRows);

  // The row grain factRows / stockRows are built from. The viewer's own rows unless the caller lifted
  // the geography (liftRowGrainGeography, Weekly Stock), in which case the same filters and the same time
  // scope run over rows scoped WITHOUT the region and area bounds. Only the returned grain differs: every
  // aggregate above and below stays on the viewer's own scope, and the caller narrows this grain back to
  // his own areas. Never alongside ownAreaShare: that viewer's rows are already his own areas' share, and
  // re-reading them without the bound would hand back other managers' money.
  const grainScope =
    filters?.liftRowGrainGeography && !ownAreaShare ? liftWeeklyGeography(accessScope) : accessScope;
  const grainLifted = grainScope !== accessScope && Boolean(filters?.includeFactRows || filters?.includeStockRows);
  const grainScopedRows = grainLifted
    ? applyWeeklyTrackedLineScope(applyWeeklyAccessScope(realRows, grainScope), {
        includeUntracked: lineNamedExplicitly,
      }).filter(passesRowFilters)
    : scopedRows;
  const grainWeekRowsAdj = grainLifted
    ? latestStockOnly(
        timeFilterActive ? grainScopedRows : grainScopedRows.filter((row) => selectedWeekSet.has(row.weekStart)),
      )
    : weekRowsAdj;

  const sum = (rows: FactRow[], pick: (row: FactRow) => number) => rows.reduce((acc, row) => acc + pick(row), 0);

  await yieldToEventLoop();
  // Zero-sales branches: stock on hand this week but no sales, each product checked on its own and
  // ranked by stock value at the price covering each row's month (weeklyZeroSalesBranches, live-price.ts).
  const zeroSalesBranches = weeklyZeroSalesBranches(weekRowsAdj, (productCode, period) => liveUnitPrice(productCode, period, priceMap, datedPrices) ?? undefined);

  const trendWeeks = [...rawAvailableWeeks].sort();
  // flatMap: return [] for weeks with no loaded rows (empty historical batches), [point] otherwise.
  // Checking rows.length avoids falsely dropping weeks where returns exceed sales (net-negative
  // salesValue/salesUnits) which a >0 value filter would incorrectly discard.
  // One pass groups the rows by week, in their own order, so each week's sums add the same rows in the
  // same order as filtering per week did — once over the rows, not once per week (every week of history
  // on Weekly Stock: ~40 passes over ~55,000 rows per viewer, 14 Nov 2026).
  const scopedRowsByWeek = new Map<string, FactRow[]>();
  for (const row of scopedRows) {
    const bucket = scopedRowsByWeek.get(row.weekStart);
    if (bucket) bucket.push(row);
    else scopedRowsByWeek.set(row.weekStart, [row]);
  }
  const rawTrend = trendWeeks.flatMap((week) => {
    const rows = scopedRowsByWeek.get(week) ?? [];
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
    {
      cycleMonth: string;
      weekNumber: number;
      weekStart: string;
      salesValue: number;
      salesUnits: number;
      stockUnits: number;
      depotSpansGap: boolean;
    }
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
      depotSpansGap: false,
    };
    cur.salesValue += row.salesValue;
    cur.salesUnits += row.netQty;
    cur.stockUnits += row.stockQty;
    if (moneySpansDepotGap(row, { value: row.salesValue, units: row.netQty }, depotGapKeys)) cur.depotSpansGap = true;
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
      // Marked, never suppressed (owner, 2026-09-17): one depot skipping a week must not blank the figure
      // every other depot sent, but the reader is told it reads high.
      depotSpansGap: w.depotSpansGap,
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

  // One product's units for every unit figure that would add products (WeeklyDashboardUnitView). A
  // product filter pinning one code already makes every figure that product's, so there is none then.
  // Built with the same rank / rankBranches as the rows it stands beside, so its codes are theirs.
  const productRanking = rank(weekRowsAdj, (row) => row.productCode, (row) => row.productName);
  const unitProduct = appliedFilters.productCode ? null : weeklyUnitViewProduct(productRanking, filters?.unitProductCode);
  let unitView: WeeklyDashboardUnitView | null = null;
  if (unitProduct) {
    const isUnitProduct = (row: FactRow) => row.productCode === unitProduct.code;
    const unitRows = weekRowsAdj.filter(isUnitProduct);
    const unitPriorRows = !timeFilterActive && priorCanonical ? priorRowsAdj.filter(isUnitProduct) : null;
    const unitsByCode = (ranked: WeeklyRanked[]): Record<string, WeeklyUnitFigures> =>
      Object.fromEntries(ranked.map((row) => [row.code, { salesUnits: row.salesUnits, stockUnits: row.stockUnits }]));
    const unitWeeks = new Map<string, WeeklyUnitFigures>();
    for (const row of scopedRows) {
      if (!isUnitProduct(row) || !row.cycleMonth || row.weekNumber == null) continue;
      const key = weeklyWeekKey(row.cycleMonth, row.weekNumber);
      const current = unitWeeks.get(key) ?? { salesUnits: 0, stockUnits: 0 };
      current.salesUnits += row.netQty;
      current.stockUnits += row.stockQty;
      unitWeeks.set(key, current);
    }
    unitView = {
      productCode: unitProduct.code,
      productName: unitProduct.name,
      kpis: {
        salesUnits: Number(sum(unitRows, (row) => row.netQty).toFixed(2)),
        stockUnits: Number(sum(unitRows, (row) => row.stockQty).toFixed(2)),
      },
      compare: {
        salesUnits: delta(sum(unitRows, (row) => row.netQty), unitPriorRows ? sum(unitPriorRows, (row) => row.netQty) : null),
        stockUnits: delta(sum(unitRows, (row) => row.stockQty), unitPriorRows ? sum(unitPriorRows, (row) => row.stockQty) : null),
      },
      regions: unitsByCode(rank(unitRows, (row) => row.regionCode, (row) => row.regionName)),
      distributors: unitsByCode(rank(unitRows, (row) => row.distributorCode, (row) => row.distributorName)),
      branches: unitsByCode(rankBranches(unitRows)),
      // The week's own gap rule, not the product's: a week whose figure spans a missing upload is nulled
      // for every product alike, exactly as weekComparison nulls it.
      weeks: Object.fromEntries(
        weekComparison.map((week) => {
          const own = unitWeeks.get(weeklyWeekKey(week.cycleMonth, week.weekNumber));
          return [
            weeklyWeekKey(week.cycleMonth, week.weekNumber),
            {
              salesUnits: suppressGapSpannedValue(week.spansGap, Number((own?.salesUnits ?? 0).toFixed(2))),
              stockUnits: Number((own?.stockUnits ?? 0).toFixed(2)),
            },
          ];
        }),
      ),
    };
  }

  // Whole-load time into the per-minute process_health line (PERF-011), beside the fetch's own log.
  recordTiming("weekly_dashboard_load", Date.now() - loadStartedAt);
  return {
    weekStart: selectedWeekAnchor,
    priorWeekStart: priorCanonical,
    // What the numbers below actually cover. The owner's rule is that an export must match the
    // screen, so this travels with the data rather than being re-derived by each surface.
    trackedScope: { active: !lineNamedExplicitly, note: WEEKLY_TRACKED_SCOPE_NOTE },
    availableWeeks,
    weekGroupMembers: weekGroupMembersObj,
    availableLines,
    availableRegions,
    availableProducts,
    availableMonths,
    availableWeekNumbers,
    // Bounded to the distributors this viewer can actually see, exactly like `distributors` below —
    // otherwise the picker would name uploads outside their scope.
    availableUploads: batches
      .filter(
        (batch) =>
          !scopeVisibleDistributorCodes ||
          scopeVisibleDistributorCodes.has(normalizeCode(String(batch.distributor_code ?? ""))),
      )
      .map(uploadOption),
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
    products: productRanking,
    distributorBreakdown: rank(weekRowsAdj, (row) => row.distributorCode, (row) => row.distributorName),
    branchBreakdown: rankBranches(weekRowsAdj),
    zeroSalesBranches: zeroSalesBranches.slice(0, 100),
    weekComparison,
    unitView,
    sources,
    trend,
    // Row-level grain for the BI export (hidden Data sheet → pivots/charts/formulas). Mirrors the exact
    // rows behind the on-screen aggregates (weekRowsAdj: time-scoped, latest-stock-only) so the workbook's
    // pivots/formulas reconcile to the dashboard. Only built when requested (export path).
    factRows: filters?.includeFactRows
      ? grainWeekRowsAdj.map((row) => ({
          distributorCode: row.distributorCode,
          distributorName: row.distributorName,
          productCode: row.productCode,
          productName: row.productName,
          line: row.officialLine,
          regionCode: row.regionCode,
          regionName: row.regionName,
          areaCode: row.areaCode,
          branchCode: row.branchCode,
          branchName: row.branchName,
          cycleMonth: row.cycleMonth,
          weekNumber: row.weekNumber,
          weekStart: row.weekStart,
          batchId: row.batchId,
          family: familyByCode.get(normalizeCode(row.productCode)) ?? "",
          salesValue: filters?.factRowsFullPrecision ? row.salesValue : Number(row.salesValue.toFixed(2)),
          salesUnits: filters?.factRowsFullPrecision ? row.netQty : Number(row.netQty.toFixed(2)),
          stockUnits: Number(row.stockQty.toFixed(2)),
          ...(row.areaBasis ? { areaBasis: row.areaBasis } : {}),
        }))
      : undefined,
    stockRows: filters?.includeStockRows
      ? grainScopedRows.map((row) => ({
          distributorCode: row.distributorCode,
          distributorName: row.distributorName,
          regionCode: row.regionCode,
          regionName: row.regionName,
          areaCode: row.areaCode,
          branchCode: row.branchCode,
          branchName: row.branchName,
          productCode: row.productCode,
          productName: row.productName,
          line: row.officialLine,
          cycleMonth: row.cycleMonth,
          weekNumber: row.weekNumber,
          weekStart: row.weekStart,
          netUnits: row.netQty,
          stockUnits: row.stockQty,
          // The price covering this upload's own month (Saginko 170.52 from 2026-10), as weekly sales.
          factoryPrice: liveUnitPrice(row.productCode, weeklyRowPeriod(row.cycleMonth, row.weekStart), priceMap, datedPrices),
        }))
      : undefined,
    factRowDepotWeekGaps: filters?.includeFactRows ? depotGaps : undefined,
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
