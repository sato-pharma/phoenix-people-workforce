import ExcelJS from "exceljs";

import type { SalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import { IGNORE_PRODUCT_CODE } from "@/lib/sales/normalizer/types";
import { needsAGuess, normalizeNumberText, twoReadings } from "@/lib/sales/normalizer/number-text";
import {
  weeklyContractByCode,
  type WeeklyContractSheet,
  type WeeklyContractSheetRole,
  type WeeklyDistributorContract,
} from "@/lib/sales/weekly/column-contract";
import type { WeeklyBranchRegionIndex } from "@/lib/sales/weekly/branch-region-map";
import { canonicalWeeklyDistributorCode, weeklyDistributorByCode } from "@/lib/sales/weekly/distributors";
import { normalizeCode, normalizeKey, normalizeSoft } from "@/lib/sales/weekly/mapping-normalize";
import { matchWeeklySheet, weeklySheetMatcher } from "@/lib/sales/weekly/sheet-match";
import type { WeeklyProductAliasIndex } from "@/lib/sales/weekly/product-aliases";
import type {
  WeeklyExcludedBranch,
  WeeklyExcludedItem,
  WeeklyFileTotalCheck,
  WeeklyFileTotalsReport,
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

// ── cells that could only be read by guessing ───────────────────────────────────────────────────
//
// A quantity or date held as TEXT can have two readings: "12,5" is 12.5 with a comma for decimals or
// 125 with the comma dropped, and "05/10/2026" is 5 October or 10 May. Until 2026-10-23 this parser
// picked one silently — "12,5" became 125, "1.234,56" became 1.23456, Arabic-Indic digits became 0,
// "−500" (the minus sign) became +500, and "05/10/2026" became 10 May (audit P4-01, P4-02). The
// monthly engine has refused such cells since 2026-09-18 (owner: "refuse them and name the cell"),
// so a weekly file now does the same: the forms with ONE meaning are read (normalizeNumberText, the
// monthly engine's own reader), and a cell with two readings stops the upload and is named.
//
// Collected while ONE file is read: set immediately before the synchronous adapter call in
// parseWeeklyWorkbookBuffer and cleared right after it, with no await in between, so two uploads in
// one process can never share the list.

/** One text cell this parser could not read without guessing. */
export type WeeklyUnreadableCell = {
  /** where the cell sits, in words: `sheet "X" cell M5` */
  where: string;
  /** the text exactly as the file holds it */
  text: string;
  /** the two numbers or dates it could mean, or null when it is not one number at all */
  readings: [string, string] | null;
  kind: "number" | "date";
};

type CellReadLog = {
  unreadable: WeeklyUnreadableCell[];
  /** "05/10/2026"-style dates whose order the cell alone cannot decide, kept for the file-level decision */
  ambiguousDates: { cell: WeeklyUnreadableCell; first: number; second: number; year: number }[];
  /** orientations proven by a slash date whose day is above 12, e.g. "13/10/2026" proves day-first */
  dayFirstVotes: number;
  monthFirstVotes: number;
};

let activeCellLog: CellReadLog | null = null;

function cellWhere(cell: ExcelJS.Cell): string {
  const address = typeof cell.address === "string" ? cell.address : "";
  let sheetName = "";
  try {
    sheetName = String(cell.worksheet?.name ?? "").trim();
  } catch {
    sheetName = "";
  }
  if (sheetName && address) return `sheet "${sheetName}" cell ${address}`;
  return address ? `cell ${address}` : "a cell";
}

// Text that is nothing but a number: digits with separators, an optional sign, optional brackets.
// Anything carrying a word ("12 units", a street address under a shifted header) keeps the old
// strip-the-letters reading — those columns are already cross-checked or fall back to the net.
const NUMBER_SHAPED = /^\(?\s*[-+]?[\d.,\s]*\d[\d.,\s]*\s*\)?$/;
// A DATE under a quantity header ("31.03.2026" in a SOLDQTY column whose header row shifted against
// its data — one real Sofico March copy) is not a quantity with two readings, it is no quantity at all:
// it keeps the old reading (0) and the adapter falls back to the stated net, as it always did.
const DATE_SHAPED = /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/;

/**
 * Read a quantity cell's TEXT. Pure, so the whole rule is tested without a workbook.
 * Returns the number, or the reason it cannot be read without a guess.
 */
export function readWeeklyNumberText(text: string): { value: number } | { readings: [string, string] | null } {
  const folded = normalizeNumberText(text);
  if (!folded) return { value: 0 };
  // Accounting style text negatives, e.g. "(500)" → -500.
  const isParenNegative = /^\(.*\)$/.test(folded);
  const inner = isParenNegative ? folded.slice(1, -1).trim() : folded;
  if (NUMBER_SHAPED.test(folded) && !DATE_SHAPED.test(inner.replace(/\s+/g, ""))) {
    // "12 5" is two numbers or a typo, never 125. Whole groups of three ("1 200") were already
    // joined by normalizeNumberText, so a space left between digits is one it could not explain.
    if (/\d\s+\d/.test(inner)) return { readings: null };
    const compact = inner.replace(/\s+/g, "");
    if (needsAGuess(compact)) return { readings: twoReadings(compact) };
    const num = Number(compact.replace(/,/g, ""));
    if (!Number.isFinite(num)) return { readings: null };
    return { value: isParenNegative ? -Math.abs(num) : num };
  }
  const raw = inner.replace(/,/g, "").replace(/[^0-9.\-]/g, "");
  if (!raw) return { value: 0 };
  const num = Number(raw);
  if (!Number.isFinite(num)) return { value: 0 };
  return { value: isParenNegative ? -Math.abs(num) : num };
}

function cellNumber(cell: ExcelJS.Cell | undefined): number {
  if (!cell) return 0;
  const value = cell.value as unknown;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const text = cellText(cell);
  if (!text) return 0;
  const read = readWeeklyNumberText(text);
  if ("value" in read) return read.value;
  activeCellLog?.unreadable.push({ kind: "number", readings: read.readings, text, where: cellWhere(cell) });
  // The upload is refused once the adapter returns (see parseWeeklyWorkbookBuffer), so this zero is
  // never stored; it only keeps the adapter's own arithmetic finite until then.
  return 0;
}

/**
 * True when the cell holds a readable quantity, zero included — as opposed to a blank or a word.
 * `cellNumber` answers 0 for all three, which is how a missing column passes for genuine zeros.
 * Arabic-Indic digits count: "٠" is a stock of zero, not a missing column.
 */
function cellHoldsNumber(cell: ExcelJS.Cell | undefined): boolean {
  return /^\(?[-+]?[\d,]*\.?\d+\)?$/.test(normalizeNumberText(cellText(cell)).replace(/\s+/g, ""));
}

/** Thousands-separated, at most 2 decimals — for numbers that appear in operator-facing messages. */
function readableNumber(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30); // 1899-12-30, the ExcelJS/Lotus serial epoch
const DAY_MS = 24 * 60 * 60 * 1000;

/** YYYY-MM-DD for a civil date, or null when it is not a real day (30 February). */
function civilIso(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || year < 1900 || year > 9999) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Read a date cell's TEXT. Pure. A slash date whose two parts are both 12 or under and differ
 * ("05/10/2026") is returned as AMBIGUOUS rather than read: it is 5 October or 10 May, and the file
 * decides which (parseWeeklyWorkbookBuffer) — never the host's `new Date(text)`, which read it as
 * 10 May, and in a timezone ahead of UTC as the day before.
 */
export function readWeeklyDateText(
  text: string,
):
  | { iso: string | null; orientation?: "dayFirst" | "monthFirst" }
  | { ambiguous: { first: number; second: number; year: number } } {
  const trimmed = normalizeNumberText(text);
  if (!trimmed) return { iso: null };
  const ymd = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/.exec(trimmed);
  if (ymd) return { iso: civilIso(Number(ymd[1]), Number(ymd[2]), Number(ymd[3])) };
  // Numeric text that is really a serial (e.g. "45810").
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const serial = Number(trimmed);
    return { iso: serial > 59 && serial < 100000 ? excelSerialToIso(serial) : null };
  }
  const dmy = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?!\d)/.exec(trimmed);
  if (dmy) {
    const first = Number(dmy[1]);
    const second = Number(dmy[2]);
    let year = Number(dmy[3]);
    if (year < 100) year += 2000;
    if (first > 12 && second <= 12) return { iso: civilIso(year, second, first), orientation: "dayFirst" };
    if (second > 12 && first <= 12) return { iso: civilIso(year, first, second), orientation: "monthFirst" };
    if (first === second) return { iso: civilIso(year, first, second) };
    return { ambiguous: { first, second, year } };
  }
  // Last resort: the host's own parser for written-out dates ("Oct 5, 2026"). It parses as LOCAL
  // midnight, so the day is read with the local getters — toISOString() would hand back the day
  // before on any host ahead of UTC.
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return { iso: null };
  return { iso: civilIso(parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate()) };
}

/** Convert an Excel SERIAL number, a Date, or date text into an ISO date (YYYY-MM-DD) or null. */
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
  const read = readWeeklyDateText(text);
  if ("ambiguous" in read) {
    activeCellLog?.ambiguousDates.push({
      ...read.ambiguous,
      cell: { kind: "date", readings: null, text, where: cellWhere(cell) },
    });
    return null;
  }
  if (read.orientation === "dayFirst" && activeCellLog) activeCellLog.dayFirstVotes += 1;
  if (read.orientation === "monthFirst" && activeCellLog) activeCellLog.monthFirstVotes += 1;
  return read.iso;
}

function excelSerialToIso(serial: number): string | null {
  // Only treat plausible date serials as dates (Excel dates after ~1900). Small integers like a
  // quantity or a branch code must NOT be mistaken for dates.
  if (serial <= 59 || serial >= 100000) return null;
  // FLOOR, never round: the fraction is the time of day, so 46,000.6 is 14:24 on day 46,000 — rounding
  // carried every afternoon timestamp into the NEXT day (audit P4-02).
  const ms = EXCEL_EPOCH_UTC + Math.floor(serial) * DAY_MS;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function spokenDate(iso: string | null): string {
  if (!iso) return "no real day";
  const [year, month, day] = iso.split("-").map(Number);
  return `${day} ${MONTH_NAMES[month - 1]} ${year}`;
}

/**
 * The file-level half of the date rule. A file whose own slash dates prove an order (a day above 12
 * somewhere) has its ambiguous ones read that way; otherwise they stay unread. Pure.
 */
export function resolveAmbiguousWeeklyDates(log: Pick<CellReadLog, "ambiguousDates" | "dayFirstVotes" | "monthFirstVotes">): {
  resolved: string[];
  unresolved: { cell: WeeklyUnreadableCell; dayFirst: string | null; monthFirst: string | null }[];
} {
  const resolved: string[] = [];
  const unresolved: { cell: WeeklyUnreadableCell; dayFirst: string | null; monthFirst: string | null }[] = [];
  const order =
    log.dayFirstVotes > 0 && log.monthFirstVotes === 0
      ? "dayFirst"
      : log.monthFirstVotes > 0 && log.dayFirstVotes === 0
        ? "monthFirst"
        : null;
  for (const entry of log.ambiguousDates) {
    const dayFirst = civilIso(entry.year, entry.second, entry.first);
    const monthFirst = civilIso(entry.year, entry.first, entry.second);
    if (order === "dayFirst" && dayFirst) resolved.push(dayFirst);
    else if (order === "monthFirst" && monthFirst) resolved.push(monthFirst);
    else unresolved.push({ cell: entry.cell, dayFirst, monthFirst });
  }
  return { resolved, unresolved };
}

/** At most this many cells are named in one refusal; the rest are counted. */
const UNREADABLE_CELLS_NAMED = 8;

/** The operator-facing refusal for number cells that need a guess. Pure. */
export function unreadableNumbersMessage(distributorName: string, cells: readonly WeeklyUnreadableCell[]): string | null {
  if (cells.length === 0) return null;
  const named = cells.slice(0, UNREADABLE_CELLS_NAMED).map((cell) =>
    cell.readings
      ? `${cell.where} reads "${cell.text}", which could be ${cell.readings[0]} or ${cell.readings[1]}`
      : `${cell.where} reads "${cell.text}", which is not one number`,
  );
  const more = cells.length > named.length ? ` There are ${cells.length - named.length} more like them.` : "";
  return (
    `${distributorName}: ${cells.length} quantity cell(s) can only be read by guessing — ${named.join("; ")}.${more} ` +
    "Nothing was imported. Write each one as a plain number (for example 12.5 or 125), or store the column as " +
    "numbers in Excel, and upload again."
  );
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
  /** what the FILE says its own totals are, against what this adapter read — see the section below */
  fileTotalChecks?: WeeklyFileTotalCheck[];
};

// ── file-declared totals: check what we read against what the file says it contains ──────────────
//
// The 2026-08 POS batch stored 172,046 units against a true 1,048, priced them at EGP 16.4M, and
// passed validation cleanly, because nothing anywhere compared the parsed result to anything. Several
// of these exports state their own totals; where one does, it is an independent check on whether the
// adapter read the file the way the file meant, and it costs nothing to run.
//
// TWO RULES make this safe to switch on across every distributor at once:
//
//   1. A check must be INDEPENDENT of the range the adapter scanned. A declared total summed across
//      the same columns the adapter read cannot see a wrong column range — both sides shrink together
//      and the check passes while the import is short. So a grand-total CELL is preferred over a
//      summed row wherever the file provides one, and the column holding it is located by its own
//      header, never from where the data scan happened to stop.
//   2. A check only BLOCKS where the invariant is proven against real files. Everything else reports.
//      These are live weekly uploads; blocking a legitimate one on a format nobody has a sample of
//      would cost more than it saves, and a loud advisory catches the fault this class produces (the
//      POS gap was 172,046 against 1,048 — not a rounding question) without that risk.

/** Absolute tolerance, in units. The files state whole packs; anything above this is real. */
const FILE_TOTAL_TOLERANCE = 0.01;

function fileTotalCheck(input: {
  label: string;
  where: string;
  declared: number;
  parsed: number;
  severity: "block" | "report";
  hint?: string;
}): WeeklyFileTotalCheck {
  return {
    label: input.label,
    where: input.where,
    declared: input.declared,
    parsed: input.parsed,
    severity: input.severity,
    status: Math.abs(input.declared - input.parsed) > FILE_TOTAL_TOLERANCE ? "mismatch" : "ok",
    ...(input.hint ? { hint: input.hint } : {}),
  };
}

/** Operator-facing sentence for one failed check — the same shape whether it blocks or advises. */
function fileTotalMessage(distributorName: string, check: WeeklyFileTotalCheck): string {
  const head =
    `${distributorName}: the file's own ${check.label} says ${readableNumber(check.declared)}, but the import read ` +
    `${readableNumber(check.parsed)} (${check.where}).`;
  const tail =
    check.severity === "block"
      ? " Nothing was imported, rather than storing quantities that are known to disagree with the file."
      : " The import was not stopped, but these two should agree — check the figures before you press Import.";
  return check.hint ? `${head}${tail} ${check.hint}` : `${head}${tail}`;
}

/**
 * Why a distributor's export offers nothing to check an import against. Written out per distributor
 * so that "no self-check" is a stated fact on the screen, not an empty list that could equally mean
 * the adapter forgot to run one. Each was read off the adapter's own column map and the golden
 * fixtures in tests/weekly-sales-import.test.ts, which mirror the real exports.
 */
const FILE_DECLARES_NO_TOTAL: Record<string, string> = {
  EG:
    "EGD's three sheets (Branches Sales, Branch Sales Return, Current Stock Branches) are plain " +
    "row-per-record exports with no totals row and no value column, so the file states no figure the " +
    "import can be checked against.",
  IS:
    "The Ibn Sina sheet is one row per product and branch with no totals row and no value column, so " +
    "the file states no figure the import can be checked against.",
  "IS-S":
    "The Ibn Sina Sato sheet is one row per product and branch and closes with a blank row rather than " +
    "a totals row, so the file states no figure the import can be checked against.",
  SF:
    "This Sofico sheet states a net quantity per row but carries no SOLDQTY and RETURNQTY pair beside " +
    "it, so it states no second figure the import can be checked against. A Sofico export that carries " +
    "all three is cross-checked instead.",
  Direct:
    "The Direct sheet is filled in by hand, one row per order, with no totals row. Its Value column is " +
    "the real per-deal price and is stored as-is rather than derived, so it cannot cross-check the " +
    "quantity either.",
};

// ── adapters: each reads a verified real layout and emits neutral observations ───────────────────

/** The worksheet an adapter reads, by the rule the verification screen shares (sheet-match.ts). */
function findSheet(
  workbook: ExcelJS.Workbook,
  distributorCode: string,
  role: WeeklyContractSheetRole,
): ExcelJS.Worksheet | undefined {
  const matcher = weeklySheetMatcher(distributorCode, role);
  return matcher ? matchWeeklySheet(workbook, matcher)?.worksheet : undefined;
}

const at = (row: ExcelJS.Row, col: number): ExcelJS.Cell => row.getCell(col);

/**
 * First column in `headerRow` whose header matches `pattern`, searched across the WHOLE row rather
 * than stopping where a data scan stopped. That independence is the point: a grand-total column found
 * by walking until the data ran out can only ever agree with the data that was read, so it would pass
 * on exactly the wrong-column-range fault it is meant to catch. `limit` is a loop bound, not a
 * meaningful edge — ExcelJS `columnCount` is unreliable on sparse sheets.
 */
function findHeaderColumn(headerRow: ExcelJS.Row, pattern: RegExp, from: number, limit = 300): number | null {
  for (let col = from; col <= limit; col += 1) {
    const header = cellText(at(headerRow, col)).trim();
    if (header && pattern.test(header)) return col;
  }
  return null;
}

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

  const sales = findSheet(workbook, "EG", "sales");
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

  const returns = findSheet(workbook, "EG", "returns");
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
  //
  // A workbook that yields NO stock blocks the upload instead of storing zero on every row. The
  // 2026-08 month-end file ("EGD SATO END SALES &STOCK 31-8-2026") was read with no sheet of that
  // name — only its two sales sheets — and validated cleanly at 0 stock; because the engine keeps each distributor's stock
  // from its LATEST week, that one batch turned EGD's whole stock position into 0. Genuine zero is
  // still accepted: the check is for a readable quantity in the stock column, and "0" is readable.
  const stock = findSheet(workbook, "EG", "stock");
  if (!stock) {
    blockingReasons.push(
      `EGD: this workbook has no "Current Stock Branches" sheet (its sheets are: ${workbook.worksheets.map((sheet) => sheet.name.trim()).join(" · ")}). ` +
        "Stock is read from that sheet only, so importing would store every branch with zero stock. Nothing was " +
        "imported. Ask EGD for the full sales and stock export, or restore the sheet's name, and upload again.",
    );
  } else {
    names.push(stock.name);
    const agg = new Map<string, WeeklyObservation>();
    const stockQtyCol = colOf(stockC, "stockQty", 3);
    let stockRows = 0;
    let stockRowsWithQty = 0;
    for (let r = dataStartRow(stockC, 2); r <= stock.rowCount; r += 1) {
      const row = stock.getRow(r);
      const itemCode = cellText(at(row, colOf(stockC, "itemCode", 1)));
      const itemName = cellText(at(row, colOf(stockC, "itemName", 2)));
      const entityCode = cellText(at(row, colOf(stockC, "entityCode", 13)));
      const entityName = cellText(at(row, colOf(stockC, "entityName", 14)));
      const qty = cellNumber(at(row, stockQtyCol));
      if (!itemCode && !entityCode) continue;
      stockRows += 1;
      if (cellHoldsNumber(at(row, stockQtyCol))) stockRowsWithQty += 1;
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

    const sheetLabel = `EGD: the "${stock.name.trim()}" sheet`;
    if (stockRows === 0) {
      blockingReasons.push(
        `${sheetLabel} has no stock rows, so importing would store every branch with zero stock. Nothing was ` +
          "imported. Ask EGD for the export with its stock filled in, and upload again.",
      );
    } else if (stockRowsWithQty === 0) {
      const header = cellText(at(stock.getRow(headerRowOf(stockC, 1)), stockQtyCol)) || "blank";
      blockingReasons.push(
        `${sheetLabel} has ${stockRows} row(s) but no stock quantity in column ${stockQtyCol} (header: ${header}), ` +
          "so the stock column has moved or is missing and importing would store every branch with zero stock. " +
          "Nothing was imported. Check the column layout for EGD before uploading again.",
      );
    }
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
  const fileTotalChecks: WeeklyFileTotalCheck[] = [];

  const salesC = contractSheet(ctx.contract, "sales");
  const stockC = contractSheet(ctx.contract, "stock");

  const sales = findSheet(workbook, "RM", "sales");
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
  const stock = findSheet(workbook, "RM", "stock");
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

    // الإجمالى — the sheet's own grand total per product, until now used only as a marker telling the
    // branch scan where to stop, its value never read. Located here across the WHOLE header row rather
    // than from where that scan stopped: the scan also breaks at the first blank header, so a branch
    // column added mid-row ends the scan early and every column past it is silently dropped. The grand
    // total is the only figure in the sheet that can see that happen.
    const grandTotalCol = findHeaderColumn(
      headerRow,
      /^\s*(?:الإجمالى|الاجمالى|الإجمالي|الاجمالي)\s*$/u,
      matrixFirst,
      Math.max(stock.columnCount, 200),
    );
    let declaredStock = 0;
    let parsedStock = 0;
    let sawDeclaredStock = false;

    for (let r = dataStartRow(stockC, 3); r <= stock.rowCount; r += 1) {
      const row = stock.getRow(r);
      const itemCode = cellText(at(row, colOf(stockC, "itemCode", 4)));
      const itemName = cellText(at(row, colOf(stockC, "itemName", 5)));
      if (!itemCode && !itemName) continue;

      // Only a row that actually STATES a grand total joins the comparison, and when it does, both
      // sides take that row — a blank cell means the file totalled nothing there, not zero.
      const statesTotal = grandTotalCol !== null && cellText(row.getCell(grandTotalCol)).trim() !== "";
      if (statesTotal) {
        declaredStock += cellNumber(row.getCell(grandTotalCol as number));
        sawDeclaredStock = true;
      }
      for (const [col, branch] of branchCols) {
        const qty = cellNumber(row.getCell(col));
        if (statesTotal) parsedStock += qty;
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

    if (sawDeclaredStock) {
      fileTotalChecks.push(
        fileTotalCheck({
          label: 'stock sheet grand-total column (الإجمالى), summed over every product',
          where: `${stock.name}, column ${grandTotalCol} against branch columns ${[...branchCols.keys()].join(", ") || "none"}`,
          declared: declaredStock,
          parsed: parsedStock,
          // Reports rather than blocks: no real RAMCO stock file has been measured against this column,
          // and the columns between the branches and the grand total are unverified, so a blocking
          // check here could stop a legitimate upload on a shape nobody has seen.
          severity: "report",
          hint:
            "A gap here usually means branch columns were missed — the branch scan stops at the first " +
            "blank header, so a column added or renamed part-way along the row ends it early.",
        }),
      );
    }
  }

  return { observations, sheetDates, sheetName: names.join(" + ") || "RAMCO", blockingReasons: [], fileTotalChecks };
}

// IS-S (Ibn Sina Sato) and IS-L (Ibn Sina Lacto) — single sheet "SalesAndStockReport2_DataHub",
// title row 1, header row 2, data row 3+. Single Date in col1. Sales Quantity (col10) is signed
// (negative = inline return). ONE adapter, both codes: Ibn Sina exports this workbook per supplier,
// so the shape is identical and only the distributor code differs (distributors.ts).
function adaptISS(ctx: AdapterContext): AdapterResult {
  const workbook = ctx.workbooks[0];
  const combinedC = contractSheet(ctx.contract, "combined");
  // The sheet rule is looked up by the CALLER's code, not a literal — IS-S and IS-L have the same
  // rule today, and a literal would quietly read IS-S's rule if one of them ever moved.
  const sheet = findSheet(workbook, ctx.distributorCode, "combined");
  const observations: WeeklyObservation[] = [];
  const sheetDates = new Set<string>();
  const fileTotalChecks: WeeklyFileTotalCheck[] = [];
  if (!sheet) return { observations, sheetDates, sheetName: "Ibn Sina", blockingReasons: [] };

  // The footer row — blank Item Code AND blank Branch — carries the sheet's own grand totals in the
  // very quantity columns the data rows use: Stock in col8, Sales Quantity in col10. The Sato export
  // has closed with an all-blank row (nothing to check), while the LACTO MISR one states both
  // (measured 2026-10-11: stock 27,815 and sales 7,583, each exact against the 177 data rows). So
  // capture whatever the footer holds and cross-check only where a figure was actually declared.
  let declaredStock: number | null = null;
  let declaredSignedSales: number | null = null;
  let parsedStock = 0;
  let parsedSignedSales = 0;

  for (let r = dataStartRow(combinedC, 3); r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r);
    const itemCode = cellText(at(row, colOf(combinedC, "itemCode", 4)));
    const itemName = cellText(at(row, colOf(combinedC, "itemName", 5)));
    const branchCode = cellText(at(row, colOf(combinedC, "branchCode", 6)));
    const branchName = cellText(at(row, colOf(combinedC, "branchName", 7)));
    const stock = cellNumber(at(row, colOf(combinedC, "stockQty", 8)));
    const signedSales = cellNumber(at(row, colOf(combinedC, "signedSales", 10)));
    // Totals/footer row — never a fact, but its figures are what the file says it contains.
    if (!itemCode && !branchCode) {
      if (stock !== 0) declaredStock = (declaredStock ?? 0) + stock;
      if (signedSales !== 0) declaredSignedSales = (declaredSignedSales ?? 0) + signedSales;
      continue;
    }
    const date = cellDateIso(at(row, colOf(combinedC, "date", 1)));
    if (date) sheetDates.add(date);
    parsedStock += stock;
    parsedSignedSales += signedSales;
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

  // Reports rather than blocks: the footer is the distributor's own arithmetic, and an export that
  // states it for the first time must not be able to stop a legitimate upload on a shape nobody has
  // measured yet. A gap still shows on the screen before Import.
  if (declaredSignedSales != null) {
    fileTotalChecks.push(
      fileTotalCheck({
        label: "footer Sales Quantity total, summed over every product and branch",
        where: `${sheet.name}, the blank-key footer row against the ${observations.length ? "data rows above it" : "empty data range"}`,
        declared: declaredSignedSales,
        parsed: parsedSignedSales,
        severity: "report",
        hint:
          "Both sides are SIGNED quantities, so an inline return (a negative Sales Quantity) is " +
          "subtracted in each — a gap means rows were missed, not that returns were handled twice.",
      }),
    );
  }
  if (declaredStock != null) {
    fileTotalChecks.push(
      fileTotalCheck({
        label: "footer Stock total, summed over every product and branch",
        where: `${sheet.name}, the blank-key footer row against the data rows above it`,
        declared: declaredStock,
        parsed: parsedStock,
        severity: "report",
      }),
    );
  }

  return { observations, sheetDates, sheetName: sheet.name, blockingReasons: [], fileTotalChecks };
}

// IS (Ibn Sina, "ISP" file) — single sheet "Sheet2", header row 1, data row 2+. NO Date column.
// Sales Quantity (col9) signed (negative = return). Free Unit (col10) is ignored.
function adaptIS(ctx: AdapterContext): AdapterResult {
  const workbook = ctx.workbooks[0];
  const combinedC = contractSheet(ctx.contract, "combined");
  const sheet = findSheet(workbook, "IS", "combined");
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
  const fileTotalChecks: WeeklyFileTotalCheck[] = [];

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
  const salesSheet = findSheet(salesWb, "PS", "sales");
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
  const stockSheet = findSheet(stockWb, "PS", "stock");
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
    // The stock matrix states its own "Total Qty." per product, in a column BEFORE the locations —
    // never read until now. It is the one figure in this file that is independent of the location
    // range, which is detected per file and shifts whenever the distributor renames or adds a depot,
    // so it is exactly the check the location scan cannot perform on itself.
    const stockTotalQtyCol = findHeaderColumn(header, /total\s*qty/i, 1, Math.max(lastLocationCol, 200));
    let declaredStockQty = 0;
    let parsedStockQty = 0;
    let sawDeclaredStockQty = false;

    // PS stock location headers change every month by design (distributors rename branches).
    // The mapping is keyed by column index, not by name, so header drift never breaks resolution.
    // No blocking check here — resolveRegion already falls back to name if the index is missing.
    for (let r = dataStartRow(stockC, 2); r <= stockSheet.rowCount; r += 1) {
      const row = stockSheet.getRow(r);
      const itemCode = cellText(at(row, colOf(stockC, "itemCode", 3)));
      const itemName = cellText(at(row, colOf(stockC, "itemName", 4)));
      if (!itemCode && !itemName) continue;
      // Only a row that actually STATES a total joins the comparison, and when it does, both sides
      // take that row — otherwise a blank total cell would read as a declared zero and manufacture a
      // gap out of a row the file simply did not total.
      const statesTotal =
        stockTotalQtyCol !== null &&
        stockTotalQtyCol < locationFirst &&
        cellText(at(row, stockTotalQtyCol)).trim() !== "";
      if (statesTotal) {
        declaredStockQty += cellNumber(at(row, stockTotalQtyCol as number));
        sawDeclaredStockQty = true;
      }
      for (let col = locationFirst; col <= lastLocationCol; col += 1) {
        const locHeader = cellText(at(header, col));
        if (!locHeader) continue;
        const qty = cellNumber(at(row, col));
        if (statesTotal) parsedStockQty += qty;
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

    if (sawDeclaredStockQty) {
      fileTotalChecks.push(
        fileTotalCheck({
          label: 'stock matrix "Total Qty." column, summed over every product',
          where: `${stockSheet.name}, column ${stockTotalQtyCol} against locations ${locationFirst}–${lastLocationCol}`,
          declared: declaredStockQty,
          parsed: parsedStockQty,
          // Reports rather than blocks: no real Overseas stock file has been measured against this
          // column, and stopping a legitimate weekly upload would cost more than the check saves.
          severity: "report",
          hint:
            "A gap here usually means the location columns end somewhere other than where the import " +
            "stopped reading them — a renamed or newly added depot leaves a blank header, and the scan " +
            "stops at the first one.",
        }),
      );
    }
  }

  return { observations, sheetDates, sheetName: names.join(" + ") || "Overseas", blockingReasons, fileTotalChecks };
}

/**
 * The POS sheet's own "Total Units" summary row, read TWO independent ways.
 *
 * POS closes the product block with a "Total Units" row and a "Total Values" row; only the first is a
 * unit total, and it agrees with the product qty rows exactly — measured across all seven files held
 * for 2026-07 and 2026-08, where the row's channel sum, the row's own "Total" cell and the parser's
 * net were the same number every time.
 *
 * `acrossChannels` sums the row over the same columns the adapter read, so it catches a row the
 * adapter CLASSIFIED wrongly (the EGP value row counted as units). It cannot catch a wrong channel
 * RANGE, because a short range shortens both sides equally and the check still passes.
 *
 * `grandTotalCell` is the row's own "Total" cell, located from the header row independently of where
 * the channel scan stopped. That one does catch a short range — POS adds branches over time (83 → 94 →
 * 99 → 103 channels across the files held), so the range is detected per file and is exactly the kind
 * of thing that can silently drift.
 */
function posDeclaredTotals(
  sheet: ExcelJS.Worksheet,
  itemNameCol: number,
  channelFirst: number,
  lastChannelCol: number,
  totalCol: number | null,
  firstDataRow: number,
): { acrossChannels: number; grandTotalCell: number | null } | null {
  for (let r = firstDataRow; r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r);
    if (!/^total\s*units?$/i.test(cellText(at(row, itemNameCol)).trim())) continue;
    let sum = 0;
    for (let col = channelFirst; col <= lastChannelCol; col += 1) sum += cellNumber(at(row, col));
    // A BLANK total cell means the file declares nothing there — not that it declares zero. Reading it
    // as zero would turn every file that leaves it empty into a blocked import.
    const totalCellIsStated = totalCol !== null && cellText(at(row, totalCol)).trim() !== "";
    return {
      acrossChannels: sum,
      grandTotalCell: totalCellIsStated ? cellNumber(at(row, totalCol as number)) : null,
    };
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

  const sheet = findSheet(workbook, "POS", "combined");
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

  // The "Total" column, located from the header row itself rather than from wherever the scan above
  // stopped — the scan also breaks on an empty header, and a total column found by following the data
  // could only ever confirm the data that was read. See findHeaderColumn and posDeclaredTotals.
  const totalCol = findHeaderColumn(headerRow, totalStop, channelFirst);

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

  // Reconcile the units we read against the units the sheet says it contains, TWICE — once across the
  // channel columns (catches a misclassified row: a new layout, a shifted column, a value row counted
  // as units) and once against the row's own "Total" cell (catches a channel range that stopped short,
  // which the first check cannot see, because a short range shortens both of its sides together).
  // Either disagreement means the adapter read the file differently from how the file meant it, and the
  // numbers must not reach the database. On the 2026-08 W3 file the first fires at 93,261 read against
  // 1,048 declared and blocks the import.
  const declared = posDeclaredTotals(
    sheet,
    itemNameCol,
    channelFirst,
    lastChannelCol,
    totalCol,
    dataStartRow(combinedC, 2),
  );
  const fileTotalChecks: WeeklyFileTotalCheck[] = [];
  if (declared) {
    fileTotalChecks.push(
      fileTotalCheck({
        label: '"Total Units" row, summed across the channel columns',
        where: `${sheet.name}, columns ${channelFirst}–${lastChannelCol}`,
        declared: declared.acrossChannels,
        parsed: parsedUnitsNet,
        severity: "block",
        hint:
          "A gap this size normally means each product's EGP value row is being counted as units — check " +
          "whether the value rows now repeat the product name and code.",
      }),
    );
    // The grand-total cell sees a channel range that stopped short, which the summed row cannot.
    if (declared.grandTotalCell !== null && totalCol !== null) {
      fileTotalChecks.push(
        fileTotalCheck({
          label: '"Total Units" row, its own "Total" cell',
          where: `${sheet.name}, column ${totalCol}`,
          declared: declared.grandTotalCell,
          parsed: parsedUnitsNet,
          severity: "block",
          hint:
            "This total is the file's own, independent of the channel columns the import scanned, so a gap " +
            "here alongside a matching channel sum means whole channel columns were missed — POS adds " +
            "branches over time and the range is detected per file.",
        }),
      );
    }
  }

  return { observations, sheetDates, sheetName: sheet.name, blockingReasons, fileTotalChecks };
}

// SF (Sofico) — single "Sheet1" workbook. Per-customer invoice detail rows (one invoice line per
// row). Header row 1, data row 2+. No period-date column; periodDate is always required on upload.
//
// COLUMNS ARE RESOLVED BY HEADER NAME, NEVER BY POSITION — the one distributor here that has to be.
// Sofico's export moves its own columns between months. Measured across 33 real files (Jan 2025 to
// Jun 2026): SOLDQTY sits at column 34, 36 or 37; `State` at 17, 18 or 21; `statename` at 18, 19 or
// 22. A pinned index therefore reads a DIFFERENT FIELD depending on which month was exported, and it
// lands on a customer code or an invoice id without failing — every row still parses, so the batch
// validates and the numbers are simply wrong. Simulating the previous pinned map against three real
// files imported 315, 280 and 0 units where the files themselves state 1,428, 4,837 and 710, and
// summed 428 BILLION units of "gross" out of the ten-digit CUSTOMERCODE column.
//
// There is no "NET SALES" column and there never was: of the 68 distinct headers those 33 files
// carry between them, the only one containing "net" is `net qty`, and not one of the 68 is a bonus
// or free-goods column either — so the "BonusQty" the previous map documented as ignored does not
// exist in any Sofico file. That map's field NAMES came from the 2025 generation (ItemID / ItemName
// / State / statename / SalesQty / ReturnQty) but its positions matched no file of either generation.
//
// Both generations resolve here. 2026 files name the product ITEMIDE / ITEMNAME, the branch
// SITE / SITENAME, the quantities `qty` + SOLDQTY + RETURNQTY. 2025 files name them ItemID /
// ItemName, InventSiteID / statename, `net qty` + SalesQty + ReturnQty. RETURNQTY is stored
// NEGATIVE (−302 against 1,730 sold), so the file's own identity is SOLDQTY + RETURNQTY = net qty.
// Measured over all 33 with the pair-picking and the per-row guard below: 33 of 33 import the net
// the file itself states, and 32 of 33 satisfy that identity outright. The one exception is a March
// copy whose header row is shifted against its data — its net is still right and agrees with its
// three sibling copies of the same month, so the self-check below REPORTS and does not block:
// refusing a file whose net is demonstrably correct would cost more than the advisory does.
const SF_HEADER_ALIASES: Record<string, string[]> = {
  branchCode: ["SITE", "InventSiteID", "State"],
  branchName: ["SITENAME", "statename"],
  itemCode: ["ITEMIDE", "ItemID"],
  itemName: ["ITEMNAME", "ItemName"],
  net: ["net qty", "qty"],
  return: ["RETURNQTY", "RETURNQTY4", "ReturnQty"],
  sold: ["SOLDQTY", "SalesQty"],
};
/** Without these the sheet cannot be read at all, so a miss blocks rather than guesses a position. */
const SF_REQUIRED_FIELDS = ["itemCode", "branchCode", "net"] as const;
const SF_FIELD_WANTED: Record<string, string> = {
  branchCode: "a branch code (SITE, InventSiteID or State)",
  itemCode: "a product code (ITEMIDE or ItemID)",
  net: "a net quantity (net qty or qty)",
};

function adaptSF(ctx: AdapterContext): AdapterResult {
  const workbook = ctx.workbooks[0];
  const combinedC = contractSheet(ctx.contract, "combined");
  const sheet = findSheet(workbook, "SF", "combined");
  const observations: WeeklyObservation[] = [];
  const blockingReasons: string[] = [];
  const fileTotalChecks: WeeklyFileTotalCheck[] = [];
  const sheetDates = new Set<string>(); // no date column → always require periodDate
  if (!sheet) return { observations, sheetDates, sheetName: "Sofico", blockingReasons };

  // Scan well past the widest real file (44 populated columns) — ExcelJS `columnCount` under-reports
  // on sparse sheets, and a header missed here would be indistinguishable from one Sofico renamed.
  const headerRowNumber = headerRowOf(combinedC, 1);
  const headerRow = sheet.getRow(headerRowNumber);
  const lastColumn = Math.max(sheet.columnCount, 80);
  const cols = findHeaderColumns(headerRow, lastColumn, SF_HEADER_ALIASES);

  const missing = SF_REQUIRED_FIELDS.filter((field) => !cols.has(field));
  if (missing.length > 0) {
    const present: string[] = [];
    for (let c = 1; c <= lastColumn; c += 1) {
      const text = cellText(at(headerRow, c)).trim();
      if (text) present.push(text);
    }
    blockingReasons.push(
      `Sofico: this file states no ${missing.map((field) => SF_FIELD_WANTED[field]).join(", and no ")}. ` +
        "Sofico moves its columns between months, so the import matches them by header name instead of by " +
        "position, and it will not guess at one it cannot find — reading the wrong column here imports a " +
        "customer code as a quantity without anything looking wrong. " +
        `The headers on sheet "${sheet.name}" row ${headerRowNumber} read: ${present.join(" · ")}. ` +
        "Send that list on and the new name will be added to the ones the import recognizes.",
    );
    return { observations, sheetDates, sheetName: sheet.name, blockingReasons };
  }

  const colItemCode = cols.get("itemCode") as number;
  const colBranchCode = cols.get("branchCode") as number;
  const colNet = cols.get("net") as number;
  const colItemName = cols.get("itemName") ?? null;
  const colBranchName = cols.get("branchName") ?? null;

  const firstDataRow = dataStartRow(combinedC, 2);
  const isDataRow = (row: ExcelJS.Row) => Boolean(cellText(at(row, colItemCode)) || cellText(at(row, colBranchCode)));

  // Two of the 33 real files carry BOTH generations' quantity headers at once — SalesQty/ReturnQty
  // AND SOLDQTY/RETURNQTY — with one pair populated and the other blank. Header matching is
  // case-insensitive, so `RETURNQTY` and `ReturnQty` are the same name and the lower column index
  // wins on nothing but position; measured, that handed the file the BLANK pair. So when a file
  // offers more than one candidate, the pair is chosen by the file's own arithmetic instead: the one
  // whose sold − |return| lands on the net the file states beside it. Ties keep the first candidate,
  // and a file where no pair reconciles keeps it too — the check at the end then reports the gap.
  const soldCandidates = headerColumnsMatching(headerRow, lastColumn, SF_HEADER_ALIASES.sold);
  const returnCandidates = headerColumnsMatching(headerRow, lastColumn, SF_HEADER_ALIASES.return);
  let colSold: number | null = soldCandidates[0] ?? null;
  let colReturn: number | null = returnCandidates[0] ?? null;
  if (soldCandidates.length > 1 || returnCandidates.length > 1) {
    const candidateSums = new Map<number, number>();
    let netTotal = 0;
    for (let r = firstDataRow; r <= sheet.rowCount; r += 1) {
      const row = sheet.getRow(r);
      if (!isDataRow(row)) continue;
      netTotal += cellNumber(at(row, colNet));
      for (const c of new Set([...soldCandidates, ...returnCandidates])) {
        candidateSums.set(c, (candidateSums.get(c) ?? 0) + cellNumber(at(row, c)));
      }
    }
    let smallestGap = Number.POSITIVE_INFINITY;
    for (const sold of soldCandidates.length > 0 ? soldCandidates : [null]) {
      for (const ret of returnCandidates.length > 0 ? returnCandidates : [null]) {
        const soldTotal = sold === null ? 0 : candidateSums.get(sold) ?? 0;
        const returnTotal = ret === null ? 0 : Math.abs(candidateSums.get(ret) ?? 0);
        const gap = Math.abs(soldTotal - returnTotal - netTotal);
        if (gap < smallestGap - 0.001) {
          smallestGap = gap;
          colSold = sold;
          colReturn = ret;
        }
      }
    }
  }

  let netSum = 0;
  let soldSum = 0;
  let returnSignedSum = 0;

  for (let r = firstDataRow; r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r);
    const itemCode = cellText(at(row, colItemCode));
    const itemName = colItemName ? cellText(at(row, colItemName)) : "";
    const branchCode = cellText(at(row, colBranchCode));
    const branchName = colBranchName ? cellText(at(row, colBranchName)) : "";
    if (!itemCode && !branchCode) continue;

    // Sofico's stated net is the net of record, exactly as RAMCO's صافى كمية is. SOLDQTY and
    // RETURNQTY only supply the gross/return split for display and the cross-check below.
    const net = cellNumber(at(row, colNet));
    const returnSigned = colReturn ? cellNumber(at(row, colReturn)) : 0;
    let returned = Math.abs(returnSigned); // stored negative in every real file; take either sign
    let gross = colSold ? cellNumber(at(row, colSold)) : Math.max(net, 0) + returned;

    // Take the split only when the row's own arithmetic agrees with the net beside it. Measured
    // across the 33 files, sold − |return| = net holds on EVERY row of 29 of them; it fails only on
    // hand-edited March copies, one of which has its header row shifted against its data so that
    // SOLDQTY sits over a date and ReturnQty over a street address — which reads as a gross of zero
    // against a net of 4,837, i.e. a return of MINUS 4,837 units on the screen. Rather than book an
    // impossible split, fall back to the net itself: a positive net is all sales, a negative net is
    // all return. The net — the only figure that reaches the closing — is untouched either way.
    if (Math.abs(gross - returned - net) > 0.001) {
      gross = Math.max(net, 0);
      returned = Math.max(-net, 0);
    }

    // The sums below are the file's RAW columns, never the corrected split, so the check at the end
    // still reports a disagreement the correction has just hidden from the screen.
    netSum += net;
    soldSum += colSold ? cellNumber(at(row, colSold)) : gross;
    returnSignedSum += colReturn ? returnSigned : 0;

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
    if (returned > 0) {
      observations.push({
        side: "return",
        sourceRowNumber: r,
        rawItemCode: itemCode,
        rawItemName: itemName,
        rawBranchCode: branchCode,
        rawBranchName: branchName || branchCode,
        branchFileType: "sales",
        qty: returned,
      });
    }
  }

  // The file's own identity, read from columns the import does NOT take its net from — so a header
  // that resolved to the wrong field shows up as a number, not as a silently plausible import.
  if (colSold !== null && colReturn !== null) {
    const soldHeader = cellText(at(headerRow, colSold)).trim();
    const returnHeader = cellText(at(headerRow, colReturn)).trim();
    const netHeader = cellText(at(headerRow, colNet)).trim();
    fileTotalChecks.push(
      fileTotalCheck({
        label: `${soldHeader} + ${returnHeader} against its own ${netHeader}`,
        where: `${sheet.name}, columns ${colSold} and ${colReturn} against column ${colNet}`,
        declared: Number((soldSum + returnSignedSum).toFixed(6)),
        parsed: Number(netSum.toFixed(6)),
        severity: "report",
        hint:
          "Sofico states the same quantity twice, and the import takes its net from the second. When " +
          "the two disagree, either one of the three columns was matched to the wrong field or the " +
          "sheet was edited by hand after Sofico produced it. The net is not at risk either way — it " +
          "is read from the column Sofico states it in, and on any row where the sales and return " +
          "columns contradict that net, the split falls back to the net rather than to them.",
      }),
    );
  }

  return { observations, sheetDates, sheetName: sheet.name, blockingReasons, fileTotalChecks };
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

/**
 * Resolve field → column by matching the header row against a per-field alias list, first alias
 * that matches wins. Used by every adapter that cannot pin a position: Direct because the sheet is
 * hand-made, SF because Sofico's own export moves its columns between months.
 */
function findHeaderColumns(
  headerRow: ExcelJS.Row,
  lastColumn: number,
  aliases: Record<string, string[]>,
): Map<string, number> {
  const byText = new Map<string, number>();
  for (let c = 1; c <= lastColumn; c += 1) {
    const text = cellText(at(headerRow, c)).trim().toLowerCase();
    if (text && !byText.has(text)) byText.set(text, c);
  }
  const found = new Map<string, number>();
  for (const [field, fieldAliases] of Object.entries(aliases)) {
    for (const alias of fieldAliases) {
      const col = byText.get(alias.trim().toLowerCase());
      if (col != null) {
        found.set(field, col);
        break;
      }
    }
  }
  return found;
}

/**
 * EVERY column matching one of `aliases`, in sheet order — where `findHeaderColumns` returns the one
 * winner, this returns the whole field of candidates. Sofico needs it: a file that carries two
 * generations of headers at once offers two columns for the same field, and which one holds the
 * numbers cannot be decided from the names alone.
 */
function headerColumnsMatching(headerRow: ExcelJS.Row, lastColumn: number, aliases: string[]): number[] {
  const wanted = new Set(aliases.map((alias) => alias.trim().toLowerCase()));
  const found: number[] = [];
  for (let c = 1; c <= lastColumn; c += 1) {
    const text = cellText(at(headerRow, c)).trim().toLowerCase();
    if (text && wanted.has(text)) found.push(c);
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
  const cols = findHeaderColumns(headerRow, lastColumn, DIRECT_HEADER_ALIASES);

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
  // The text cells this file could only be read by guessing — see "cells that could only be read by
  // guessing" above. Opened and closed around the SYNCHRONOUS adapter call only: every await (the
  // workbook loads) happens before it is opened, so no other upload can write into this file's log.
  const cellLog: CellReadLog = { ambiguousDates: [], dayFirstVotes: 0, monthFirstVotes: 0, unreadable: [] };
  try {
    if (canonicalCode === "PS") {
      const salesWb = input.salesBuffer ? await loadWorkbook(input.salesBuffer) : undefined;
      const stockWb = input.stockBuffer ? await loadWorkbook(input.stockBuffer) : undefined;
      activeCellLog = cellLog;
      try {
        adapted = adaptPS({ workbooks: [], distributorCode: canonicalCode, branchMapIndex, contract }, salesWb, stockWb);
      } finally {
        activeCellLog = null;
      }
    } else {
      if (!input.buffer) {
        return { ok: false, error: { code: "empty_file", message: "No workbook was provided." } };
      }
      const workbook = await loadWorkbook(input.buffer);
      const ctx: AdapterContext = { workbooks: [workbook], distributorCode: canonicalCode, branchMapIndex, contract };
      activeCellLog = cellLog;
      try {
        adapted =
          canonicalCode === "EG"
            ? adaptEG(ctx)
            : canonicalCode === "RM"
              ? adaptRM(ctx)
              : // IS-S (Sato Pharma) and IS-L (LACTO MISR EG) are the same Ibn Sina export for two
                // different suppliers — one adapter, two distributor codes so de-cumulation keeps
                // their cycles apart (distributors.ts).
                canonicalCode === "IS-S" || canonicalCode === "IS-L"
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
      } finally {
        activeCellLog = null;
      }
    }
  } catch (error) {
    return {
      ok: false,
      error: { code: "empty_file", message: error instanceof Error ? error.message : "Could not read the weekly workbook." },
    };
  }

  const blockingReasons = [...adapted.blockingReasons];

  // A quantity cell with two readings stops the upload and is named (P4-01).
  const unreadableNumbers = unreadableNumbersMessage(distributorName, cellLog.unreadable);
  if (unreadableNumbers) blockingReasons.push(unreadableNumbers);

  // A "05/10/2026" date is read the way the file's own unambiguous slash dates are written; with no
  // such proof it is left unread, so it can never pick the week on its own (P4-02).
  const dateResolution = resolveAmbiguousWeeklyDates(cellLog);
  for (const iso of dateResolution.resolved) adapted.sheetDates.add(iso);
  const unresolvedDates = dateResolution.unresolved;

  // ── what the file said about itself, against what we read ───────────────────────────────────
  // A `block` mismatch joins the blocking reasons and nothing persists; a `report` mismatch becomes an
  // advisory the operator sees before pressing Import. A format that states no total of its own is
  // recorded as such, so "nothing checked this" is visible instead of looking like a check that passed.
  const fileTotalChecks = adapted.fileTotalChecks ?? [];
  const fileTotals: WeeklyFileTotalsReport = {
    checks: fileTotalChecks,
    absence:
      fileTotalChecks.length > 0
        ? null
        : {
            reason:
              FILE_DECLARES_NO_TOTAL[canonicalCode] ??
              `${distributorName} states no total of its own in this export, so there is no figure the import can be checked against.`,
          },
  };
  const fileTotalAdvisories: string[] = [];
  for (const check of fileTotalChecks) {
    if (check.status !== "mismatch") continue;
    if (check.severity === "block") blockingReasons.push(fileTotalMessage(distributorName, check));
    else fileTotalAdvisories.push(fileTotalMessage(distributorName, check));
  }

  // ── date rule: exactly one distinct sheet date auto-uses it; else require periodDate ─────────
  const distinctDates = [...adapted.sheetDates].sort();
  const explicitPeriod = (input.periodDate ?? "").trim() || null;
  let weekStart: string | null;
  if (unresolvedDates.length > 0 && !explicitPeriod) {
    // The file's dates cannot be read without guessing the order, so none of them may choose the
    // week — not even the readable ones beside them, which could be a different week entirely.
    weekStart = null;
    const first = unresolvedDates[0];
    blockingReasons.push(
      `The file writes its date as "${first.cell.text}" (${first.cell.where}), which could be ` +
        `${spokenDate(first.dayFirst)} or ${spokenDate(first.monthFirst)}` +
        (unresolvedDates.length > 1 ? `, and ${unresolvedDates.length - 1} more date cell(s) read the same way` : "") +
        ". Provide the period date (YYYY-MM-DD) for this upload.",
    );
  } else if (unresolvedDates.length > 0) {
    // The operator named the period, which is the one reading that needs no guess.
    weekStart = explicitPeriod;
  } else if (distinctDates.length === 1) {
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
  const excludedBranches = new Map<
    string,
    { rawBranch: string; branchName: string; branchColumnIndex: number | null; items: Set<string>; tally: HeldOutTally }
  >();

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
        items: new Set<string>(),
        tally: emptyHeldOut(),
      };
      // An excluded depot spans the sales and stock sides; whichever landed first may have carried a
      // blank display name or no column index (same late-fill the real aggregate does).
      if (!entry.branchName && obs.rawBranchName) entry.branchName = obs.rawBranchName;
      if (entry.branchColumnIndex == null && obs.posColumnIndex != null) entry.branchColumnIndex = obs.posColumnIndex;
      // Which items the depot held out, keyed the way the IGNORE path keys an item, so the screen can tell
      // one product's units from several products' (units of different products are never added).
      entry.items.add(`${normalizeCode(obs.rawItemCode || "")}|${normalizeKey(obs.rawItemName || "")}`);
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
    fileTotals,
    advisories: fileTotalAdvisories,
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
        itemKeys: [...entry.items].sort(),
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

/** The rows' By region and By branch, still being added up. */
type GeographyTally = {
  regions: Map<string, { regionName: string; totals: WeeklyTotals }>;
  branches: Map<string, { branchName: string; regionCode: string; regionName: string; totals: WeeklyTotals }>;
};
const emptyGeography = (): GeographyTally => ({ regions: new Map(), branches: new Map() });

const addGeography = (tally: GeographyTally, row: WeeklyParsedRow) => {
  // Region/branch breakdowns are geographic — only rows with a resolved region/branch belong.
  // Rows with no resolved region (e.g. branchless stock fallbacks) stay in totals + by-product
  // but must not form a phantom "—" region/branch row.
  if (row.regionCode) {
    const region = tally.regions.get(row.regionCode) ?? { regionName: row.regionName || row.regionCode, totals: emptyTotals() };
    addTotals(region.totals, row);
    tally.regions.set(row.regionCode, region);
  }

  const branchKey = row.branchCode || row.branchName;
  if (branchKey) {
    const branch = tally.branches.get(branchKey) ?? { branchName: row.branchName || branchKey, regionCode: row.regionCode, regionName: row.regionName, totals: emptyTotals() };
    addTotals(branch.totals, row);
    tally.branches.set(branchKey, branch);
  }
};

const geographyTables = (tally: GeographyTally): Pick<WeeklySalesValidationResult, "byRegion" | "byBranch"> => ({
  byRegion: [...tally.regions.entries()]
    .map(([regionCode, entry]) => ({ regionCode, regionName: entry.regionName, ...round(entry.totals) }))
    .sort((left, right) => right.salesValue - left.salesValue),
  byBranch: [...tally.branches.entries()]
    .map(([branchCode, entry]) => ({ branchCode, branchName: entry.branchName, regionCode: entry.regionCode, regionName: entry.regionName, ...round(entry.totals) }))
    .sort((left, right) => right.salesValue - left.salesValue),
});

export function summarizeWeekly(input: {
  rows: WeeklyParsedRow[];
  distributor: { code: string; name: string };
  fileName: string;
  sheetName: string;
  weekStart: string | null;
  blockingReasons: string[];
  /** what the file declared about its own totals, and whether we read it that way */
  fileTotals?: WeeklyFileTotalsReport;
  /** non-blocking notes shown before Import — currently the `report`-severity file-total mismatches */
  advisories?: string[];
  excludedItems?: WeeklyExcludedItem[];
  excludedBranches?: WeeklyExcludedBranch[];
}): WeeklySalesValidationResult {
  const { rows } = input;
  const totals = emptyTotals();
  const geography = emptyGeography();
  const products = new Map<string, { productName: string; officialLine: string; totals: WeeklyTotals }>();
  // The same geography again, one product at a time: the only grain where a branch's or a region's units
  // mean anything once the sheet carries several products (see WeeklyProductGeography).
  const productGeography = new Map<string, GeographyTally>();
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

    addGeography(geography, row);

    const productKey = row.productCode || row.productName || "—";
    const product = products.get(productKey) ?? { productName: row.productName || productKey, officialLine: row.officialLine, totals: emptyTotals() };
    addTotals(product.totals, row);
    products.set(productKey, product);

    const ownGeography = productGeography.get(productKey) ?? emptyGeography();
    addGeography(ownGeography, row);
    productGeography.set(productKey, ownGeography);
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

  const { byRegion, byBranch } = geographyTables(geography);
  const byProduct = [...products.entries()]
    .map(([productCode, entry]) => ({ productCode, productName: entry.productName, officialLine: entry.officialLine, ...round(entry.totals) }))
    .sort((left, right) => right.salesValue - left.salesValue);

  return {
    distributor: { code: input.distributor.code, name: input.distributor.name },
    ...(input.advisories && input.advisories.length > 0 ? { advisories: input.advisories } : {}),
    ...(input.fileTotals ? { fileTotals: input.fileTotals } : {}),
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
    byRegion,
    byProduct,
    byBranch,
    byProductGeography: byProduct.map((product) => ({
      productCode: product.productCode,
      ...geographyTables(productGeography.get(product.productCode) ?? emptyGeography()),
    })),
    issues: issues.slice(0, 500),
    excludedItems: input.excludedItems ?? [],
    excludedBranches: input.excludedBranches ?? [],
  };
}
