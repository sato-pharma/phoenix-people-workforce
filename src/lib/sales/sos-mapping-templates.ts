import ExcelJS from "exceljs";

import { writeAuditLog } from "@/lib/admin/audit";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import { listCustomerMap } from "@/lib/sales/normalizer/customer-map";
import { listTerritoryAliases, saveMappings, type MappingInput } from "@/lib/sales/normalizer/mapping";
import { normalizeAliasKey, normalizeCodeKey } from "@/lib/sales/normalizer/resolvers";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// ─────────────────────────────────────────────────────────────────────────────
// Source of Sales — mapping templates (download → fill → upload), the Weekly-style
// front door for the monthly distributor importer. Two templates:
//   • Product Mapping  — raw item code/name → Phoenix product_code, PER-DISTRIBUTOR (the Distrub ID
//     column is locked to the selected distributor). Persists to source_of_sales_product_aliases,
//     keyed by (distributor_code, normalized_alias).
//   • Customer / Brick — distributor customer code → Phoenix Brick ID (per-distributor).
//     Round-trips the SAME sheet importCustomerMap() already accepts.
// Filled mappings let the distributor's RAW sheet upload as-is (the normalizer engine joins them).
// ─────────────────────────────────────────────────────────────────────────────

const ORANGE = "FFF97316";
const NAVY = "FF0F172A";
const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export type SosMappingImportResult = {
  saved: number;
  skipped: number;
  blockedRows: { rowNumber: number; reason: string; values: string }[];
};

function headerStyle(sheet: ExcelJS.Worksheet, argb: string) {
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb } };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
}

function cellString(row: ExcelJS.Row, index: number): string {
  const value = row.getCell(index).value as unknown;
  if (value == null) return "";
  if (typeof value === "object") {
    const obj = value as { text?: unknown; result?: unknown; richText?: { text?: string }[] };
    if (obj.richText) return obj.richText.map((part) => part.text).join("").trim();
    if (obj.result != null) return String(obj.result).trim();
    if (obj.text != null) return String(obj.text).trim();
  }
  return String(value).trim();
}

/** Master products keyed by normalized code → { canonical code, name }. */
async function loadProductIndex(): Promise<Map<string, { code: string; name: string; line: string; price: number }>> {
  const refs = await loadSalesReferenceData({ includeCustomerBricks: false });
  const map = new Map<string, { code: string; name: string; line: string; price: number }>();
  for (const product of refs.products) {
    const key = normalizeCodeKey(product.productCode);
    if (!key || map.has(key)) continue;
    const price = Number(product.factoryPrice);
    map.set(key, {
      code: product.productCode.trim(),
      name: (product.productName || product.productCode).trim(),
      line: (product.line ?? "").trim(),
      price: Number.isFinite(price) ? price : 0,
    });
  }
  return map;
}

/** Existing product aliases FOR ONE DISTRIBUTOR (alias → product_code), paged past PostgREST's 1000 cap. */
async function loadExistingProductAliases(distributorCode: string): Promise<{ alias: string; productCode: string }[]> {
  const supabase = getSupabaseAdmin();
  const code = normalizeCodeKey(distributorCode);
  const pageSize = 1000;
  const rows: { alias: string; productCode: string }[] = [];
  let from = 0;
  for (;;) {
    const result = await supabase
      .from("source_of_sales_product_aliases")
      .select("alias, product_code")
      .eq("active", true)
      .eq("distributor_code", code)
      .order("alias", { ascending: true })
      .range(from, from + pageSize - 1);
    if (result.error) break; // tolerate (e.g. table absent); return what we have
    const page = (result.data ?? []) as Array<{ alias?: string; product_code?: string }>;
    for (const r of page) rows.push({ alias: String(r.alias ?? ""), productCode: String(r.product_code ?? "") });
    if (page.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

// Blank rows the user can fill on a downloaded template without unprotecting it (overflow can still be
// added with Excel's "insert rows", which inherits the locked Distrub-ID + unlocked editable columns).
const PRODUCT_SPARE_ROWS = 1000;
const CUSTOMER_SPARE_ROWS = 30000;

/** Header-row column index whose label matches any of `names` (case-insensitive); 0 if none. */
function headerIndex(sheet: ExcelJS.Worksheet, names: string[]): number {
  const wanted = names.map((n) => n.trim().toLowerCase());
  let found = 0;
  sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => {
    if (found) return;
    if (wanted.includes(String(cell.text ?? "").trim().toLowerCase())) found = col;
  });
  return found;
}

// Locks the Distrub-ID column (col 1) and protects the sheet — used by the product mapping template
// (small row count, protection prevents accidental code edits).
async function lockDistributorColumn(sheet: ExcelJS.Worksheet, distributorCode: string, editableColumns: number, prefilledRows: number, spareRows: number) {
  const totalRows = prefilledRows + spareRows;
  for (let i = 0; i < totalRows; i += 1) {
    const row = sheet.getRow(2 + i);
    const distCell = row.getCell(1);
    distCell.value = distributorCode;
    distCell.protection = { locked: true };
    distCell.font = { color: { argb: "FF64748B" } };
    for (let c = 2; c <= editableColumns + 1; c += 1) row.getCell(c).protection = { locked: false };
  }
  await sheet.protect("", {
    autoFilter: true,
    formatCells: false,
    formatColumns: true,
    formatRows: true,
    insertRows: true,
    selectLockedCells: true,
    selectUnlockedCells: true,
    sort: true,
  });
}

// Pre-stamps the Distrub-ID column (col 1) on every row WITHOUT sheet protection.
// Used by the customer/brick template: Excel's Ctrl+V blocks paste into protected sheets even
// when target cells are unlocked, so protection is omitted here. The distributor is validated
// server-side on import, making the lock unnecessary.
function stampDistributorColumn(sheet: ExcelJS.Worksheet, distributorCode: string, prefilledRows: number, spareRows: number) {
  const totalRows = prefilledRows + spareRows;
  for (let i = 0; i < totalRows; i += 1) {
    const distCell = sheet.getRow(2 + i).getCell(1);
    distCell.value = distributorCode;
    distCell.font = { color: { argb: "FF64748B" } };
  }
}

// ── Product Mapping template (PER-DISTRIBUTOR) ──

export async function buildSosProductMappingTemplate(distributorCode: string): Promise<ArrayBuffer> {
  const code = String(distributorCode ?? "").trim();
  if (!code) throw new SalesWorkflowError("invalid_request", "A distributor is required.", 400);
  const [products, aliases] = await Promise.all([loadProductIndex(), loadExistingProductAliases(code)]);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Product Mapping");
  sheet.columns = [
    { header: "Distrub ID", key: "distributor", width: 14 },
    { header: "ALIAS", key: "alias", width: 44 },
    { header: "PRODUCT_CODE", key: "productCode", width: 16 },
    { header: "PRODUCT_NAME", key: "productName", width: 44 },
  ];
  for (const row of aliases) {
    const product = products.get(normalizeCodeKey(row.productCode));
    sheet.addRow({ distributor: code, alias: row.alias, productCode: row.productCode, productName: product?.name ?? row.productCode });
  }
  if (aliases.length === 0) {
    sheet.addRow({ distributor: code, alias: "paste this distributor's item code or item name", productCode: "MASTER_CODE", productName: "(filled automatically)" });
  }
  headerStyle(sheet, ORANGE);
  await lockDistributorColumn(sheet, code, 3, Math.max(aliases.length, 1), PRODUCT_SPARE_ROWS);

  const reference = workbook.addWorksheet("Master Products");
  reference.columns = [
    { header: "PRODUCT_CODE", key: "code", width: 16 },
    { header: "PRODUCT_NAME", key: "name", width: 46 },
    { header: "LINE", key: "line", width: 22 },
    { header: "FACTORY_PRICE", key: "price", width: 16 },
  ];
  for (const product of [...products.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    reference.addRow({ code: product.code, name: product.name, line: product.line, price: product.price });
  }
  headerStyle(reference, NAVY);

  return workbook.xlsx.writeBuffer() as unknown as ArrayBuffer;
}

export async function importSosProductMappingWorkbook(input: { file: File; actorId: string | null; distributorCode?: string }): Promise<SosMappingImportResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load((await input.file.arrayBuffer()) as Parameters<typeof workbook.xlsx.load>[0]);
  const sheet = workbook.getWorksheet("Product Mapping") ?? workbook.worksheets[0];
  if (!sheet) throw new SalesWorkflowError("invalid_mapping_template", "The mapping workbook has no sheets.", 400);

  // Locate columns by header so both the per-distributor layout (Distrub ID | ALIAS | PRODUCT_CODE | …)
  // and any older global sheet (ALIAS | PRODUCT_CODE | …) round-trip.
  const aliasCol = headerIndex(sheet, ["ALIAS", "Alias"]);
  const codeCol = headerIndex(sheet, ["PRODUCT_CODE", "PRODUCT CODE", "Product code"]);
  if (!aliasCol || !codeCol) {
    throw new SalesWorkflowError("invalid_mapping_template", "Use the downloaded Product Mapping template — its ALIAS and PRODUCT_CODE columns are required.", 400);
  }
  const distCol = headerIndex(sheet, ["Distrub ID", "Distributor", "Distributor code", "Distrib ID"]);

  // The distributor is authoritative from the selected dropdown; fall back to the sheet's locked column.
  let distributorCode = String(input.distributorCode ?? "").trim();
  if (!distributorCode && distCol) {
    for (let r = 2; r <= sheet.rowCount; r += 1) { const v = cellString(sheet.getRow(r), distCol); if (v) { distributorCode = v; break; } }
  }
  if (!distributorCode) {
    throw new SalesWorkflowError("invalid_request", "A distributor is required — product mappings are per-distributor.", 400);
  }

  const products = await loadProductIndex();
  const blockedRows: SosMappingImportResult["blockedRows"] = [];
  const seen = new Map<string, string>(); // normalizedAlias -> productKey (within-file conflict guard)
  const mappings: MappingInput[] = [];
  let skipped = 0;

  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const alias = cellString(row, aliasCol);
    const productCodeRaw = cellString(row, codeCol);
    if (!alias && !productCodeRaw) { skipped += 1; continue; }
    if (!alias) { blockedRows.push({ rowNumber, reason: "Alias is required.", values: productCodeRaw }); continue; }
    const productKey = normalizeCodeKey(productCodeRaw);
    if (!productKey || !products.has(productKey)) {
      blockedRows.push({ rowNumber, reason: `Product code "${productCodeRaw || "(blank)"}" is not in the Source of Sales master.`, values: alias });
      continue;
    }
    const normalizedAlias = normalizeAliasKey(alias);
    if (!normalizedAlias) { blockedRows.push({ rowNumber, reason: "Alias could not be normalized.", values: alias }); continue; }
    const prior = seen.get(normalizedAlias);
    if (prior && prior !== productKey) {
      blockedRows.push({ rowNumber, reason: `Alias "${alias}" maps to two different products in this file.`, values: alias });
      continue;
    }
    seen.set(normalizedAlias, productKey);
    mappings.push({ type: "product", raw: alias, code: products.get(productKey)!.code, distributorCode });
  }

  // Per-row tolerant (like importCustomerMap): persist every valid row even when some rows are blocked,
  // so a single stale/typo'd row in a pre-filled template never discards the user's good edits. The
  // blocked rows are returned for the user to fix and re-upload (the saved rows upsert idempotently).
  const result = await saveMappings(mappings);
  await writeAuditLog({
    actorLoginId: input.actorId ?? "system",
    entityId: "source_of_sales_product_aliases",
    entityType: "sales_import_batch",
    newValues: { blocked: blockedRows.length, distributorCode, saved: result.saved, skipped: skipped + result.skipped, source: "product_mapping_import" },
    summary: `Product mapping import (${distributorCode}) — ${result.saved} saved, ${skipped + result.skipped} skipped, ${blockedRows.length} blocked.`,
  });
  return { saved: result.saved, skipped: skipped + result.skipped, blockedRows };
}

// ── Customer / Brick template (per-distributor; upload reuses importCustomerMap) ──

export async function buildSosCustomerBrickTemplate(distributorCode: string): Promise<ArrayBuffer> {
  const code = String(distributorCode ?? "").trim();
  if (!code) throw new SalesWorkflowError("invalid_request", "A distributor is required.", 400);

  const [existing, refs] = await Promise.all([
    // Stored distributor codes are canonical (normalizeCodeKey'd); match that so the prefill isn't empty
    // when the dropdown value differs in case/spacing.
    listCustomerMap({ distributorCode: normalizeCodeKey(code) }),
    loadSalesReferenceData({ includeCustomerBricks: false }),
  ]);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  workbook.created = new Date();

  // Headers MUST match the customer-map importer (locateCustomerMapSheet): Distrub ID / Customer code / Brick ID.
  const sheet = workbook.addWorksheet("Customer Mapping");
  sheet.columns = [
    { header: "Distrub ID", key: "distributor", width: 14 },
    { header: "Customer code", key: "customerCode", width: 20 },
    { header: "Customer name", key: "customerName", width: 38 },
    { header: "Address", key: "address", width: 38 },
    { header: "Brick ID", key: "brickId", width: 14 },
  ];
  for (const row of existing) {
    sheet.addRow({ distributor: row.distributorCode, customerCode: row.customerCode, customerName: row.customerName, address: row.address, brickId: row.brickId });
  }
  if (existing.length === 0) {
    sheet.addRow({ distributor: code, customerCode: "paste the distributor's customer code", customerName: "", address: "", brickId: "MASTER_BRICK_ID" });
  }
  headerStyle(sheet, ORANGE);
  stampDistributorColumn(sheet, code, Math.max(existing.length, 1), CUSTOMER_SPARE_ROWS);

  const reference = workbook.addWorksheet("Master Bricks");
  reference.columns = [
    { header: "BRICK_ID", key: "brickId", width: 14 },
    { header: "BRICK_NAME", key: "brickName", width: 34 },
    { header: "AREA", key: "area", width: 28 },
    { header: "REGION", key: "region", width: 24 },
  ];
  for (const brick of [...(refs.bricks ?? [])].sort((a, b) => a.brickId.localeCompare(b.brickId))) {
    reference.addRow({ brickId: brick.brickId, brickName: brick.brickName, area: brick.areaName, region: brick.regionName });
  }
  headerStyle(reference, NAVY);

  return workbook.xlsx.writeBuffer() as unknown as ArrayBuffer;
}

// ── Territory / Brick Alias template (GLOBAL — not per-distributor) ──

export async function buildSosTerritoryMappingTemplate(): Promise<ArrayBuffer> {
  const [existing, refs] = await Promise.all([
    listTerritoryAliases(),
    loadSalesReferenceData({ includeCustomerBricks: false }),
  ]);

  const brickIndex = new Map<string, string>();
  for (const b of refs.bricks ?? []) brickIndex.set(normalizeCodeKey(b.brickId), b.brickName);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Territory Mapping");
  sheet.columns = [
    { header: "ALIAS", key: "alias", width: 50 },
    { header: "BRICK_ID", key: "brickId", width: 16 },
    { header: "BRICK_NAME", key: "brickName", width: 38 },
  ];
  for (const row of existing) {
    sheet.addRow({ alias: row.alias, brickId: row.targetCode, brickName: brickIndex.get(normalizeCodeKey(row.targetCode)) ?? row.targetCode });
  }
  if (existing.length === 0) {
    sheet.addRow({ alias: "paste the raw territory / area text here", brickId: "MASTER_BRICK_ID", brickName: "(filled automatically)" });
  }
  headerStyle(sheet, ORANGE);
  sheet.views = [{ state: "frozen", ySplit: 1 }];

  const reference = workbook.addWorksheet("Master Bricks");
  reference.columns = [
    { header: "BRICK_ID", key: "brickId", width: 14 },
    { header: "BRICK_NAME", key: "brickName", width: 34 },
    { header: "AREA", key: "area", width: 28 },
    { header: "REGION", key: "region", width: 24 },
  ];
  for (const brick of [...(refs.bricks ?? [])].sort((a, b) => a.brickId.localeCompare(b.brickId))) {
    reference.addRow({ brickId: brick.brickId, brickName: brick.brickName, area: brick.areaName, region: brick.regionName });
  }
  headerStyle(reference, NAVY);

  return workbook.xlsx.writeBuffer() as unknown as ArrayBuffer;
}

export async function importSosTerritoryMappingWorkbook(input: { file: File; actorId: string | null }): Promise<SosMappingImportResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load((await input.file.arrayBuffer()) as Parameters<typeof workbook.xlsx.load>[0]);
  const sheet = workbook.getWorksheet("Territory Mapping") ?? workbook.worksheets[0];
  if (!sheet) throw new SalesWorkflowError("invalid_mapping_template", "The workbook has no sheets.", 400);

  const aliasCol = headerIndex(sheet, ["ALIAS", "Alias", "Raw", "Territory"]);
  const brickCol = headerIndex(sheet, ["BRICK_ID", "BRICK ID", "Brick ID", "BrickId"]);
  if (!aliasCol || !brickCol) {
    throw new SalesWorkflowError("invalid_mapping_template", "Use the downloaded Territory Mapping template — ALIAS and BRICK_ID columns are required.", 400);
  }

  const refs = await loadSalesReferenceData({ includeCustomerBricks: false });
  const validBricks = new Set((refs.bricks ?? []).map((b) => normalizeCodeKey(b.brickId)));

  const blockedRows: SosMappingImportResult["blockedRows"] = [];
  const seen = new Set<string>();
  const mappings: MappingInput[] = [];
  let skipped = 0;

  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const alias = cellString(row, aliasCol);
    const brickRaw = cellString(row, brickCol);
    if (!alias && !brickRaw) { skipped += 1; continue; }
    if (!alias) { blockedRows.push({ rowNumber, reason: "Alias is required.", values: brickRaw }); continue; }
    const brickKey = normalizeCodeKey(brickRaw);
    if (!brickKey || !validBricks.has(brickKey)) {
      blockedRows.push({ rowNumber, reason: `Brick ID "${brickRaw || "(blank)"}" is not in the master bricks table.`, values: alias });
      continue;
    }
    const normalizedAlias = normalizeAliasKey(alias);
    if (!normalizedAlias) { blockedRows.push({ rowNumber, reason: "Alias could not be normalized.", values: alias }); continue; }
    if (seen.has(normalizedAlias)) { skipped += 1; continue; }
    seen.add(normalizedAlias);
    mappings.push({ type: "territory", raw: alias, code: brickRaw.trim() });
  }

  const result = await saveMappings(mappings);
  await writeAuditLog({
    actorLoginId: input.actorId ?? "system",
    entityId: "source_of_sales_territory_aliases",
    entityType: "sales_import_batch",
    newValues: { blocked: blockedRows.length, saved: result.saved, skipped: skipped + result.skipped, source: "territory_mapping_import" },
    summary: `Territory mapping import — ${result.saved} saved, ${skipped + result.skipped} skipped, ${blockedRows.length} blocked.`,
  });
  return { saved: result.saved, skipped: skipped + result.skipped, blockedRows };
}

export const SOS_MAPPING_XLSX_CONTENT_TYPE = XLSX_CONTENT_TYPE;
