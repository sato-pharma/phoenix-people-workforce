import ExcelJS from "exceljs";

import { systemIdentity } from "@/config/system-settings";
import { loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import { loadCrosswalks } from "@/lib/sales/normalizer/crosswalks";
import { normalizeRawWorkbook } from "@/lib/sales/normalizer/engine";
import { distinctUnknowns, saveMappings, type DistinctUnknown, type MappingInput, type ProductRef } from "@/lib/sales/normalizer/mapping";
import { RAW_DISTRIBUTOR_PROFILES, rawProfileForDistributor } from "@/lib/sales/normalizer/profiles";
import { normalizeCodeKey } from "@/lib/sales/normalizer/resolvers";
import type { CodedRow, NormalizeResult } from "@/lib/sales/normalizer/types";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type MappingReferences = { bricks: { id: string; name: string }[]; products: { code: string; name: string }[] };

export async function listMappingReferences(): Promise<MappingReferences> {
  const refs = await loadSalesReferenceData();
  return {
    bricks: (refs.bricks ?? []).map((b) => ({ id: b.brickId, name: b.brickName })).sort((a, b) => a.id.localeCompare(b.id)),
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
  const profile = rawProfileForDistributor(distributorCode);
  if (!profile) throw new Error(`No normalizer profile for distributor ${distributorCode}.`);
  const [refs, buffer] = await Promise.all([loadSalesReferenceData(), file.arrayBuffer()]);
  const productCodes = new Set(refs.products.map((p) => normalizeCodeKey(p.productCode)));
  const brickIds = new Set((refs.bricks ?? []).map((b) => normalizeCodeKey(b.brickId)));

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const sheet = workbook.worksheets[0];
  if (!sheet) return { invalid: 0, saved: 0, scannedRows: 0, skipped: 0 };

  let headerRow = 1;
  for (let r = 1; r <= Math.min(sheet.rowCount, 10); r += 1) { let n = 0; sheet.getRow(r).eachCell({ includeEmpty: false }, () => { n += 1; }); if (n >= 3) { headerRow = r; break; } }
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
      for (const ci of rawProductCols) { const raw = text(row, ci); const key = `p:${raw.toLowerCase()}`; if (raw && !seen.has(key)) { seen.add(key); mappings.push({ code: pid, raw, type: "product" }); } }
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

// Most-frequent invoice period among coded rows (the batch period).
function dominantPeriod(rows: CodedRow[]): string | null {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.invoiceDate) counts.set(row.invoiceDate, (counts.get(row.invoiceDate) ?? 0) + 1);
  }
  let best: string | null = null; let bestN = 0;
  for (const [period, n] of counts) { if (n > bestN) { best = period; bestN = n; } }
  return best;
}

export type NormalizePreview = {
  distributorCode: string;
  distributorName: string;
  period: string | null;
  periods: { period: string; rows: number }[];
  sampleCoded: CodedRow[];
  summary: NormalizeResult["summary"];
  unknownCustomers: DistinctUnknown[];
  unknownProducts: DistinctUnknown[];
  unknownTerritories: DistinctUnknown[];
};

export async function normalizeUploadedFile(distributorCode: string, file: File): Promise<{ result: NormalizeResult; period: string | null; distributorName: string; products: ProductRef[] }> {
  const profile = rawProfileForDistributor(distributorCode);
  if (!profile) throw new Error(`No normalizer profile for distributor ${distributorCode}.`);
  // Load the masters once and hand them to loadCrosswalks (which would otherwise reload them) — halves
  // the reference round-trips per analyze.
  const [refs, buffer] = await Promise.all([loadSalesReferenceData(), file.arrayBuffer()]);
  const maps = await loadCrosswalks(refs);
  const result = await normalizeRawWorkbook(buffer, profile, maps);
  const products: ProductRef[] = refs.products.map((p) => ({ code: p.productCode, family: p.family, name: p.productName }));
  return { result, period: dominantPeriod(result.coded), distributorName: profile.distributorName, products };
}

export function summarizePreview(distributorCode: string, distributorName: string, result: NormalizeResult, products: ProductRef[]): NormalizePreview {
  const periodCounts = new Map<string, number>();
  result.coded.forEach((r) => { if (r.invoiceDate) periodCounts.set(r.invoiceDate, (periodCounts.get(r.invoiceDate) ?? 0) + 1); });
  const distinct = distinctUnknowns(result.exceptions, products);
  return {
    distributorCode,
    distributorName,
    period: dominantPeriod(result.coded),
    periods: [...periodCounts.entries()].map(([period, rows]) => ({ period, rows })).sort((a, b) => a.period.localeCompare(b.period)),
    sampleCoded: result.coded.slice(0, 50),
    summary: result.summary,
    unknownCustomers: distinct.customers.slice(0, 500),
    unknownProducts: distinct.products.slice(0, 500),
    unknownTerritories: distinct.territories.slice(0, 500),
  };
}

// ── Coded XLSX (the format the user produces by hand today; Phoenix-branded) ──

// "Discount%" carries the exact discount fraction the engine applied, so the Source-of-Sales importer's
// recompute (Qty x factory_price x (1 - discount)) reproduces this sheet's Value exactly. It maps to the
// NORMALIZER_TEMPLATE.discountField in monthly-distributor-import.ts.
export const CODED_HEADERS = [
  "Distrub ID", "Region ID", "Area ID", "Brick ID", "Product ID", "Product Name",
  "Qty", "B. Qty", "Value", "Discount%", "Invoice Date", "Customer", "Customer Name", "Official Line",
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
      r.qty, r.bonusQty, r.value, r.discount, r.invoiceDate, r.clientCode ?? "", r.clientName ?? "", r.officialLine,
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
  const { distributorName, period, result } = await normalizeUploadedFile(distributorCode, file);
  const buffer = await buildCodedWorkbook(result);
  return { buffer, distributorName, period, result };
}

// ── Direct import of coded rows (bypasses templates — rows are already coded + validated) ──

export async function persistNormalizedBatch(input: {
  distributorCode: string;
  distributorName: string;
  fileName: string;
  result: NormalizeResult;
  uploadedBy: string;
}): Promise<{ batchId: string; period: string | null; importedRows: number }> {
  const supabase = getSupabaseAdmin();
  const { coded } = input.result;
  const period = dominantPeriod(coded);
  // only rows in the dominant period are imported (one batch = one month, like the importer)
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
      blocking_reasons: [],
      uploaded_by: input.uploadedBy,
    })
    .select("id")
    .single();
  if (batchInsert.error) throw batchInsert.error;
  const batchId = String(batchInsert.data.id);

  const inserts = rows.map((r, index) => ({
    area_code: r.areaCode,
    area_name: r.areaName,
    batch_id: batchId,
    block_code: "",
    block_name: "",
    brick_id: r.brickId,
    brick_name: r.brickName,
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
  for (let i = 0; i < inserts.length; i += 500) {
    const { error } = await supabase.from("source_of_sales_import_rows").insert(inserts.slice(i, i + 500));
    if (error) throw error;
  }
  return { batchId, period, importedRows: rows.length };
}
