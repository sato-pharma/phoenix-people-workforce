import ExcelJS from "exceljs";

import type { SalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import {
  normalizeWeeklyPosColumnName,
  type WeeklyPosRegionMappingReference,
} from "@/lib/sales/weekly/pos-region-mappings";
import {
  weeklyTemplatesForDistributor,
  type WeeklyTemplate,
  type WeeklyTemplateField,
} from "@/lib/sales/weekly/templates";
import type {
  WeeklyParsedRow,
  WeeklySalesValidationResult,
  WeeklyTotals,
  WeeklyValidationIssue,
} from "@/lib/sales/weekly/types";

// ── small parsing helpers (self-contained; no coupling to the monthly importer) ────────────────

const normHeader = (value: unknown) =>
  String(value ?? "")
    .normalize("NFKC")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
const normCode = (value: unknown) => String(value ?? "").trim().toUpperCase();
function parseWeekFromFileName(fileName: string): string | null {
  const baseName = String(fileName || "");
  const candidate = /(\d{4})(\d{2})(\d{2})/g;
  let match: RegExpExecArray | null;
  while ((match = candidate.exec(baseName)) !== null) {
    const [, y, m, d] = match;
    const iso = `${y}-${m}-${d}`;
    const year = Number(y);
    const month = Number(m);
    const day = Number(d);
    const date = new Date(`${iso}T00:00:00.000Z`);
    if (
      Number.isFinite(year) &&
      Number.isFinite(month) &&
      Number.isFinite(day) &&
      !Number.isNaN(date.getTime()) &&
      date.getUTCFullYear() === year &&
      date.getUTCMonth() + 1 === month &&
      date.getUTCDate() === day
    ) {
      return iso;
    }
  }
  return null;
}

const normName = (value: unknown) =>
  String(value ?? "")
    .replace(/\([^)]*\)/g, " ") // drop "(OLD PRICE)" etc.
    .replace(/[^a-z0-9؀-ۿ]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

function cellText(cell: ExcelJS.Cell | undefined): string {
  if (!cell) return "";
  const value = cell.value as unknown;
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    const obj = value as {
      result?: unknown;
      text?: unknown;
      richText?: { text?: string }[];
    };
    if (obj.richText) return obj.richText.map((part) => part.text).join("").trim();
    if (obj.result != null) return String(obj.result).trim();
    if (obj.text != null) return String(obj.text).trim();
    if (Array.isArray(obj)) return obj.map((part) => cellText({ value: part } as ExcelJS.Cell)).join(" ").trim();
  }
  return String(value).trim();
}

function cellNumber(cell: ExcelJS.Cell | undefined): number {
  const raw = cellText(cell).replace(/,/g, "").replace(/[^0-9.\-]/g, "");
  if (!raw) return 0;
  const num = Number(raw);
  return Number.isFinite(num) ? num : 0;
}

function cellNumberOrNull(cell: ExcelJS.Cell | undefined): number | null {
  const raw = cellText(cell).replace(/,/g, "").replace(/[^0-9.\-]/g, "");
  if (!raw) return null;
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

function resolveWeeklyXfactor(cell: ExcelJS.Cell | undefined, productMasterXfactor: number): { source: string; xfactor: number } {
  const sheetXfactor = cellNumberOrNull(cell);
  if (sheetXfactor != null) return { source: "sheet", xfactor: sheetXfactor };
  return { source: "productMaster", xfactor: Number.isFinite(productMasterXfactor) ? productMasterXfactor : 0 };
}

function weeklySalesValue(salesQty: number, xfactor: number, discount = 0): number {
  const safeQty = Number.isFinite(salesQty) ? salesQty : 0;
  const safeXfactor = Number.isFinite(xfactor) ? xfactor : 0;
  const safeDiscount = Number.isFinite(discount) ? discount : 0;
  return Number((safeQty * safeXfactor * (1 - safeDiscount)).toFixed(6));
}

function cellDateIso(cell: ExcelJS.Cell | undefined): string | null {
  if (!cell) return null;
  const value = cell.value as unknown;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = cellText(cell);
  if (!text) return null;
  // Accept YYYY-MM-DD directly; otherwise let Date try.
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

// A discount cell of 25 means 25% (→0.25); 0.25 is already a fraction. Blank = 0.
function discountFraction(cell: ExcelJS.Cell | undefined): number {
  const num = cellNumber(cell);
  if (!num) return 0;
  return Math.abs(num) > 1 ? num / 100 : num;
}

type HeaderMap = {
  template: WeeklyTemplate;
  rowNumber: number;
  columns: Partial<Record<WeeklyTemplateField, number>>;
};

type WeeklyReferenceIndexes = {
  productByCode: Map<string, SalesReferenceData["products"][number]>;
  productByName: Map<string, SalesReferenceData["products"][number]>;
  regionName: Map<string, string>;
  posRegionByColumn: Map<string, { regionCode: string; regionName: string }>;
};

function resolveHeaderMap(sheet: ExcelJS.Worksheet, template: WeeklyTemplate): HeaderMap | null {
  const maxScan = Math.min(sheet.rowCount || 30, 30);
  for (let rowNumber = 1; rowNumber <= maxScan; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const headerByText = new Map<string, number>();
    let filled = 0;
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const key = normHeader(cellText(cell));
      if (key) {
        if (!headerByText.has(key)) headerByText.set(key, colNumber);
        filled += 1;
      }
    });
    if (filled < 3) continue;

    const columns: Partial<Record<WeeklyTemplateField, number>> = {};
    for (const field of Object.keys(template.fields) as WeeklyTemplateField[]) {
      for (const alias of template.fields[field]) {
        const col = headerByText.get(normHeader(alias));
        if (col) {
          columns[field] = col;
          break;
        }
      }
    }
    const hasRequired = template.required.every((field) => columns[field] != null);
    if (hasRequired) return { template, rowNumber, columns };
  }
  return null;
}

function findWeeklySheet(
  workbook: ExcelJS.Workbook,
  distributorCode: string,
): { sheet: ExcelJS.Worksheet; headerMap: HeaderMap } | null {
  const templates = weeklyTemplatesForDistributor(distributorCode);
  for (const template of templates) {
    for (const sheet of workbook.worksheets) {
      if (
        template.sheetNameIncludes &&
        !sheet.name.toLowerCase().includes(template.sheetNameIncludes.toLowerCase())
      ) {
        continue;
      }
      const headerMap = resolveHeaderMap(sheet, template);
      if (headerMap) return { sheet, headerMap };
    }
    // Fall back to scanning any sheet (in case the sheet name token changed).
    for (const sheet of workbook.worksheets) {
      const headerMap = resolveHeaderMap(sheet, template);
      if (headerMap) return { sheet, headerMap };
    }
  }
  return null;
}

function buildWeeklyReferenceIndexes(
  references: SalesReferenceData,
  posRegionMappings: WeeklyPosRegionMappingReference[] = [],
): WeeklyReferenceIndexes {
  const productByCode = new Map<string, SalesReferenceData["products"][number]>();
  const productByName = new Map<string, SalesReferenceData["products"][number]>();
  for (const product of references.products) {
    if (product.productCode) productByCode.set(normCode(product.productCode), product);
    const nameKey = normName(product.productName);
    if (nameKey && !productByName.has(nameKey)) productByName.set(nameKey, product);
  }

  const regionName = new Map<string, string>();
  for (const pair of references.regions ?? []) {
    const regionCode = normCode(pair.regionCode);
    const displayName = String(pair.regionName ?? "").trim();
    if (regionCode && displayName && !regionName.has(regionCode)) regionName.set(regionCode, displayName);
  }

  const posRegionByColumn = new Map<string, { regionCode: string; regionName: string }>();
  for (const mapping of posRegionMappings) {
    const normalizedColumnName = normalizeWeeklyPosColumnName(mapping.normalizedColumnName || mapping.rawColumnName);
    const regionCode = normCode(mapping.regionCode);
    const officialRegionName = regionName.get(regionCode);
    if (!normalizedColumnName || !regionCode || !officialRegionName) continue;
    posRegionByColumn.set(normalizedColumnName, { regionCode, regionName: officialRegionName });
  }

  return { productByCode, productByName, regionName, posRegionByColumn };
}

function resolveProductByUploadedName(
  productByName: Map<string, SalesReferenceData["products"][number]>,
  uploadedName: string,
): SalesReferenceData["products"][number] | undefined {
  const nameKey = normName(uploadedName);
  if (!nameKey) return undefined;

  const exact = productByName.get(nameKey);
  if (exact) return exact;

  const candidates = [...productByName.entries()]
    .filter(([masterName]) => masterName.length >= 4 && nameKey.startsWith(`${masterName} `))
    .map(([, product]) => product);
  return candidates.length === 1 ? candidates[0] : undefined;
}

function cleanPosBranchName(value: string, colNumber: number): string {
  const cleaned = value
    .normalize("NFKC")
    .replace(/[_\s]*\u0643$/u, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || `POS column ${colNumber}`;
}

function resolveOverseasPosQuantityColumns(
  sheet: ExcelJS.Worksheet,
  headerMap: HeaderMap,
  indexes: WeeklyReferenceIndexes,
): { colNumber: number; branchName: string; regionCode: string; regionName: string; regionSource: string }[] {
  const productCol = headerMap.columns.productCode ?? 0;
  const hasSalesQtyColumn = typeof headerMap.columns.salesQty === "number";
  const totalQtyCol = hasSalesQtyColumn ? (headerMap.columns.salesQty as number) : sheet.columnCount + 1;
  const excluded = new Set<number>();
  for (const colNumber of Object.values(headerMap.columns)) {
    if (typeof colNumber === "number") excluded.add(colNumber);
  }

  const headerRow = sheet.getRow(headerMap.rowNumber);
  const columns: { colNumber: number; branchName: string; regionCode: string; regionName: string; regionSource: string }[] = [];
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    if (colNumber <= productCol || colNumber >= totalQtyCol || excluded.has(colNumber)) return;
    const header = cellText(cell);
    if (!header) return;
    const branchName = cleanPosBranchName(header, colNumber);
    const region = indexes.posRegionByColumn.get(normalizeWeeklyPosColumnName(branchName)) ?? {
      regionCode: "",
      regionName: "",
    };
    columns.push({
      colNumber,
      branchName,
      regionCode: region.regionCode,
      regionName: region.regionName,
      regionSource: region.regionCode ? "mapping" : "unmapped",
    });
  });
  return columns;
}

function parseOverseasPosMatrixWeekly(input: {
  sheet: ExcelJS.Worksheet;
  headerMap: HeaderMap;
  distributorCode: string;
  distributorName: string;
  fileName: string;
  filenameWeek: string | null;
  indexes: WeeklyReferenceIndexes;
}): WeeklyParseOutput {
  const { sheet, headerMap, distributorCode, distributorName, fileName, filenameWeek, indexes } = input;
  const col = headerMap.columns;
  const at = (row: ExcelJS.Row, field: WeeklyTemplateField): ExcelJS.Cell | undefined =>
    col[field] ? row.getCell(col[field] as number) : undefined;
  const quantityColumns = resolveOverseasPosQuantityColumns(sheet, headerMap, indexes);
  const hasSalesQtyColumn = typeof col.salesQty === "number";
  const totalValueCol = hasSalesQtyColumn ? (col.salesQty as number) + 1 : null;

  if (quantityColumns.length === 0) {
    return {
      ok: false,
      error: {
        code: "unsupported_template",
        message: hasSalesQtyColumn
          ? "Overseas POS matrix was recognised, but no outlet quantity columns were found before Total Qty."
          : "Overseas POS matrix was recognised, but no outlet quantity columns were found.",
      },
    };
  }

  const rows: WeeklyParsedRow[] = [];
  const weekStarts = new Set<string>();
  const unmappedPosColumns = new Set<string>();
  let generatedRowNumber = 0;

  const pushFactRow = (fact: {
    rowNumber: number;
    weekStart: string | null;
    regionCode: string;
    regionName: string;
    regionSource: string;
    branchCode: string;
    branchName: string;
    itemCode: string;
    itemName: string;
    productIdRaw: string;
    productCode: string;
    productName: string;
    officialLine: string;
    xfactor: number;
    xfactorSource: string;
    salesQty: number;
    issues: WeeklyValidationIssue[];
    quantitySource: string;
    productTotalQty: number;
    productBonusQty: number;
    sheetTotalValue: string;
  }) => {
    const salesValue = weeklySalesValue(fact.salesQty, fact.xfactor);
    const validationState: WeeklyParsedRow["validationState"] = fact.issues.some((issue) => issue.severity === "failure")
      ? "failed"
      : fact.issues.length > 0
        ? "warning"
        : "valid";

    const importRowNumber = ++generatedRowNumber;
    rows.push({
      rowNumber: importRowNumber,
      weekStart: fact.weekStart,
      distributorCode,
      distributorName,
      regionCode: fact.regionCode,
      regionName: fact.regionName,
      branchCode: fact.branchCode,
      branchName: fact.branchName,
      itemCode: fact.itemCode,
      productCode: fact.productCode,
      productName: fact.productName,
      officialLine: fact.officialLine,
      salesQty: fact.salesQty,
      bonusQty: 0,
      discount: 0,
      salesValue,
      stockQty: 0,
      validationState,
      validationIssues: fact.issues,
      rawRow: {
        itemCode: fact.itemCode,
        itemName: fact.itemName,
        productId: fact.productIdRaw,
        regionCode: fact.regionCode,
        regionName: fact.regionName,
        regionSource: fact.regionSource,
        branchCode: fact.branchCode,
        branchName: fact.branchName,
        salesQty: String(fact.salesQty),
        xfactor: String(fact.xfactor),
        xfactorSource: fact.xfactorSource,
        stockQty: "0",
        quantitySource: fact.quantitySource,
        sourceRowNumber: String(fact.rowNumber),
        productTotalQty: String(fact.productTotalQty),
        productBonusQty: String(fact.productBonusQty),
        sheetTotalValue: fact.sheetTotalValue,
      },
    });
  };

  for (let rowNumber = headerMap.rowNumber + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const itemCode = cellText(at(row, "itemCode"));
    const itemName = cellText(at(row, "itemName"));
    const productIdRaw = cellText(at(row, "productCode"));
    const hasAny =
      itemCode || itemName || productIdRaw || quantityColumns.some((quantityCol) => cellText(row.getCell(quantityCol.colNumber)));
    if (!hasAny) continue;

    const issues: WeeklyValidationIssue[] = [];
    const sheetWeek = cellDateIso(at(row, "weekStart"));
    const weekStart = sheetWeek ?? filenameWeek;
    if (weekStart) weekStarts.add(weekStart);
    else {
      issues.push({
        field: "weekStart",
        message: "Missing or unreadable week date.",
        rowNumber,
        severity: "warning",
        value: cellText(at(row, "weekStart")) || null,
      });
    }

    const productIdKey = normCode(productIdRaw);
    let product = productIdKey && productIdKey !== "#N/A" ? indexes.productByCode.get(productIdKey) : undefined;
    if (!product && itemName) product = resolveProductByUploadedName(indexes.productByName, itemName);
    const productCode = product?.productCode ?? (productIdKey && productIdKey !== "#N/A" ? productIdRaw.trim() : "");
    const productName = product?.productName ?? (itemName || productIdRaw || "");
    const officialLine = product?.line ?? "";
    const { source: xfactorSource, xfactor } = resolveWeeklyXfactor(at(row, "xfactor"), product?.factoryPrice ?? 0);
    if (!product) {
      issues.push({
        field: "productCode",
        message:
          xfactorSource === "sheet"
            ? `Product not found in master (Product ID "${productIdRaw || "?"}", item "${itemName || itemCode || "?"}"); value calculated from uploaded XFactor.`
            : `Product not found in master (Product ID "${productIdRaw || "?"}", item "${itemName || itemCode || "?"}"); value set to 0.`,
        rowNumber,
        severity: "warning",
        value: productIdRaw || itemName || null,
      });
    }

    const outletQty = quantityColumns.reduce((acc, quantityCol) => acc + cellNumber(row.getCell(quantityCol.colNumber)), 0);
    const productTotalQty = hasSalesQtyColumn ? cellNumber(at(row, "salesQty")) : Number(outletQty.toFixed(6));
    const productBonusQty = cellNumber(at(row, "bonusQty"));
    let sheetTotalValue = "";
    if (totalValueCol && totalValueCol > 0) {
      sheetTotalValue = cellText(row.getCell(totalValueCol));
    }

    for (const quantityCol of quantityColumns) {
      const qty = cellNumber(row.getCell(quantityCol.colNumber));
      if (qty === 0) continue;
      const rowIssues = [...issues];
      if (!quantityCol.regionCode) {
        unmappedPosColumns.add(quantityCol.branchName);
        rowIssues.push({
          field: "regionCode",
          message: `POS outlet column "${quantityCol.branchName}" could not be mapped to the Source of Sales region reference table.`,
          rowNumber,
          severity: "warning",
          value: quantityCol.branchName,
        });
      }
      pushFactRow({
        rowNumber,
        weekStart,
        branchCode: quantityCol.branchName,
        branchName: quantityCol.branchName,
        regionCode: quantityCol.regionCode,
        regionName: quantityCol.regionName,
        regionSource: quantityCol.regionSource,
        itemCode,
        itemName,
        productIdRaw,
        productCode,
        productName,
        officialLine,
        xfactor,
        xfactorSource,
        salesQty: qty,
        issues: rowIssues,
        quantitySource: "outletColumn",
        productTotalQty,
        productBonusQty,
        sheetTotalValue,
      });
    }

    if (hasSalesQtyColumn) {
      const diff = Number((productTotalQty - Number(outletQty.toFixed(6))).toFixed(6));
      if (diff !== 0) {
        pushFactRow({
          rowNumber,
          weekStart,
          branchCode: "UNALLOCATED_POS_DIFFERENCE",
          branchName: "Unallocated POS difference",
          regionCode: "",
          regionName: "",
          regionSource: "unallocatedDifference",
          itemCode,
          itemName,
          productIdRaw,
          productCode,
          productName,
          officialLine,
          xfactor,
          xfactorSource,
          salesQty: diff,
          issues: [
            ...issues,
            {
              field: "salesQty",
              message: `Total Qty. (${productTotalQty}) does not match outlet-column sum (${Number(outletQty.toFixed(6))}); imported the difference as an unallocated POS row so product totals stay trusted.`,
              rowNumber,
              severity: "warning",
              value: String(productTotalQty),
            },
          ],
          quantitySource: "unallocatedDifference",
          productTotalQty,
          productBonusQty,
          sheetTotalValue,
        });
      }
    }
  }

  if (rows.length === 0) {
    return { ok: false, error: { code: "empty_file", message: "No data rows found in the weekly file." } };
  }

  if (weekStarts.size === 1) {
    const detectedWeek = [...weekStarts][0];
    for (const row of rows) {
      if (row.weekStart === null) row.weekStart = filenameWeek ?? detectedWeek;
    }
  }

  const distinctWeeks = [...weekStarts].sort();
  const blockingReasons: string[] = [];
  if (unmappedPosColumns.size > 0) {
    blockingReasons.push(
      `Unmapped POS region columns with nonzero sales: ${[...unmappedPosColumns].sort().slice(0, 30).join(", ")}. Download the POS region mapping XLSX, map each column to an official Region ID, upload the mapping, then re-upload sales.`,
    );
  }
  if (distinctWeeks.length > 1) {
    blockingReasons.push(
      `File contains ${distinctWeeks.length} different week dates (${distinctWeeks.join(", ")}). Upload one week per file.`,
    );
  }
  const weekStart = distinctWeeks[0] ?? null;
  if (!weekStart) blockingReasons.push("Could not determine the week date from the sheet's Date column.");

  const result = summarizeWeekly({
    rows,
    distributor: { code: distributorCode, name: distributorName },
    fileName,
    sheetName: sheet.name,
    templateKey: headerMap.template.key,
    templateName: headerMap.template.name,
    weekStart,
    blockingReasons,
  });

  return {
    ok: true,
    rows,
    result: {
      ...result,
      advisories: [
        "Overseas POS matrix detected: sales value was recalculated from quantity and xfactor.",
        "Total Val. from the uploaded sheet was ignored.",
        "Bonus Qty. is product-level in this template and was not counted in weekly sales value.",
      ],
    },
  };
}

export type WeeklyParseError = { code: "unsupported_template" | "empty_file"; message: string };

export type WeeklyParseOutput =
  | { ok: true; rows: WeeklyParsedRow[]; result: WeeklySalesValidationResult }
  | { ok: false; error: WeeklyParseError };

export async function parseWeeklyWorkbookBuffer(input: {
  buffer: ArrayBuffer | Buffer;
  distributorCode: string;
  distributorName: string;
  fileName: string;
  references: SalesReferenceData;
  posRegionMappings?: WeeklyPosRegionMappingReference[];
}): Promise<WeeklyParseOutput> {
  const { distributorCode, distributorName, fileName, references } = input;
  const filenameWeek = parseWeekFromFileName(fileName);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(input.buffer as Parameters<typeof workbook.xlsx.load>[0]);

  const match = findWeeklySheet(workbook, distributorCode);
  if (!match) {
    return {
      ok: false,
      error: {
        code: "unsupported_template",
        message: `No weekly template recognised this file for distributor "${distributorCode}". Register the distributor's weekly format first.`,
      },
    };
  }

  const indexes = buildWeeklyReferenceIndexes(references, input.posRegionMappings ?? []);
  const { productByCode, productByName, regionName } = indexes;
  if (match.headerMap.template.layout === "overseasPosMatrix") {
    return parseOverseasPosMatrixWeekly({
      sheet: match.sheet,
      headerMap: match.headerMap,
      distributorCode,
      distributorName,
      fileName,
      filenameWeek,
      indexes,
    });
  }

  const { sheet, headerMap } = match;
  const col = headerMap.columns;
  const at = (row: ExcelJS.Row, field: WeeklyTemplateField): ExcelJS.Cell | undefined =>
    col[field] ? row.getCell(col[field] as number) : undefined;

  const rows: WeeklyParsedRow[] = [];
  const weekStarts = new Set<string>();

  for (let rowNumber = headerMap.rowNumber + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const itemCode = cellText(at(row, "itemCode"));
    const itemName = cellText(at(row, "itemName"));
    const productIdRaw = cellText(at(row, "productCode"));
    const regionCode = normCode(at(row, "regionCode") ? cellText(at(row, "regionCode")) : "");
    const branchName = cellText(at(row, "branchName"));
    const branchCode = cellText(at(row, "branchCode"));
    const hasAny = itemCode || itemName || productIdRaw || regionCode || branchName;
    if (!hasAny) continue; // skip blank rows

    const issues: WeeklyValidationIssue[] = [];
    const sheetWeek = cellDateIso(at(row, "weekStart"));
    const weekStart = sheetWeek ?? filenameWeek;
    if (weekStart) weekStarts.add(weekStart);
    else
      issues.push({
        field: "weekStart",
        message: "Missing or unreadable week date.",
        rowNumber,
        severity: "warning",
        value: cellText(at(row, "weekStart")) || null,
      });

    // Resolve product: Product ID → master code; else Item name → master name; else unmapped.
    const productIdKey = normCode(productIdRaw);
    let product = productIdKey && productIdKey !== "#N/A" ? productByCode.get(productIdKey) : undefined;
    if (!product && itemName) product = resolveProductByUploadedName(productByName, itemName);
    const productCode = product?.productCode ?? (productIdKey && productIdKey !== "#N/A" ? productIdRaw.trim() : "");
    const productName = product?.productName ?? (itemName || productIdRaw || "");
    const officialLine = product?.line ?? "";
    const { source: xfactorSource, xfactor } = resolveWeeklyXfactor(at(row, "xfactor"), product?.factoryPrice ?? 0);
    if (!product) {
      issues.push({
        field: "productCode",
        message:
          xfactorSource === "sheet"
            ? `Product not found in master (Product ID "${productIdRaw || "—"}", item "${itemName || itemCode || "—"}"); value calculated from uploaded XFactor.`
            : `Product not found in master (Product ID "${productIdRaw || "—"}", item "${itemName || itemCode || "—"}"); value set to 0.`,
        rowNumber,
        severity: "warning",
        value: productIdRaw || itemName || null,
      });
    }

    if (!regionCode) {
      issues.push({ field: "regionCode", message: "Missing Region ID.", rowNumber, severity: "warning", value: null });
    } else if (!regionName.has(regionCode)) {
      issues.push({ field: "regionCode", message: `Region ID "${regionCode}" is not in the master list; row stored but will appear as an unmapped bucket.`, rowNumber, severity: "warning", value: regionCode });
    }

    const salesQty = cellNumber(at(row, "salesQty"));
    const bonusQty = cellNumber(at(row, "bonusQty"));
    const discount = discountFraction(at(row, "discount"));
    const stockQty = cellNumber(at(row, "stockQty"));
    const salesValue = weeklySalesValue(salesQty, xfactor, discount);

    const validationState: WeeklyParsedRow["validationState"] = issues.some((issue) => issue.severity === "failure")
      ? "failed"
      : issues.length > 0
        ? "warning"
        : "valid";

    rows.push({
      rowNumber,
      weekStart,
      distributorCode,
      distributorName,
      regionCode,
      regionName: regionName.get(regionCode) ?? regionCode,
      branchCode,
      branchName,
      itemCode,
      productCode,
      productName,
      officialLine,
      salesQty,
      bonusQty,
      discount,
      salesValue,
      stockQty,
      validationState,
      validationIssues: issues,
      rawRow: {
        itemCode,
        itemName,
        productId: productIdRaw,
        regionCode,
        branchCode,
        branchName,
        salesQty: String(salesQty),
        xfactor: String(xfactor),
        xfactorSource,
        stockQty: String(stockQty),
      },
    });
  }

  if (rows.length === 0) {
    return { ok: false, error: { code: "empty_file", message: "No data rows found in the weekly file." } };
  }

  // Backfill null weekStart rows with the single detected week so they are not silently
  // dropped from the dashboard's per-week aggregation (Codex P2 fix).
  if (weekStarts.size === 1) {
    const detectedWeek = [...weekStarts][0];
    for (const row of rows) {
      if (row.weekStart === null) row.weekStart = filenameWeek ?? detectedWeek;
    }
  }

  // One week per file: block if the sheet carries more than one distinct date.
  const distinctWeeks = [...weekStarts].sort();
  const blockingReasons: string[] = [];
  if (distinctWeeks.length > 1) {
    blockingReasons.push(
      `File contains ${distinctWeeks.length} different week dates (${distinctWeeks.join(", ")}). Upload one week per file.`,
    );
  }
  const weekStart = distinctWeeks[0] ?? null;
  if (!weekStart) blockingReasons.push("Could not determine the week date from the sheet's Date column.");

  const result = summarizeWeekly({
    rows,
    distributor: { code: distributorCode, name: distributorName },
    fileName,
    sheetName: sheet.name,
    templateKey: headerMap.template.key,
    templateName: headerMap.template.name,
    weekStart,
    blockingReasons,
  });
  return { ok: true, rows, result };
}

const emptyTotals = (): WeeklyTotals => ({ rowCount: 0, salesQty: 0, bonusQty: 0, salesValue: 0, stockQty: 0 });
const addTotals = (acc: WeeklyTotals, row: WeeklyParsedRow) => {
  acc.rowCount += 1;
  acc.salesQty += row.salesQty;
  acc.bonusQty += row.bonusQty;
  acc.salesValue += row.salesValue;
  acc.stockQty += row.stockQty;
};
const round = (totals: WeeklyTotals): WeeklyTotals => ({
  rowCount: totals.rowCount,
  salesQty: Number(totals.salesQty.toFixed(2)),
  bonusQty: Number(totals.bonusQty.toFixed(2)),
  salesValue: Number(totals.salesValue.toFixed(2)),
  stockQty: Number(totals.stockQty.toFixed(2)),
});

export function summarizeWeekly(input: {
  rows: WeeklyParsedRow[];
  distributor: { code: string; name: string };
  fileName: string;
  sheetName: string;
  templateKey: string;
  templateName: string;
  weekStart: string | null;
  blockingReasons: string[];
}): WeeklySalesValidationResult {
  const { rows } = input;
  const totals = emptyTotals();
  const regions = new Map<string, { regionName: string; totals: WeeklyTotals }>();
  const products = new Map<string, { productName: string; officialLine: string; totals: WeeklyTotals }>();
  const branches = new Map<string, { branchName: string; regionCode: string; regionName: string; totals: WeeklyTotals }>();
  const issues: WeeklyValidationIssue[] = [];
  let importableRows = 0;
  let failedRows = 0;
  let warningRows = 0;

  for (const row of rows) {
    addTotals(totals, row);
    if (row.validationState === "failed") failedRows += 1;
    else {
      importableRows += 1;
      if (row.validationState === "warning") warningRows += 1;
    }
    for (const issue of row.validationIssues) issues.push(issue);

    const regionKey = row.regionCode || "—";
    const region = regions.get(regionKey) ?? { regionName: row.regionName || regionKey, totals: emptyTotals() };
    addTotals(region.totals, row);
    regions.set(regionKey, region);

    const productKey = row.productCode || row.productName || "—";
    const product = products.get(productKey) ?? { productName: row.productName || productKey, officialLine: row.officialLine, totals: emptyTotals() };
    addTotals(product.totals, row);
    products.set(productKey, product);

    const branchKey = row.branchCode || row.branchName || "—";
    const branch = branches.get(branchKey) ?? { branchName: row.branchName || branchKey, regionCode: row.regionCode, regionName: row.regionName, totals: emptyTotals() };
    addTotals(branch.totals, row);
    branches.set(branchKey, branch);
  }

  const status: "blocked" | "validated" = input.blockingReasons.length > 0 ? "blocked" : "validated";

  return {
    distributor: { code: input.distributor.code, name: input.distributor.name },
    fileName: input.fileName,
    sheetName: input.sheetName,
    templateKey: input.templateKey,
    templateName: input.templateName,
    weekStart: input.weekStart,
    status,
    blockingReasons: input.blockingReasons,
    rowCount: rows.length,
    importableRows,
    failedRows,
    warningRows,
    totals: round(totals),
    byRegion: [...regions.entries()]
      .map(([regionCode, entry]) => ({ regionCode, regionName: entry.regionName, ...round(entry.totals) }))
      .sort((left, right) => right.salesValue - left.salesValue),
    byProduct: [...products.entries()]
      .map(([productCode, entry]) => ({ productCode, productName: entry.productName, officialLine: entry.officialLine, ...round(entry.totals) }))
      .sort((left, right) => right.salesValue - left.salesValue),
    byBranch: [...branches.entries()]
      .map(([branchCode, entry]) => ({ branchCode, branchName: entry.branchName, regionCode: entry.regionCode, regionName: entry.regionName, ...round(entry.totals) }))
      .sort((left, right) => right.salesValue - left.salesValue),
    issues: issues.slice(0, 500),
  };
}
