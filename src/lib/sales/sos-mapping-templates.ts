import ExcelJS from "exceljs";

import { writeAuditLog } from "@/lib/admin/audit";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import { listCustomerMap } from "@/lib/sales/normalizer/customer-map";
import { saveMappings, type MappingInput } from "@/lib/sales/normalizer/mapping";
import { normalizeAliasKey, normalizeCodeKey } from "@/lib/sales/normalizer/resolvers";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// ─────────────────────────────────────────────────────────────────────────────
// Source of Sales — mapping templates (download → fill → upload), the Weekly-style
// front door for the monthly distributor importer. Two templates:
//   • Product Mapping  — raw item code/name → Phoenix product_code (GLOBAL dictionary;
//     SoS product aliases are not distributor-scoped). Persists to source_of_sales_product_aliases.
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

/** Existing global product aliases (alias → product_code), paginated past PostgREST's 1000-row cap. */
async function loadExistingProductAliases(): Promise<{ alias: string; productCode: string }[]> {
  const supabase = getSupabaseAdmin();
  const pageSize = 1000;
  const rows: { alias: string; productCode: string }[] = [];
  let from = 0;
  for (;;) {
    const result = await supabase
      .from("source_of_sales_product_aliases")
      .select("alias, product_code")
      .eq("active", true)
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

// ── Product Mapping template (global) ──

export async function buildSosProductMappingTemplate(): Promise<ArrayBuffer> {
  const [products, aliases] = await Promise.all([loadProductIndex(), loadExistingProductAliases()]);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Product Mapping");
  sheet.columns = [
    { header: "ALIAS", key: "alias", width: 44 },
    { header: "PRODUCT_CODE", key: "productCode", width: 16 },
    { header: "PRODUCT_NAME", key: "productName", width: 44 },
  ];
  for (const row of aliases) {
    const product = products.get(normalizeCodeKey(row.productCode));
    sheet.addRow({ alias: row.alias, productCode: row.productCode, productName: product?.name ?? row.productCode });
  }
  if (aliases.length === 0) {
    sheet.addRow({ alias: "paste the distributor's item code or item name", productCode: "MASTER_CODE", productName: "(filled automatically)" });
  }
  headerStyle(sheet, ORANGE);

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

export async function importSosProductMappingWorkbook(input: { file: File; actorId: string | null }): Promise<SosMappingImportResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load((await input.file.arrayBuffer()) as Parameters<typeof workbook.xlsx.load>[0]);
  const sheet = workbook.getWorksheet("Product Mapping") ?? workbook.worksheets[0];
  if (!sheet) throw new SalesWorkflowError("invalid_mapping_template", "The mapping workbook has no sheets.", 400);

  const products = await loadProductIndex();
  const blockedRows: SosMappingImportResult["blockedRows"] = [];
  const seen = new Map<string, string>(); // normalizedAlias -> productKey (within-file conflict guard)
  const mappings: MappingInput[] = [];
  let skipped = 0;

  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const alias = cellString(row, 1);
    const productCodeRaw = cellString(row, 2);
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
    mappings.push({ type: "product", raw: alias, code: products.get(productKey)!.code });
  }

  // Per-row tolerant (like importCustomerMap): persist every valid row even when some rows are blocked,
  // so a single stale/typo'd row in a pre-filled template never discards the user's good edits. The
  // blocked rows are returned for the user to fix and re-upload (the saved rows upsert idempotently).
  const result = await saveMappings(mappings);
  await writeAuditLog({
    actorLoginId: input.actorId ?? "system",
    entityId: "source_of_sales_product_aliases",
    entityType: "sales_import_batch",
    newValues: { blocked: blockedRows.length, saved: result.saved, skipped: skipped + result.skipped, source: "product_mapping_import" },
    summary: `Product mapping import — ${result.saved} saved, ${skipped + result.skipped} skipped, ${blockedRows.length} blocked.`,
  });
  return { saved: result.saved, skipped: skipped + result.skipped, blockedRows };
}

// ── Customer / Brick template (per-distributor; upload reuses importCustomerMap) ──

export async function buildSosCustomerBrickTemplate(distributorCode: string): Promise<ArrayBuffer> {
  const code = String(distributorCode ?? "").trim();
  if (!code) throw new SalesWorkflowError("invalid_request", "A distributor is required.", 400);

  const [existing, refs] = await Promise.all([
    listCustomerMap({ distributorCode: code }),
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

export const SOS_MAPPING_XLSX_CONTENT_TYPE = XLSX_CONTENT_TYPE;
