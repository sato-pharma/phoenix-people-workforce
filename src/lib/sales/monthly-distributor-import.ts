import ExcelJS from "exceljs";

import { writeAuditLog } from "@/lib/admin/audit";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";

export type SalesDistributorOption = {
  code: string;
  name: string;
};

export type SalesAreaRegionReference = {
  areaCode: string;
  areaName: string;
  regionCode: string;
  regionName: string;
};

export type SalesProductReference = {
  factoryPrice: number;
  family: string;
  familyCode: string;
  line: string;
  productCode: string;
  productName: string;
  source: string;
};

export type SalesDistributorReference = SalesDistributorOption;

export type SalesReferenceData = {
  distributors: SalesDistributorReference[];
  products: SalesProductReference[];
  regions: SalesAreaRegionReference[];
};

export type DistributorSalesValidationIssue = {
  field: string;
  message: string;
  rowNumber: number;
  severity: "failure" | "warning";
  value: string | null;
};

export type DistributorSalesTotal = {
  rowCount: number;
  totalBonusQty: number;
  totalQty: number;
  totalValue: number;
};

export type DistributorSalesLineSummary = DistributorSalesTotal & {
  line: string;
};

export type DistributorSalesRegionSummary = DistributorSalesTotal & {
  regionCode: string;
  regionName: string;
};

export type DistributorSalesProductSummary = DistributorSalesTotal & {
  officialLine: string;
  productCode: string;
  productName: string;
};

export type DistributorSalesValidationResult = {
  batchId?: string;
  blockingReasons: string[];
  byLine: DistributorSalesLineSummary[];
  byProduct: DistributorSalesProductSummary[];
  byRegion: DistributorSalesRegionSummary[];
  createdAt?: string;
  distributor: SalesDistributorOption;
  failedRows: number;
  fileName: string;
  importableRows: number;
  issues: DistributorSalesValidationIssue[];
  period: string | null;
  rowCount: number;
  sheetName: string;
  status: "blocked" | "validated";
  totals: DistributorSalesTotal;
  warningRows: number;
};

export type SourceOfSalesUploadBatch = {
  batchId: string;
  blockingReasons: string[];
  createdAt: string;
  distributorCode: string;
  distributorName: string;
  failedRows: number;
  fileName: string;
  importableRows: number;
  period: string | null;
  rowCount: number;
  status: "blocked" | "validated";
  totalBonusQty: number;
  totalQty: number;
  totalValue: number;
  uploadedBy: string;
  warningRows: number;
};

type HeaderMap = {
  columns: Map<string, number>;
  rowNumber: number;
};

type ParsedDistributorRow = {
  bonusQty: number;
  distributorCode: string;
  invoicePeriod: string | null;
  officialLine: string;
  productCode: string;
  productName: string;
  qty: number;
  regionCode: string;
  regionName: string;
  rowNumber: number;
  rawRow: Record<string, string>;
  validationIssues: DistributorSalesValidationIssue[];
  validationState: "failed" | "valid" | "warning";
  value: number;
};

const OVERSEAS_PS_HEADERS = [
  "Region Name",
  "Region Code",
  "Product Name",
  "Product Code",
  "Qty",
  "B. Qty",
  "Value",
  "Distrb code",
  "Invoice Date",
] as const;

function normalizeKey(value: unknown) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeCode(value: unknown) {
  return String(value ?? "").trim().toUpperCase();
}

function normalizeDisplay(value: unknown) {
  return String(value ?? "").trim();
}

function isNotAvailable(value: unknown) {
  return normalizeDisplay(value).toUpperCase() === "#N/A";
}

function cellValue(cell: ExcelJS.Cell) {
  const value = cell.value;
  if (value instanceof Date) return value;
  if (value && typeof value === "object") {
    if ("result" in value) return (value as { result?: unknown }).result ?? cell.text;
    if ("error" in value) return (value as { error?: unknown }).error ?? cell.text;
    if ("text" in value) return (value as { text?: unknown }).text ?? cell.text;
    if ("richText" in value) {
      const richText = (value as { richText?: Array<{ text?: string }> }).richText;
      return richText?.map((part) => part.text ?? "").join("") ?? cell.text;
    }
  }
  return value ?? cell.text;
}

function findHeaderMap(sheet: ExcelJS.Worksheet): HeaderMap | null {
  const maxHeaderRow = Math.min(sheet.rowCount, 10);
  const requiredKeys = OVERSEAS_PS_HEADERS.map(normalizeKey);

  for (let rowNumber = 1; rowNumber <= maxHeaderRow; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const columns = new Map<string, number>();
    row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
      const header = normalizeKey(cellValue(cell));
      if (header) columns.set(header, columnNumber);
    });

    if (requiredKeys.every((header) => columns.has(header))) {
      return { columns, rowNumber };
    }
  }

  return null;
}

function findSalesSheet(workbook: ExcelJS.Workbook) {
  for (const sheet of workbook.worksheets) {
    const headerMap = findHeaderMap(sheet);
    if (headerMap) return { sheet, headerMap };
  }
  return null;
}

function valueAt(row: ExcelJS.Row, headerMap: HeaderMap, header: (typeof OVERSEAS_PS_HEADERS)[number]) {
  const column = headerMap.columns.get(normalizeKey(header));
  return column ? cellValue(row.getCell(column)) : null;
}

function hasAnyImportValue(row: ExcelJS.Row, headerMap: HeaderMap) {
  return OVERSEAS_PS_HEADERS.some((header) => normalizeDisplay(valueAt(row, headerMap, header)) !== "");
}

function parseNumber(value: unknown, options?: { emptyAsZero?: boolean }) {
  const text = normalizeDisplay(value);
  if (!text && options?.emptyAsZero) return 0;
  if (!text) return Number.NaN;
  if (typeof value === "number") return Number.isFinite(value) ? value : Number.NaN;
  const parsed = Number(text.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function excelSerialToDate(serial: number) {
  return new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000);
}

function invoicePeriod(value: unknown) {
  let date: Date | null = null;
  if (value instanceof Date) {
    date = value;
  } else if (typeof value === "number" && Number.isFinite(value)) {
    date = excelSerialToDate(value);
  } else {
    const text = normalizeDisplay(value);
    if (text) {
      const parsed = new Date(text);
      if (!Number.isNaN(parsed.getTime())) date = parsed;
    }
  }

  if (!date || Number.isNaN(date.getTime())) return null;
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function addIssue(
  issues: DistributorSalesValidationIssue[],
  rowNumber: number,
  field: string,
  value: unknown,
  message: string,
  severity: "failure" | "warning" = "failure",
) {
  const issue = {
    field,
    message,
    rowNumber,
    severity,
    value: normalizeDisplay(value) || null,
  };
  issues.push(issue);
  return issue;
}

function validationStateForIssues(issues: DistributorSalesValidationIssue[]): ParsedDistributorRow["validationState"] {
  if (issues.some((issue) => issue.severity === "failure")) return "failed";
  if (issues.length > 0) return "warning";
  return "valid";
}

function rawImportRow(row: ExcelJS.Row, headerMap: HeaderMap) {
  return Object.fromEntries(
    OVERSEAS_PS_HEADERS.map((header) => [header, normalizeDisplay(valueAt(row, headerMap, header))]),
  );
}

function addTotals<T extends DistributorSalesTotal>(current: T, row: ParsedDistributorRow) {
  current.rowCount += 1;
  current.totalQty += Number.isFinite(row.qty) ? row.qty : 0;
  current.totalBonusQty += Number.isFinite(row.bonusQty) ? row.bonusQty : 0;
  current.totalValue += Number.isFinite(row.value) ? row.value : 0;
}

function emptyTotals(): DistributorSalesTotal {
  return {
    rowCount: 0,
    totalBonusQty: 0,
    totalQty: 0,
    totalValue: 0,
  };
}

function roundedTotals<T extends DistributorSalesTotal>(row: T): T {
  return {
    ...row,
    totalBonusQty: Number(row.totalBonusQty.toFixed(6)),
    totalQty: Number(row.totalQty.toFixed(6)),
    totalValue: Number(row.totalValue.toFixed(6)),
  };
}

function summarizeRows(rows: ParsedDistributorRow[]) {
  const totals = emptyTotals();
  const lineMap = new Map<string, DistributorSalesLineSummary>();
  const regionMap = new Map<string, DistributorSalesRegionSummary>();
  const productMap = new Map<string, DistributorSalesProductSummary>();

  rows.forEach((row) => {
    addTotals(totals, row);

    const line = row.officialLine || "Unknown";
    const lineSummary = lineMap.get(line) ?? { ...emptyTotals(), line };
    addTotals(lineSummary, row);
    lineMap.set(line, lineSummary);

    const regionKey = `${row.regionName}\u0000${row.regionCode}`;
    const regionSummary = regionMap.get(regionKey) ?? {
      ...emptyTotals(),
      regionCode: row.regionCode || "Unknown",
      regionName: row.regionName || "Unknown",
    };
    addTotals(regionSummary, row);
    regionMap.set(regionKey, regionSummary);

    const productKey = `${row.productName}\u0000${row.productCode}\u0000${line}`;
    const productSummary = productMap.get(productKey) ?? {
      ...emptyTotals(),
      officialLine: line,
      productCode: row.productCode || "Unknown",
      productName: row.productName || "Unknown",
    };
    addTotals(productSummary, row);
    productMap.set(productKey, productSummary);
  });

  return {
    totals: roundedTotals(totals),
    byLine: [...lineMap.values()]
      .map(roundedTotals)
      .sort((left, right) => left.line.localeCompare(right.line)),
    byRegion: [...regionMap.values()]
      .map(roundedTotals)
      .sort((left, right) => left.regionCode.localeCompare(right.regionCode) || left.regionName.localeCompare(right.regionName)),
    byProduct: [...productMap.values()]
      .map(roundedTotals)
      .sort((left, right) => right.totalValue - left.totalValue || left.productName.localeCompare(right.productName)),
  };
}

function buildReferenceMaps(references: SalesReferenceData) {
  return {
    distributorByCode: new Map(references.distributors.map((row) => [normalizeCode(row.code), row])),
    productByCode: new Map(references.products.map((row) => [normalizeCode(row.productCode), row])),
    regionByCode: new Map(references.regions.map((row) => [normalizeCode(row.regionCode), row])),
  };
}

async function workbookFromBuffer(buffer: ArrayBuffer | Buffer) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as Parameters<typeof workbook.xlsx.load>[0]);
  } catch {
    throw new SalesWorkflowError(
      "invalid_workbook",
      "The uploaded workbook could not be read. Please use a valid .xlsx file.",
      400,
    );
  }
  return workbook;
}

async function parseDistributorSalesWorkbookBuffer(input: {
  buffer: ArrayBuffer | Buffer;
  distributorCode: string;
  fileName: string;
  references: SalesReferenceData;
}): Promise<DistributorSalesValidationResult & { parsedRows: ParsedDistributorRow[] }> {
  const selectedDistributorCode = normalizeCode(input.distributorCode);
  const maps = buildReferenceMaps(input.references);
  const distributor = maps.distributorByCode.get(selectedDistributorCode);

  if (!distributor) {
    throw new SalesWorkflowError(
      "unknown_distributor",
      `Distributor code ${selectedDistributorCode || "(empty)"} is not in the distributor source-of-truth table.`,
      400,
    );
  }

  const workbook = await workbookFromBuffer(input.buffer);
  const detected = findSalesSheet(workbook);
  if (!detected) {
    throw new SalesWorkflowError(
      "unsupported_distributor_template",
      `This workbook does not match the Overseas POS template. Required headers: ${OVERSEAS_PS_HEADERS.join(", ")}.`,
      400,
    );
  }

  const { sheet, headerMap } = detected;
  const issues: DistributorSalesValidationIssue[] = [];
  const rows: ParsedDistributorRow[] = [];

  for (let rowNumber = headerMap.rowNumber + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    if (!hasAnyImportValue(row, headerMap)) continue;
    const rowIssues: DistributorSalesValidationIssue[] = [];

    const rawRegionName = valueAt(row, headerMap, "Region Name");
    const rawRegionCode = valueAt(row, headerMap, "Region Code");
    const rawProductName = valueAt(row, headerMap, "Product Name");
    const rawProductCode = valueAt(row, headerMap, "Product Code");
    const rawQty = valueAt(row, headerMap, "Qty");
    const rawBonusQty = valueAt(row, headerMap, "B. Qty");
    const rawValue = valueAt(row, headerMap, "Value");
    const rawDistributorCode = valueAt(row, headerMap, "Distrb code");
    const rawInvoiceDate = valueAt(row, headerMap, "Invoice Date");

    const regionName = normalizeDisplay(rawRegionName);
    const regionCode = normalizeCode(rawRegionCode);
    const productName = normalizeDisplay(rawProductName);
    const productCode = normalizeCode(rawProductCode);
    const rowDistributorCode = normalizeCode(rawDistributorCode);
    const qty = parseNumber(rawQty);
    const bonusQty = parseNumber(rawBonusQty, { emptyAsZero: true });
    const value = parseNumber(rawValue);
    const period = invoicePeriod(rawInvoiceDate);

    const naFields = [
      ["Region Name", rawRegionName],
      ["Region Code", rawRegionCode],
      ["Product Name", rawProductName],
      ["Product Code", rawProductCode],
    ] as const;

    naFields.forEach(([field, raw]) => {
      if (isNotAvailable(raw)) {
        addIssue(
          rowIssues,
          rowNumber,
          field,
          raw,
          `${field} is #N/A. Fix the workbook mapping before importing.`,
        );
      }
    });

    if (!regionName) addIssue(rowIssues, rowNumber, "Region Name", rawRegionName, "Region Name is required.");
    if (!regionCode) addIssue(rowIssues, rowNumber, "Region Code", rawRegionCode, "Region Code is required.");
    if (!productName) addIssue(rowIssues, rowNumber, "Product Name", rawProductName, "Product Name is required.");
    if (!productCode) addIssue(rowIssues, rowNumber, "Product Code", rawProductCode, "Product Code is required.");
    if (!rowDistributorCode) addIssue(rowIssues, rowNumber, "Distrb code", rawDistributorCode, "Distributor code is required.");
    if (rowDistributorCode && rowDistributorCode !== selectedDistributorCode) {
      addIssue(
        rowIssues,
        rowNumber,
        "Distrb code",
        rawDistributorCode,
        `Distributor code must be ${selectedDistributorCode} for the selected distributor.`,
      );
    }
    if (!Number.isFinite(qty)) addIssue(rowIssues, rowNumber, "Qty", rawQty, "Qty must be numeric.");
    if (!Number.isFinite(bonusQty)) addIssue(rowIssues, rowNumber, "B. Qty", rawBonusQty, "B. Qty must be numeric.");
    if (!Number.isFinite(value)) addIssue(rowIssues, rowNumber, "Value", rawValue, "Value must be numeric.");
    if (!period) addIssue(rowIssues, rowNumber, "Invoice Date", rawInvoiceDate, "Invoice Date must be a valid date.");

    const productReference = !isNotAvailable(rawProductCode) ? maps.productByCode.get(productCode) : undefined;
    const regionReference = !isNotAvailable(rawRegionCode) ? maps.regionByCode.get(regionCode) : undefined;

    if (productCode && !isNotAvailable(rawProductCode) && !productReference) {
      addIssue(
        rowIssues,
        rowNumber,
        "Product Code",
        rawProductCode,
        `Product Code ${productCode} is not in the product source-of-truth table.`,
      );
    }
    if (regionCode && !isNotAvailable(rawRegionCode) && !regionReference) {
      addIssue(
        rowIssues,
        rowNumber,
        "Region Code",
        rawRegionCode,
        `Region Code ${regionCode} is not in the area/region source-of-truth table.`,
      );
    }
    if (regionReference && normalizeKey(regionName) !== normalizeKey(regionReference.regionName)) {
      addIssue(
        rowIssues,
        rowNumber,
        "Region Name",
        rawRegionName,
        `Region Name must be ${regionReference.regionName} for Region Code ${regionCode}.`,
      );
    }
    if (productReference && normalizeKey(productName) !== normalizeKey(productReference.productName)) {
      addIssue(
        rowIssues,
        rowNumber,
        "Product Name",
        rawProductName,
        `Product Name must be ${productReference.productName} for Product Code ${productCode}.`,
      );
    }

    issues.push(...rowIssues);
    rows.push({
      bonusQty,
      distributorCode: rowDistributorCode,
      invoicePeriod: period,
      officialLine: productReference?.line ?? "Unknown",
      productCode: productCode || normalizeDisplay(rawProductCode),
      productName: productName || "Unknown",
      qty,
      regionCode: regionCode || normalizeDisplay(rawRegionCode),
      regionName: regionName || "Unknown",
      rowNumber,
      rawRow: rawImportRow(row, headerMap),
      validationIssues: rowIssues,
      validationState: validationStateForIssues(rowIssues),
      value,
    });
  }

  if (rows.length === 0) {
    throw new SalesWorkflowError("empty_sales_sheet", "No sales rows were found in this workbook.", 400);
  }

  const periods = [...new Set(rows.map((row) => row.invoicePeriod).filter(Boolean) as string[])].sort();
  const blockingReasons: string[] = [];
  const failureIssues = issues.filter((issue) => issue.severity === "failure");
  const warningRows = new Set(issues.filter((issue) => issue.severity === "warning").map((issue) => issue.rowNumber)).size;
  const failedRows = new Set(failureIssues.map((issue) => issue.rowNumber)).size;

  if (failureIssues.length > 0) {
    blockingReasons.push(
      `Fix ${failedRows} row${failedRows === 1 ? "" : "s"} before importing this distributor sales sheet.`,
    );
  }
  if (periods.length === 0) {
    blockingReasons.push("No valid invoice month was detected.");
  }
  if (periods.length > 1) {
    blockingReasons.push(`The sheet contains multiple invoice months: ${periods.join(", ")}.`);
  }

  return {
    ...summarizeRows(rows),
    blockingReasons,
    distributor,
    failedRows,
    fileName: input.fileName,
    importableRows: rows.length - failedRows,
    issues,
    period: periods.length === 1 ? periods[0] : null,
    rowCount: rows.length,
    sheetName: sheet.name,
    status: blockingReasons.length > 0 ? "blocked" : "validated",
    warningRows,
    parsedRows: rows,
  };
}

export async function validateDistributorSalesWorkbookBuffer(input: {
  buffer: ArrayBuffer | Buffer;
  distributorCode: string;
  fileName: string;
  references: SalesReferenceData;
}): Promise<DistributorSalesValidationResult> {
  const parsed = await parseDistributorSalesWorkbookBuffer(input);

  return {
    batchId: parsed.batchId,
    blockingReasons: parsed.blockingReasons,
    byLine: parsed.byLine,
    byProduct: parsed.byProduct,
    byRegion: parsed.byRegion,
    createdAt: parsed.createdAt,
    distributor: parsed.distributor,
    failedRows: parsed.failedRows,
    fileName: parsed.fileName,
    importableRows: parsed.importableRows,
    issues: parsed.issues,
    period: parsed.period,
    rowCount: parsed.rowCount,
    sheetName: parsed.sheetName,
    status: parsed.status,
    totals: parsed.totals,
    warningRows: parsed.warningRows,
  };
}

export async function loadSalesReferenceData(): Promise<SalesReferenceData> {
  const supabase = getSupabaseAdmin();
  const [regionsResult, productsResult, distributorsResult] = await Promise.all([
    supabase
      .from("source_of_sales_area_regions")
      .select("area_code,area_name,region_code,region_name")
      .order("region_code", { ascending: true }),
    supabase
      .from("source_of_sales_products")
      .select("product_code,product_name,factory_price,family,family_code,source,line")
      .order("product_name", { ascending: true }),
    supabase
      .from("source_of_sales_distributors")
      .select("distributor_code,distributor_name")
      .order("distributor_name", { ascending: true }),
  ]);

  if (regionsResult.error) throw regionsResult.error;
  if (productsResult.error) throw productsResult.error;
  if (distributorsResult.error) throw distributorsResult.error;

  return {
    regions: (regionsResult.data ?? []).map((row) => ({
      areaCode: String(row.area_code ?? ""),
      areaName: String(row.area_name ?? ""),
      regionCode: String(row.region_code ?? ""),
      regionName: String(row.region_name ?? ""),
    })),
    products: (productsResult.data ?? []).map((row) => ({
      factoryPrice: Number(row.factory_price ?? 0),
      family: String(row.family ?? ""),
      familyCode: String(row.family_code ?? ""),
      line: String(row.line ?? ""),
      productCode: String(row.product_code ?? ""),
      productName: String(row.product_name ?? ""),
      source: String(row.source ?? ""),
    })),
    distributors: (distributorsResult.data ?? []).map((row) => ({
      code: String(row.distributor_code ?? ""),
      name: String(row.distributor_name ?? ""),
    })),
  };
}

export async function listSalesImportDistributors() {
  const references = await loadSalesReferenceData();
  return references.distributors;
}

function mapSourceOfSalesBatch(row: Record<string, unknown>): SourceOfSalesUploadBatch {
  return {
    batchId: String(row.id ?? ""),
    blockingReasons: Array.isArray(row.blocking_reasons)
      ? row.blocking_reasons.map((reason) => String(reason))
      : [],
    createdAt: String(row.created_at ?? ""),
    distributorCode: String(row.distributor_code ?? ""),
    distributorName: String(row.distributor_name ?? ""),
    failedRows: Number(row.failed_rows ?? 0),
    fileName: String(row.file_name ?? ""),
    importableRows: Number(row.importable_rows ?? 0),
    period: row.period ? String(row.period) : null,
    rowCount: Number(row.total_rows ?? 0),
    status: String(row.status ?? "blocked") === "validated" ? "validated" : "blocked",
    totalBonusQty: Number(row.total_bonus_qty ?? 0),
    totalQty: Number(row.total_qty ?? 0),
    totalValue: Number(row.total_value ?? 0),
    uploadedBy: String(row.uploaded_by ?? "system"),
    warningRows: Number(row.warning_rows ?? 0),
  };
}

export async function listSourceOfSalesUploadBatches(): Promise<SourceOfSalesUploadBatch[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("source_of_sales_import_batches")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) throw error;
  return (data ?? []).map((row) => mapSourceOfSalesBatch(row as Record<string, unknown>));
}

function sourceOfSalesSummaryRows(batchId: string, result: DistributorSalesValidationResult) {
  return [
    ...result.byLine.map((row) => ({
      batch_id: batchId,
      group_type: "line",
      group_key: row.line,
      group_label: row.line,
      group_code: null,
      official_line: row.line,
      row_count: row.rowCount,
      total_qty: row.totalQty,
      total_bonus_qty: row.totalBonusQty,
      total_value: row.totalValue,
    })),
    ...result.byRegion.map((row) => ({
      batch_id: batchId,
      group_type: "region",
      group_key: `${row.regionCode}|${row.regionName}`,
      group_label: row.regionName,
      group_code: row.regionCode,
      official_line: null,
      row_count: row.rowCount,
      total_qty: row.totalQty,
      total_bonus_qty: row.totalBonusQty,
      total_value: row.totalValue,
    })),
    ...result.byProduct.map((row) => ({
      batch_id: batchId,
      group_type: "product",
      group_key: `${row.productCode}|${row.productName}|${row.officialLine}`,
      group_label: row.productName,
      group_code: row.productCode,
      official_line: row.officialLine,
      row_count: row.rowCount,
      total_qty: row.totalQty,
      total_bonus_qty: row.totalBonusQty,
      total_value: row.totalValue,
    })),
  ];
}

async function insertSourceOfSalesRows(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  batchId: string,
  rows: ParsedDistributorRow[],
) {
  const inserts = rows.map((row) => ({
    batch_id: batchId,
    row_number: row.rowNumber,
    distributor_code: row.distributorCode,
    invoice_period: row.invoicePeriod,
    region_name: row.regionName,
    region_code: row.regionCode,
    product_name: row.productName,
    product_code: row.productCode,
    official_line: row.officialLine,
    qty: Number.isFinite(row.qty) ? row.qty : 0,
    bonus_qty: Number.isFinite(row.bonusQty) ? row.bonusQty : 0,
    value: Number.isFinite(row.value) ? row.value : 0,
    validation_state: row.validationState,
    validation_issues: row.validationIssues,
    raw_row: row.rawRow,
  }));

  for (let index = 0; index < inserts.length; index += 500) {
    const { error } = await supabase
      .from("source_of_sales_import_rows")
      .insert(inserts.slice(index, index + 500));
    if (error) throw error;
  }
}

export async function createSourceOfSalesUpload(input: {
  distributorCode: string;
  file: File;
  uploadedBy: string;
}) {
  const references = await loadSalesReferenceData();
  const buffer = await input.file.arrayBuffer();
  const parsed = await parseDistributorSalesWorkbookBuffer({
    buffer,
    distributorCode: input.distributorCode,
    fileName: input.file.name,
    references,
  });
  const { parsedRows, ...result } = parsed;

  const supabase = getSupabaseAdmin();
  const batchInsert = await supabase
    .from("source_of_sales_import_batches")
    .insert({
      distributor_code: result.distributor.code,
      distributor_name: result.distributor.name,
      template_key: "overseas_ps",
      file_name: result.fileName,
      sheet_name: result.sheetName,
      period: result.period,
      status: result.status,
      total_rows: result.rowCount,
      importable_rows: result.importableRows,
      failed_rows: result.failedRows,
      warning_rows: result.warningRows,
      total_qty: result.totals.totalQty,
      total_bonus_qty: result.totals.totalBonusQty,
      total_value: result.totals.totalValue,
      blocking_reasons: result.blockingReasons,
      uploaded_by: input.uploadedBy,
    })
    .select("id,created_at")
    .single();

  if (batchInsert.error) throw batchInsert.error;

  const batchId = String(batchInsert.data.id);
  await insertSourceOfSalesRows(supabase, batchId, parsedRows);

  const summaries = sourceOfSalesSummaryRows(batchId, result);
  if (summaries.length > 0) {
    const { error } = await supabase.from("source_of_sales_import_summaries").insert(summaries);
    if (error) throw error;
  }

  return {
    ...result,
    batchId,
    createdAt: String(batchInsert.data.created_at),
  };
}

export async function validateDistributorSalesFile(input: {
  distributorCode: string;
  file: File;
}) {
  const references = await loadSalesReferenceData();
  const buffer = await input.file.arrayBuffer();
  return validateDistributorSalesWorkbookBuffer({
    buffer,
    distributorCode: input.distributorCode,
    fileName: input.file.name,
    references,
  });
}

export async function deleteSourceOfSalesUploadBatch(input: {
  actorLoginId: string;
  batchId: string;
}) {
  const supabase = getSupabaseAdmin();
  const { data: existing, error: existingError } = await supabase
    .from("source_of_sales_import_batches")
    .select("id,file_name,distributor_code,period,status")
    .eq("id", input.batchId)
    .maybeSingle();

  if (existingError) throw existingError;
  if (!existing) return null;

  const { error } = await supabase
    .from("source_of_sales_import_batches")
    .delete()
    .eq("id", input.batchId);
  if (error) throw error;

  await writeAuditLog({
    actorLoginId: input.actorLoginId,
    entityId: input.batchId,
    entityType: "sales_import_batch",
    oldValues: {
      distributorCode: existing.distributor_code,
      fileName: existing.file_name,
      period: existing.period,
      source: "source_of_sales",
      status: existing.status,
    },
    summary: "Source of Sales uploaded sheet deleted.",
  });

  return true;
}
