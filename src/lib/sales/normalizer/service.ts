import ExcelJS from "exceljs";

import { systemIdentity } from "@/config/system-settings";
import { loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import { resolveDistributorProfile } from "@/lib/sales/normalizer/distributor-profile-store";
import { pickBestSheet } from "@/lib/sales/normalizer/engine";
import { HEADER_SCAN_ROWS } from "@/lib/sales/normalizer/header-normalize";
import { saveMappings, type MappingInput } from "@/lib/sales/normalizer/mapping";
import { RAW_DISTRIBUTOR_PROFILES } from "@/lib/sales/normalizer/profiles";
import { normalizeCodeKey } from "@/lib/sales/normalizer/resolvers";
import type { CodedRow, NormalizeResult } from "@/lib/sales/normalizer/types";
import { RECOGNITION_ENGINE_VERSION, dominantPeriod, normalizeUploadedFile, summarizePreview, type NormalizeFileResult, type NormalizePreview } from "@/lib/sales/recognize";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// Recognition lives in `@/lib/sales/recognize` (the single Sales recognition spine). Re-exported
// here so existing import sites (`@/lib/sales/normalizer/service`) keep working unchanged.
export { normalizeUploadedFile, summarizePreview };
export type { NormalizeFileResult, NormalizePreview };

export type MappingReferences = { bricks: { id: string; name: string }[]; products: { code: string; name: string }[] };

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
    client_address: null,
    client_code: r.clientCode,
    client_name: r.clientName,
    row_number: index + 1,
    distributor_code: r.distributorCode,
    invoice_period: r.invoiceDate,
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
    raw_row: {},
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
      status: "validated",
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
      blocking_reasons: [],
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

  const summaries = buildNormalizedSummaryRows(rows, batchId);
  for (let i = 0; i < summaries.length; i += 500) {
    const { error } = await supabase.from("source_of_sales_import_summaries").insert(summaries.slice(i, i + 500));
    if (error) throw error;
  }

  return { batchId, period, importedRows: rows.length };
}
