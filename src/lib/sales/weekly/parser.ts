import ExcelJS from "exceljs";

import type { SalesReferenceData } from "@/lib/sales/monthly-distributor-import";
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

const normHeader = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
const normCode = (value: unknown) => String(value ?? "").trim().toUpperCase();
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
    const obj = value as { result?: unknown; text?: unknown; richText?: { text: string }[] };
    if (obj.richText) return obj.richText.map((part) => part.text).join("").trim();
    if (obj.result != null) return String(obj.result).trim();
    if (obj.text != null) return String(obj.text).trim();
  }
  return String(value).trim();
}

function cellNumber(cell: ExcelJS.Cell | undefined): number {
  const raw = cellText(cell).replace(/,/g, "").replace(/[^0-9.\-]/g, "");
  if (!raw) return 0;
  const num = Number(raw);
  return Number.isFinite(num) ? num : 0;
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

function resolveHeaderMap(sheet: ExcelJS.Worksheet, template: WeeklyTemplate): HeaderMap | null {
  const maxScan = Math.min(sheet.rowCount || 10, 10);
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
}): Promise<WeeklyParseOutput> {
  const { distributorCode, distributorName, fileName, references } = input;

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

  // Product master indexes: by code (Product ID) and by normalised name (Item name fallback).
  const productByCode = new Map<string, (typeof references.products)[number]>();
  const productByName = new Map<string, (typeof references.products)[number]>();
  for (const product of references.products) {
    if (product.productCode) productByCode.set(normCode(product.productCode), product);
    const nameKey = normName(product.productName);
    if (nameKey && !productByName.has(nameKey)) productByName.set(nameKey, product);
  }
  // Region code → name (from the area/region master pairs).
  const regionName = new Map<string, string>();
  for (const pair of references.regions ?? []) {
    if (pair.regionCode && pair.regionName && !regionName.has(normCode(pair.regionCode))) {
      regionName.set(normCode(pair.regionCode), pair.regionName);
    }
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
    const weekStart = cellDateIso(at(row, "weekStart"));
    if (weekStart) weekStarts.add(weekStart);
    else issues.push({ field: "weekStart", message: "Missing or unreadable week date.", rowNumber, severity: "warning", value: cellText(at(row, "weekStart")) || null });

    // Resolve product: Product ID → master code; else Item name → master name; else unmapped.
    const productIdKey = normCode(productIdRaw);
    let product = productIdKey && productIdKey !== "#N/A" ? productByCode.get(productIdKey) : undefined;
    if (!product && itemName) product = productByName.get(normName(itemName));
    const productCode = product?.productCode ?? (productIdKey && productIdKey !== "#N/A" ? productIdRaw.trim() : "");
    const productName = product?.productName ?? (itemName || productIdRaw || "");
    const officialLine = product?.line ?? "";
    const factoryPrice = product?.factoryPrice ?? 0;
    if (!product) {
      issues.push({
        field: "productCode",
        message: `Product not found in master (Product ID "${productIdRaw || "—"}", item "${itemName || itemCode || "—"}"); value set to 0.`,
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
    const salesValue = Number((salesQty * factoryPrice * (1 - discount)).toFixed(6));

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
      if (row.weekStart === null) row.weekStart = detectedWeek;
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
