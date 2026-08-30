import ExcelJS from "exceljs";

import type { SalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import { IGNORE_PRODUCT_CODE } from "@/lib/sales/normalizer/types";
import {
  weeklyContractByCode,
  type WeeklyContractSheet,
  type WeeklyContractSheetRole,
  type WeeklyDistributorContract,
} from "@/lib/sales/weekly/column-contract";
import type { WeeklyBranchRegionIndex } from "@/lib/sales/weekly/branch-region-map";
import { canonicalWeeklyDistributorCode, weeklyDistributorByCode } from "@/lib/sales/weekly/distributors";
import { normalizeCode, normalizeKey, normalizeSoft } from "@/lib/sales/weekly/mapping-normalize";
import type { WeeklyProductAliasIndex } from "@/lib/sales/weekly/product-aliases";
import type {
  WeeklyExcludedBranch,
  WeeklyExcludedItem,
  WeeklyParsedRow,
  WeeklySalesValidationResult,
  WeeklyTotals,
  WeeklyValidationIssue,
} from "@/lib/sales/weekly/types";

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Weekly Sales — mapping-driven parser engine.
//
// One generic core does all the business logic:
//   • product resolution  → alias index (distributor code/name → master product_code)
//   • region resolution   → branch-region index (branch key OR PS stock column-index → master region)
//   • value               → netQty × master factory_price (discount + sheet value columns ignored)
//   • net                 → netQty = grossSalesQty − returnQty
//   • aggregation grain   → (product_code, branchKey, period) over the UNION of every (product,branch)
//                            key seen across the sales / return / stock observations.
//   • strict validation   → any "failure" issue blocks the whole batch (nothing persists).
//
// Five thin distributor adapters (EG / RM / IS-S / IS / PS) read each verified raw layout and emit
// neutral "observations" (product + branch + one of sales/return/stock). The core never knows the
// per-distributor column layout.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

// ── cell helpers ────────────────────────────────────────────────────────────────────────────────

function cellText(cell: ExcelJS.Cell | undefined): string {
  if (!cell) return "";
  const value = cell.value as unknown;
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    const obj = value as { result?: unknown; text?: unknown; richText?: { text?: string }[] };
    if (obj.richText) return obj.richText.map((part) => part.text).join("").trim();
    if (obj.result != null) return String(obj.result).trim();
    if (obj.text != null) return String(obj.text).trim();
    if (Array.isArray(obj)) return obj.map((part) => cellText({ value: part } as ExcelJS.Cell)).join(" ").trim();
  }
  return String(value).trim();
}

function cellNumber(cell: ExcelJS.Cell | undefined): number {
  if (!cell) return 0;
  const value = cell.value as unknown;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const text = cellText(cell);
  if (!text) return 0;
  // Accounting style text negatives, e.g. "(500)" → -500, before we strip non-numeric characters.
  const isParenNegative = /^\(.*\)$/.test(text.trim());
  const raw = text.replace(/,/g, "").replace(/[^0-9.\-]/g, "");
  if (!raw) return 0;
  const num = Number(raw);
  if (!Number.isFinite(num)) return 0;
  return isParenNegative ? -Math.abs(num) : num;
}

/** Thousands-separated, at most 2 decimals — for numbers that appear in operator-facing messages. */
function readableNumber(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30); // 1899-12-30, the ExcelJS/Lotus serial epoch
const DAY_MS = 24 * 60 * 60 * 1000;

/** Convert an Excel SERIAL number, a Date, or YYYY-MM-DD text into an ISO date (YYYY-MM-DD) or null. */
function cellDateIso(cell: ExcelJS.Cell | undefined): string | null {
  if (!cell) return null;
  const value = cell.value as unknown;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "number" && Number.isFinite(value)) return excelSerialToIso(value);
  if (typeof value === "object" && value != null) {
    const obj = value as { result?: unknown };
    if (obj.result instanceof Date) return obj.result.toISOString().slice(0, 10);
    if (typeof obj.result === "number" && Number.isFinite(obj.result)) return excelSerialToIso(obj.result);
  }
  const text = cellText(cell);
  if (!text) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  // Numeric text that is really a serial (e.g. "45810").
  if (/^\d+(\.\d+)?$/.test(text)) {
    const serial = Number(text);
    if (serial > 59 && serial < 100000) return excelSerialToIso(serial);
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function excelSerialToIso(serial: number): string | null {
  // Only treat plausible date serials as dates (Excel dates after ~1900). Small integers like a
  // quantity or a branch code must NOT be mistaken for dates.
  if (serial <= 59 || serial >= 100000) return null;
  const ms = EXCEL_EPOCH_UTC + Math.round(serial) * DAY_MS;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

// ── reference indexes ─────────────────────────────────────────────────────────────────────────

type MasterProduct = SalesReferenceData["products"][number];

type WeeklyReferenceIndexes = {
  /** master product by normalized product_code */
  productByCode: Map<string, MasterProduct>;
  /** region display name by region code (from the master regions list) */
  regionNameByCode: Map<string, string>;
};

function buildReferenceIndexes(references: SalesReferenceData): WeeklyReferenceIndexes {
  const productByCode = new Map<string, MasterProduct>();
  for (const product of references.products) {
    const code = normalizeCode(product.productCode);
    if (code && !productByCode.has(code)) productByCode.set(code, product);
  }
  const regionNameByCode = new Map<string, string>();
  for (const region of references.regions ?? []) {
    const code = normalizeCode(region.regionCode);
    const name = String(region.regionName ?? "").trim();
    if (code && !regionNameByCode.has(code)) regionNameByCode.set(code, name || code);
  }
  return { productByCode, regionNameByCode };
}

// ── neutral observations emitted by adapters ────────────────────────────────────────────────────

type WeeklySide = "sales" | "return" | "stock";

/**
 * One observation from the raw file: a (product, branch) value of a given side. The core resolves
 * the master product + master region, validates, and aggregates across sides.
 */
type WeeklyObservation = {
  side: WeeklySide;
  sourceRowNumber: number;
  /** distributor's own item code (alias kind "code") */
  rawItemCode: string;
  /** distributor's own item name (alias kind "name") */
  rawItemName: string;
  /** distributor's own branch code (joins the branch-region map) */
  rawBranchCode: string;
  /** distributor's own branch display name */
  rawBranchName: string;
  /** which branch file the row came from (drives the `${fileType}|key` lookup) */
  branchFileType: "sales" | "stock";
  /** quantity (gross sales units / returned units / stock units depending on side) — always >= 0 */
  qty: number;
  /**
   * Distributor-authoritative NET quantity for this (product, branch) row, when the source file
   * states net directly (e.g. RM's صافى كمية / col15). When present on a sales-side observation it
   * becomes the net of record for the aggregate; the gross/return split is reconciled to it.
   */
  authoritativeNet?: number;
  /** PS stock column-index path: resolve region by column index + verify header drift */
  posColumnIndex?: number;
  posColumnHeaderRaw?: string;
  /** PS unallocated reconciliation row — bypasses branch mapping, region left empty */
  unallocated?: boolean;
  /** POS only: per-product total bonus (free) units. Never priced. Carried on a dedicated synthetic
   *  unallocated observation (qty=0) so it doesn't inflate sales numbers. */
  bonusQty?: number;
  /** Direct only: raw (unresolved) Region ID text. When set, resolveRegion maps the branch DIRECTLY
   *  to this region (no branch-region admin mapping involved) — including the "NATIONAL" sentinel. */
  directRegionCodeRaw?: string;
  /** Direct only: rawItemCode is already a Source-of-Sales MASTER product code (the operator fills
   *  the canonical ID by hand) — resolveProduct skips the raw→master alias lookup entirely. */
  directProductLookup?: boolean;
  /** Direct only: the sheet's own per-row Value (real per-deal pricing). Summed per aggregate and
   *  used AS the row's salesValue instead of netQty × factory_price. */
  sheetValue?: number;
};

type AdapterContext = {
  workbooks: ExcelJS.Workbook[];
  distributorCode: string;
  branchMapIndex: WeeklyBranchRegionIndex;
  /** Resolved column contract (DB override merged over code, or code default). Drives column positions.
   *  Optional: when absent, every lookup falls back to the original code-literal columns. */
  contract?: WeeklyDistributorContract;
};

// ── contract-driven column resolution ─────────────────────────────────────────────────────────
// Adapters read column POSITIONS (and the header-row number, and matrix bounds) from the resolved
// contract instead of hard-coded literals, so an in-app edit can move a column without a code change.
// Every lookup carries the original literal as a fallback, so a contract that is somehow missing a sheet
// or field degrades to EXACTLY the previous hard-coded behaviour (proven by the golden parser tests).

function contractSheet(contract: WeeklyDistributorContract | undefined, role: WeeklyContractSheetRole): WeeklyContractSheet | undefined {
  return contract?.sheets.find((sheet) => sheet.role === role);
}

/** 1-based column for a field key on a sheet, or the code-literal fallback if absent. */
function colOf(sheet: WeeklyContractSheet | undefined, field: string, fallback: number): number {
  const found = sheet?.fields.find((f) => f.field === field);
  const value = found?.columnIndex;
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : fallback;
}

/** First data row = header row + 1, or the code-literal fallback if the sheet is absent. */
function dataStartRow(sheet: WeeklyContractSheet | undefined, fallback: number): number {
  const header = sheet?.headerRowNumber;
  return typeof header === "number" && (header === 1 || header === 2) ? header + 1 : fallback;
}

/** Header row (1-based) the matrix scan reads, or the fallback if the sheet is absent. */
function headerRowOf(sheet: WeeklyContractSheet | undefined, fallback: number): number {
  const header = sheet?.headerRowNumber;
  return typeof header === "number" && (header === 1 || header === 2) ? header : fallback;
}

/** Compile a matrix stop-pattern (case-insensitive) from the contract, falling back on any error. */
function stopRegex(pattern: string | undefined, fallback: RegExp): RegExp {
  if (!pattern) return fallback;
  try {
    return new RegExp(pattern, "i");
  } catch {
    return fallback;
  }
}


type AdapterResult = {
  observations: WeeklyObservation[];
  /** distinct sheet dates collected (ISO). One → auto-use; zero/many → periodDate required. */
  sheetDates: Set<string>;
  /** sheet name(s) for the batch label */
  sheetName: string;
  /** hard structural failures the adapter detected (e.g. PS missing a file, header drift) */
  blockingReasons: string[];
};

// ── adapters: each reads a verified real layout and emits neutral observations ───────────────────

function findSheet(
  workbook: ExcelJS.Workbook,
  matcher: { name?: string; includes?: string },
): ExcelJS.Worksheet | undefined {
  if (matcher.name) {
    const exact = workbook.worksheets.find((sheet) => sheet.name.trim().toLowerCase() === matcher.name!.toLowerCase());
    if (exact) return exact;
  }
  if (matcher.includes) {
    return workbook.worksheets.find((sheet) => sheet.name.toLowerCase().includes(matcher.includes!.toLowerCase()));
  }
  return workbook.worksheets[0];
}

const at = (row: ExcelJS.Row, col: number): ExcelJS.Cell => row.getCell(col);

// EG (EGD) — combined workbook. Sales = "Branches Sales", Returns = "Branch Sales Return",
// Stock = "Current Stock Branches" only.
function adaptEG(ctx: AdapterContext): AdapterResult {
  const workbook = ctx.workbooks[0];
  const observations: WeeklyObservation[] = [];
  const sheetDates = new Set<string>();
  const blockingReasons: string[] = [];
  const names: string[] = [];

  const salesC = contractSheet(ctx.contract, "sales");
  const returnsC = contractSheet(ctx.contract, "returns");
  const stockC = contractSheet(ctx.contract, "stock");

  const sales = findSheet(workbook, { name: "Branches Sales", includes: "Branches Sales" });
  if (sales) {
    names.push(sales.name);
    for (let r = dataStartRow(salesC, 2); r <= sales.rowCount; r += 1) {
      const row = sales.getRow(r);
      const itemCode = cellText(at(row, colOf(salesC, "itemCode", 5)));
      const itemName = cellText(at(row, colOf(salesC, "itemName", 6)));
      const branchCode = cellText(at(row, colOf(salesC, "branchCode", 29)));
      const branchName = cellText(at(row, colOf(salesC, "branchName", 30)));
      const qty = cellNumber(at(row, colOf(salesC, "salesQty", 13)));
      if (!itemCode && !itemName && !branchCode) continue;
      const date = cellDateIso(at(row, colOf(salesC, "date", 4)));
      if (date) sheetDates.add(date);
      observations.push({
        side: "sales",
        sourceRowNumber: r,
        rawItemCode: itemCode,
        rawItemName: itemName,
        rawBranchCode: branchCode,
        rawBranchName: branchName,
        branchFileType: "sales",
        qty,
      });
    }
  }

  const returns = findSheet(workbook, { name: "Branch Sales Return", includes: "Branch Sales Return" });
  if (returns) {
    names.push(returns.name);
    for (let r = dataStartRow(returnsC, 2); r <= returns.rowCount; r += 1) {
      const row = returns.getRow(r);
      const itemCode = cellText(at(row, colOf(returnsC, "itemCode", 5)));
      const itemName = cellText(at(row, colOf(returnsC, "itemName", 6)));
      const branchCode = cellText(at(row, colOf(returnsC, "branchCode", 29)));
      const branchName = cellText(at(row, colOf(returnsC, "branchName", 30)));
      const qty = Math.abs(cellNumber(at(row, colOf(returnsC, "returnQty", 14)))); // RETURN_QTY is negative in the file
      if (!itemCode && !itemName && !branchCode) continue;
      const date = cellDateIso(at(row, colOf(returnsC, "date", 4)));
      if (date) sheetDates.add(date);
      observations.push({
        side: "return",
        sourceRowNumber: r,
        rawItemCode: itemCode,
        rawItemName: itemName,
        rawBranchCode: branchCode,
        rawBranchName: branchName,
        branchFileType: "sales",
        qty,
      });
    }
  }

  // Stock ONLY from "Current Stock Branches" (ignore Pharmacy / Transfer / Transfer Return). Sum
  // ITEM_STOCK per (ITEM_CODE, COMPANY_ENTITY_CODE).
  const stock = findSheet(workbook, { name: "Current Stock Branches", includes: "Current Stock Branches" });
  if (stock) {
    names.push(stock.name);
    const agg = new Map<string, WeeklyObservation>();
    for (let r = dataStartRow(stockC, 2); r <= stock.rowCount; r += 1) {
      const row = stock.getRow(r);
      const itemCode = cellText(at(row, colOf(stockC, "itemCode", 1)));
      const itemName = cellText(at(row, colOf(stockC, "itemName", 2)));
      const entityCode = cellText(at(row, colOf(stockC, "entityCode", 13)));
      const entityName = cellText(at(row, colOf(stockC, "entityName", 14)));
      const qty = cellNumber(at(row, colOf(stockC, "stockQty", 3)));
      if (!itemCode && !entityCode) continue;
      const key = `${normalizeCode(itemCode)}|${normalizeKey(entityCode || entityName)}`;
      const existing = agg.get(key);
      if (existing) {
        existing.qty += qty;
      } else {
        agg.set(key, {
          side: "stock",
          sourceRowNumber: r,
          rawItemCode: itemCode,
          rawItemName: itemName,
          rawBranchCode: entityCode,
          rawBranchName: entityName,
          branchFileType: "stock",
          qty,
        });
      }
    }
    for (const obs of agg.values()) observations.push(obs);
  }

  return { observations, sheetDates, sheetName: names.join(" + ") || "EGD", blockingReasons };
}

// RM (RAMCO) — combined workbook. Sales sheet header row 2, data row 3+. NET qty is stated directly
// in col15 (صافى كمية) and is AUTHORITATIVE — it can carry adjustments not visible in بيع(col11) /
// مرتجع بيع(col13). col11 = gross, abs(col13) = return are kept only for the display split; the core
// uses col15 as the net of record and reconciles gross/return so (gross − return) == net. Stock sheet
// header row 2, grand total per product (no branch).
function adaptRM(ctx: AdapterContext): AdapterResult {
  const workbook = ctx.workbooks[0];
  const observations: WeeklyObservation[] = [];
  const sheetDates = new Set<string>();
  const names: string[] = [];

  // Build Arabic-name → numeric-code lookup from the SALES sheet (col2 → col1).
  // The STOCK sheet headers use Arabic branch names; this map lets us emit stock with
  // the same numeric key already registered in the branch-mapping template.
  const branchNameToCode = new Map<string, string>();

  const salesC = contractSheet(ctx.contract, "sales");
  const stockC = contractSheet(ctx.contract, "stock");

  const sales = findSheet(workbook, { name: "SALES", includes: "SALES" });
  if (sales) {
    names.push(sales.name);
    for (let r = dataStartRow(salesC, 3); r <= sales.rowCount; r += 1) {
      const row = sales.getRow(r);
      const itemCode = cellText(at(row, colOf(salesC, "itemCode", 9)));
      const itemName = cellText(at(row, colOf(salesC, "itemName", 10)));
      // col1 = numeric branch code (e.g. "11"); col2 = Arabic branch name (e.g. "شرق").
      // The mapping template uses the numeric code as the join key, so rawBranchCode = col1.
      const branchCode = cellText(at(row, colOf(salesC, "branchCode", 1)));
      const branchName = cellText(at(row, colOf(salesC, "branchName", 2)));
      if (branchCode && branchName) branchNameToCode.set(branchName.trim(), branchCode.trim());
      const gross = cellNumber(at(row, colOf(salesC, "gross", 11)));
      const ret = Math.abs(cellNumber(at(row, colOf(salesC, "return", 13))));
      const net = cellNumber(at(row, colOf(salesC, "net", 15))); // صافى كمية — authoritative net of record
      if (!itemCode && !itemName && !branchCode && !branchName) continue;
      const date = cellDateIso(at(row, colOf(salesC, "date", 24)));
      if (date) sheetDates.add(date);
      // Carry the authoritative net (col15) on the sales-side observation; keep gross (col11) for the
      // display split. The core reconciles return = gross − net so the row reconciles to col15.
      observations.push({
        side: "sales",
        sourceRowNumber: r,
        rawItemCode: itemCode,
        rawItemName: itemName,
        rawBranchCode: branchCode || branchName,
        rawBranchName: branchName || branchCode,
        branchFileType: "sales",
        qty: gross,
        authoritativeNet: net,
      });
      if (ret > 0) {
        observations.push({
          side: "return",
          sourceRowNumber: r,
          rawItemCode: itemCode,
          rawItemName: itemName,
          rawBranchCode: branchCode || branchName,
          rawBranchName: branchName || branchCode,
          branchFileType: "sales",
          qty: ret,
        });
      }
    }
  }

  // STOCK sheet is a wide matrix: one row per product; headers run until the grand-total column
  // (الإجمالى) or the first empty cell. Each header is either "إجمالى <branch-name>" (regular
  // branches) or a raw channel label (Key Accounts, Wholesale, Tenders, etc.). Strip the "إجمالى"
  // prefix when present; otherwise use the raw header as the branch key so that any column the
  // user has mapped is counted, regardless of its header format.
  const stock = findSheet(workbook, { name: "STOCK", includes: "STOCK" });
  if (stock) {
    names.push(stock.name);

    const branchCols = new Map<number, { code: string; name: string }>();
    const stockHeaderRow = stockC?.headerRowNumber === 1 || stockC?.headerRowNumber === 2 ? stockC.headerRowNumber : 2;
    const matrixFirst = stockC?.matrix?.firstColumn ?? 6;
    const headerRow = stock.getRow(stockHeaderRow);
    const headerKey = (value: string) => value.replace(/\s+/g, "").trim();
    const isGrandTotalHeader = (value: string) => {
      const key = headerKey(value);
      return key === headerKey("الإجمالى")
        || key === headerKey("الاجمالى")
        || key === headerKey("الإجمالي")
        || key === headerKey("الاجمالي");
    };
    const branchNameFromHeader = (value: string): string | null => {
      const raw = value.trim();
      if (!raw) return null;
      if (isGrandTotalHeader(raw)) return null;
      const match = raw.match(/^(إجمالى|اجمالى|إجمالي|اجمالي)\s*/u);
      if (!match) return raw; // no prefix → use raw header as the branch key
      const name = raw.slice(match[0].length).trim();
      return name || raw;
    };

    for (let c = matrixFirst; c <= stock.columnCount; c += 1) {
      const header = cellText(headerRow.getCell(c));
      if (!header.trim()) break;
      if (isGrandTotalHeader(header)) break;
      const name = branchNameFromHeader(header);
      if (!name) break;
      const mapped = branchNameToCode.get(name.trim());
      branchCols.set(c, { code: mapped ?? name, name });
    }

    for (let r = dataStartRow(stockC, 3); r <= stock.rowCount; r += 1) {
      const row = stock.getRow(r);
      const itemCode = cellText(at(row, colOf(stockC, "itemCode", 4)));
      const itemName = cellText(at(row, colOf(stockC, "itemName", 5)));
      if (!itemCode && !itemName) continue;

      for (const [col, branch] of branchCols) {
        const qty = cellNumber(row.getCell(col));
        if (qty === 0) continue; // skip zero-stock branch entries to keep row count lean
        observations.push({
          side: "stock",
          sourceRowNumber: r,
          rawItemCode: itemCode,
          rawItemName: itemName,
          rawBranchCode: branch.code,
          rawBranchName: branch.name,
          branchFileType: "sales",
          qty,
        });
      }
    }
  }

  return { observations, sheetDates, sheetName: names.join(" + ") || "RAMCO", blockingReasons: [] };
}

// IS-S (Ibn Sina Sato) — single sheet "SalesAndStockReport2_DataHub", title row 1, header row 2,
// data row 3+. Single Date in col1. Sales Quantity (col10) is signed (negative = inline return).
function adaptISS(ctx: AdapterContext): AdapterResult {
  const workbook = ctx.workbooks[0];
  const combinedC = contractSheet(ctx.contract, "combined");
  const sheet = findSheet(workbook, { name: "SalesAndStockReport2_DataHub", includes: "DataHub" }) ?? workbook.worksheets[0];
  const observations: WeeklyObservation[] = [];
  const sheetDates = new Set<string>();
  if (!sheet) return { observations, sheetDates, sheetName: "Ibn Sina Sato", blockingReasons: [] };

  for (let r = dataStartRow(combinedC, 3); r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r);
    const itemCode = cellText(at(row, colOf(combinedC, "itemCode", 4)));
    const itemName = cellText(at(row, colOf(combinedC, "itemName", 5)));
    const branchCode = cellText(at(row, colOf(combinedC, "branchCode", 6)));
    const branchName = cellText(at(row, colOf(combinedC, "branchName", 7)));
    // Skip totals/footer row (blank Item Code + blank Branch).
    if (!itemCode && !branchCode) continue;
    const date = cellDateIso(at(row, colOf(combinedC, "date", 1)));
    if (date) sheetDates.add(date);
    const stock = cellNumber(at(row, colOf(combinedC, "stockQty", 8)));
    const signedSales = cellNumber(at(row, colOf(combinedC, "signedSales", 10)));
    pushSignedSales(observations, r, { itemCode, itemName, branchCode, branchName }, signedSales);
    if (stock !== 0 || itemCode || branchCode) {
      observations.push({
        side: "stock",
        sourceRowNumber: r,
        rawItemCode: itemCode,
        rawItemName: itemName,
        rawBranchCode: branchCode,
        rawBranchName: branchName,
        branchFileType: "stock",
        qty: stock,
      });
    }
  }
  return { observations, sheetDates, sheetName: sheet.name, blockingReasons: [] };
}

// IS (Ibn Sina, "ISP" file) — single sheet "Sheet2", header row 1, data row 2+. NO Date column.
// Sales Quantity (col9) signed (negative = return). Free Unit (col10) is ignored.
function adaptIS(ctx: AdapterContext): AdapterResult {
  const workbook = ctx.workbooks[0];
  const combinedC = contractSheet(ctx.contract, "combined");
  const sheet = findSheet(workbook, { name: "Sheet2", includes: "Sheet2" }) ?? workbook.worksheets[0];
  const observations: WeeklyObservation[] = [];
  const sheetDates = new Set<string>(); // IS has no date column → always require periodDate
  if (!sheet) return { observations, sheetDates, sheetName: "Ibn Sina", blockingReasons: [] };

  for (let r = dataStartRow(combinedC, 2); r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r);
    const itemCode = cellText(at(row, colOf(combinedC, "itemCode", 3)));
    const itemName = cellText(at(row, colOf(combinedC, "itemName", 4)));
    const branchCode = cellText(at(row, colOf(combinedC, "branchCode", 5)));
    const branchName = cellText(at(row, colOf(combinedC, "branchName", 6)));
    if (!itemCode && !branchCode) continue;
    const stock = cellNumber(at(row, colOf(combinedC, "stockQty", 7)));
    const signedSales = cellNumber(at(row, colOf(combinedC, "signedSales", 9)));
    // col10 (Free Unit) is ignored — free units are never counted as sales.
    pushSignedSales(observations, r, { itemCode, itemName, branchCode, branchName }, signedSales);
    if (stock !== 0 || itemCode || branchCode) {
      observations.push({
        side: "stock",
        sourceRowNumber: r,
        rawItemCode: itemCode,
        rawItemName: itemName,
        rawBranchCode: branchCode,
        rawBranchName: branchName,
        branchFileType: "stock",
        qty: stock,
      });
    }
  }
  return { observations, sheetDates, sheetName: sheet.name, blockingReasons: [] };
}

/** Split a signed sales quantity into a gross-sales observation (>=0) or a return observation. */
function pushSignedSales(
  observations: WeeklyObservation[],
  rowNumber: number,
  ref: { itemCode: string; itemName: string; branchCode: string; branchName: string },
  signedSales: number,
): void {
  if (signedSales === 0) return;
  observations.push({
    side: signedSales < 0 ? "return" : "sales",
    sourceRowNumber: rowNumber,
    rawItemCode: ref.itemCode,
    rawItemName: ref.itemName,
    rawBranchCode: ref.branchCode,
    rawBranchName: ref.branchName,
    branchFileType: "sales",
    qty: Math.abs(signedSales),
  });
}

// PS (Overseas) — TWO matrix files, one combined batch. Sales file + stock file are both required.
function adaptPS(ctx: AdapterContext, salesWb?: ExcelJS.Workbook, stockWb?: ExcelJS.Workbook): AdapterResult {
  const observations: WeeklyObservation[] = [];
  const sheetDates = new Set<string>(); // PS matrices carry no row dates → require periodDate
  const blockingReasons: string[] = [];
  const names: string[] = [];

  if (!salesWb || !stockWb) {
    blockingReasons.push(
      "Overseas (PS) requires BOTH the sales matrix file and the stock matrix file in one upload. One of them is missing.",
    );
    return { observations, sheetDates, sheetName: "Overseas", blockingReasons };
  }

  const salesC = contractSheet(ctx.contract, "sales");
  const stockC = contractSheet(ctx.contract, "stock");

  // ── SALES matrix: header row 1; Mat. Code col3 / Mat. Desc col4; outlet columns 5..N-1;
  //    Total Qty at col N (detected dynamically — column count varies by month/file version).
  const salesSheet = findSheet(salesWb, { name: "Data", includes: "Data" }) ?? salesWb.worksheets[0];
  if (salesSheet) {
    names.push(`Sales:${salesSheet.name}`);
    const header = salesSheet.getRow(headerRowOf(salesC, 1));
    const outletFirst = salesC?.matrix?.firstColumn ?? 5;
    const totalStop = stopRegex(salesC?.matrix?.stopAtHeaderPattern, /total\s*qty/i);
    // Detect outlet range by scanning for the "Total Qty" summary header instead of hard-coding 118/119.
    let lastOutletCol = 118;
    let totalQtyCol = 119;
    for (let col = outletFirst; col <= 200; col += 1) {
      const hdr = cellText(at(header, col));
      if (!hdr) break;
      if (totalStop.test(hdr)) { totalQtyCol = col; lastOutletCol = col - 1; break; }
    }
    for (let r = dataStartRow(salesC, 2); r <= salesSheet.rowCount; r += 1) {
      const row = salesSheet.getRow(r);
      const itemCode = cellText(at(row, colOf(salesC, "itemCode", 3)));
      const itemName = cellText(at(row, colOf(salesC, "itemName", 4)));
      if (!itemCode && !itemName) continue;
      let outletSum = 0;
      for (let col = outletFirst; col <= lastOutletCol; col += 1) {
        const outletHeader = cellText(at(header, col));
        if (!outletHeader) continue;
        const qty = cellNumber(at(row, col)); // PS NET qty (keep negatives)
        if (qty === 0) continue;
        outletSum += qty;
        observations.push({
          side: "sales",
          sourceRowNumber: r,
          rawItemCode: itemCode,
          rawItemName: itemName,
          rawBranchCode: outletHeader, // verbatim header incl. trailing _ك + double spaces
          rawBranchName: outletHeader,
          branchFileType: "sales",
          qty,
        });
      }
      // Trust Total Qty: reconcile any difference into one unallocated row.
      const totalQty = cellNumber(at(row, totalQtyCol));
      const diff = Number((totalQty - outletSum).toFixed(6));
      if (diff !== 0) {
        observations.push({
          side: "sales",
          sourceRowNumber: r,
          rawItemCode: itemCode,
          rawItemName: itemName,
          rawBranchCode: "UNALLOCATED_POS",
          rawBranchName: "Unallocated POS",
          branchFileType: "sales",
          qty: diff,
          unallocated: true,
        });
      }
    }
  }

  // ── STOCK matrix: header row 1; Mat. Code col3 / Mat. Desc col4; LOCATION columns 7..N keyed by
  //    COLUMN INDEX (detected dynamically — column count varies by month/file version).
  const stockSheet = findSheet(stockWb, { name: "Data", includes: "Data" }) ?? stockWb.worksheets[0];
  if (stockSheet) {
    names.push(`Stock:${stockSheet.name}`);
    const header = stockSheet.getRow(headerRowOf(stockC, 1));
    const locationFirst = stockC?.matrix?.firstColumn ?? 7;
    // Detect last location column dynamically instead of hard-coding 85.
    let lastLocationCol = 85;
    for (let col = locationFirst; col <= 200; col += 1) {
      if (!cellText(at(header, col))) break;
      lastLocationCol = col;
    }
    // PS stock location headers change every month by design (distributors rename branches).
    // The mapping is keyed by column index, not by name, so header drift never breaks resolution.
    // No blocking check here — resolveRegion already falls back to name if the index is missing.
    for (let r = dataStartRow(stockC, 2); r <= stockSheet.rowCount; r += 1) {
      const row = stockSheet.getRow(r);
      const itemCode = cellText(at(row, colOf(stockC, "itemCode", 3)));
      const itemName = cellText(at(row, colOf(stockC, "itemName", 4)));
      if (!itemCode && !itemName) continue;
      for (let col = locationFirst; col <= lastLocationCol; col += 1) {
        const locHeader = cellText(at(header, col));
        if (!locHeader) continue;
        const qty = cellNumber(at(row, col));
        if (qty === 0) continue;
        observations.push({
          side: "stock",
          sourceRowNumber: r,
          rawItemCode: itemCode,
          rawItemName: itemName,
          rawBranchCode: locHeader,
          rawBranchName: locHeader,
          branchFileType: "stock",
          qty,
          posColumnIndex: col,
          posColumnHeaderRaw: locHeader,
        });
      }
    }
  }

  return { observations, sheetDates, sheetName: names.join(" + ") || "Overseas", blockingReasons };
}

/**
 * Sum of the POS sheet's own "Total Units" summary row across the channel block, or null when that
 * row is absent. POS closes the product block with a "Total Units" row and a "Total Values" row; only
 * the first is a unit total, and it agrees with the product qty rows exactly — measured on the
 * 2026-08 file at 1,048 against 1,048, and on the value side 92,213.02 against 92,213.02. That makes
 * it a free, file-supplied check on whether the adapter classified the rows the way the file meant.
 */
function posDeclaredTotalUnits(
  sheet: ExcelJS.Worksheet,
  itemNameCol: number,
  channelFirst: number,
  lastChannelCol: number,
  firstDataRow: number,
): number | null {
  for (let r = firstDataRow; r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r);
    if (!/^total\s*units?$/i.test(cellText(at(row, itemNameCol)).trim())) continue;
    let sum = 0;
    for (let col = channelFirst; col <= lastChannelCol; col += 1) sum += cellNumber(at(row, col));
    return sum;
  }
  return null;
}

// POS (POS Purchasing Sales) — single matrix sheet "Purchasing Sales Data".
// Unique interleaved layout: every product occupies two consecutive rows.
//   Qty row  : col1=company (first product only, ignored) | col2=product name (Arabic) |
//              col3=product code | col4..N=qty per channel | colN+1=Total | colN+2=Total Bonus
//   Value row: col4..N=EGP values (ignored — factory_price is used instead). Older files left its
//              name and code cells BLANK; from the 2026-08 file POS repeats both. See the
//              classification note in the row loop — that change is what cost EGP 16.4M.
// Returns are negative quantities in the qty row; the adapter splits them into separate observations.
// No date column → periodDate is always required on upload.
function adaptPOS(ctx: AdapterContext): AdapterResult {
  const workbook = ctx.workbooks[0];
  const observations: WeeklyObservation[] = [];
  const sheetDates = new Set<string>();
  const blockingReasons: string[] = [];

  const combinedC = contractSheet(ctx.contract, "combined");

  const sheet =
    findSheet(workbook, { name: "Purchasing Sales Data", includes: "Purchasing" }) ??
    workbook.worksheets[0];
  if (!sheet) {
    blockingReasons.push(
      "POS Purchasing Sales: could not find the data sheet. Expected a sheet named 'Purchasing Sales Data'.",
    );
    return { observations, sheetDates, sheetName: "POS Purchasing Sales", blockingReasons };
  }

  // Read channel names from the header row (row 1). Scan from firstColumn until we hit
  // "Total" (case-insensitive) or an empty cell — both signal the end of the channel block.
  const headerRow = sheet.getRow(headerRowOf(combinedC, 1));
  const channelFirst = combinedC?.matrix?.firstColumn ?? 4;
  const totalStop = stopRegex(combinedC?.matrix?.stopAtHeaderPattern, /^total$/i);

  let lastChannelCol = channelFirst - 1;
  for (let col = channelFirst; col <= 300; col += 1) {
    const hdr = cellText(at(headerRow, col));
    if (!hdr) break;
    if (totalStop.test(hdr)) break;
    lastChannelCol = col;
  }

  if (lastChannelCol < channelFirst) {
    blockingReasons.push(
      "POS Purchasing Sales: no channel columns found in the header row. The file may be in an unexpected format.",
    );
    return { observations, sheetDates, sheetName: sheet.name, blockingReasons };
  }

  const itemNameCol = colOf(combinedC, "itemName", 2);
  const itemCodeCol = colOf(combinedC, "itemCode", 3);
  const bonusCol   = colOf(combinedC, "bonusQty", 109);

  // Row-kind classification. POS ships every product as a PAIR of consecutive rows: the first holds
  // units per channel, the second the matching EGP values. Older POS files left the value row's name
  // and code cells BLANK, so "no product name" identified one. That test is not safe, and stopped
  // being true: from the 2026-08 file onward POS repeats the product name AND code on the value row,
  // so a name-only test reads every value row as a quantity row. Rows aggregate by (product, branch),
  // so the pair then MERGES into one cell holding units + EGP. That is how the 2026-08 W3 batch came
  // to hold 172,046 "units" and EGP 16.4M against a true 1,048 units — and to pass validation, since
  // nothing compared the result to anything.
  //
  // Classify by the file's own pairing instead: a row repeating the product key of the row directly
  // above it IS that row's value row. A standalone product row — the one-row-per-product layout still
  // seen in the 2026-07 file, whose products sat on consecutive rows 2,3,4,6,7 — keeps reading as
  // units, so both shapes parse correctly and a file may switch between them. The parsed unit total is
  // then reconciled against the sheet's own "Total Units" row below, which is what turns the next
  // layout change into a blocked upload instead of another silent inflation.
  let previousPairKey: string | null = null;
  let parsedUnitsNet = 0;

  for (let r = dataStartRow(combinedC, 2); r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r);
    const productName = cellText(at(row, itemNameCol));
    const productCode = cellText(at(row, itemCodeCol));

    // Blank row, legacy blank-name value row, or a "Total Units" / "Total Values" sentinel.
    if (!productName || /^total/i.test(productName.trim())) {
      previousPairKey = null;
      continue;
    }

    // Value row: repeats the product key of the qty row directly above → never a quantity.
    const pairKey = productCode || productName;
    if (pairKey && pairKey === previousPairKey) {
      previousPairKey = null; // pair closed; the next row starts a new product
      continue;
    }
    previousPairKey = pairKey || null;

    // Qty row: iterate every channel column and emit an observation for each non-zero cell.
    for (let col = channelFirst; col <= lastChannelCol; col += 1) {
      const channelName = cellText(at(headerRow, col));
      if (!channelName) continue;
      const qty = cellNumber(at(row, col));
      if (qty === 0) continue;
      parsedUnitsNet += qty;

      if (qty > 0) {
        observations.push({
          side: "sales",
          sourceRowNumber: r,
          rawItemCode: productCode,
          rawItemName: productName,
          rawBranchCode: channelName,
          rawBranchName: channelName,
          branchFileType: "sales",
          qty,
        });
      } else {
        // Negative qty → return (e.g. Mina Al-Basal −3, Beheira −4).
        observations.push({
          side: "return",
          sourceRowNumber: r,
          rawItemCode: productCode,
          rawItemName: productName,
          rawBranchCode: channelName,
          rawBranchName: channelName,
          branchFileType: "sales",
          qty: Math.abs(qty),
        });
      }
    }

    // "Total Bonus" column: per-product free units. Emit as a dedicated unallocated observation
    // (qty: 0 so sales are not inflated; bonusQty carries the value). Region mapping is bypassed
    // via unallocated: true — same pattern as PS's unallocated reconciliation rows.
    const bonusUnits = cellNumber(at(row, bonusCol));
    if (bonusUnits > 0) {
      observations.push({
        side: "sales",
        sourceRowNumber: r,
        rawItemCode: productCode,
        rawItemName: productName,
        rawBranchCode: "POS_BONUS_TOTAL",
        rawBranchName: "POS Bonus (product total)",
        branchFileType: "sales",
        qty: 0,
        bonusQty: bonusUnits,
        unallocated: true,
      });
    }
  }

  // Reconcile the units we read against the units the sheet says it contains. POS states its own unit
  // total per channel on the "Total Units" row and it agrees with the qty rows to the unit, so any
  // disagreement means the adapter classified rows differently from the file (a new layout, a shifted
  // column, a value row counted as units) and the numbers must not reach the database. This is the
  // self-check PS has always had through its "Total Qty" column and POS never had; on the 2026-08 W3
  // file it fires at 93,261 read against 1,048 declared, and blocks the import.
  const declaredUnits = posDeclaredTotalUnits(
    sheet,
    itemNameCol,
    channelFirst,
    lastChannelCol,
    dataStartRow(combinedC, 2),
  );
  if (declaredUnits !== null && Math.abs(declaredUnits - parsedUnitsNet) > 0.01) {
    blockingReasons.push(
      `POS Purchasing Sales: the sheet's own "Total Units" row declares ${readableNumber(declaredUnits)} units, but the ` +
        `adapter read ${readableNumber(parsedUnitsNet)}. The file's layout is not the one the adapter expects, so nothing ` +
        `was imported rather than storing quantities that are known to be wrong. A gap this size normally means ` +
        `each product's EGP value row is being counted as units — check whether the value rows now repeat the ` +
        `product name and code.`,
    );
  }

  return { observations, sheetDates, sheetName: sheet.name, blockingReasons };
}

// SF (Sofico) — single "Sheet1" workbook. Per-customer invoice detail rows (one invoice line per
// row). Header row 1, data row 2+. col4=ItemID (Sofico product code, not the master — alias key),
// col5=ItemName (product display name), col12=State (branch numeric ID, e.g. "2" / "11"),
// col13=statename (Arabic branch name), col20=SalesQty (gross), col21=BonusQty (ignored),
// col22=ReturnQty (positive), col24=NET SALES (authoritative net — same semantics as
// RM col15). No period-date column; periodDate is always required on upload.
function adaptSF(ctx: AdapterContext): AdapterResult {
  const workbook = ctx.workbooks[0];
  const combinedC = contractSheet(ctx.contract, "combined");
  const sheet = findSheet(workbook, { name: "Sheet1", includes: "Sheet" }) ?? workbook.worksheets[0];
  const observations: WeeklyObservation[] = [];
  const sheetDates = new Set<string>(); // no date column → always require periodDate
  if (!sheet) return { observations, sheetDates, sheetName: "Sofico", blockingReasons: [] };

  for (let r = dataStartRow(combinedC, 2); r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r);
    const itemCode = cellText(at(row, colOf(combinedC, "itemCode", 4)));    // ItemID — Sofico's own product code (alias key)
    const itemName = cellText(at(row, colOf(combinedC, "itemName", 5)));    // ItemName
    const branchCode = cellText(at(row, colOf(combinedC, "branchCode", 12))); // State — branch numeric ID (e.g. "2", "11")
    const branchName = cellText(at(row, colOf(combinedC, "branchName", 13))); // statename — Arabic branch display name
    if (!itemCode && !branchCode) continue;
    const gross = cellNumber(at(row, colOf(combinedC, "gross", 20)));    // SalesQty
    const ret = cellNumber(at(row, colOf(combinedC, "return", 22)));      // ReturnQty (positive in the file)
    const net = cellNumber(at(row, colOf(combinedC, "net", 24)));      // NET SALES — authoritative net of record
    // col21 (BonusQty) is ignored — free units are never counted as sales.

    observations.push({
      side: "sales",
      sourceRowNumber: r,
      rawItemCode: itemCode,
      rawItemName: itemName,
      rawBranchCode: branchCode,
      rawBranchName: branchName || branchCode,
      branchFileType: "sales",
      qty: gross,
      authoritativeNet: net,
    });
    if (ret > 0) {
      observations.push({
        side: "return",
        sourceRowNumber: r,
        rawItemCode: itemCode,
        rawItemName: itemName,
        rawBranchCode: branchCode,
        rawBranchName: branchName || branchCode,
        branchFileType: "sales",
        qty: ret,
      });
    }
  }
  return { observations, sheetDates, sheetName: sheet.name, blockingReasons: [] };
}

// Direct (company) channel — a hand-coded sheet, not a distributor's raw export, so headers are
// located BY NAME (not fixed position): Distrub ID / Region ID / Product ID / Qty / Invoice Date /
// Value / Pharmacy Name (+ optional Product name). Mirrors monthly's DIRECT_TEMPLATE exactly
// (src/lib/sales/monthly-distributor-import.ts) — same header names, region-only geography (no
// branch/area; "NATIONAL" is a sentinel bucket for orders tied to no region), Product ID already a
// Source-of-Sales MASTER code (no raw→master alias step), and Value read straight from the sheet
// rather than recomputed from factory price. branchCode is set to the raw Region ID text so rows
// aggregate one "branch" per region (decision: branch maps directly to region) — resolveRegion fills
// in the real region + branchName ("Direct – <Region>") once the code is resolved against the master.
const DIRECT_HEADER_ALIASES: Record<string, string[]> = {
  distributorCode: ["Distrub ID"],
  invoiceDate: ["Invoice Date", "Date", "INVOICE_DATE", "inv_date"],
  pharmacyName: ["Pharmacy Name"],
  productCode: ["Product ID"],
  productName: ["Product"],
  qty: ["Qty", "Quantity", "QTY_INVOICE", "QTY_PACK", "qnt"],
  regionCode: ["Region ID"],
  value: ["Value"],
};
const DIRECT_REQUIRED_FIELDS = ["distributorCode", "invoiceDate", "productCode", "qty", "regionCode", "value"];

function findHeaderColumns(headerRow: ExcelJS.Row, lastColumn: number): Map<string, number> {
  const byText = new Map<string, number>();
  for (let c = 1; c <= lastColumn; c += 1) {
    const text = cellText(at(headerRow, c)).trim().toLowerCase();
    if (text && !byText.has(text)) byText.set(text, c);
  }
  const found = new Map<string, number>();
  for (const [field, aliases] of Object.entries(DIRECT_HEADER_ALIASES)) {
    for (const alias of aliases) {
      const col = byText.get(alias.trim().toLowerCase());
      if (col != null) {
        found.set(field, col);
        break;
      }
    }
  }
  return found;
}

function adaptDirect(ctx: AdapterContext): AdapterResult {
  const workbook = ctx.workbooks[0];
  const sheet = workbook.worksheets[0];
  const observations: WeeklyObservation[] = [];
  const sheetDates = new Set<string>();
  if (!sheet) return { observations, sheetDates, sheetName: "Direct", blockingReasons: [] };

  const headerRow = sheet.getRow(1);
  const lastColumn = Math.max(sheet.columnCount, 16);
  const cols = findHeaderColumns(headerRow, lastColumn);

  const missing = DIRECT_REQUIRED_FIELDS.filter((field) => !cols.has(field));
  if (missing.length > 0) {
    const labels = missing.map((field) => DIRECT_HEADER_ALIASES[field][0]);
    return {
      observations,
      sheetDates,
      sheetName: sheet.name,
      blockingReasons: [`Direct template is missing required column(s): ${labels.join(", ")}.`],
    };
  }

  let mismatchedDistributorRows = 0;
  let firstMismatchRow: number | null = null;

  for (let r = 2; r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r);
    const productCode = cellText(at(row, cols.get("productCode")!));
    const regionCode = cellText(at(row, cols.get("regionCode")!));
    const qtyCell = at(row, cols.get("qty")!);
    if (!productCode && !regionCode && cellText(qtyCell) === "") continue; // blank row

    const distributorCodeRaw = cellText(at(row, cols.get("distributorCode")!));
    if (distributorCodeRaw && normalizeCode(distributorCodeRaw) !== "DIRECT") {
      mismatchedDistributorRows += 1;
      firstMismatchRow ??= r;
    }

    const productName = cols.has("productName") ? cellText(at(row, cols.get("productName")!)) : "";
    const pharmacyName = cols.has("pharmacyName") ? cellText(at(row, cols.get("pharmacyName")!)) : "";
    const qty = cellNumber(qtyCell);
    const value = cellNumber(at(row, cols.get("value")!));
    const dateIso = cellDateIso(at(row, cols.get("invoiceDate")!));
    if (dateIso) sheetDates.add(dateIso);

    observations.push({
      branchFileType: "sales",
      directProductLookup: true,
      directRegionCodeRaw: regionCode,
      qty,
      rawBranchCode: regionCode,
      rawBranchName: pharmacyName,
      rawItemCode: productCode,
      rawItemName: productName,
      sheetValue: value,
      side: "sales",
      sourceRowNumber: r,
    });
  }

  const blockingReasons: string[] = [];
  if (mismatchedDistributorRows > 0) {
    blockingReasons.push(
      `${mismatchedDistributorRows} row(s) have a Distrub ID that is not "Direct" (first at row ${firstMismatchRow}). Fix the workbook before importing.`,
    );
  }

  return { observations, sheetDates, sheetName: sheet.name, blockingReasons };
}

// ── core: resolve, validate strictly, aggregate by key union, value, summarize ───────────────────

type ResolvedProduct = {
  productCode: string;
  productName: string;
  officialLine: string;
  factoryPrice: number;
  /** alias points at the IGNORE sentinel → keep the item out of the numbers, on purpose */
  excluded: boolean;
  /** no alias, or alias found but master data is invalid → hard block */
  failure: { field: string; message: string } | null;
};

function resolveProduct(
  obs: WeeklyObservation,
  aliasBucket: { byCode: Map<string, string>; byName: Map<string, string> } | undefined,
  indexes: WeeklyReferenceIndexes,
): ResolvedProduct {
  // Direct: rawItemCode is already a Source-of-Sales MASTER code (operator fills it by hand, same
  // convention as monthly's coded sheets) — skip the raw→master alias lookup entirely. A miss here
  // is a hard failure (typo'd master code), not a soft "no alias yet" warning.
  if (obs.directProductLookup) {
    const masterCode = normalizeCode(obs.rawItemCode);
    if (masterCode === IGNORE_PRODUCT_CODE) return excludedProduct(obs);
    const master = masterCode ? indexes.productByCode.get(masterCode) : undefined;
    if (!master) {
      return {
        productCode: obs.rawItemCode || obs.rawItemName || "",
        productName: obs.rawItemName || obs.rawItemCode || "",
        officialLine: "",
        factoryPrice: 0,
        excluded: false,
        failure: {
          field: "productCode",
          message: `Product ID "${obs.rawItemCode || "(blank)"}" is not in the Source of Sales master product table.`,
        },
      };
    }
    const line = (master.line ?? "").trim();
    // Direct's value comes straight from the sheet, never from factory price — so an unpriced
    // master must NOT block here (e.g. Satoslim has factory_price = 0 but a real deal value).
    const failure: ResolvedProduct["failure"] = line
      ? null
      : {
          field: "officialLine",
          message: `Master product "${master.productCode}" has no line. Assign a line in Source of Sales, then re-upload.`,
        };
    return {
      productCode: master.productCode.trim(),
      productName: (master.productName || master.productCode).trim(),
      officialLine: line,
      factoryPrice: Number(master.factoryPrice) || 0,
      excluded: false,
      failure,
    };
  }

  const codeKey = normalizeCode(obs.rawItemCode);
  const nameKey = normalizeKey(obs.rawItemName);
  let masterCode = (codeKey && aliasBucket?.byCode.get(codeKey)) || (nameKey && aliasBucket?.byName.get(nameKey)) || "";
  masterCode = normalizeCode(masterCode);

  // "We don't sell this" — the alias deliberately points at the IGNORE sentinel. The sentinel master
  // carries no price and no line by design, so validating it like a real product would block the
  // whole upload on data that is missing on purpose. Drop the observation from the numbers instead,
  // and let the caller count and show it (never a silent drop).
  if (masterCode === IGNORE_PRODUCT_CODE) return excludedProduct(obs);

  if (!masterCode) {
    return {
      productCode: obs.rawItemCode || obs.rawItemName || "",
      productName: obs.rawItemName || obs.rawItemCode || "",
      officialLine: "",
      factoryPrice: 0,
      excluded: false,
      failure: {
        field: "productCode",
        message: `No product alias maps "${obs.rawItemCode || obs.rawItemName || "(blank)"}" to a Source of Sales master product. Map it below, then re-validate.`,
      },
    };
  }

  const master = indexes.productByCode.get(masterCode);
  if (!master) {
    return {
      productCode: masterCode,
      productName: masterCode,
      officialLine: "",
      factoryPrice: 0,
      excluded: false,
      failure: {
        field: "productCode",
        message: `Alias resolves to product "${masterCode}", which is not in the Source of Sales master.`,
      },
    };
  }

  const factoryPrice = Number(master.factoryPrice);
  const safePrice = Number.isFinite(factoryPrice) ? factoryPrice : 0;
  const line = (master.line ?? "").trim();
  let failure: ResolvedProduct["failure"] = null;
  if (!(safePrice > 0)) {
    failure = {
      field: "factoryPrice",
      message: `Master product "${master.productCode}" has no factory price; cannot value it. Fix the master price, then re-upload.`,
    };
  } else if (!line) {
    failure = {
      field: "officialLine",
      message: `Master product "${master.productCode}" has no line. Assign a line in Source of Sales, then re-upload.`,
    };
  }

  return {
    productCode: master.productCode.trim(),
    productName: (master.productName || master.productCode).trim(),
    officialLine: line,
    factoryPrice: safePrice,
    excluded: false,
    failure,
  };
}

function excludedProduct(obs: WeeklyObservation): ResolvedProduct {
  return {
    productCode: IGNORE_PRODUCT_CODE,
    productName: obs.rawItemName || obs.rawItemCode || IGNORE_PRODUCT_CODE,
    officialLine: "",
    factoryPrice: 0,
    excluded: true,
    failure: null,
  };
}

type ResolvedRegion = {
  regionCode: string;
  regionName: string;
  /**
   * The single area this branch belongs to, when the owner mapped one. null is the norm — a branch is
   * a depot, not a rep territory — and a null area simply leaves the row region-scoped, exactly as
   * before areas existed. Never inferred from a name: only an explicit mapping sets it.
   */
  areaCode: string | null;
  /** excluded mapping → cell dropped from totals, not a failure */
  excluded: boolean;
  /** unmapped non-excluded branch → batch blocks */
  failure: { field: string; message: string } | null;
};

function resolveRegion(
  obs: WeeklyObservation,
  branchMapIndex: WeeklyBranchRegionIndex,
  indexes: WeeklyReferenceIndexes,
): ResolvedRegion {
  // Direct: the branch IS the region (decision: map directly to region, no branch-region admin
  // mapping). "NATIONAL" is a sentinel for orders tied to no real region (mirrors monthly's Direct
  // "National" bucket); any other code must resolve against the master region list.
  if (obs.directRegionCodeRaw != null) {
    const raw = normalizeCode(obs.directRegionCodeRaw);
    if (!raw) {
      return { regionCode: "", regionName: "", areaCode: null, excluded: false, failure: { field: "regionCode", message: "Region ID is required." } };
    }
    if (raw === "NATIONAL") {
      return { regionCode: "NATIONAL", regionName: "National", areaCode: null, excluded: false, failure: null };
    }
    const name = indexes.regionNameByCode.get(raw);
    if (!name) {
      return {
        regionCode: raw,
        regionName: raw,
        areaCode: null,
        excluded: false,
        failure: { field: "regionCode", message: `Region ID "${raw}" is not in the Source of Sales master region table.` },
      };
    }
    return { regionCode: raw, regionName: name, areaCode: null, excluded: false, failure: null };
  }

  // PS unallocated reconciliation rows carry no branch → region left empty, never blocks.
  if (obs.unallocated) {
    return { regionCode: "", regionName: "", areaCode: null, excluded: false, failure: null };
  }

  // PS stock path. Prefer the column-index mapping (it disambiguates genuinely duplicated location
  // headers); if this column has NO column-index mapping, fall back to matching the location header
  // BY NAME (stock|name, then any|name). Column positions are fragile — they are silently lost on a
  // name-only re-import and shift whenever the distributor reorders the export's columns — whereas the
  // location name is stable and, for PS, resolves to a single region. This stops stock from
  // re-breaking every time the mapping is rebuilt by name instead of by column index.
  if (obs.posColumnIndex != null) {
    const entry = branchMapIndex.byColumnIndex.get(obs.posColumnIndex);
    if (entry) {
      if (entry.excluded) return { regionCode: "", regionName: "", areaCode: null, excluded: true, failure: null };
      return { regionCode: entry.regionCode, regionName: entry.regionName, areaCode: entry.areaCode, excluded: false, failure: null };
    }
    const stockName = normalizeKey(obs.posColumnHeaderRaw ?? obs.rawBranchCode ?? obs.rawBranchName);
    const byName = stockName
      ? branchMapIndex.byBranch.get(`stock|${stockName}`) ?? branchMapIndex.byBranch.get(`any|${stockName}`)
      : undefined;
    if (byName) {
      if (byName.excluded) return { regionCode: "", regionName: "", areaCode: null, excluded: true, failure: null };
      return { regionCode: byName.regionCode, regionName: byName.regionName, areaCode: byName.areaCode, excluded: false, failure: null };
    }
    return {
      regionCode: "",
      regionName: "",
      areaCode: null,
      excluded: false,
      failure: {
        field: "regionCode",
        message: `PS stock column ${obs.posColumnIndex} ("${obs.posColumnHeaderRaw ?? obs.rawBranchName}") is not mapped to a master region (by column or by name). Map it, then re-upload.`,
      },
    };
  }

  // Stock-only rows with no branch (e.g. a grand-total fallback) → allow without a region, never block.
  const branchKeyRaw = obs.rawBranchCode || obs.rawBranchName;
  if (!branchKeyRaw && obs.side === "stock") {
    return { regionCode: "", regionName: "", areaCode: null, excluded: false, failure: null };
  }

  const normalized = normalizeKey(branchKeyRaw);
  const lookupKey = `${obs.branchFileType}|${normalized}`;
  const anyKey = `any|${normalized}`;
  const entry = branchMapIndex.byBranch.get(lookupKey) ?? branchMapIndex.byBranch.get(anyKey);
  if (!entry) {
    // Soft fallback: tolerates weekly PS header drift (trailing digit suffix, _ك variant,
    // parenthetical qualifier). Hits only when the exact normalizeKey lookup already failed.
    const softKey = normalizeSoft(branchKeyRaw);
    const softEntry = softKey
      ? (branchMapIndex.bySoftName.get(`${obs.branchFileType}|${softKey}`) ?? branchMapIndex.bySoftName.get(`any|${softKey}`))
      : undefined;
    if (softEntry) {
      if (softEntry.excluded) return { regionCode: "", regionName: "", areaCode: null, excluded: true, failure: null };
      return { regionCode: softEntry.regionCode, regionName: softEntry.regionName, areaCode: softEntry.areaCode, excluded: false, failure: null };
    }
    return {
      regionCode: "",
      regionName: "",
      areaCode: null,
      excluded: false,
      failure: {
        field: "regionCode",
        message: `Branch "${obs.rawBranchName || obs.rawBranchCode || "(blank)"}" is not mapped to a master region (and is not excluded). Map it, then re-upload.`,
      },
    };
  }
  if (entry.excluded) return { regionCode: "", regionName: "", areaCode: null, excluded: true, failure: null };
  return { regionCode: entry.regionCode, regionName: entry.regionName, areaCode: entry.areaCode, excluded: false, failure: null };
}

// Aggregation key = product_code + branch identity. Branch identity uses the verbatim raw branch
// key so a sales-only / return-only / stock-only branch all share one fact row.
type AggKey = string;
type Agg = {
  productCode: string;
  productName: string;
  officialLine: string;
  factoryPrice: number;
  regionCode: string;
  regionName: string;
  areaCode: string | null;
  branchCode: string;
  branchName: string;
  itemCode: string;
  /** distributor's own item NAME as the sheet spelled it — kept for the normalizer's `name`-kind aliases */
  itemName: string;
  /** which side this branch was read from (branch-map lookup half) */
  branchFileType: "sales" | "stock";
  /** PS stock matrix: the 1-based column this branch sat in, and the raw header text there */
  branchColumnIndex: number | null;
  branchColumnHeader: string;
  grossSalesQty: number;
  returnQty: number;
  stockQty: number;
  bonusQty: number;
  /** sum of distributor-stated authoritative net (e.g. RM col15) when the source provides it */
  authoritativeNet: number;
  /** true once any sales observation carried an authoritative net → use it as the net of record */
  hasAuthoritativeNet: boolean;
  sourceRowNumber: number;
  unallocated: boolean;
  issues: WeeklyValidationIssue[];
  /** Direct only: sum of the sheet's own Value column — used AS salesValue instead of netQty × factory_price */
  sheetValue: number;
  /** Direct only: distinct Pharmacy Name values folded into this region row — audit context only,
   *  never a dashboard dimension (branch maps directly to region; see branchName above). */
  pharmacyNames: Set<string>;
};

function aggKeyOf(productCode: string, obs: WeeklyObservation): AggKey {
  return `${normalizeCode(productCode)}||${branchKeyOf(obs)}`;
}

/** The branch half of an aggregate key, on its own — so a HELD-OUT depot groups exactly the way an
 *  included one would (PS resolves by stock-matrix column index, everyone else by code/name). */
function branchKeyOf(obs: WeeklyObservation): string {
  return obs.posColumnIndex != null ? `col#${obs.posColumnIndex}` : normalizeKey(obs.rawBranchCode || obs.rawBranchName);
}

/** Quantities for one bucket of observations deliberately held OUT of the totals. */
type HeldOutTally = {
  rows: Set<number>;
  grossSalesQty: number;
  returnQty: number;
  authoritativeNet: number;
  hasAuthoritativeNet: boolean;
  stockQty: number;
};

function emptyHeldOut(): HeldOutTally {
  return { rows: new Set<number>(), grossSalesQty: 0, returnQty: 0, authoritativeNet: 0, hasAuthoritativeNet: false, stockQty: 0 };
}

function addHeldOut(tally: HeldOutTally, obs: WeeklyObservation): void {
  tally.rows.add(obs.sourceRowNumber);
  if (obs.side === "sales") {
    tally.grossSalesQty += obs.qty;
    if (obs.authoritativeNet != null) {
      tally.hasAuthoritativeNet = true;
      tally.authoritativeNet += obs.authoritativeNet;
    }
  } else if (obs.side === "return") tally.returnQty += obs.qty;
  else tally.stockQty += obs.qty;
}

/** Net of a held-out bucket, derived exactly the way the real fact-row builder derives it: a
 *  distributor-stated authoritative net (RM col15) wins outright and the return is NOT taken off it
 *  again, because that net is already net of returns. */
function heldOutNet(tally: HeldOutTally): number {
  return tally.hasAuthoritativeNet ? tally.authoritativeNet : tally.grossSalesQty - tally.returnQty;
}

export type WeeklyParseError = { code: "unsupported_template" | "empty_file"; message: string };

export type WeeklyParseOutput =
  | { ok: true; rows: WeeklyParsedRow[]; result: WeeklySalesValidationResult }
  | { ok: false; error: WeeklyParseError };

async function loadWorkbook(buffer: ArrayBuffer | Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as Parameters<typeof workbook.xlsx.load>[0]);
  return workbook;
}

export async function parseWeeklyWorkbookBuffer(input: {
  /** combined / single workbook buffer (everyone except PS) */
  buffer?: ArrayBuffer | Buffer;
  /** PS sales matrix buffer */
  salesBuffer?: ArrayBuffer | Buffer;
  /** PS stock matrix buffer */
  stockBuffer?: ArrayBuffer | Buffer;
  distributorCode: string;
  distributorName: string;
  fileName: string;
  references: SalesReferenceData;
  aliasIndex: WeeklyProductAliasIndex;
  branchMapIndex: WeeklyBranchRegionIndex;
  /** explicit period (YYYY-MM-DD) used when the sheet has zero or many distinct dates */
  periodDate?: string | null;
  /** Resolved column contract (DB override merged over code). When omitted, the CODE contract is used,
   *  so parsing is byte-identical to the previous hard-coded behaviour. Callers that want in-app edits
   *  to take effect pass `await resolveWeeklyContract(code)`. */
  contract?: WeeklyDistributorContract;
}): Promise<WeeklyParseOutput> {
  let canonicalCode: string;
  try {
    canonicalCode = canonicalWeeklyDistributorCode(input.distributorCode);
  } catch {
    return {
      ok: false,
      error: {
        code: "unsupported_template",
        message: `No weekly adapter is registered for distributor "${String(input.distributorCode ?? "").trim()}".`,
      },
    };
  }
  const distributorName = input.distributorName || weeklyDistributorByCode(canonicalCode)?.name || canonicalCode;
  // Default to the CODE contract when none is supplied → byte-identical to the previous behaviour.
  const contract = input.contract ?? weeklyContractByCode(canonicalCode);

  const indexes = buildReferenceIndexes(input.references);
  const aliasBucket = input.aliasIndex.get(canonicalCode);
  const branchMapIndex = input.branchMapIndex;

  // ── run the distributor adapter ────────────────────────────────────────────────────────────
  let adapted: AdapterResult;
  try {
    if (canonicalCode === "PS") {
      const salesWb = input.salesBuffer ? await loadWorkbook(input.salesBuffer) : undefined;
      const stockWb = input.stockBuffer ? await loadWorkbook(input.stockBuffer) : undefined;
      adapted = adaptPS({ workbooks: [], distributorCode: canonicalCode, branchMapIndex, contract }, salesWb, stockWb);
    } else {
      if (!input.buffer) {
        return { ok: false, error: { code: "empty_file", message: "No workbook was provided." } };
      }
      const workbook = await loadWorkbook(input.buffer);
      const ctx: AdapterContext = { workbooks: [workbook], distributorCode: canonicalCode, branchMapIndex, contract };
      adapted =
        canonicalCode === "EG"
          ? adaptEG(ctx)
          : canonicalCode === "RM"
            ? adaptRM(ctx)
            : canonicalCode === "IS-S"
              ? adaptISS(ctx)
              : canonicalCode === "IS"
                ? adaptIS(ctx)
                : canonicalCode === "SF"
                  ? adaptSF(ctx)
                  : canonicalCode === "POS"
                    ? adaptPOS(ctx)
                    : canonicalCode === "Direct"
                      ? adaptDirect(ctx)
                      : { observations: [], sheetDates: new Set<string>(), sheetName: "", blockingReasons: [] };
    }
  } catch (error) {
    return {
      ok: false,
      error: { code: "empty_file", message: error instanceof Error ? error.message : "Could not read the weekly workbook." },
    };
  }

  const blockingReasons = [...adapted.blockingReasons];

  // ── date rule: exactly one distinct sheet date auto-uses it; else require periodDate ─────────
  const distinctDates = [...adapted.sheetDates].sort();
  const explicitPeriod = (input.periodDate ?? "").trim() || null;
  let weekStart: string | null;
  if (distinctDates.length === 1) {
    // Exactly one sheet date → auto-use it (a supplied periodDate is ignored in this case).
    weekStart = distinctDates[0];
  } else if (explicitPeriod) {
    // Zero or many sheet dates but an explicit period was supplied → use it, no block.
    weekStart = explicitPeriod;
  } else if (distinctDates.length > 1) {
    weekStart = null;
    blockingReasons.push(
      `File carries ${distinctDates.length} different sheet dates (${distinctDates.join(", ")}). Provide a single period date (YYYY-MM-DD) for this upload.`,
    );
  } else {
    weekStart = null;
    blockingReasons.push(
      "The file has no readable date. Provide a period date (YYYY-MM-DD) for this upload.",
    );
  }

  if (adapted.observations.length === 0 && blockingReasons.length === 0) {
    return { ok: false, error: { code: "empty_file", message: "No data rows found in the weekly file." } };
  }

  // ── resolve + aggregate over the UNION of (product, branch) keys across all sides ─────────────
  const aggregates = new Map<AggKey, Agg>();
  const excluded = new Map<string, { itemCode: string; itemName: string; tally: HeldOutTally }>();
  const excludedBranches = new Map<string, { rawBranch: string; branchName: string; branchColumnIndex: number | null; tally: HeldOutTally }>();

  for (const obs of adapted.observations) {
    const product = resolveProduct(obs, aliasBucket, indexes);
    const region = resolveRegion(obs, branchMapIndex, indexes);

    // Excluded branch → the cell leaves the totals entirely (not a failure, no fact row), but it is
    // tallied per depot first. Same rule as the IGNORE-item path below: count and show what was left
    // out, never silently drop. Checked before the item so a depot that is BOTH excluded and selling
    // an IGNORE item is reported once, against the depot that removed it.
    if (region.excluded) {
      const key = branchKeyOf(obs);
      const entry = excludedBranches.get(key) ?? {
        rawBranch: obs.rawBranchCode || obs.rawBranchName || "",
        branchName: obs.rawBranchName || "",
        branchColumnIndex: obs.posColumnIndex ?? null,
        tally: emptyHeldOut(),
      };
      // An excluded depot spans the sales and stock sides; whichever landed first may have carried a
      // blank display name or no column index (same late-fill the real aggregate does).
      if (!entry.branchName && obs.rawBranchName) entry.branchName = obs.rawBranchName;
      if (entry.branchColumnIndex == null && obs.posColumnIndex != null) entry.branchColumnIndex = obs.posColumnIndex;
      addHeldOut(entry.tally, obs);
      excludedBranches.set(key, entry);
      continue;
    }

    // IGNORE-mapped item → same, but tallied per raw item so the operator sees exactly what was
    // left out and how much of it (owner's rule: count and flag, never silently drop).
    if (product.excluded) {
      const itemCode = obs.rawItemCode || "";
      const itemName = obs.rawItemName || "";
      const key = `${normalizeCode(itemCode)}|${normalizeKey(itemName)}`;
      const entry = excluded.get(key) ?? { itemCode, itemName, tally: emptyHeldOut() };
      addHeldOut(entry.tally, obs);
      excluded.set(key, entry);
      continue;
    }

    const key = aggKeyOf(product.productCode, obs);
    let agg = aggregates.get(key);
    if (!agg) {
      agg = {
        productCode: product.productCode,
        productName: product.productName,
        officialLine: product.officialLine,
        factoryPrice: product.factoryPrice,
        regionCode: region.regionCode,
        regionName: region.regionName,
        areaCode: region.areaCode,
        branchCode: obs.rawBranchCode,
        // Direct: branch maps directly to region — label it "Direct – <Region>" instead of the
        // raw Pharmacy Name (kept only in rawRow as audit context, never a dashboard dimension).
        branchName: obs.directRegionCodeRaw != null
          ? (region.regionName ? `Direct – ${region.regionName}` : `Direct – ${obs.rawBranchCode}`)
          : obs.rawBranchName || obs.rawBranchCode,
        itemCode: obs.rawItemCode,
        itemName: obs.rawItemName,
        branchFileType: obs.branchFileType,
        branchColumnIndex: obs.posColumnIndex ?? null,
        branchColumnHeader: obs.posColumnHeaderRaw ?? "",
        grossSalesQty: 0,
        returnQty: 0,
        stockQty: 0,
        bonusQty: 0,
        authoritativeNet: 0,
        hasAuthoritativeNet: false,
        sourceRowNumber: obs.sourceRowNumber,
        unallocated: Boolean(obs.unallocated),
        issues: [],
        sheetValue: 0,
        pharmacyNames: new Set<string>(),
      };
      aggregates.set(key, agg);
    }
    // Carry a region as soon as any side resolves one (sales side usually does; stock-only may not).
    if (!agg.regionCode && region.regionCode) {
      agg.regionCode = region.regionCode;
      agg.regionName = region.regionName;
    }
    if (!agg.itemCode && obs.rawItemCode) agg.itemCode = obs.rawItemCode;
    // Same late-fill for the raw identity the normalizer maps on: an aggregate spans both the sales
    // and stock sides, and whichever side landed first may have carried a blank name/header.
    if (!agg.itemName && obs.rawItemName) agg.itemName = obs.rawItemName;
    if (agg.branchColumnIndex == null && obs.posColumnIndex != null) agg.branchColumnIndex = obs.posColumnIndex;
    if (!agg.branchColumnHeader && obs.posColumnHeaderRaw) agg.branchColumnHeader = obs.posColumnHeaderRaw;

    if (obs.side === "sales") {
      agg.grossSalesQty += obs.qty;
      if (obs.authoritativeNet != null) {
        agg.hasAuthoritativeNet = true;
        agg.authoritativeNet += obs.authoritativeNet;
      }
    } else if (obs.side === "return") agg.returnQty += obs.qty;
    else agg.stockQty += obs.qty;

    if (obs.bonusQty != null && obs.bonusQty > 0) agg.bonusQty += obs.bonusQty;
    if (obs.sheetValue != null) agg.sheetValue += obs.sheetValue;
    if (obs.directRegionCodeRaw != null && obs.rawBranchName) agg.pharmacyNames.add(obs.rawBranchName);

    // No alias, or master data invalid (no price / no line) — all product failures, plus an
    // unmapped region, are hard failures that block the batch. Nothing here is silently skipped.
    if (product.failure && !agg.issues.some((i) => i.field === product.failure!.field && i.message === product.failure!.message)) {
      agg.issues.push({
        field: product.failure.field,
        message: product.failure.message,
        rowNumber: obs.sourceRowNumber,
        severity: "failure",
        value: obs.rawItemCode || obs.rawItemName || null,
      });
    }
    if (region.failure && !agg.issues.some((i) => i.field === region.failure!.field && i.message === region.failure!.message)) {
      agg.issues.push({
        field: region.failure.field,
        message: region.failure.message,
        rowNumber: obs.sourceRowNumber,
        severity: "failure",
        value: obs.rawBranchName || obs.rawBranchCode || null,
      });
    }
  }

  // ── build fact rows ───────────────────────────────────────────────────────────────────────
  const rows: WeeklyParsedRow[] = [];
  let rowNumber = 0;
  const isPS = canonicalCode === "PS";
  const isDirect = canonicalCode === "Direct";
  for (const agg of aggregates.values()) {
    rowNumber += 1;
    // Net of record: a distributor-stated authoritative net (e.g. RM col15) wins over the computed
    // gross − return; otherwise net = gross − return.
    const netQty = agg.hasAuthoritativeNet
      ? Number(agg.authoritativeNet.toFixed(6))
      : Number((agg.grossSalesQty - agg.returnQty).toFixed(6));
    // Display split. PS preview shows NET only (salesQty = net, return = 0). When an authoritative net
    // is used, keep gross (col11) and reconcile the return so (gross − return) == net of record.
    const grossForDisplay = isPS
      ? netQty
      : Number(agg.grossSalesQty.toFixed(6));
    const returnForDisplay = isPS
      ? 0
      : agg.hasAuthoritativeNet
        ? Number((agg.grossSalesQty - netQty).toFixed(6))
        : Number(agg.returnQty.toFixed(6));
    // Direct: value is the sheet's own Value column summed per aggregate — never netQty × factory
    // price (the whole point of the Direct channel is honoring real per-deal pricing, e.g. a
    // price-0 master product like Satoslim that still carries a real Value on the sheet).
    const salesValue = isDirect
      ? Number(agg.sheetValue.toFixed(6))
      : Number((netQty * agg.factoryPrice).toFixed(6));
    const validationState: WeeklyParsedRow["validationState"] = agg.issues.some((i) => i.severity === "failure")
      ? "failed"
      : agg.issues.length > 0
        ? "warning"
        : "valid";

    rows.push({
      rowNumber,
      weekStart,
      distributorCode: canonicalCode,
      distributorName,
      regionCode: agg.regionCode,
      regionName: agg.regionName,
      areaCode: agg.areaCode,
      branchCode: agg.branchCode,
      branchName: agg.branchName,
      itemCode: agg.itemCode,
      itemName: agg.itemName,
      branchFileType: agg.branchFileType,
      branchColumnIndex: agg.branchColumnIndex,
      branchColumnHeader: agg.branchColumnHeader,
      productCode: agg.productCode,
      productName: agg.productName,
      officialLine: agg.officialLine,
      salesQty: grossForDisplay,
      returnQty: returnForDisplay,
      netQty,
      bonusQty: Number(agg.bonusQty.toFixed(6)),
      salesValue,
      stockQty: Number(agg.stockQty.toFixed(6)),
      validationState,
      validationIssues: agg.issues,
      rawRow: {
        itemCode: agg.itemCode,
        productCode: agg.productCode,
        productName: agg.productName,
        branchCode: agg.branchCode,
        branchName: agg.branchName,
        regionCode: agg.regionCode,
        regionName: agg.regionName,
        ...(agg.areaCode ? { areaCode: agg.areaCode } : {}),
        grossSalesQty: String(grossForDisplay),
        returnQty: String(returnForDisplay),
        netQty: String(netQty),
        stockQty: String(Number(agg.stockQty.toFixed(6))),
        bonusQty: String(Number(agg.bonusQty.toFixed(6))),
        sourceRowNumber: String(agg.sourceRowNumber),
        ...(agg.hasAuthoritativeNet
          ? {
              // Audit trail: distributor-stated net is authoritative. Record the observed return
              // (abs col13) alongside the reconciled return so any divergence is visible.
              authoritativeNet: "true",
              observedReturnQty: String(Number(agg.returnQty.toFixed(6))),
            }
          : {}),
        ...(agg.unallocated ? { unallocated: "true" } : {}),
        ...(agg.pharmacyNames.size > 0 ? { pharmacyNames: [...agg.pharmacyNames].slice(0, 20).join(", ") } : {}),
      },
    });
  }

  // Note: rows.length === 0 with observations present is a legitimate all-excluded file — it
  // returns a validated empty summary, NOT an empty_file error (the empty_file guard above only
  // fires when the adapter found no observations at all).

  const result = summarizeWeekly({
    rows,
    distributor: { code: canonicalCode, name: distributorName },
    fileName: input.fileName,
    sheetName: adapted.sheetName,
    weekStart,
    blockingReasons,
    excludedItems: [...excluded.values()]
      .map((entry) => ({
        itemCode: entry.itemCode,
        itemName: entry.itemName,
        rows: entry.tally.rows.size,
        netQty: Number(heldOutNet(entry.tally).toFixed(2)),
        stockQty: Number(entry.tally.stockQty.toFixed(2)),
      }))
      .sort((left, right) => right.netQty - left.netQty),
    excludedBranches: [...excludedBranches.values()]
      .map((entry) => ({
        rawBranch: entry.rawBranch,
        branchName: entry.branchName,
        branchColumnIndex: entry.branchColumnIndex,
        rows: entry.tally.rows.size,
        netQty: Number(heldOutNet(entry.tally).toFixed(2)),
        stockQty: Number(entry.tally.stockQty.toFixed(2)),
      }))
      // A stock-only depot nets zero — fall back to stock so it never sorts as "nothing happened".
      .sort((left, right) => right.netQty - left.netQty || right.stockQty - left.stockQty),
  });
  return { ok: true, rows, result };
}

// ── summarize ────────────────────────────────────────────────────────────────────────────────

const emptyTotals = (): WeeklyTotals => ({ rowCount: 0, salesQty: 0, returnQty: 0, netQty: 0, bonusQty: 0, salesValue: 0, stockQty: 0 });
const addTotals = (acc: WeeklyTotals, row: WeeklyParsedRow) => {
  acc.rowCount += 1;
  acc.salesQty += row.salesQty;
  acc.returnQty += row.returnQty;
  acc.netQty += row.netQty;
  acc.bonusQty += row.bonusQty;
  acc.salesValue += row.salesValue;
  acc.stockQty += row.stockQty;
};
const round = (totals: WeeklyTotals): WeeklyTotals => ({
  rowCount: totals.rowCount,
  salesQty: Number(totals.salesQty.toFixed(2)),
  returnQty: Number(totals.returnQty.toFixed(2)),
  netQty: Number(totals.netQty.toFixed(2)),
  bonusQty: Number(totals.bonusQty.toFixed(2)),
  salesValue: Number(totals.salesValue.toFixed(2)),
  stockQty: Number(totals.stockQty.toFixed(2)),
});

export function summarizeWeekly(input: {
  rows: WeeklyParsedRow[];
  distributor: { code: string; name: string };
  fileName: string;
  sheetName: string;
  weekStart: string | null;
  blockingReasons: string[];
  excludedItems?: WeeklyExcludedItem[];
  excludedBranches?: WeeklyExcludedBranch[];
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

    // Region/branch breakdowns are geographic — only rows with a resolved region/branch belong.
    // Rows with no resolved region (e.g. branchless stock fallbacks) stay in totals + by-product
    // but must not form a phantom "—" region/branch row.
    if (row.regionCode) {
      const region = regions.get(row.regionCode) ?? { regionName: row.regionName || row.regionCode, totals: emptyTotals() };
      addTotals(region.totals, row);
      regions.set(row.regionCode, region);
    }

    const productKey = row.productCode || row.productName || "—";
    const product = products.get(productKey) ?? { productName: row.productName || productKey, officialLine: row.officialLine, totals: emptyTotals() };
    addTotals(product.totals, row);
    products.set(productKey, product);

    const branchKey = row.branchCode || row.branchName;
    if (branchKey) {
      const branch = branches.get(branchKey) ?? { branchName: row.branchName || branchKey, regionCode: row.regionCode, regionName: row.regionName, totals: emptyTotals() };
      addTotals(branch.totals, row);
      branches.set(branchKey, branch);
    }
  }

  // STRICT: any failure issue blocks the batch (and nothing persists).
  const hasFailure = failedRows > 0;
  const blockingReasons = [...input.blockingReasons];
  if (hasFailure && !blockingReasons.some((reason) => reason.startsWith("Validation failed:"))) {
    blockingReasons.push(
      `Validation failed: ${failedRows} row(s) have unresolved product/region/price/line issues. Fix them, then re-upload.`,
    );
  }
  const status: "blocked" | "validated" = blockingReasons.length > 0 ? "blocked" : "validated";

  return {
    distributor: { code: input.distributor.code, name: input.distributor.name },
    fileName: input.fileName,
    sheetName: input.sheetName,
    templateKey: input.distributor.code,
    templateName: input.distributor.name,
    weekStart: input.weekStart,
    // Week-of-month tags are assigned by the service (importWeeklySalesFile) after parsing; the parser
    // doesn't know the wizard-confirmed week, so it leaves them null here.
    cycleMonth: null,
    weekNumber: null,
    suggestedWeekNumber: null,
    status,
    blockingReasons,
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
    excludedItems: input.excludedItems ?? [],
    excludedBranches: input.excludedBranches ?? [],
  };
}
