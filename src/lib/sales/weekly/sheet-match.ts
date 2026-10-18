// Weekly Sales — which worksheet each distributor's import reads.
//
// ONE rule, shared by the importer (parser.ts adapters), the pre-upload verification screen
// (ai-verify.ts) and the column editor's preview, so no screen can show a sheet the import will not
// read. They used to carry three copies: the verification screen matched on column-contract.ts's
// looser `sheetIncludes` ("Stock", "Return") and fell back to the FIRST sheet when nothing matched,
// while adaptEG matched only "Current Stock Branches" and "Branch Sales Return" and never fell back.
// On an EGD workbook without its branch stock sheet the screen therefore showed "Current Stock
// Pharmacy" (which the import deliberately ignores), or column 3 of the sales sheet, as the stock
// source while the import read no stock at all — the shape of the 2026-08 month-end EGD file that was
// stored with stock 0 on every row.
//
// Matching, in order: a sheet whose trimmed name equals `name` (case-insensitive); else the first sheet
// whose name contains `includes` (case-insensitive); else — ONLY where the adapter has always done so
// — the workbook's first sheet. Otherwise the sheet is missing, and callers must say so. Where that
// first-sheet fallback is allowed, a BLANK sheet never wins at any step (see matchWeeklySheet).
//
// `firstSheetFallback` is the adapters' real behaviour, not a default. Ibn Sina's export has no
// "Sheet2": on production 8 of its 9 stored uploads to 2026-09-16 were read from "Sheet1" through this
// fallback, so removing it would block every normal Ibn Sina upload. EGD and RAMCO have never had one.

import type ExcelJS from "exceljs";

import type { WeeklyContractSheetRole } from "@/lib/sales/weekly/column-contract";

export type WeeklySheetMatcher = {
  /** preferred exact sheet name (trimmed, case-insensitive) */
  name: string;
  /** substring match when no sheet has the exact name (case-insensitive) */
  includes: string;
  /** true when the adapter reads the workbook's first sheet if neither name matches */
  firstSheetFallback: boolean;
};

export type WeeklySheetMatch = {
  worksheet: ExcelJS.Worksheet;
  matchedBy: "name" | "includes" | "first-sheet";
};

const WEEKLY_SHEET_MATCHERS: Readonly<Record<string, Partial<Record<WeeklyContractSheetRole, WeeklySheetMatcher>>>> = {
  EG: {
    sales: { name: "Branches Sales", includes: "Branches Sales", firstSheetFallback: false },
    returns: { name: "Branch Sales Return", includes: "Branch Sales Return", firstSheetFallback: false },
    // Branch stock only — never "Current Stock Pharmacy", "Transfer" or "Transfer Return".
    stock: { name: "Current Stock Branches", includes: "Current Stock Branches", firstSheetFallback: false },
  },
  RM: {
    sales: { name: "SALES", includes: "SALES", firstSheetFallback: false },
    stock: { name: "STOCK", includes: "STOCK", firstSheetFallback: false },
  },
  "IS-S": {
    combined: { name: "SalesAndStockReport2_DataHub", includes: "DataHub", firstSheetFallback: true },
  },
  // Ibn Sina Lacto is the same Ibn Sina export for a different supplier — same sheet name, so the
  // same rule, first-sheet fallback included (measured on the real
  // Weekly_Sales_And_Stock_For_LACTO_MISR_EG20261011120032.xlsx: one sheet, named exactly).
  "IS-L": {
    combined: { name: "SalesAndStockReport2_DataHub", includes: "DataHub", firstSheetFallback: true },
  },
  IS: {
    combined: { name: "Sheet2", includes: "Sheet2", firstSheetFallback: true },
  },
  SF: {
    combined: { name: "Sheet1", includes: "Sheet", firstSheetFallback: true },
  },
  POS: {
    combined: { name: "Purchasing Sales Data", includes: "Purchasing", firstSheetFallback: true },
  },
  PS: {
    sales: { name: "Data", includes: "Data", firstSheetFallback: true },
    stock: { name: "Data", includes: "Data", firstSheetFallback: true },
  },
};

/** The sheet rule for one distributor's sheet role, or undefined when that adapter reads no such sheet. */
export function weeklySheetMatcher(
  distributorCode: string | null | undefined,
  role: WeeklyContractSheetRole,
): WeeklySheetMatcher | undefined {
  const key = String(distributorCode ?? "").trim().toUpperCase();
  const entry = Object.entries(WEEKLY_SHEET_MATCHERS).find(([code]) => code.toUpperCase() === key);
  return entry?.[1][role];
}

/** Every distributor code that has a sheet rule (Direct reads its first sheet by header name and has none). */
export function weeklySheetMatcherCodes(): string[] {
  return Object.keys(WEEKLY_SHEET_MATCHERS);
}

/** True when at least one cell of the sheet holds a value (ExcelJS: `actualRowCount`, rows with values). */
function sheetHasData(sheet: ExcelJS.Worksheet): boolean {
  return sheet.actualRowCount > 0;
}

/**
 * The worksheet the import reads for `matcher`, and how it was found — or null when the sheet is missing.
 *
 * Where `firstSheetFallback` is true a BLANK sheet never wins: it is stepped past, by name and by the
 * fallback alike. Excel gives every new workbook "Sheet1", "Sheet2" and "Sheet3", so an Ibn Sina file
 * re-saved from one carries data in "Sheet1" and two empty sheets beside it — and the IS rule, which
 * looks for an exact "Sheet2" first, used to land on the empty one and answer "No data rows found in
 * the weekly file" about a 679-row workbook (ISP SATO SALES & STOCK 14-10-2026, 2026-10-18). Where the
 * fallback is false the rule is unchanged on purpose: an EGD "Branch Sales Return" with no returns is a
 * legitimate empty sheet, and skipping it would turn it into a missing one.
 */
export function matchWeeklySheet(workbook: ExcelJS.Workbook, matcher: WeeklySheetMatcher): WeeklySheetMatch | null {
  const usable = (sheet: ExcelJS.Worksheet) => !matcher.firstSheetFallback || sheetHasData(sheet);
  const name = matcher.name.trim().toLowerCase();
  const exact = workbook.worksheets.find((sheet) => sheet.name.trim().toLowerCase() === name && usable(sheet));
  if (exact) return { worksheet: exact, matchedBy: "name" };
  const includes = matcher.includes.toLowerCase();
  const partial = workbook.worksheets.find((sheet) => sheet.name.toLowerCase().includes(includes) && usable(sheet));
  if (partial) return { worksheet: partial, matchedBy: "includes" };
  // A workbook with no data anywhere keeps the first sheet, so it still reads as an empty file.
  const first = matcher.firstSheetFallback ? (workbook.worksheets.find(sheetHasData) ?? workbook.worksheets[0]) : undefined;
  return first ? { worksheet: first, matchedBy: "first-sheet" } : null;
}

/** The contract's display names for a sheet, taken from the shared rule so the two can never drift. */
export function weeklyContractSheetNames(
  distributorCode: string,
  role: WeeklyContractSheetRole,
): { sheetName: string; sheetIncludes: string } {
  const matcher = weeklySheetMatcher(distributorCode, role);
  if (!matcher) throw new Error(`No weekly sheet rule for ${distributorCode} ${role}.`);
  return { sheetName: matcher.name, sheetIncludes: matcher.includes };
}
