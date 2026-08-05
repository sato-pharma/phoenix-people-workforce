import ExcelJS from "exceljs";

import { systemIdentity } from "@/config/system-settings";
import { invalidateSalesDashboardCache } from "@/lib/dashboard/invalidation";
import { logError } from "@/lib/observability/log";
import { computeBrickCoverage, saveBrickCoverageSnapshot } from "@/lib/sales/import-coverage";
import { loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import { resolveDistributorProfile } from "@/lib/sales/normalizer/distributor-profile-store";
import { applyCustomerBrickCorrections } from "@/lib/sales/normalizer/customer-map";
import { pickBestSheet } from "@/lib/sales/normalizer/engine";
import { HEADER_SCAN_ROWS } from "@/lib/sales/normalizer/header-normalize";
import { saveMappings, type MappingInput } from "@/lib/sales/normalizer/mapping";
import { RAW_DISTRIBUTOR_PROFILES } from "@/lib/sales/normalizer/profiles";
import { normalizeCodeKey } from "@/lib/sales/normalizer/resolvers";
import type { CodedRow, NormalizeResult } from "@/lib/sales/normalizer/types";
import { RECOGNITION_ENGINE_VERSION, dominantPeriod, normalizeUploadedFile, summarizePreview, type NormalizeFileResult, type NormalizePreview } from "@/lib/sales/recognize";
import { finalizeSosBatchAndAuditSupersede } from "@/lib/sales/source-of-sales-batch-supersede";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// Recognition lives in `@/lib/sales/recognize` (the single Sales recognition spine). Re-exported
// here so existing import sites (`@/lib/sales/normalizer/service`) keep working unchanged.
export { normalizeUploadedFile, summarizePreview };
export type { NormalizeFileResult, NormalizePreview };

export type MappingReferences = { bricks: { id: string; name: string }[]; products: { code: string; name: string }[] };

const IMPORT_FINALIZING_REASON = "Import is still being finalized. Retry the upload if this remains blocked.";

export async function listMappingReferences(): Promise<MappingReferences> {
  // Only the product + brick name lists are needed for the mapping dropdowns — skip the (large)
  // customer->brick crosswalk that loadSalesReferenceData() pages by default.
  const refs = await loadSalesReferenceData({ includeCustomerBricks: false });
  return {
    bricks: (refs.bricks ?? []).map((b) => ({ id: b.brickId, name: b.brickName })).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    products: refs.products.map((p) => ({ code: p.productCode, name: p.productName })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// Bootstrap / self-service "Learn from a cleaned file": a previously hand-cleaned sheet carries the
// distributor's RAW columns AND the added Phoenix columns (Product ID, Brick ID) side by side. Using
// the distributor's profile to know which raw columns hold the item + territory, we mine every
// raw → Phoenix pair and write them as aliases (validated, insert-if-absent). One upload teaches the
// dictionary hundreds of mappings at once, so future raw files auto-code.
const PHOENIX_PRODUCT_COLUMNS = ["Product ID"];
const PHOENIX_BRICK_COLUMNS = ["Brick ID", "Brick ID2"];

export async function learnFromCleanedFile(distributorCode: string, file: File): Promise<{ saved: number; skipped: number; invalid: number; scannedRows: number }> {
  const profile = await resolveDistributorProfile(distributorCode);
  if (!profile) throw new Error(`No normalizer profile for distributor ${distributorCode}.`);
  const [refs, buffer] = await Promise.all([loadSalesReferenceData(), file.arrayBuffer()]);
  const productCodes = new Set(refs.products.map((p) => normalizeCodeKey(p.productCode)));
  const brickIds = new Set((refs.bricks ?? []).map((b) => normalizeCodeKey(b.brickId)));

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  // Pick the richest worksheet (not just the first) and scan deep, consistent with the importer engine.
  const sheet = pickBestSheet(workbook, profile);
  if (!sheet) return { invalid: 0, saved: 0, scannedRows: 0, skipped: 0 };

  let headerRow = 1;
  for (let r = 1; r <= Math.min(sheet.rowCount, HEADER_SCAN_ROWS); r += 1) { let n = 0; sheet.getRow(r).eachCell({ includeEmpty: false }, () => { n += 1; }); if (n >= 3) { headerRow = r; break; } }
  const col = new Map<string, number>();
  sheet.getRow(headerRow).eachCell({ includeEmpty: false }, (cell, i) => { const k = String(cell.text ?? "").trim().toLowerCase(); if (k && !col.has(k)) col.set(k, i); });
  const colOf = (names: string[]) => { for (const n of names) { const i = col.get(n.trim().toLowerCase()); if (i) return i; } return 0; };
  const text = (row: ExcelJS.Row, i: number) => (i ? String(row.getCell(i)?.text ?? "").trim() : "");

  const productIdCol = colOf(PHOENIX_PRODUCT_COLUMNS);
  const brickIdCol = colOf(PHOENIX_BRICK_COLUMNS);
  const rawProductCols = profile.productColumns.map((n) => colOf([n])).filter(Boolean); // code + name both → product
  const primaryTerritory = profile.territoryColumns?.[0] ? colOf([profile.territoryColumns[0]]) : 0; // most specific only
  const customerCol = profile.customerCodeColumns?.[0] ? colOf([profile.customerCodeColumns[0]]) : 0;

  const seen = new Set<string>();
  const mappings: MappingInput[] = [];
  let scannedRows = 0;
  for (let r = headerRow + 1; r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r);
    let any = false; row.eachCell({ includeEmpty: false }, () => { any = true; });
    if (!any) continue;
    scannedRows += 1;
    const pid = normalizeCodeKey(text(row, productIdCol));
    if (pid && productCodes.has(pid)) {
      for (const ci of rawProductCols) { const raw = text(row, ci); const key = `p:${raw.toLowerCase()}`; if (raw && !seen.has(key)) { seen.add(key); mappings.push({ code: pid, distributorCode, raw, type: "product" }); } }
    }
    const bid = normalizeCodeKey(text(row, brickIdCol));
    if (bid && brickIds.has(bid)) {
      if (primaryTerritory) {
        const raw = text(row, primaryTerritory); const key = `t:${raw.toLowerCase()}`;
        if (raw && !seen.has(key)) { seen.add(key); mappings.push({ code: bid, raw, type: "territory" }); }
      }
      if (customerCol) {
        const raw = text(row, customerCol); const key = `c:${raw.toLowerCase()}`;
        if (raw && !seen.has(key)) { seen.add(key); mappings.push({ code: bid, distributorCode, raw, type: "customer" }); }
      }
    }
  }
  const result = await saveMappings(mappings);
  return { ...result, scannedRows };
}

// Read EVERY matching import row, paging past PostgREST's 1000-row default cap. Without this, a mine
// over 84k rows silently truncates to the first 1000 — only a handful of distributors learned anything.
async function selectAllImportRows(columns: string, distributorCode: string | undefined, notNull: string[]): Promise<Array<Record<string, unknown>>> {
  const supabase = getSupabaseAdmin();
  const pageSize = 1000;
  const rows: Array<Record<string, unknown>> = [];
  let from = 0;
  for (;;) {
    let q = supabase.from("source_of_sales_import_rows").select(columns).order("id", { ascending: true }).range(from, from + pageSize - 1);
    for (const col of notNull) q = q.not(col, "is", null);
    if (distributorCode) q = q.eq("distributor_code", distributorCode);
    const result = await q;
    if (result.error) throw new Error(`Failed to read import rows: ${result.error.message}`);
    const page = (result.data ?? []) as unknown as Array<Record<string, unknown>>;
    rows.push(...page);
    if (page.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

// Mine every import_rows record for product_name→product_code and client_code→brick_id pairs and
// upsert them as aliases. Runs per-distributor or across all distributors. Idempotent (ON CONFLICT
// DO UPDATE). Use this to bulk-bootstrap the alias dictionary from all historical upload data.
// Fully paginated (reads all rows, not just the first 1000) and the upserts are chunked so a large
// distributor never sends one oversized request.
export async function learnFromImportHistory(distributorCode?: string): Promise<{ saved: number; skipped: number; invalid: number; scannedRows: number }> {
  const [productRows, customerRows] = await Promise.all([
    selectAllImportRows("distributor_code,product_name,product_code", distributorCode, ["product_name", "product_code"]),
    selectAllImportRows("distributor_code,client_code,brick_id", distributorCode, ["client_code", "brick_id"]),
  ]);

  const seenProd = new Set<string>();
  const seenCust = new Set<string>();
  const mappings: MappingInput[] = [];
  let scannedRows = 0;

  for (const row of productRows) {
    scannedRows += 1;
    const raw = String(row.product_name ?? "").trim();
    const code = String(row.product_code ?? "").trim();
    const dist = String(row.distributor_code ?? "").trim();
    if (!raw || !code || !dist || code.toUpperCase() === "IGNORE") continue;
    const key = `${dist}\x00${raw.toLowerCase()}\x00${code}`;
    if (!seenProd.has(key)) { seenProd.add(key); mappings.push({ type: "product", raw, code, distributorCode: dist }); }
  }
  for (const row of customerRows) {
    scannedRows += 1;
    const clientCode = String(row.client_code ?? "").trim();
    const brick = String(row.brick_id ?? "").trim();
    const dist = String(row.distributor_code ?? "").trim();
    if (!clientCode || !brick || !dist) continue;
    const key = `${dist}\x00${clientCode}`;
    if (!seenCust.has(key)) { seenCust.add(key); mappings.push({ type: "customer", raw: clientCode, code: brick, distributorCode: dist }); }
  }

  if (mappings.length === 0) return { saved: 0, skipped: 0, invalid: 0, scannedRows };
  // Chunk the upserts so one big distributor never sends a single oversized request.
  const CHUNK = 1000;
  let saved = 0, skipped = 0, invalid = 0;
  for (let i = 0; i < mappings.length; i += CHUNK) {
    const r = await saveMappings(mappings.slice(i, i + CHUNK));
    saved += r.saved; skipped += r.skipped; invalid += r.invalid;
  }
  return { saved, skipped, invalid, scannedRows };
}

export type NormalizerDistributorOption = { code: string; name: string };

export function listNormalizerDistributors(): NormalizerDistributorOption[] {
  return RAW_DISTRIBUTOR_PROFILES.map((p) => ({ code: p.distributorCode, name: p.distributorName }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ── Coded XLSX (the format the user produces by hand today; Phoenix-branded) ──

// "Discount%" carries the exact discount fraction the engine applied, so the Source-of-Sales importer's
// recompute (Qty x factory_price x (1 - discount)) reproduces this sheet's Value exactly. It maps to the
// NORMALIZER_TEMPLATE.discountField in monthly-distributor-import.ts.
export const CODED_HEADERS = [
  "Distrub ID", "Region ID", "Area ID", "Brick ID", "Product ID", "Product Name",
  "Qty", "B. Qty", "Value", "Discount%", "Invoice Date", "Customer", "Customer Name", "Customer Address", "Official Line",
] as const;

export function buildCodedWorkbook(result: NormalizeResult): Promise<ExcelJS.Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = systemIdentity.appName;
  const sheet = workbook.addWorksheet("Coded");
  const header = sheet.addRow(CODED_HEADERS as unknown as string[]);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.eachCell((cell) => { cell.fill = { fgColor: { argb: "FF0B0B0B" }, pattern: "solid", type: "pattern" }; });
  result.coded.forEach((r) => {
    sheet.addRow([
      r.distributorCode, r.regionCode, r.areaCode, r.brickId, r.productCode, r.productName,
      r.qty, r.bonusQty, r.value, r.discount, r.invoiceDate, r.clientCode ?? "", r.clientName ?? "", r.clientAddress ?? "", r.officialLine,
    ]);
  });
  // Second sheet: the unmapped rows the user still needs to map once.
  if (result.exceptions.length > 0) {
    const ex = workbook.addWorksheet("Needs mapping");
    ex.addRow(["Row", "Reason", "Raw product", "Raw territory", "Raw customer"]).font = { bold: true };
    result.exceptions.forEach((e) => ex.addRow([e.rawRowNumber, e.reason, e.rawProduct, e.rawTerritory, e.rawCustomerCode]));
  }
  for (let c = 1; c <= CODED_HEADERS.length; c += 1) sheet.getColumn(c).width = 16;
  return workbook.xlsx.writeBuffer();
}

// Normalize a raw distributor file and return its coded XLSX as an in-memory buffer — used by the
// one-click "Import (validated)" path so the coded sheet can be fed straight into the Source-of-Sales
// validator without writing a temp file.
export async function buildCodedBuffer(distributorCode: string, file: File): Promise<{ buffer: ExcelJS.Buffer; distributorName: string; period: string | null; result: NormalizeResult }> {
  const normalized = await normalizeUploadedFile(distributorCode, file);
  if (normalized.status === "coded_sheet") throw new Error("This sheet has already been processed — use the direct import path instead.");
  if (normalized.status === "header_error") throw new Error(`Header validation failed: ${normalized.missingGroups.map((g) => g.label).join(", ")} columns missing.`);
  const buffer = await buildCodedWorkbook(normalized.result);
  return { buffer, distributorName: normalized.distributorName, period: normalized.period, result: normalized.result };
}

// ── Direct import of coded rows (bypasses templates — rows are already coded + validated) ──

// Build the row objects persisted to source_of_sales_import_rows. Kept pure (no DB) so the column
// shape can be unit-tested against the live schema. It MUST mirror insertSourceOfSalesRows in
// monthly-distributor-import.ts: only block_code + brick_id are stored, never block_name/brick_name —
// the table has no such columns (they live on source_of_sales_bricks), and brick display names are
// resolved live from the master in loadSourceOfSalesDashboard. Writing them made PostgREST reject
// (or silently drop) the entire "Import (validated)" batch.
export function buildNormalizedImportRows(rows: CodedRow[], batchId: string) {
  return rows.map((r, index) => ({
    area_code: r.areaCode,
    area_name: r.areaName,
    batch_id: batchId,
    block_code: "",
    brick_id: r.brickId,
    // The engine already resolved this from the profile's address columns. It used to be written as
    // a literal null, which discarded it — and made client_address null on 100% of 294,445 rows for
    // all 15 distributors, while client_name (one line down, same mechanism) was 100% populated.
    // The emptiness read as "the distributors do not send an address"; it was never stored.
    //
    // This branch fixed the same bug independently, as `r.clientAddress ?? null`. Resolved to main's
    // form: CodedRow.clientAddress is `string | null` and never undefined, so the two are identical
    // in behaviour, and this spelling is the one insertSourceOfSalesRows in
    // monthly-distributor-import.ts already uses — the two persist paths must agree.
    client_address: r.clientAddress,
    client_code: r.clientCode,
    client_name: r.clientName,
    row_number: index + 1,
    distributor_code: r.distributorCode,
    invoice_period: r.invoiceDate,
    // The real date, not just the month. Omitting it left 96% of production rows dateless and made
    // a mislabelled source file (an "April" folder holding May invoices) invisible in the data.
    invoice_date: r.invoiceDay ?? null,
    region_name: r.regionName,
    region_code: r.regionCode,
    product_name: r.productName,
    product_code: r.productCode,
    official_line: r.officialLine,
    qty: Number.isFinite(r.qty) ? r.qty : 0,
    bonus_qty: Number.isFinite(r.bonusQty) ? r.bonusQty : 0,
    discount: Number.isFinite(r.discount) ? r.discount : 0,
    value: Number.isFinite(r.value) ? r.value : 0,
    is_direct: r.isDirect,
    validation_state: "valid",
    validation_issues: [],
    // The source row, keyed by the file's own headings — the audit trail this column exists for.
    // It was a literal {} here while the other import path (insertSourceOfSalesRows) stored the real
    // thing, so 282,215 of 294,445 rows carry no record of what their distributor actually sent.
    // Kept tolerant of a row built before rawRow existed rather than writing undefined, which
    // PostgREST would reject for a NOT NULL jsonb column and fail the whole batch.
    raw_row: r.rawRow ?? {},
  }));
}

type NormalizedSummaryRow = {
  batch_id: string;
  group_type: "line" | "region" | "area" | "product" | "brick";
  group_key: string;
  group_label: string;
  group_code: string | null;
  official_line: string | null;
  row_count: number;
  total_qty: number;
  total_bonus_qty: number;
  total_value: number;
};

type SummaryAccumulator = Omit<NormalizedSummaryRow, "batch_id">;

function addSummary(
  summaries: Map<string, SummaryAccumulator>,
  key: string,
  shape: Pick<SummaryAccumulator, "group_type" | "group_key" | "group_label" | "group_code" | "official_line">,
  row: CodedRow,
) {
  const existing = summaries.get(key) ?? {
    ...shape,
    row_count: 0,
    total_qty: 0,
    total_bonus_qty: 0,
    total_value: 0,
  };
  existing.row_count += 1;
  existing.total_qty += Number.isFinite(row.qty) ? row.qty : 0;
  existing.total_bonus_qty += Number.isFinite(row.bonusQty) ? row.bonusQty : 0;
  existing.total_value += Number.isFinite(row.value) ? row.value : 0;
  summaries.set(key, existing);
}

export function buildNormalizedSummaryRows(rows: CodedRow[], batchId: string): NormalizedSummaryRow[] {
  const summaries = new Map<string, SummaryAccumulator>();

  for (const row of rows) {
    const line = row.officialLine || "";
    addSummary(summaries, `line:${line}`, { group_code: null, group_key: line, group_label: line, group_type: "line", official_line: line }, row);

    addSummary(
      summaries,
      `region:${row.regionCode}|${row.regionName}`,
      { group_code: row.regionCode, group_key: `${row.regionCode}|${row.regionName}`, group_label: row.regionName, group_type: "region", official_line: null },
      row,
    );

    addSummary(
      summaries,
      `product:${row.productCode}|${row.productName}|${line}`,
      { group_code: row.productCode, group_key: `${row.productCode}|${row.productName}|${line}`, group_label: row.productName, group_type: "product", official_line: line },
      row,
    );

    if (row.isDirect) continue;

    addSummary(
      summaries,
      `area:${row.areaCode}|${row.areaName}|${row.regionCode}`,
      { group_code: row.areaCode, group_key: `${row.areaCode}|${row.areaName}|${row.regionCode}`, group_label: row.areaName, group_type: "area", official_line: row.regionName || row.regionCode },
      row,
    );

    addSummary(
      summaries,
      `brick:${row.brickId}|${row.brickName}|${row.areaCode}|${row.regionCode}`,
      { group_code: row.brickId, group_key: `${row.brickId}|${row.brickName}|${row.areaCode}|${row.regionCode}`, group_label: row.brickName, group_type: "brick", official_line: row.areaName || row.areaCode },
      row,
    );
  }

  return [...summaries.values()].map((summary) => ({
    ...summary,
    batch_id: batchId,
    total_bonus_qty: Number(summary.total_bonus_qty.toFixed(6)),
    total_qty: Number(summary.total_qty.toFixed(6)),
    total_value: Number(summary.total_value.toFixed(6)),
  }));
}

export async function persistNormalizedBatch(input: {
  distributorCode: string;
  distributorName: string;
  fileName: string;
  result: NormalizeResult;
  uploadedBy: string;
  // Explicit period (the caller's single source of truth). When omitted, falls back to the dominant
  // period (legacy callers). The new Sales Upload commit ALWAYS passes this so a user-picked period
  // is honored and replace/insert target the same month.
  period?: string;
}): Promise<{ batchId: string; period: string | null; importedRows: number }> {
  const supabase = getSupabaseAdmin();
  const { coded } = input.result;
  const period = input.period ?? dominantPeriod(coded);
  // only rows in the chosen period are imported (one batch = one month, like the importer)
  const rows = coded.filter((r) => r.invoiceDate === period);
  const totalQty = rows.reduce((s, r) => s + (Number.isFinite(r.qty) ? r.qty : 0), 0);
  const totalBonus = rows.reduce((s, r) => s + (Number.isFinite(r.bonusQty) ? r.bonusQty : 0), 0);
  const totalValue = rows.reduce((s, r) => s + (Number.isFinite(r.value) ? r.value : 0), 0);

  const batchInsert = await supabase
    .from("source_of_sales_import_batches")
    .insert({
      distributor_code: input.distributorCode,
      distributor_name: input.distributorName,
      template_key: "normalizer",
      file_name: input.fileName,
      sheet_name: "Coded",
      period,
      status: "pending",
      total_rows: rows.length,
      importable_rows: rows.length,
      failed_rows: 0,
      warning_rows: input.result.exceptions.length,
      total_qty: Number(totalQty.toFixed(6)),
      total_bonus_qty: Number(totalBonus.toFixed(6)),
      total_value: Number(totalValue.toFixed(6)),
      // C3 reconciliation breakdown + C5 lineage (coded = importable_rows, blocked = failed_rows).
      rows_ignored: input.result.summary.ignored,
      rows_blank: input.result.summary.blankCustomerSkipped,
      recognition_engine_version: RECOGNITION_ENGINE_VERSION,
      blocking_reasons: [IMPORT_FINALIZING_REASON],
      uploaded_by: input.uploadedBy,
    })
    .select("id")
    .single();
  if (batchInsert.error) throw batchInsert.error;
  const batchId = String(batchInsert.data.id);

  const inserts = buildNormalizedImportRows(rows, batchId);
  for (let i = 0; i < inserts.length; i += 500) {
    const { error } = await supabase.from("source_of_sales_import_rows").insert(inserts.slice(i, i + 500));
    if (error) throw error;
  }

  // RECONCILIATION GATE: what we meant to write must equal what is actually there.
  //
  // The chunked inserts above throw on error, which catches a failed chunk — but not a chunk that
  // succeeds while landing fewer rows than it was given (a policy filter, a partial write, a
  // silently-dropped row). Nothing downstream would notice: the batch records `total_rows` from the
  // in-memory array, so a short table still reports a full, healthy import. Every sales figure
  // derived from it would then be quietly low, exactly like the 2026-06 mapping loss.
  //
  // Counting is cheap next to the insert we just did, and this is the last moment the intended
  // number is still known.
  const { count: persistedRows, error: persistedError } = await supabase
    .from("source_of_sales_import_rows")
    .select("id", { count: "exact", head: true })
    .eq("batch_id", batchId);
  if (persistedError) throw persistedError;
  if ((persistedRows ?? 0) !== inserts.length) {
    // Leave the batch pending + blocked rather than deleting anything: the rows stay on disk for
    // diagnosis, and a blocked batch cannot be superseded into the live rollups.
    await supabase
      .from("source_of_sales_import_batches")
      .update({
        status: "blocked",
        blocking_reasons: [
          `Row reconciliation failed — ${inserts.length} row(s) sent, ${persistedRows ?? 0} stored. The import was NOT applied.`,
        ],
      })
      .eq("id", batchId);
    logError("SoS import row reconciliation failed", {
      labels: {
        event: "sos_import_row_reconciliation_failed",
        batchId,
        distributorCode: input.distributorCode,
        sentRows: String(inserts.length),
        storedRows: String(persistedRows ?? 0),
      },
    });
    throw new Error(
      `Import blocked: ${inserts.length} row(s) were sent but ${persistedRows ?? 0} were stored. Nothing was applied — re-run the upload.`,
    );
  }

  const summaries = buildNormalizedSummaryRows(rows, batchId);
  for (let i = 0; i < summaries.length; i += 500) {
    const { error } = await supabase.from("source_of_sales_import_summaries").insert(summaries.slice(i, i + 500));
    if (error) throw error;
  }

  // Promote this batch to validated, supersede any other batch for this distributor + period, and
  // refresh every dependent rollup — all inside ONE atomic transaction (phx_finalize_sos_batch), so
  // a failure anywhere leaves the previous good batch untouched instead of deleting it up front.
  if (period) {
    await finalizeSosBatchAndAuditSupersede({
      batchId,
      distributorCode: input.distributorCode,
      period,
      actorLoginId: input.uploadedBy,
    });
  } else {
    // Defensive fallback when no single period could be resolved — nothing sensible to
    // dedupe/lock on without a period key, so promote directly and refresh individually.
    const finalized = await supabase
      .from("source_of_sales_import_batches")
      .update({ status: "validated", blocking_reasons: [] })
      .eq("id", batchId);
    if (finalized.error) throw finalized.error;
    const rollupRefresh = await supabase.rpc("phx_refresh_sos_fact_rollup", { p_batch_id: batchId });
    if (rollupRefresh.error) throw rollupRefresh.error;
    const customerRollupRefresh = await supabase.rpc("phx_refresh_sos_customer_directory_rollup", { p_batch_id: batchId });
    if (customerRollupRefresh.error) throw customerRollupRefresh.error;
    const roiRefresh = await supabase.rpc("phx_refresh_marketing_roi_facts", { p_batch_id: batchId });
    if (roiRefresh.error) throw roiRefresh.error;
    invalidateSalesDashboardCache("source of sales multi-period import (fallback refresh)");
  }

  // Self-heal the customer->brick crosswalk from what this CONFIRMED import's sheet itself resolved
  // (see engine.ts's customerBrickCorrections) — only after the batch is validated, never on a preview.
  if (input.result.customerBrickCorrections.length > 0) {
    await applyCustomerBrickCorrections(input.result.customerBrickCorrections, { actorLoginId: input.uploadedBy });
  }

  // Record REAL brick coverage for this batch and warn when it is poor.
  //
  // This path wrote no coverage snapshot at all until now — the newest row in the table predated
  // the June 2026 import entirely — and the metric it would have written (`importable_rows /
  // total_rows`) is 100% by construction here, since both are set to `rows.length` above. So the
  // one mechanism that could have caught June's 3,184 brick-less rows was simultaneously not
  // running and incapable of failing. Best-effort: a coverage record must never fail an import
  // that already committed successfully.
  try {
    const coverage = computeBrickCoverage(rows);
    await saveBrickCoverageSnapshot({
      batchId,
      coverage,
      details: rows
        .filter((r) => String(r.brickId ?? "").trim() === "" && !r.isDirect && r.clientCode)
        .map((r) => ({ address: r.clientAddress ?? "", code: String(r.clientCode), name: r.clientName ?? "" })),
      distributorCode: input.distributorCode,
      period,
      totalRows: rows.length,
    });
  } catch (error) {
    logError("Failed to record SoS brick coverage for batch", {
      labels: { event: "sos_coverage_record_failed", batchId, distributorCode: input.distributorCode },
      error,
    });
  }

  return { batchId, period, importedRows: rows.length };
}
