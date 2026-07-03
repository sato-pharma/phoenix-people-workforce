import ExcelJS from "exceljs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

import { getSupabaseAdmin } from "@/lib/supabase/server";

export type MarketingDistributorSeed = {
  active: boolean;
  displayName: string;
  distributorCode: string;
  normalizedName: string;
  sourceName: string | null;
};

export type MarketingProductSeed = {
  active: boolean;
  factoryPrice: number;
  family: string | null;
  line: string | null;
  normalizedName: string;
  productCode: string;
  productName: string;
  sourceCompany: string | null;
  sourceFile: string;
};

export type MarketingPharmacyCodeReferenceSeed = {
  normalizedDistributorName: string;
  rawArea: string | null;
  rawDistributorName: string;
  rawPharmacyAddress: string | null;
  rawPharmacyCode: string;
  rawRegion: string | null;
  sourceFile: string;
  sourceRow: number;
};

export type MarketingReferenceImportPreview = {
  distributors: MarketingDistributorSeed[];
  pharmacyCodeReferences: MarketingPharmacyCodeReferenceSeed[];
  products: MarketingProductSeed[];
  summary: {
    distributors: number;
    duplicateDistributorCodePairs: number;
    pharmacyCodeReferences: number;
    products: number;
    skippedPharmacyRows: number;
    skippedProductRows: number;
  };
};

export type MarketingReferenceImportResult = MarketingReferenceImportPreview["summary"] & {
  distributorRowsUpserted: number;
  pharmacyReferenceRowsUpserted: number;
  productRowsUpserted: number;
};

type WorkbookPaths = {
  pharmacyDatabasePath: string;
  productsPath: string;
};

type SeedOptions = WorkbookPaths & {
  batchSize?: number;
  supabase?: SupabaseClient;
};

type HeaderMap = Map<string, number>;

const pharmacySourceFile = "Phoenix Pharmacy Database.xlsx";
const productsSourceFile = "phoenix products.xlsx";

function cleanText(value: unknown) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || null;
}

export function normalizeMarketingLookupKey(value: unknown) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeHeader(value: unknown) {
  return normalizeMarketingLookupKey(value).replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function stableCode(prefix: string, value: string) {
  const slug = value
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .replace(/_/g, " ")
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9_]/g, "")
    .replace(/^_|_$/g, "")
    .toUpperCase();
  const hash = createHash("sha1").update(value).digest("hex").slice(0, 8).toUpperCase();
  const codeBody = slug || `REF_${hash}`;

  return `${prefix}_${codeBody}`.slice(0, 64);
}

function buildHeaderMap(sheet: ExcelJS.Worksheet) {
  const headers: HeaderMap = new Map();
  const row = sheet.getRow(1);
  for (let column = 1; column <= row.cellCount; column += 1) {
    const header = normalizeHeader(row.getCell(column).text || row.getCell(column).value);
    if (header) headers.set(header, column);
  }
  return headers;
}

function requiredColumn(headers: HeaderMap, candidates: string[]) {
  for (const candidate of candidates) {
    const column = headers.get(normalizeHeader(candidate));
    if (column) return column;
  }

  throw new Error(`Missing required column. Expected one of: ${candidates.join(", ")}.`);
}

function optionalColumn(headers: HeaderMap, candidates: string[]) {
  for (const candidate of candidates) {
    const column = headers.get(normalizeHeader(candidate));
    if (column) return column;
  }

  return null;
}

function readableCellValue(cell: ExcelJS.Cell) {
  const value = cell.value;
  if (value && typeof value === "object" && "result" in value) {
    return (value as { result?: unknown }).result ?? cell.text;
  }
  return value ?? cell.text;
}

async function loadWorkbook(path: string) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  return workbook;
}

function firstWorksheet(workbook: ExcelJS.Workbook, fileLabel: string) {
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error(`${fileLabel} has no worksheets.`);
  return sheet;
}

function addDistributor(
  distributorsByNormalizedName: Map<string, MarketingDistributorSeed>,
  rawName: unknown,
) {
  const displayName = cleanText(rawName);
  if (!displayName) return null;

  const normalizedName = normalizeMarketingLookupKey(displayName);
  if (!normalizedName) return null;

  if (!distributorsByNormalizedName.has(normalizedName)) {
    distributorsByNormalizedName.set(normalizedName, {
      active: true,
      displayName,
      distributorCode: stableCode("DST", normalizedName),
      normalizedName,
      sourceName: displayName,
    });
  }

  return normalizedName;
}

async function parseProductWorkbook(
  productsPath: string,
  distributorsByNormalizedName: Map<string, MarketingDistributorSeed>,
) {
  const workbook = await loadWorkbook(productsPath);
  const productsSheet = workbook.getWorksheet("Products") ?? firstWorksheet(workbook, productsSourceFile);
  const headers = buildHeaderMap(productsSheet);
  const productColumn = requiredColumn(headers, ["PRODUCT", "Product"]);
  const factoryPriceColumn = requiredColumn(headers, ["Factory Price"]);
  const familyColumn = optionalColumn(headers, ["Family"]);
  const sourceColumn = optionalColumn(headers, ["Source"]);
  const lineColumn = optionalColumn(headers, ["Line", "Line "]);
  const products: MarketingProductSeed[] = [];
  let skippedProductRows = 0;

  for (let rowNumber = 2; rowNumber <= productsSheet.rowCount; rowNumber += 1) {
    const row = productsSheet.getRow(rowNumber);
    const productName = cleanText(readableCellValue(row.getCell(productColumn)));
    const normalizedName = normalizeMarketingLookupKey(productName);
    if (!productName || !normalizedName) {
      skippedProductRows += 1;
      continue;
    }

    const factoryPrice = Number(readableCellValue(row.getCell(factoryPriceColumn)) ?? 0);
    products.push({
      active: true,
      factoryPrice: Number.isFinite(factoryPrice) && factoryPrice > 0 ? factoryPrice : 0,
      family: familyColumn ? cleanText(readableCellValue(row.getCell(familyColumn))) : null,
      line: lineColumn ? cleanText(readableCellValue(row.getCell(lineColumn))) : null,
      normalizedName,
      productCode: `MKT_PRD${String(products.length + 1).padStart(4, "0")}`,
      productName,
      sourceCompany: sourceColumn ? cleanText(readableCellValue(row.getCell(sourceColumn))) : null,
      sourceFile: productsSourceFile,
    });
  }

  const distributorSheet = workbook.getWorksheet("Distrubutors") ?? workbook.getWorksheet("Distributors");
  if (distributorSheet) {
    for (let rowNumber = 2; rowNumber <= distributorSheet.rowCount; rowNumber += 1) {
      addDistributor(distributorsByNormalizedName, readableCellValue(distributorSheet.getRow(rowNumber).getCell(1)));
    }
  }

  return { products, skippedProductRows };
}

async function parsePharmacyDatabaseWorkbook(
  pharmacyDatabasePath: string,
  distributorsByNormalizedName: Map<string, MarketingDistributorSeed>,
) {
  const workbook = await loadWorkbook(pharmacyDatabasePath);
  const sheet = firstWorksheet(workbook, pharmacySourceFile);
  const headers = buildHeaderMap(sheet);
  const codeColumn = requiredColumn(headers, ["Pharmacy Code"]);
  const addressColumn = optionalColumn(headers, ["Pharmacy Address"]);
  const regionColumn = optionalColumn(headers, ["Region"]);
  const areaColumn = optionalColumn(headers, ["Area"]);
  const distributorColumn = requiredColumn(headers, ["Distrbutor", "Distributor"]);
  const pharmacyCodeReferences: MarketingPharmacyCodeReferenceSeed[] = [];
  const distributorCodePairs = new Map<string, number>();
  let skippedPharmacyRows = 0;

  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const rawPharmacyCode = cleanText(readableCellValue(row.getCell(codeColumn)));
    const rawDistributorName = cleanText(readableCellValue(row.getCell(distributorColumn)));
    if (!rawPharmacyCode || !rawDistributorName) {
      skippedPharmacyRows += 1;
      continue;
    }

    const normalizedDistributorName = addDistributor(distributorsByNormalizedName, rawDistributorName);
    if (!normalizedDistributorName) {
      skippedPharmacyRows += 1;
      continue;
    }

    const pairKey = `${normalizedDistributorName}::${rawPharmacyCode}`;
    distributorCodePairs.set(pairKey, (distributorCodePairs.get(pairKey) ?? 0) + 1);

    pharmacyCodeReferences.push({
      normalizedDistributorName,
      rawArea: areaColumn ? cleanText(readableCellValue(row.getCell(areaColumn))) : null,
      rawDistributorName,
      rawPharmacyAddress: addressColumn ? cleanText(readableCellValue(row.getCell(addressColumn))) : null,
      rawPharmacyCode,
      rawRegion: regionColumn ? cleanText(readableCellValue(row.getCell(regionColumn))) : null,
      sourceFile: pharmacySourceFile,
      sourceRow: rowNumber,
    });
  }

  const duplicateDistributorCodePairs = [...distributorCodePairs.values()].filter((count) => count > 1).length;

  return {
    duplicateDistributorCodePairs,
    pharmacyCodeReferences,
    skippedPharmacyRows,
  };
}

export async function parseMarketingReferenceWorkbooks(
  paths: WorkbookPaths,
): Promise<MarketingReferenceImportPreview> {
  const distributorsByNormalizedName = new Map<string, MarketingDistributorSeed>();
  const { products, skippedProductRows } = await parseProductWorkbook(
    paths.productsPath,
    distributorsByNormalizedName,
  );
  const {
    duplicateDistributorCodePairs,
    pharmacyCodeReferences,
    skippedPharmacyRows,
  } = await parsePharmacyDatabaseWorkbook(paths.pharmacyDatabasePath, distributorsByNormalizedName);
  const distributors = [...distributorsByNormalizedName.values()].sort((left, right) =>
    left.displayName.localeCompare(right.displayName),
  );

  return {
    distributors,
    pharmacyCodeReferences,
    products,
    summary: {
      distributors: distributors.length,
      duplicateDistributorCodePairs,
      pharmacyCodeReferences: pharmacyCodeReferences.length,
      products: products.length,
      skippedPharmacyRows,
      skippedProductRows,
    },
  };
}

function toDistributorDbRow(row: MarketingDistributorSeed) {
  return {
    active: row.active,
    display_name: row.displayName,
    distributor_code: row.distributorCode,
    normalized_name: row.normalizedName,
    source_name: row.sourceName,
  };
}

function toProductDbRow(row: MarketingProductSeed) {
  return {
    active: row.active,
    factory_price: row.factoryPrice,
    family: row.family,
    line: row.line,
    normalized_name: row.normalizedName,
    product_code: row.productCode,
    product_name: row.productName,
    source_company: row.sourceCompany,
    source_file: row.sourceFile,
  };
}

function toReferenceDbRow(
  row: MarketingPharmacyCodeReferenceSeed,
  distributorIdByNormalizedName: Map<string, number>,
) {
  return {
    distributor_id: distributorIdByNormalizedName.get(row.normalizedDistributorName) ?? null,
    normalized_distributor_name: row.normalizedDistributorName,
    raw_area: row.rawArea,
    raw_distributor_name: row.rawDistributorName,
    raw_pharmacy_address: row.rawPharmacyAddress,
    raw_pharmacy_code: row.rawPharmacyCode,
    raw_region: row.rawRegion,
    source_file: row.sourceFile,
    source_row: row.sourceRow,
  };
}

async function upsertInBatches<T>(
  rows: T[],
  batchSize: number,
  execute: (batch: T[]) => Promise<void>,
) {
  for (let index = 0; index < rows.length; index += batchSize) {
    await execute(rows.slice(index, index + batchSize));
  }
}

export type SalesProductCodeLookup = {
  line: string | null;
  normalizedName: string;
  productCode: string;
};

// Known product-name spelling drift between the marketing reference workbook and the
// Source-of-Sales catalog (same product, different source file). Keyed by the marketing side's
// normalized name -> the sales side's normalized name, so reconciliation still matches. Mirrors
// the PRODUCT_LINE_TEXT_ALIASES pattern already used for line-name drift in
// marketing-requests/service.ts.
const MARKETING_PRODUCT_NAME_ALIASES: Record<string, string> = {
  "tebofrtin drops": "tebofotin drops", // phoenix products.xlsx typo; sales catalog has "Tebofotin drops".
};

/**
 * Reconcile marketing product codes against the Source-of-Sales catalog. Sales is the reference
 * for product codes (source_of_sales_products.product_code is what product_scope_override
 * matches in sales dashboards), so a marketing product whose normalized name (or a known alias)
 * matches a sales product on the same line takes over that sales product_code instead of a
 * freshly generated MKT_PRD#### code — one code identifies the product in both catalogs. A
 * product with no sales match (marketing-only) keeps its generated code unchanged.
 */
export function reconcileProductCodesWithSalesCatalog(
  products: MarketingProductSeed[],
  salesProducts: SalesProductCodeLookup[],
): MarketingProductSeed[] {
  const salesCodeByKey = new Map<string, string>();
  for (const sales of salesProducts) {
    const key = `${normalizeMarketingLookupKey(sales.line)}::${sales.normalizedName}`;
    salesCodeByKey.set(key, sales.productCode);
  }
  return products.map((product) => {
    const line = normalizeMarketingLookupKey(product.line);
    const aliasedName = MARKETING_PRODUCT_NAME_ALIASES[product.normalizedName] ?? product.normalizedName;
    const salesCode = salesCodeByKey.get(`${line}::${aliasedName}`);
    return salesCode ? { ...product, productCode: salesCode } : product;
  });
}

export async function seedMarketingReferenceData(
  options: SeedOptions,
): Promise<MarketingReferenceImportResult> {
  const supabase = options.supabase ?? getSupabaseAdmin();
  const batchSize = Math.max(100, options.batchSize ?? 1000);
  const parsed = await parseMarketingReferenceWorkbooks({
    pharmacyDatabasePath: options.pharmacyDatabasePath,
    productsPath: options.productsPath,
  });

  const { data: salesProductRows, error: salesProductsError } = await supabase
    .from("source_of_sales_products")
    .select("product_code, normalized_product_name, line");
  if (salesProductsError) throw salesProductsError;
  const salesProducts: SalesProductCodeLookup[] = (salesProductRows ?? []).map((row) => {
    const typed = row as { line: string | null; normalized_product_name: string | null; product_code: string };
    return {
      line: typed.line,
      normalizedName: String(typed.normalized_product_name ?? ""),
      productCode: typed.product_code,
    };
  });

  const distributorRows = parsed.distributors.map(toDistributorDbRow);
  const productRows = reconcileProductCodesWithSalesCatalog(parsed.products, salesProducts).map(toProductDbRow);

  await upsertInBatches(distributorRows, batchSize, async (batch) => {
    const { error } = await supabase
      .from("marketing_distributors")
      .upsert(batch, { onConflict: "normalized_name" });
    if (error) throw error;
  });

  await upsertInBatches(productRows, batchSize, async (batch) => {
    const { error } = await supabase
      .from("marketing_products")
      .upsert(batch, { onConflict: "product_code" });
    if (error) throw error;
  });

  const { data: distributors, error: distributorSelectError } = await supabase
    .from("marketing_distributors")
    .select("id, normalized_name");
  if (distributorSelectError) throw distributorSelectError;

  const distributorIdByNormalizedName = new Map<string, number>();
  for (const distributor of distributors ?? []) {
    const id = Number((distributor as { id: unknown }).id);
    const normalizedName = String((distributor as { normalized_name: unknown }).normalized_name ?? "");
    if (Number.isFinite(id) && normalizedName) distributorIdByNormalizedName.set(normalizedName, id);
  }

  const referenceRows = parsed.pharmacyCodeReferences.map((row) =>
    toReferenceDbRow(row, distributorIdByNormalizedName),
  );
  await upsertInBatches(referenceRows, batchSize, async (batch) => {
    const { error } = await supabase
      .from("marketing_pharmacy_code_references")
      .upsert(batch, { onConflict: "source_file,source_row" });
    if (error) throw error;
  });

  return {
    ...parsed.summary,
    distributorRowsUpserted: distributorRows.length,
    pharmacyReferenceRowsUpserted: referenceRows.length,
    productRowsUpserted: productRows.length,
  };
}
