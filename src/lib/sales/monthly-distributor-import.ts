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

export type SalesRegionReference = {
  regionCode: string;
  regionName: string;
};

export type SalesAreaReference = SalesAreaRegionReference;

export type SalesBlockReference = {
  areaCode: string;
  areaName: string;
  blockCode: string;
  blockName: string;
  regionCode: string;
  regionName: string;
};

export type SalesBrickReference = {
  areaCode: string;
  areaName: string;
  blockCode: string;
  blockName: string;
  brickId: string;
  brickName: string;
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
  areas?: SalesAreaReference[];
  blocks?: SalesBlockReference[];
  bricks?: SalesBrickReference[];
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

export type DistributorSalesAreaSummary = DistributorSalesTotal & {
  areaCode: string;
  areaName: string;
  regionCode: string;
  regionName: string;
};

export type DistributorSalesBrickSummary = DistributorSalesTotal & {
  areaCode: string;
  areaName: string;
  blockCode: string;
  blockName: string;
  brickId: string;
  brickName: string;
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
  byArea: DistributorSalesAreaSummary[];
  byBrick: DistributorSalesBrickSummary[];
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
  templateKey: string;
  templateName: string;
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
  templateKey: string;
  totalBonusQty: number;
  totalQty: number;
  totalValue: number;
  uploadedBy: string;
  warningRows: number;
};

export type SourceOfSalesDashboardGroup = DistributorSalesTotal & {
  code: string | null;
  key: string;
  label: string;
  line: string | null;
};

export type SourceOfSalesDashboardDistributor = DistributorSalesTotal & {
  distributorCode: string;
  distributorName: string;
  sheetCount: number;
};

export type SourceOfSalesDashboard = {
  availablePeriods: string[];
  byArea: SourceOfSalesDashboardGroup[];
  byBrick: SourceOfSalesDashboardGroup[];
  byDistributor: SourceOfSalesDashboardDistributor[];
  byLine: SourceOfSalesDashboardGroup[];
  byProduct: SourceOfSalesDashboardGroup[];
  byRegion: SourceOfSalesDashboardGroup[];
  period: string | null;
  sheetCount: number;
  totals: DistributorSalesTotal;
};

export type SourceOfSalesProduct = SalesProductReference & {
  active: boolean;
  createdAt: string;
  normalizedLine: string;
  normalizedProductName: string;
  sourceFile: string;
  sourceRowNumber: number | null;
  sourceSheet: string;
  updatedAt: string;
};

export type SourceOfSalesProductInput = {
  active?: boolean;
  factoryPrice: number | string;
  family: string;
  familyCode: string;
  line: string;
  productCode: string;
  productName: string;
  source: string;
  sourceFile?: string | null;
  sourceRowNumber?: number | string | null;
  sourceSheet?: string | null;
};

type NormalizedSourceOfSalesProductInput = {
  active: boolean;
  factoryPrice: number;
  family: string;
  familyCode: string;
  line: string;
  normalizedLine: string;
  normalizedProductName: string;
  productCode: string;
  productName: string;
  source: string;
  sourceFile: string;
  sourceRowNumber: number | null;
  sourceSheet: string;
};

type HeaderMap = {
  columns: Map<string, number>;
  labels: Map<string, string>;
  rowNumber: number;
  template: DistributorSalesTemplate;
};

type ParsedDistributorRow = {
  areaCode: string;
  areaName: string;
  blockCode: string;
  blockName: string;
  bonusQty: number;
  brickId: string;
  brickName: string;
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

type DistributorSalesTemplateField =
  | "areaCode"
  | "bonusQty"
  | "brickId"
  | "distributorCode"
  | "invoiceDate"
  | "productCode"
  | "qty"
  | "regionCode"
  | "value";

type OptionalTemplateField = "areaName" | "brickName" | "productName" | "regionName";

type DistributorSalesTemplate = {
  distributorCodes: string[];
  fields: Record<DistributorSalesTemplateField, string>;
  key: string;
  name: string;
  optionalFields?: Partial<Record<OptionalTemplateField, string[]>>;
};

const OVERSEAS_PS_TEMPLATE: DistributorSalesTemplate = {
  distributorCodes: ["PS"],
  fields: {
    areaCode: "Area ID",
    bonusQty: "B. Qty",
    brickId: "Brick ID",
    distributorCode: "Distrub ID",
    invoiceDate: "Invoice Date",
    productCode: "Product ID",
    qty: "Qty",
    regionCode: "Region ID",
    value: "Value",
  },
  key: "overseas_ps",
  name: "Overseas PS coded template",
  optionalFields: {
    productName: ["Product Name", "Mat. Desc."],
  },
};

const IBN_SINA_IS_TEMPLATE: DistributorSalesTemplate = {
  distributorCodes: ["IS"],
  fields: {
    areaCode: "Area ID",
    bonusQty: "Free Unit",
    brickId: "Brick ID2",
    distributorCode: "Distrub ID",
    invoiceDate: "Date",
    productCode: "Product ID",
    qty: "Quantity",
    regionCode: "Region ID",
    value: "Net",
  },
  key: "ibn_sina_is",
  name: "Ibn Sina IS coded template",
  optionalFields: {
    brickName: ["Brick Name"],
    productName: ["Item Name"],
  },
};

const DISTRIBUTOR_SALES_TEMPLATES = [
  OVERSEAS_PS_TEMPLATE,
  IBN_SINA_IS_TEMPLATE,
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

function normalizeOptionalDisplay(value: unknown, fallback: string) {
  const normalized = normalizeDisplay(value);
  return normalized || fallback;
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

function requiredHeadersForTemplate(template: DistributorSalesTemplate) {
  return Object.values(template.fields);
}

function templateForDistributor(distributorCode: string) {
  const code = normalizeCode(distributorCode);
  const matchingTemplates = DISTRIBUTOR_SALES_TEMPLATES.filter((template) =>
    template.distributorCodes.includes(code),
  );
  return matchingTemplates.length > 0 ? matchingTemplates : [...DISTRIBUTOR_SALES_TEMPLATES];
}

function findHeaderMap(sheet: ExcelJS.Worksheet, template: DistributorSalesTemplate): HeaderMap | null {
  const maxHeaderRow = Math.min(sheet.rowCount, 10);
  const requiredKeys = requiredHeadersForTemplate(template).map(normalizeKey);

  for (let rowNumber = 1; rowNumber <= maxHeaderRow; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const columns = new Map<string, number>();
    const labels = new Map<string, string>();
    row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
      const rawHeader = normalizeDisplay(cellValue(cell));
      const header = normalizeKey(rawHeader);
      if (header) {
        columns.set(header, columnNumber);
        labels.set(header, rawHeader);
      }
    });

    if (requiredKeys.every((header) => columns.has(header))) {
      return { columns, labels, rowNumber, template };
    }
  }

  return null;
}

function findSalesSheet(workbook: ExcelJS.Workbook, distributorCode: string) {
  const templates = templateForDistributor(distributorCode);
  for (const template of templates) {
    for (const sheet of workbook.worksheets) {
      const headerMap = findHeaderMap(sheet, template);
      if (headerMap) return { sheet, headerMap };
    }
  }
  return null;
}

function requiredTemplateMessage(distributorCode: string) {
  return templateForDistributor(distributorCode)
    .map((template) => `${template.name}: ${requiredHeadersForTemplate(template).join(", ")}`)
    .join(" | ");
}

function valueAtHeader(row: ExcelJS.Row, headerMap: HeaderMap, header: string | null | undefined) {
  if (!header) return null;
  const column = headerMap.columns.get(normalizeKey(header));
  return column ? cellValue(row.getCell(column)) : null;
}

function valueAt(row: ExcelJS.Row, headerMap: HeaderMap, field: DistributorSalesTemplateField) {
  return valueAtHeader(row, headerMap, headerMap.template.fields[field]);
}

function optionalValueAt(row: ExcelJS.Row, headerMap: HeaderMap, field: OptionalTemplateField) {
  const headers = headerMap.template.optionalFields?.[field] ?? [];
  for (const header of headers) {
    const value = valueAtHeader(row, headerMap, header);
    if (normalizeDisplay(value)) return value;
  }
  return null;
}

function hasAnyImportValue(row: ExcelJS.Row, headerMap: HeaderMap) {
  return requiredHeadersForTemplate(headerMap.template).some(
    (header) => normalizeDisplay(valueAtHeader(row, headerMap, header)) !== "",
  );
}

function rawImportRow(row: ExcelJS.Row, headerMap: HeaderMap) {
  return Object.fromEntries(
    [...headerMap.columns.entries()].map(([key, column]) => [
      headerMap.labels.get(key) ?? key,
      normalizeDisplay(cellValue(row.getCell(column))),
    ]),
  );
}

function parseNumber(value: unknown, options?: { emptyAsZero?: boolean }) {
  const text = normalizeDisplay(value);
  if (!text && options?.emptyAsZero) return 0;
  if (!text) return Number.NaN;
  if (typeof value === "number") return Number.isFinite(value) ? value : Number.NaN;
  const parsed = Number(text.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function parseOptionalInteger(value: unknown) {
  const text = normalizeDisplay(value);
  if (!text) return null;
  const parsed = Number(text.replace(/,/g, ""));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : Number.NaN;
}

function requireSourceOfSalesProductField(
  input: SourceOfSalesProductInput,
  key: keyof SourceOfSalesProductInput,
  label: string,
) {
  const value = normalizeDisplay(input[key]);
  if (!value) {
    throw new SalesWorkflowError(
      "invalid_product_reference",
      `${label} is required.`,
      400,
      { field: key },
    );
  }
  return value;
}

export function normalizeSourceOfSalesProductInput(
  input: SourceOfSalesProductInput,
): NormalizedSourceOfSalesProductInput {
  const productCode = normalizeCode(requireSourceOfSalesProductField(input, "productCode", "Product Code"));
  const productName = requireSourceOfSalesProductField(input, "productName", "Product Name");
  const family = requireSourceOfSalesProductField(input, "family", "Family");
  const familyCode = normalizeCode(requireSourceOfSalesProductField(input, "familyCode", "Family Code"));
  const source = requireSourceOfSalesProductField(input, "source", "Source");
  const line = requireSourceOfSalesProductField(input, "line", "Line");
  const factoryPrice = parseNumber(input.factoryPrice);
  const sourceRowNumber = parseOptionalInteger(input.sourceRowNumber);

  if (!Number.isFinite(factoryPrice) || factoryPrice < 0) {
    throw new SalesWorkflowError(
      "invalid_product_reference",
      "Factory Price must be a non-negative number.",
      400,
      { field: "factoryPrice" },
    );
  }

  if (Number.isNaN(sourceRowNumber)) {
    throw new SalesWorkflowError(
      "invalid_product_reference",
      "Source Row Number must be a positive whole number.",
      400,
      { field: "sourceRowNumber" },
    );
  }

  return {
    active: input.active ?? true,
    factoryPrice,
    family,
    familyCode,
    line,
    normalizedLine: normalizeKey(line),
    normalizedProductName: normalizeKey(productName),
    productCode,
    productName,
    source,
    sourceFile: normalizeOptionalDisplay(input.sourceFile, "Manual Entry"),
    sourceRowNumber,
    sourceSheet: normalizeOptionalDisplay(input.sourceSheet, "Products"),
  };
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
  const areaMap = new Map<string, DistributorSalesAreaSummary>();
  const brickMap = new Map<string, DistributorSalesBrickSummary>();
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

    const areaKey = `${row.areaCode}\u0000${row.areaName}\u0000${row.regionCode}`;
    const areaSummary = areaMap.get(areaKey) ?? {
      ...emptyTotals(),
      areaCode: row.areaCode || "Unknown",
      areaName: row.areaName || "Unknown",
      regionCode: row.regionCode || "Unknown",
      regionName: row.regionName || "Unknown",
    };
    addTotals(areaSummary, row);
    areaMap.set(areaKey, areaSummary);

    const brickKey = `${row.brickId}\u0000${row.blockCode}\u0000${row.areaCode}\u0000${row.regionCode}`;
    const brickSummary = brickMap.get(brickKey) ?? {
      ...emptyTotals(),
      areaCode: row.areaCode || "Unknown",
      areaName: row.areaName || "Unknown",
      blockCode: row.blockCode || "Unknown",
      blockName: row.blockName || "Unknown",
      brickId: row.brickId || "Unknown",
      brickName: row.brickName || "Unknown",
      regionCode: row.regionCode || "Unknown",
      regionName: row.regionName || "Unknown",
    };
    addTotals(brickSummary, row);
    brickMap.set(brickKey, brickSummary);

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
    byArea: [...areaMap.values()]
      .map(roundedTotals)
      .sort((left, right) => left.regionCode.localeCompare(right.regionCode) || left.areaCode.localeCompare(right.areaCode)),
    byBrick: [...brickMap.values()]
      .map(roundedTotals)
      .sort((left, right) => left.regionCode.localeCompare(right.regionCode) || left.areaCode.localeCompare(right.areaCode) || left.brickId.localeCompare(right.brickId)),
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
  const areas = references.areas ?? references.regions;
  const regionReferences = new Map<string, SalesRegionReference>();
  for (const row of [...references.regions, ...areas]) {
    const regionCode = normalizeCode(row.regionCode);
    if (regionCode && !regionReferences.has(regionCode)) {
      regionReferences.set(regionCode, {
        regionCode,
        regionName: normalizeDisplay(row.regionName),
      });
    }
  }

  return {
    areaByCode: new Map(areas.map((row) => [normalizeCode(row.areaCode), row])),
    blockByCode: new Map((references.blocks ?? []).map((row) => [normalizeCode(row.blockCode), row])),
    brickById: new Map((references.bricks ?? []).map((row) => [normalizeCode(row.brickId), row])),
    distributorByCode: new Map(references.distributors.map((row) => [normalizeCode(row.code), row])),
    productByCode: new Map(references.products.map((row) => [normalizeCode(row.productCode), row])),
    regionByCode: regionReferences,
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
  const detected = findSalesSheet(workbook, selectedDistributorCode);
  if (!detected) {
    throw new SalesWorkflowError(
      "unsupported_distributor_template",
      `This workbook does not match the selected distributor template. Required headers: ${requiredTemplateMessage(selectedDistributorCode)}.`,
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

    const rawAreaCode = valueAt(row, headerMap, "areaCode");
    const rawAreaName = optionalValueAt(row, headerMap, "areaName");
    const rawBrickId = valueAt(row, headerMap, "brickId");
    const rawBrickName = optionalValueAt(row, headerMap, "brickName");
    const rawRegionCode = valueAt(row, headerMap, "regionCode");
    const rawRegionName = optionalValueAt(row, headerMap, "regionName");
    const rawProductCode = valueAt(row, headerMap, "productCode");
    const rawProductName = optionalValueAt(row, headerMap, "productName");
    const rawQty = valueAt(row, headerMap, "qty");
    const rawBonusQty = valueAt(row, headerMap, "bonusQty");
    const rawValue = valueAt(row, headerMap, "value");
    const rawDistributorCode = valueAt(row, headerMap, "distributorCode");
    const rawInvoiceDate = valueAt(row, headerMap, "invoiceDate");

    const areaCode = normalizeCode(rawAreaCode);
    const brickId = normalizeCode(rawBrickId);
    const regionCode = normalizeCode(rawRegionCode);
    const productCode = normalizeCode(rawProductCode);
    const rowDistributorCode = normalizeCode(rawDistributorCode);
    const qty = parseNumber(rawQty);
    const bonusQty = parseNumber(rawBonusQty, { emptyAsZero: true });
    const value = parseNumber(rawValue);
    const period = invoicePeriod(rawInvoiceDate);

    const productReference = !isNotAvailable(rawProductCode) ? maps.productByCode.get(productCode) : undefined;
    const regionReference = !isNotAvailable(rawRegionCode) ? maps.regionByCode.get(regionCode) : undefined;
    const areaReference = !isNotAvailable(rawAreaCode) ? maps.areaByCode.get(areaCode) : undefined;
    const brickReference = !isNotAvailable(rawBrickId) ? maps.brickById.get(brickId) : undefined;
    const blockReference = brickReference ? maps.blockByCode.get(normalizeCode(brickReference.blockCode)) : undefined;

    const regionName = normalizeDisplay(rawRegionName)
      || regionReference?.regionName
      || areaReference?.regionName
      || brickReference?.regionName
      || regionCode
      || "Unknown";
    const areaName = normalizeDisplay(rawAreaName)
      || areaReference?.areaName
      || brickReference?.areaName
      || areaCode
      || "Unknown";
    const blockCode = brickReference?.blockCode ?? "";
    const blockName = brickReference?.blockName
      || blockReference?.blockName
      || blockCode
      || "Unknown";
    const brickName = normalizeDisplay(rawBrickName)
      || brickReference?.brickName
      || brickId
      || "Unknown";
    const productName = productReference?.productName
      || normalizeDisplay(rawProductName)
      || productCode
      || "Unknown";

    const naFields = [
      [headerMap.template.fields.areaCode, rawAreaCode],
      [headerMap.template.fields.brickId, rawBrickId],
      [headerMap.template.fields.regionCode, rawRegionCode],
      [headerMap.template.fields.productCode, rawProductCode],
      [headerMap.template.fields.distributorCode, rawDistributorCode],
      [headerMap.template.fields.invoiceDate, rawInvoiceDate],
      [headerMap.template.fields.qty, rawQty],
      [headerMap.template.fields.bonusQty, rawBonusQty],
      [headerMap.template.fields.value, rawValue],
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

    if (!areaCode) addIssue(rowIssues, rowNumber, headerMap.template.fields.areaCode, rawAreaCode, "Area code is required.");
    if (!brickId) addIssue(rowIssues, rowNumber, headerMap.template.fields.brickId, rawBrickId, "Brick ID is required.");
    if (!regionCode) addIssue(rowIssues, rowNumber, headerMap.template.fields.regionCode, rawRegionCode, "Region code is required.");
    if (!productCode) addIssue(rowIssues, rowNumber, headerMap.template.fields.productCode, rawProductCode, "Product code is required.");
    if (!rowDistributorCode) addIssue(rowIssues, rowNumber, headerMap.template.fields.distributorCode, rawDistributorCode, "Distributor code is required.");
    if (rowDistributorCode && rowDistributorCode !== selectedDistributorCode) {
      addIssue(
        rowIssues,
        rowNumber,
        headerMap.template.fields.distributorCode,
        rawDistributorCode,
        `Distributor code must be ${selectedDistributorCode} for the selected distributor.`,
      );
    }
    if (!Number.isFinite(qty)) addIssue(rowIssues, rowNumber, headerMap.template.fields.qty, rawQty, "Qty must be numeric.");
    if (!Number.isFinite(bonusQty)) addIssue(rowIssues, rowNumber, headerMap.template.fields.bonusQty, rawBonusQty, "Bonus quantity must be numeric.");
    if (!Number.isFinite(value)) addIssue(rowIssues, rowNumber, headerMap.template.fields.value, rawValue, "Value must be numeric.");
    if (!period) addIssue(rowIssues, rowNumber, headerMap.template.fields.invoiceDate, rawInvoiceDate, "Invoice Date must be a valid date.");

    if (productCode && !isNotAvailable(rawProductCode) && !productReference) {
      addIssue(
        rowIssues,
        rowNumber,
        headerMap.template.fields.productCode,
        rawProductCode,
        `Product Code ${productCode} is not in the product source-of-truth table.`,
      );
    }
    if (regionCode && !isNotAvailable(rawRegionCode) && !regionReference) {
      addIssue(
        rowIssues,
        rowNumber,
        headerMap.template.fields.regionCode,
        rawRegionCode,
        `Region Code ${regionCode} is not in the area/region source-of-truth table.`,
        "warning",
      );
    }
    if (areaCode && !isNotAvailable(rawAreaCode) && !areaReference) {
      addIssue(
        rowIssues,
        rowNumber,
        headerMap.template.fields.areaCode,
        rawAreaCode,
        `Area Code ${areaCode} is not in the area source-of-truth table. Uploaded code is kept for allocation.`,
        "warning",
      );
    }
    if (brickId && !isNotAvailable(rawBrickId) && !brickReference) {
      addIssue(
        rowIssues,
        rowNumber,
        headerMap.template.fields.brickId,
        rawBrickId,
        `Brick ID ${brickId} is not in the brick source-of-truth table. Uploaded code is kept for allocation.`,
        "warning",
      );
    }
    if (regionReference && normalizeKey(regionName) !== normalizeKey(regionReference.regionName)) {
      addIssue(
        rowIssues,
        rowNumber,
        "Region Name",
        rawRegionName,
        `Region Name is different from the source table (${regionReference.regionName}) for Region Code ${regionCode}. Uploaded code is kept for allocation.`,
        "warning",
      );
    }
    if (
      productReference
      && normalizeDisplay(rawProductName)
      && normalizeKey(rawProductName) !== normalizeKey(productReference.productName)
    ) {
      addIssue(
        rowIssues,
        rowNumber,
        "Product Name",
        rawProductName,
        `Product Name is different from the product source table (${productReference.productName}) for Product Code ${productCode}. Official product reference is used.`,
        "warning",
      );
    }
    if (areaReference && regionCode && normalizeCode(areaReference.regionCode) !== regionCode) {
      addIssue(
        rowIssues,
        rowNumber,
        headerMap.template.fields.areaCode,
        rawAreaCode,
        `Area Code ${areaCode} belongs to Region Code ${areaReference.regionCode} in the source table, but the upload says ${regionCode}. Uploaded hierarchy is kept.`,
        "warning",
      );
    }
    if (brickReference && areaCode && normalizeCode(brickReference.areaCode) !== areaCode) {
      addIssue(
        rowIssues,
        rowNumber,
        headerMap.template.fields.brickId,
        rawBrickId,
        `Brick ID ${brickId} belongs to Area Code ${brickReference.areaCode} in the source table, but the upload says ${areaCode}. Uploaded hierarchy is kept.`,
        "warning",
      );
    }

    issues.push(...rowIssues);
    rows.push({
      areaCode: areaCode || normalizeDisplay(rawAreaCode),
      areaName,
      blockCode,
      blockName,
      bonusQty,
      brickId: brickId || normalizeDisplay(rawBrickId),
      brickName,
      distributorCode: rowDistributorCode,
      invoicePeriod: period,
      officialLine: productReference?.line ?? "Unknown",
      productCode: productCode || normalizeDisplay(rawProductCode),
      productName,
      qty,
      regionCode: regionCode || normalizeDisplay(rawRegionCode),
      regionName,
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
    templateKey: headerMap.template.key,
    templateName: headerMap.template.name,
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
    byArea: parsed.byArea,
    byBrick: parsed.byBrick,
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
    templateKey: parsed.templateKey,
    templateName: parsed.templateName,
    totals: parsed.totals,
    warningRows: parsed.warningRows,
  };
}

export async function loadSalesReferenceData(): Promise<SalesReferenceData> {
  const supabase = getSupabaseAdmin();
  const [newRegionsResult, areasResult, blocksResult, bricksResult, productsResult, distributorsResult] = await Promise.all([
    supabase
      .from("source_of_sales_regions")
      .select("region_code,region_name")
      .eq("active", true)
      .order("region_code", { ascending: true }),
    supabase
      .from("source_of_sales_areas")
      .select("area_code,area_name,region_code,region_name")
      .eq("active", true)
      .order("area_code", { ascending: true }),
    supabase
      .from("source_of_sales_blocks")
      .select("block_code,block_name,area_code,area_name,region_code,region_name")
      .eq("active", true)
      .order("block_code", { ascending: true }),
    supabase
      .from("source_of_sales_bricks")
      .select("brick_id,brick_name,block_code,block_name,area_code,area_name,region_code,region_name")
      .eq("active", true)
      .order("brick_id", { ascending: true }),
    supabase
      .from("source_of_sales_products")
      .select("product_code,product_name,factory_price,family,family_code,source,line")
      .eq("active", true)
      .order("product_name", { ascending: true }),
    supabase
      .from("source_of_sales_distributors")
      .select("distributor_code,distributor_name")
      .eq("active", true)
      .order("distributor_name", { ascending: true }),
  ]);

  if (productsResult.error) throw productsResult.error;
  if (distributorsResult.error) throw distributorsResult.error;

  let areas: SalesAreaReference[] = [];
  let regions: SalesAreaRegionReference[] = [];
  const blocks: SalesBlockReference[] = blocksResult.error
    ? []
    : (blocksResult.data ?? []).map((row) => ({
      areaCode: String(row.area_code ?? ""),
      areaName: String(row.area_name ?? ""),
      blockCode: String(row.block_code ?? ""),
      blockName: String(row.block_name ?? ""),
      regionCode: String(row.region_code ?? ""),
      regionName: String(row.region_name ?? ""),
    }));
  const bricks: SalesBrickReference[] = bricksResult.error
    ? []
    : (bricksResult.data ?? []).map((row) => ({
      areaCode: String(row.area_code ?? ""),
      areaName: String(row.area_name ?? ""),
      blockCode: String(row.block_code ?? ""),
      blockName: String(row.block_name ?? ""),
      brickId: String(row.brick_id ?? ""),
      brickName: String(row.brick_name ?? ""),
      regionCode: String(row.region_code ?? ""),
      regionName: String(row.region_name ?? ""),
    }));

  if (!areasResult.error) {
    areas = (areasResult.data ?? []).map((row) => ({
      areaCode: String(row.area_code ?? ""),
      areaName: String(row.area_name ?? ""),
      regionCode: String(row.region_code ?? ""),
      regionName: String(row.region_name ?? ""),
    }));
  } else {
    const legacyRegionsResult = await supabase
      .from("source_of_sales_area_regions")
      .select("area_code,area_name,region_code,region_name")
      .eq("active", true)
      .order("region_code", { ascending: true });
    if (legacyRegionsResult.error) throw legacyRegionsResult.error;
    areas = (legacyRegionsResult.data ?? []).map((row) => ({
      areaCode: String(row.area_code ?? ""),
      areaName: String(row.area_name ?? ""),
      regionCode: String(row.region_code ?? ""),
      regionName: String(row.region_name ?? ""),
    }));
  }

  if (!newRegionsResult.error && (newRegionsResult.data ?? []).length > 0) {
    regions = (newRegionsResult.data ?? []).map((row) => ({
      areaCode: "",
      areaName: "",
      regionCode: String(row.region_code ?? ""),
      regionName: String(row.region_name ?? ""),
    }));
  } else {
    const seenRegions = new Set<string>();
    regions = areas.filter((row) => {
      const code = normalizeCode(row.regionCode);
      if (!code || seenRegions.has(code)) return false;
      seenRegions.add(code);
      return true;
    });
  }

  return {
    areas,
    blocks,
    bricks,
    regions,
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

function mapSourceOfSalesProduct(row: Record<string, unknown>): SourceOfSalesProduct {
  return {
    active: Boolean(row.active ?? true),
    createdAt: String(row.created_at ?? ""),
    factoryPrice: Number(row.factory_price ?? 0),
    family: String(row.family ?? ""),
    familyCode: String(row.family_code ?? ""),
    line: String(row.line ?? ""),
    normalizedLine: String(row.normalized_line ?? ""),
    normalizedProductName: String(row.normalized_product_name ?? ""),
    productCode: String(row.product_code ?? ""),
    productName: String(row.product_name ?? ""),
    source: String(row.source ?? ""),
    sourceFile: String(row.source_file ?? ""),
    sourceRowNumber: row.source_row_number === null || row.source_row_number === undefined
      ? null
      : Number(row.source_row_number),
    sourceSheet: String(row.source_sheet ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

function sourceOfSalesProductPayload(input: NormalizedSourceOfSalesProductInput) {
  return {
    active: input.active,
    factory_price: input.factoryPrice,
    family: input.family,
    family_code: input.familyCode,
    line: input.line,
    normalized_line: input.normalizedLine,
    normalized_product_name: input.normalizedProductName,
    product_code: input.productCode,
    product_name: input.productName,
    source: input.source,
    source_file: input.sourceFile,
    source_row_number: input.sourceRowNumber,
    source_sheet: input.sourceSheet,
    updated_at: new Date().toISOString(),
  };
}

function throwProductMutationError(error: { code?: string; message?: string } | null, fallback: string): never {
  if (error?.code === "23505") {
    throw new SalesWorkflowError(
      "duplicate_product_reference",
      "Product Code or Product Name already exists in the Source of Sales product reference.",
      409,
    );
  }
  throw new SalesWorkflowError("product_reference_mutation_failed", error?.message ?? fallback, 500);
}

export async function listSourceOfSalesProducts(): Promise<SourceOfSalesProduct[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("source_of_sales_products")
    .select("*")
    .order("line", { ascending: true })
    .order("product_name", { ascending: true });

  if (error) throw error;
  return (data ?? []).map((row) => mapSourceOfSalesProduct(row as Record<string, unknown>));
}

export async function createSourceOfSalesProduct(input: {
  actorLoginId: string;
  product: SourceOfSalesProductInput;
}) {
  const normalized = normalizeSourceOfSalesProductInput(input.product);
  const supabase = getSupabaseAdmin();
  const insertResult = await supabase
    .from("source_of_sales_products")
    .insert(sourceOfSalesProductPayload(normalized))
    .select("*")
    .single();

  if (insertResult.error) {
    throwProductMutationError(insertResult.error, "Failed to add Source of Sales product.");
  }

  const product = mapSourceOfSalesProduct(insertResult.data as Record<string, unknown>);
  await writeAuditLog({
    actorLoginId: input.actorLoginId,
    entityId: product.productCode,
    entityType: "source_of_sales_product",
    newValues: { product, source: "source_of_sales" },
    summary: "Source of Sales product added.",
  });

  return product;
}

export async function updateSourceOfSalesProduct(input: {
  actorLoginId: string;
  product: SourceOfSalesProductInput;
  productCode: string;
}) {
  const currentCode = normalizeCode(input.productCode);
  if (!currentCode) {
    throw new SalesWorkflowError("invalid_product_reference", "Product Code is required.", 400);
  }

  const normalized = normalizeSourceOfSalesProductInput(input.product);
  const supabase = getSupabaseAdmin();
  const existingResult = await supabase
    .from("source_of_sales_products")
    .select("*")
    .eq("product_code", currentCode)
    .maybeSingle();

  if (existingResult.error) throw existingResult.error;
  if (!existingResult.data) {
    throw new SalesWorkflowError("product_reference_not_found", "Source of Sales product was not found.", 404);
  }

  const updateResult = await supabase
    .from("source_of_sales_products")
    .update(sourceOfSalesProductPayload(normalized))
    .eq("product_code", currentCode)
    .select("*")
    .single();

  if (updateResult.error) {
    throwProductMutationError(updateResult.error, "Failed to update Source of Sales product.");
  }

  const product = mapSourceOfSalesProduct(updateResult.data as Record<string, unknown>);
  await writeAuditLog({
    actorLoginId: input.actorLoginId,
    entityId: product.productCode,
    entityType: "source_of_sales_product",
    newValues: { product, source: "source_of_sales" },
    oldValues: {
      product: mapSourceOfSalesProduct(existingResult.data as Record<string, unknown>),
      source: "source_of_sales",
    },
    summary: "Source of Sales product updated.",
  });

  return product;
}

export async function deleteSourceOfSalesProduct(input: {
  actorLoginId: string;
  productCode: string;
}) {
  const productCode = normalizeCode(input.productCode);
  if (!productCode) {
    throw new SalesWorkflowError("invalid_product_reference", "Product Code is required.", 400);
  }

  const supabase = getSupabaseAdmin();
  const existingResult = await supabase
    .from("source_of_sales_products")
    .select("*")
    .eq("product_code", productCode)
    .maybeSingle();

  if (existingResult.error) throw existingResult.error;
  if (!existingResult.data) return null;

  const { error } = await supabase
    .from("source_of_sales_products")
    .delete()
    .eq("product_code", productCode);
  if (error) throwProductMutationError(error, "Failed to delete Source of Sales product.");

  await writeAuditLog({
    actorLoginId: input.actorLoginId,
    entityId: productCode,
    entityType: "source_of_sales_product",
    oldValues: {
      product: mapSourceOfSalesProduct(existingResult.data as Record<string, unknown>),
      source: "source_of_sales",
    },
    summary: "Source of Sales product deleted.",
  });

  return true;
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
    templateKey: String(row.template_key ?? ""),
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

type SourceOfSalesSummaryRecord = {
  groupCode: string | null;
  groupKey: string;
  groupLabel: string;
  groupType: string;
  officialLine: string | null;
  rowCount: number;
  totalBonusQty: number;
  totalQty: number;
  totalValue: number;
};

function addDashboardTotals<T extends DistributorSalesTotal>(current: T, row: DistributorSalesTotal) {
  current.rowCount += row.rowCount;
  current.totalQty += row.totalQty;
  current.totalBonusQty += row.totalBonusQty;
  current.totalValue += row.totalValue;
}

function aggregateDashboardGroups(
  summaries: SourceOfSalesSummaryRecord[],
  groupType: string,
): SourceOfSalesDashboardGroup[] {
  const grouped = new Map<string, SourceOfSalesDashboardGroup>();
  summaries
    .filter((row) => row.groupType === groupType)
    .forEach((row) => {
      const current = grouped.get(row.groupKey) ?? {
        ...emptyTotals(),
        code: row.groupCode,
        key: row.groupKey,
        label: row.groupLabel,
        line: row.officialLine,
      };
      addDashboardTotals(current, row);
      grouped.set(row.groupKey, current);
    });

  return [...grouped.values()]
    .map(roundedTotals)
    .sort((left, right) => right.totalValue - left.totalValue || left.label.localeCompare(right.label));
}

export function buildSourceOfSalesDashboard(input: {
  availablePeriods: string[];
  batches: SourceOfSalesUploadBatch[];
  period: string | null;
  summaries: SourceOfSalesSummaryRecord[];
}): SourceOfSalesDashboard {
  const totals = emptyTotals();
  const distributorMap = new Map<string, SourceOfSalesDashboardDistributor>();

  input.batches.forEach((batch) => {
    const batchTotals = {
      rowCount: batch.rowCount,
      totalBonusQty: batch.totalBonusQty,
      totalQty: batch.totalQty,
      totalValue: batch.totalValue,
    };
    addDashboardTotals(totals, batchTotals);
    const key = batch.distributorCode;
    const distributor = distributorMap.get(key) ?? {
      ...emptyTotals(),
      distributorCode: batch.distributorCode,
      distributorName: batch.distributorName,
      sheetCount: 0,
    };
    distributor.sheetCount += 1;
    addDashboardTotals(distributor, batchTotals);
    distributorMap.set(key, distributor);
  });

  return {
    availablePeriods: input.availablePeriods,
    byArea: aggregateDashboardGroups(input.summaries, "area"),
    byBrick: aggregateDashboardGroups(input.summaries, "brick"),
    byDistributor: [...distributorMap.values()]
      .map(roundedTotals)
      .sort((left, right) => right.totalValue - left.totalValue || left.distributorName.localeCompare(right.distributorName)),
    byLine: aggregateDashboardGroups(input.summaries, "line"),
    byProduct: aggregateDashboardGroups(input.summaries, "product"),
    byRegion: aggregateDashboardGroups(input.summaries, "region"),
    period: input.period,
    sheetCount: input.batches.length,
    totals: roundedTotals(totals),
  };
}

function mapSourceOfSalesSummary(row: Record<string, unknown>): SourceOfSalesSummaryRecord {
  return {
    groupCode: row.group_code === null || row.group_code === undefined ? null : String(row.group_code),
    groupKey: String(row.group_key ?? ""),
    groupLabel: String(row.group_label ?? ""),
    groupType: String(row.group_type ?? ""),
    officialLine: row.official_line === null || row.official_line === undefined ? null : String(row.official_line),
    rowCount: Number(row.row_count ?? 0),
    totalBonusQty: Number(row.total_bonus_qty ?? 0),
    totalQty: Number(row.total_qty ?? 0),
    totalValue: Number(row.total_value ?? 0),
  };
}

export async function loadSourceOfSalesDashboard(period?: string | null): Promise<SourceOfSalesDashboard> {
  const supabase = getSupabaseAdmin();
  const periodsResult = await supabase
    .from("source_of_sales_import_batches")
    .select("period")
    .eq("status", "validated")
    .not("period", "is", null)
    .order("period", { ascending: false });

  if (periodsResult.error) throw periodsResult.error;

  const availablePeriods = [...new Set((periodsResult.data ?? [])
    .map((row) => String(row.period ?? ""))
    .filter(Boolean))]
    .sort((left, right) => right.localeCompare(left));
  const selectedPeriod = period && availablePeriods.includes(period) ? period : availablePeriods[0] ?? null;

  if (!selectedPeriod) {
    return buildSourceOfSalesDashboard({
      availablePeriods,
      batches: [],
      period: null,
      summaries: [],
    });
  }

  const batchesResult = await supabase
    .from("source_of_sales_import_batches")
    .select("*")
    .eq("status", "validated")
    .eq("period", selectedPeriod)
    .order("created_at", { ascending: false });

  if (batchesResult.error) throw batchesResult.error;

  const batches = (batchesResult.data ?? []).map((row) => mapSourceOfSalesBatch(row as Record<string, unknown>));
  const batchIds = batches.map((batch) => batch.batchId);
  if (batchIds.length === 0) {
    return buildSourceOfSalesDashboard({
      availablePeriods,
      batches,
      period: selectedPeriod,
      summaries: [],
    });
  }

  const summariesResult = await supabase
    .from("source_of_sales_import_summaries")
    .select("group_type,group_key,group_label,group_code,official_line,row_count,total_qty,total_bonus_qty,total_value")
    .in("batch_id", batchIds);

  if (summariesResult.error) throw summariesResult.error;

  return buildSourceOfSalesDashboard({
    availablePeriods,
    batches,
    period: selectedPeriod,
    summaries: (summariesResult.data ?? []).map((row) => mapSourceOfSalesSummary(row as Record<string, unknown>)),
  });
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
    ...result.byArea.map((row) => ({
      batch_id: batchId,
      group_type: "area",
      group_key: `${row.areaCode}|${row.areaName}|${row.regionCode}`,
      group_label: row.areaName,
      group_code: row.areaCode,
      official_line: row.regionCode,
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
    ...result.byBrick.map((row) => ({
      batch_id: batchId,
      group_type: "brick",
      group_key: `${row.brickId}|${row.brickName}|${row.areaCode}|${row.regionCode}`,
      group_label: row.brickName,
      group_code: row.brickId,
      official_line: row.areaCode,
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
    area_code: row.areaCode,
    area_name: row.areaName,
    batch_id: batchId,
    block_code: row.blockCode,
    brick_id: row.brickId,
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
      template_key: result.templateKey,
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
