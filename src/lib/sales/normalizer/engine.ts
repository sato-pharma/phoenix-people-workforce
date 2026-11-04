import ExcelJS from "exceljs";

import { HEADER_SCAN_ROWS, normalizeHeaderKey } from "@/lib/sales/normalizer/header-normalize";
import { needsAGuess, normalizeNumberText } from "@/lib/sales/normalizer/number-text";
import { secondLayoutProfile } from "@/lib/sales/normalizer/profiles";
import { deriveHierarchy, normalizeCodeKey, numericCanonicalKey, resolveBrick, resolveProduct } from "@/lib/sales/normalizer/resolvers";
import { IGNORE_PRODUCT_CODE, type CellCorrection, type CodedRow, type Crosswalks, type CustomerBrickCorrection, type DistributorProfile, type NormalizeException, type NormalizeIgnoredRow, type NormalizeResult } from "@/lib/sales/normalizer/types";

export type HeaderValidationFailure = { label: string; expected: string[] };
export type HeaderValidationResult = {
  valid: boolean;
  missingGroups: HeaderValidationFailure[];
  fingerprintWarning?: { likelyCode: string; likelyName: string };
};

// ── small self-contained parsers (kept local so the normalizer doesn't reach into the importer) ──

// Exported so the Phoenix-template detector reads a cell exactly the way the engine does — the
// template's Distributor Code column is a VLOOKUP formula, and the {formula} / {result} / richText
// cases below are precisely what a hand-rolled second reader gets wrong.
export function cellText(cell: ExcelJS.Cell | undefined): string {
  const v = cell?.value;
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    const o = v as unknown as Record<string, unknown>;
    if ("result" in o) return String(o.result ?? "");
    // ExcelJS DROPS the `result` key entirely when a formula's cached value is 0, so a zero-quantity
    // formula cell arrives as {formula} alone — no result to read. Falling through to String(v) turned
    // it into "[object Object]", which parseNum reads as NaN on a NON-EMPTY cell, so the row was
    // rejected as `unparseable_qty` and blocked the whole commit. Read it as an empty cell instead:
    // an empty quantity legitimately means zero (see the badQty guard). A formula that DID cache a
    // result — including an error object — still takes the branch above and keeps its old meaning.
    if ("formula" in o || "sharedFormula" in o) return "";
    if ("text" in o) return String(o.text ?? "");
    if ("richText" in o) return (o.richText as Array<{ text?: string }>).map((t) => t.text ?? "").join("");
    if ("hyperlink" in o) return String(o.text ?? o.hyperlink ?? "");
  }
  return String(v);
}

// A number cell as the engine reads it: its text, and whether Excel stores it as a NUMBER. Only text
// can be ambiguous — a number cell holding 1.234 is 1.234 however it prints, so it is never refused.
type NumberCell = { text: string; typed: boolean };

function isNumberCell(cell: ExcelJS.Cell): boolean {
  const v = cell.value;
  if (typeof v === "number") return true;
  return v != null && typeof v === "object" && "result" in v && typeof (v as { result?: unknown }).result === "number";
}

// Both readers take the cell through normalizeNumberText first, so a number written in a form with one
// meaning only (Arabic-Indic digits, space-grouped thousands, "1.234,56") is read instead of refusing
// the file. A TEXT quantity or value that could only be read by guessing ("1.234": 1.234 or 1234?
// "12,5": 12.5 or 125?) is NaN, so its row is refused and named. This used to strip every comma blind,
// which read "1.234,56" as 1.23456 and "12,5" as 125 with nothing said (owner, 2026-09-18).
function parseNum(cell: NumberCell, emptyAsZero = false): number {
  const written = normalizeNumberText(cell.text);
  if (!written) return emptyAsZero ? 0 : Number.NaN;
  if (!cell.typed && needsAGuess(written)) return Number.NaN;
  const n = Number(written.replace(/,/g, ""));
  return Number.isFinite(n) ? n : Number.NaN;
}

/**
 * Discount as a fraction, or NaN when the cell is present but cannot be trusted.
 *
 * NaN (not a clamp) is the point. This used to end in
 *     return Math.min(1, Math.max(0, fraction));
 * so a "150" typo became a 100% discount, `value = qty x price x (1 - 1)` = 0, and the sale silently
 * vanished. It also made upload-validation's `discount_out_of_range` check unreachable — nothing
 * out-of-range ever survived the clamp to be validated. The caller now raises an exception instead,
 * so a bad cell is reviewed rather than quietly zeroing revenue.
 */
function discountFrac(value: unknown): number {
  const written = normalizeNumberText(String(value ?? ""));
  const text = written.replace(/%/g, "").replace(/,/g, "").trim();
  if (!text) return 0; // an empty cell genuinely means "no discount"
  const n = Number(text);
  if (!Number.isFinite(n)) return Number.NaN; // present but unreadable
  if (n === 0) return 0;
  // Convention: a cell written with a "%" sign, or a number above 1, is a percentage; a bare number up
  // to 1 is already a fraction. The sign settles it: "1%" is 1%, where it used to be refused as 100%
  // (production on 2026-09-18 held no discount cell written with a "%" at all, so this re-reads none).
  const fraction = written.includes("%") || Math.abs(n) > 1 ? n / 100 : n;
  // >= 1 is rejected rather than applied. A bare "1" is genuinely ambiguous under the convention
  // above — 1% or 100%? — and reading it as 100% zeroes the row. Anything that would
  // wipe out a sale should be reviewed, not guessed at. Production carries no discount at or above
  // 1 today (all 55 non-zero values are 0.01–0.08 on 2026-09-18), so this rejects nothing that exists.
  if (fraction < 0 || fraction >= 1) return Number.NaN;
  return fraction;
}

/**
 * A date cell formatted as General reaches the engine as its Excel serial day: Sofico's BILLINGDATE
 * arrives as "46247", which is 13 Aug 2026 (days since 30 Dec 1899 — the importer's own
 * excelSerialToDate in monthly-distributor-import.ts). Read as text, JavaScript takes it for the year
 * 46247, so every Sofico row landed in its own impossible month and the uploader had to pick the
 * month by hand.
 *
 * ONLY A FIVE-DIGIT WHOLE NUMBER is a serial (10000–99999 spans 1927–2173). mec's date column is the
 * month "شهر" ("202607", six digits): as a serial that would be the year 2454, and it is not a day at
 * all, so it is left alone. Measured on production 2026-09-18, these are the only all-digit date
 * values any distributor has sent: Sofico 46235–46265 (166 rows) and mec 202607–202609 (13 rows).
 *
 * Both periodFrom and dateFrom read the serial through this one helper, so the month and the day
 * cannot disagree.
 */
function excelSerialParts(text: string): { y: number; m: number; d: number } | null {
  if (!/^\d{5}$/.test(text)) return null;
  const date = new Date(Date.UTC(1899, 11, 30) + Number(text) * 86_400_000);
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
}

// Timezone-safe YYYY-MM. dayFirst disambiguates DD-MM-YYYY vs MM-DD-YYYY when both parts are <= 12
// (e.g. "08-04-2026" is 8 April in DD-MM, but August in MM-DD). The caller detects the column's
// orientation from values that can't be ambiguous (a part > 12) — see detectDayFirst.
//
// A SIX-DIGIT WHOLE NUMBER is a month written YYYYMM: mec's date column is its month "شهر" ("202607"),
// per the Headers Mapping, and JavaScript read it as the YEAR 202607 ("202607-01"). It is read as
// 2026-07 now, by the owner's decision on 2026-09-18 — "شهر" decides a mec row's month, even though it
// is NOT the invoice's calendar month: on production, invoices dated the 25th or later already carry
// the NEXT month (25 Jul → 202608; 25–31 Aug → 202609 — 5 of 13 rows), so a mec file spanning that
// cut-off resolves to two months. It carries no day, so dateFrom still answers null for it.
function periodFrom(value: unknown, dayFirst?: boolean): string | null {
  const ym = (y: number, m: number) => (Number.isInteger(y) && y >= 1900 && m >= 1 && m <= 12 ? `${y}-${String(m).padStart(2, "0")}` : null);
  if (value instanceof Date) return ym(value.getUTCFullYear(), value.getUTCMonth() + 1);
  const text = String(value ?? "").trim();
  if (!text) return null;
  const serial = excelSerialParts(text);
  if (serial) return ym(serial.y, serial.m);
  const yyyymm = text.match(/^(\d{4})(\d{2})$/);
  if (yyyymm) return ym(Number(yyyymm[1]), Number(yyyymm[2]));
  const iso = text.match(/^(\d{4})[-/.](\d{1,2})/);
  if (iso) return ym(Number(iso[1]), Number(iso[2]));
  const dmy = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (dmy) {
    const a = Number(dmy[1]); const b = Number(dmy[2]); let y = Number(dmy[3]); if (y < 100) y += 2000;
    let month: number;
    if (dayFirst === true) month = b >= 1 && b <= 12 ? b : a;        // DD-MM-YYYY: month is the 2nd part
    else if (dayFirst === false) month = a >= 1 && a <= 12 ? a : b;  // MM-DD-YYYY: month is the 1st part
    else month = a > 12 && b <= 12 ? b : a;                          // unknown column: legacy best-guess
    return ym(y, month);
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : ym(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1);
}

/**
 * Timezone-safe YYYY-MM-DD — the invoice's REAL date, not just its month.
 *
 * periodFrom above keeps only the month, and for a long time that was all this path persisted:
 * `invoice_date` went in as null on every normalizer import, so 96% of production rows carry no
 * date at all and the closing's Data sheet prints an empty Invoice Date column. It also cost a
 * week of wrong numbers — a distributor folder labelled April held May's invoices, and with the
 * real dates stored that would have been visible the moment it landed rather than after an audit.
 *
 * Day/month disambiguation is deliberately identical to periodFrom: the two must never disagree
 * about which month a row belongs to.
 *
 * THE YEAR IS CAPPED AT 9999 — the importer's own bound (isoFromYmd in monthly-distributor-import.ts).
 * A cell holding only digits reaches the `new Date(text)` fallback below, and JavaScript reads a bare
 * number as a YEAR: mec's date column is the month "شهر" ("202607") and was stored as 202607-01-01
 * (13 rows on production, 2026-09-18). A month is not a day, so the answer is null — "the sheet
 * carries no date" — never an impossible year; periodFrom reads it as the month. Sofico's BILLINGDATE
 * serial ("46247") was stored the same way (46247-01-01, 166 rows); it is now read as the real day it
 * is, by excelSerialParts above.
 */
function dateFrom(value: unknown, dayFirst?: boolean): string | null {
  const ymd = (y: number, m: number, d: number) =>
    (Number.isInteger(y) && y >= 1900 && y <= 9999 && m >= 1 && m <= 12 && d >= 1 && d <= 31
      ? `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`
      : null);
  if (value instanceof Date) return ymd(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  const text = String(value ?? "").trim();
  if (!text) return null;
  const serial = excelSerialParts(text);
  if (serial) return ymd(serial.y, serial.m, serial.d);
  const iso = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (iso) return ymd(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const dmy = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (dmy) {
    const a = Number(dmy[1]); const b = Number(dmy[2]); let y = Number(dmy[3]); if (y < 100) y += 2000;
    let month: number;
    let day: number;
    if (dayFirst === true) { month = b >= 1 && b <= 12 ? b : a; day = month === b ? a : b; }
    else if (dayFirst === false) { month = a >= 1 && a <= 12 ? a : b; day = month === a ? b : a; }
    else if (a > 12 && b <= 12) { month = b; day = a; }
    else { month = a; day = b; }
    return ymd(y, month, day);
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime())
    ? null
    : ymd(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, parsed.getUTCDate());
}

// Decide if a sheet's date column is day-first (DD-MM) or month-first (MM-DD) by scanning its values.
// A value whose FIRST part is > 12 can only be a day -> DD-MM (decisive). A value whose SECOND part is
// > 12 (first <= 12) can only be a day there -> MM-DD. undefined when every value is ambiguous.
function detectDayFirst(sheet: ExcelJS.Worksheet, header: HeaderMap, dateColumns: string[] | undefined): boolean | undefined {
  let sawMonthFirst = false;
  for (let r = header.headerRow + 1; r <= sheet.rowCount; r += 1) {
    const m = firstValue(sheet.getRow(r), header, dateColumns).match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
    if (!m) continue;
    if (Number(m[1]) > 12) return true;          // first part is a day -> day-first (decisive)
    if (Number(m[2]) > 12) sawMonthFirst = true; // second part is a day -> month-first
  }
  return sawMonthFirst ? false : undefined;
}

// ── header map ──

type HeaderMap = { col: Map<string, number>; headerRow: number };

// All header names this profile expects, normalized via the shared header key. Shared by buildHeaderMap
// (skip banner/title rows) and pickBestSheet (choose the right worksheet).
export function knownHeaderKeys(profile?: DistributorProfile): Set<string> {
  const known = new Set<string>();
  for (const name of [
    ...(profile?.productColumns ?? []),
    ...(profile?.qtyColumns ?? []),
    ...(profile?.dateColumns ?? []),
    ...(profile?.valueColumns ?? []),
    ...(profile?.customerCodeColumns ?? []),
    ...(profile?.customerNameColumns ?? []),
    ...(profile?.territoryColumns ?? []),
    ...(profile?.brickIdColumns ?? []),
  ]) {
    const key = normalizeHeaderKey(name);
    if (key) known.add(key);
  }
  return known;
}

export function buildHeaderMap(sheet: ExcelJS.Worksheet, profile?: DistributorProfile): HeaderMap {
  // Header names this distributor's profile expects — used to skip banner/title rows. e.g. the IS-S
  // "Monthly Sales by Client for SATO PHARMA (PAS)" report puts a merged title in row 1 and the real
  // header in row 2; without this the title row (>=3 filled cells) wins and nothing maps.
  const known = knownHeaderKeys(profile);

  const readRow = (r: number): Map<string, number> => {
    const col = new Map<string, number>();
    sheet.getRow(r).eachCell({ includeEmpty: false }, (cell, c) => {
      const key = normalizeHeaderKey(cellText(cell));
      if (key && !col.has(key)) col.set(key, c);
    });
    return col;
  };

  // Score the first HEADER_SCAN_ROWS rows by how many KNOWN profile headers each carries. The real
  // header row carries several; a banner/title row carries none (IS-S "Monthly Sales by Client…").
  // Critically, a sparse metadata row with a single stray cell that happens to equal a column name (e.g.
  // "Name", "Column1", "qty") must NOT win, so we require >=2 known hits and pick the row with the MOST
  // (earliest on a tie).
  let best: { col: Map<string, number>; headerRow: number; hits: number } | null = null;
  let firstKnown: HeaderMap | null = null;
  let fallback: HeaderMap | null = null;
  for (let r = 1; r <= Math.min(sheet.rowCount, HEADER_SCAN_ROWS); r += 1) {
    const col = readRow(r);
    if (!fallback && col.size >= 3) fallback = { col, headerRow: r };
    if (known.size === 0) {
      if (col.size >= 3) return { col, headerRow: r };
      continue;
    }
    let hits = 0;
    for (const key of col.keys()) if (known.has(key)) hits += 1;
    if (hits > 0 && !firstKnown) firstKnown = { col, headerRow: r };
    if (hits >= 2 && (!best || hits > best.hits)) best = { col, headerRow: r, hits };
  }
  // Prefer the richest known-header row; else the first row carrying any known header (covers a profile
  // whose real header legitimately exposes only one known column); else the legacy ">=3 filled cells" row.
  if (best) return { col: best.col, headerRow: best.headerRow };
  if (firstKnown) return firstKnown;
  return fallback ?? { col: readRow(1), headerRow: 1 };
}

// STRICT pre-flight header validation ("no deviation"): the sheet must carry the selected
// distributor's CANONICAL required columns (Headers Mapping) — brick-lookup key, product NAME, qty,
// and date when the channel is dated — matched exactly (case/trim only, no alias fallback). A
// missing or renamed required column is rejected, naming the exact expected header. EXTRA/unmapped
// columns are ignored (not blocking). Also detects a wrong-distributor upload via fingerprint score.
export function validateSheetHeaders(
  sheet: ExcelJS.Worksheet,
  profile: DistributorProfile,
  allProfiles: DistributorProfile[],
  options?: { monthPicked?: boolean },
): HeaderValidationResult {
  const header = buildHeaderMap(sheet, profile);
  const found = new Set(header.col.keys()); // already lowercase-trimmed by buildHeaderMap

  // A required field passes only when its canonical header(s) are present exactly; else it fails and
  // reports the exact header(s) the distributor must use (so a renamed column is named precisely).
  const check = (label: string, cols: string[] | undefined): HeaderValidationFailure | null => {
    if (!cols || cols.length === 0) return null; // field not required for this distributor
    if (cols.some((c) => found.has(normalizeHeaderKey(c)))) return null;
    return { label, expected: cols };
  };
  // Product is keyed by NAME (owner rule: name-first); the code column is an optional fallback.
  const productNameCols = profile.productNameColumns?.length ? profile.productNameColumns : profile.productColumns;
  // Brick-lookup key: customer code for most distributors, area/territory name for CP, or a direct brick id.
  const locationCols = [
    ...(profile.customerCodeColumns ?? []),
    ...(profile.territoryColumns ?? []),
    ...(profile.brickIdColumns ?? []),
  ];
  const missingGroups = [
    check("Product name",        productNameCols),
    check("Quantity",            profile.qtyColumns),
    // A sheet that carries no date at all is taken only when the person picked its month on screen
    // (an EGD 2024 summary, owner 2026-10-26); without one the month is unknown, so it is refused.
    options?.monthPicked ? null : check("Date", profile.dateColumns),
    check("Customer code / Area", locationCols.length > 0 ? locationCols : undefined),
  ].filter((g): g is HeaderValidationFailure => g !== null);

  // Fingerprint scoring: find the profile whose signature columns best match the sheet.
  // If another distributor scores higher than ours, warn the user.
  const score = (p: DistributorProfile) =>
    (p.fingerprintColumns ?? []).filter((c) => found.has(normalizeHeaderKey(c))).length;
  const myScore = score(profile);
  let bestOther: DistributorProfile | null = null;
  let bestScore = 0;
  for (const p of allProfiles) {
    if (p.distributorCode === profile.distributorCode) continue;
    const s = score(p);
    if (s > bestScore && s > myScore) { bestScore = s; bestOther = p; }
  }

  return {
    valid: missingGroups.length === 0,
    missingGroups,
    fingerprintWarning: bestOther
      ? { likelyCode: bestOther.distributorCode, likelyName: bestOther.distributorName }
      : undefined,
  };
}

/** Whether the sheet carries any of the profile's date columns. A profile with none never does. */
export function sheetCarriesDate(sheet: ExcelJS.Worksheet, profile: DistributorProfile): boolean {
  const found = buildHeaderMap(sheet, profile).col;
  return (profile.dateColumns ?? []).some((c) => found.has(normalizeHeaderKey(c)));
}

// The raw (un-normalized) cell texts of the chosen header row — used to show the operator (and the AI
// explainer) the column TITLES the file actually has. Header text only; never reads data rows.
export function headerRowTexts(sheet: ExcelJS.Worksheet, profile?: DistributorProfile): string[] {
  const header = buildHeaderMap(sheet, profile);
  const texts: string[] = [];
  sheet.getRow(header.headerRow).eachCell({ includeEmpty: false }, (cell) => {
    const text = cellText(cell).trim();
    if (text) texts.push(text);
  });
  return texts;
}

/**
 * The file's own column headings, by column index — read once per sheet.
 *
 * HeaderMap.col is keyed by a NORMALIZED heading (lowercased, trimmed), which is right for lookup
 * and useless for provenance: it cannot tell you the file said "ADDRESSSHIP" rather than "Address".
 * These are the headings verbatim, so a stored row can be read back and compared against what a
 * profile expects.
 *
 * EVERY heading is captured, not just the ones the profile maps. A column nobody mapped is exactly
 * the column you need to see when a field arrives empty and the question is whether the distributor
 * ever sent it.
 */
function sourceColumnLabels(sheet: ExcelJS.Worksheet, map: HeaderMap): Map<number, string> {
  const labels = new Map<number, string>();
  sheet.getRow(map.headerRow).eachCell({ includeEmpty: false }, (cell, c) => {
    const label = cellText(cell).trim();
    if (label) labels.set(c, label);
  });
  return labels;
}

/** One source row, keyed by the file's own headings. Empty cells are dropped, not stored as "". */
function rawSourceRow(row: ExcelJS.Row, labels: Map<number, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [column, label] of labels) {
    const text = cellText(row.getCell(column)).trim();
    if (text) out[label] = text;
  }
  return out;
}

function firstCell(row: ExcelJS.Row, map: HeaderMap, columns: string[] | undefined): NumberCell {
  for (const name of columns ?? []) {
    const c = map.col.get(normalizeHeaderKey(name));
    if (c) {
      const cell = row.getCell(c);
      const text = cellText(cell).trim();
      if (text) return { text, typed: isNumberCell(cell) };
    }
  }
  return { text: "", typed: false };
}

function firstValue(row: ExcelJS.Row, map: HeaderMap, columns: string[] | undefined): string {
  return firstCell(row, map, columns).text;
}

// ── engine ──

export type NormalizeRowsOptions = {
  /**
   * Which sheet rows to read, by 1-based row number. Only the Phoenix universal template passes one:
   * a file naming several distributors is normalized once per distributor, over that distributor's
   * own rows, so each becomes its own batch. Left out, every row is read — as always.
   */
  includeRow?: (rowNumber: number) => boolean;
  /**
   * The month every row is filed under when the sheet has NO date column — the month the person
   * picked on the Source Normalizer for a date-less sheet ("YYYY-MM"). Only recognize.ts passes it,
   * and only after it found the sheet carries none of the profile's date columns, so a dated row
   * never has its own month overwritten.
   */
  undatedPeriod?: string;
};

export function normalizeRows(
  sheet: ExcelJS.Worksheet,
  profile: DistributorProfile,
  maps: Crosswalks,
  options?: NormalizeRowsOptions,
): NormalizeResult {
  const header = buildHeaderMap(sheet, profile);
  // Read once per sheet, not once per row: the header row does not change while we walk the data.
  const columnLabels = sourceColumnLabels(sheet, header);
  // Honour explicit per-distributor date format; only auto-detect when not set.
  // All Egyptian distributors are DD-MM-YYYY so auto-detection is unnecessary and can mis-parse
  // a month where every day-value is <= 12 (e.g. early-month data → month-first mis-read).
  const dayFirst = profile.dateFormat === "day-first" ? true
    : profile.dateFormat === "month-first" ? false
    : detectDayFirst(sheet, header, profile.dateColumns);
  const coded: CodedRow[] = [];
  const exceptions: NormalizeException[] = [];
  let productResolved = 0;
  let brickResolved = 0;
  let ignored = 0;
  const ignoredRows: NormalizeIgnoredRow[] = [];
  let blankCustomerSkipped = 0;
  const blankCustomerRows: NormalizeIgnoredRow[] = [];
  let scannedDataRows = 0;
  // Keyed by the same customerKey the resolver uses — last row for a given customer in this sheet
  // wins, so one file never produces two conflicting corrections for the same customer.
  const customerBrickCorrections = new Map<string, CustomerBrickCorrection>();
  const cellCorrections: CellCorrection[] = [];

  for (let r = header.headerRow + 1; r <= sheet.rowCount; r += 1) {
    if (options?.includeRow && !options.includeRow(r)) continue;
    const row = sheet.getRow(r);
    // skip fully-empty rows
    let any = false;
    row.eachCell({ includeEmpty: false }, () => { any = true; });
    if (!any) continue;
    // Count every non-empty data row exactly once, before it is routed to a bucket — the independent
    // physical tally the validator reconciles against (no-silent-loss guard).
    scannedDataRows += 1;

    const rawProduct = profile.productColumns.map((cName) => firstValue(row, header, [cName])).find(Boolean) ?? "";
    const productValues = profile.productColumns.map((cName) => firstValue(row, header, [cName]));
    const productCode = resolveProduct(productValues, maps, profile.distributorCode);

    // "We don't sell this" — the item is explicitly mapped to ignore: drop the row from coding
    // but record it so the import surface can tell the user exactly how many units were excluded.
    if (productCode === IGNORE_PRODUCT_CODE) {
      ignored += 1;
      const ignoredQty = parseNum(firstCell(row, header, profile.qtyColumns));
      ignoredRows.push({
        rawProduct,
        rawProductName: productValues.slice(1).find(Boolean) ?? "",
        rawRowNumber: r,
        qty: Number.isFinite(ignoredQty) ? ignoredQty : 0,
        reason: "ignore_mapped",
      });
      continue;
    }

    // Bonus/free-goods flag: skip rows marked as bonus deliveries.
    // These are free-goods shipments, not real sales — counting them inflates the numbers. The WHOLE
    // row goes, so a profile may list only a flag column here, never a bonus count that sits beside
    // paid units (see DistributorProfile.bonusColumns).
    //
    // The row's OWN units and its resolved product are recorded on the way out. They are never sales
    // and never reach a coded row — they exist so the Validate screen can say, under that product,
    // how many units the file carried that this rule excluded. Recording 0 here (what it did before
    // 2026-10-09) is what made an EPDA-BULK sheet of 6,736 Ivyronc packs validate at 5,214 with no
    // trace of the other 1,522 anywhere on the screen.
    if (profile.bonusColumns?.length) {
      const flag = firstValue(row, header, profile.bonusColumns);
      if (flag && flag !== "0" && flag.toLowerCase() !== "false") {
        ignored += 1;
        const freeGoodsQty = parseNum(firstCell(row, header, profile.qtyColumns));
        const freeGoodsProduct = productCode ? maps.productByCode.get(productCode) : undefined;
        ignoredRows.push({
          rawProduct,
          rawProductName: productValues.slice(1).find(Boolean) ?? "",
          rawRowNumber: r,
          qty: Number.isFinite(freeGoodsQty) ? freeGoodsQty : 0,
          reason: "bonus",
          productCode: productCode || undefined,
          productName: freeGoodsProduct?.productName,
          officialLine: freeGoodsProduct?.line,
        });
        continue;
      }
    }

    // Customer key: the code column, falling back to the NAME when the code is blank and the profile
    // opts in (El Qema — owner 2026-10-05, "map by id if not available fall back to name"). The name
    // then feeds everything below exactly as a code would: the crosswalk lookup, the self-heal check,
    // and the exception's rawCustomerCode (so an unmapped name is a mappable customer unknown, not a
    // silently-dropped footer). A row with neither a code nor a name stays a blank-customer footer.
    let customerCode = firstValue(row, header, profile.customerCodeColumns);
    if (!customerCode && profile.customerKeyNameFallback) {
      customerCode = firstValue(row, header, profile.customerNameColumns);
    }
    const distKey = normalizeCodeKey(profile.distributorCode);
    const customerKey = customerCode ? `${distKey} ${normalizeCodeKey(customerCode)}` : null;
    const customerCanon = customerCode ? numericCanonicalKey(customerCode) : null;
    const customerCanonicalKey = customerCanon ? `${distKey} ${customerCanon}` : null;
    const territoryValues = (profile.territoryColumns ?? []).map((cName) => firstValue(row, header, [cName]));
    const brickIdValues = (profile.brickIdColumns ?? []).map((cName) => firstValue(row, header, [cName]));
    // Every address column, in order: Ibn Sina sends Address_En then Address_Ar, and the matcher reads the Arabic one.
    const addressValues = (profile.customerAddressColumns ?? []).map((cName) => firstValue(row, header, [cName]));
    const brick = resolveBrick({ addressValues, brickIdValues, customerKey, customerCanonicalKey, distributorCode: profile.distributorCode, territoryValues }, maps);
    const hierarchy = deriveHierarchy(brick, maps);

    if (productCode) productResolved += 1;
    if (hierarchy) brickResolved += 1;

    // Self-heal detection: the sheet itself just told us this customer's brick (direct id or
    // territory/brick-name text) — never via the stored crosswalk. If that disagrees with (or is
    // absent from) the stored customer->brick map, queue a correction so the crosswalk catches up.
    if (brick && brick.source !== "customer" && brick.brickId && customerKey) {
      const stored = maps.customerBrickByKey.get(customerKey)
        ?? (customerCanonicalKey ? maps.customerBrickByCanonicalKey.get(customerCanonicalKey) : undefined);
      if (stored !== brick.brickId) {
        customerBrickCorrections.set(customerKey, {
          distributorCode: profile.distributorCode,
          customerCode,
          brickId: brick.brickId,
          previousBrickId: stored ?? null,
          source: brick.source === "address" ? "address" : "sheet",
        });
      }
    }

    if (!productCode || !hierarchy) {
      // Blank-customer check: no location data at all (no code, territory, or brick ID).
      // This is a summary/footer row for most distributors but a hard data error for EG-BR.
      const hasAnyLocation = !!(customerCode || territoryValues.find(Boolean) || brickIdValues.find(Boolean));
      if (!hierarchy && !hasAnyLocation) {
        if (profile.blankCustomerBehavior === "error") {
          exceptions.push({
            rawProduct,
            rawProductName: productValues.slice(1).find(Boolean) ?? "",
            rawTerritory: "",
            rawCustomerCode: "",
            rawCustomerName: firstValue(row, header, profile.customerNameColumns),
            rawCustomerAddress: firstValue(row, header, profile.customerAddressColumns),
            rawRowNumber: r,
            reason: "blank_customer",
          });
        } else {
          blankCustomerSkipped += 1;
          const skippedQty = parseNum(firstCell(row, header, profile.qtyColumns));
          blankCustomerRows.push({
            rawProduct,
            rawProductName: productValues.slice(1).find(Boolean) ?? "",
            rawRowNumber: r,
            qty: Number.isFinite(skippedQty) ? skippedQty : 0,
          });
        }
        continue;
      }
      exceptions.push({
        rawProduct,
        rawProductName: productValues.slice(1).find(Boolean) ?? "",
        rawTerritory: territoryValues.find(Boolean) ?? "",
        rawCustomerCode: customerCode,
        rawCustomerName: firstValue(row, header, profile.customerNameColumns),
        rawCustomerAddress: firstValue(row, header, profile.customerAddressColumns),
        rawRowNumber: r,
        reason: !productCode && !hierarchy ? "both" : !productCode ? "product" : "brick",
      });
      continue;
    }

    const product = maps.productByCode.get(productCode);
    const qtyCell = firstCell(row, header, profile.qtyColumns);
    const valueCell = firstCell(row, header, profile.valueColumns);
    const qtyRaw = qtyCell.text;
    const valueRaw = valueCell.text;
    const discountRaw = firstValue(row, header, profile.discountColumns);
    const qty = parseNum(qtyCell);
    const bonusQty = 0;
    const discount = discountFrac(discountRaw);
    const sheetValue = parseNum(valueCell, true);
    // The month this row is invoiced in — what it is stored under, and so the month whose price values it.
    const rowPeriod = periodFrom(firstValue(row, header, profile.dateColumns), dayFirst) ?? options?.undatedPeriod ?? null;
    // Units times the factory price, full stop — the discount factor came out on 2026-09-07 by the
    // owner's instruction. `discount` is still parsed and still stored on the row; it just no longer
    // multiplies anything. The price is the one OF THE ROW'S MONTH, never the master's flat price: the
    // closing prices every month through phx_factory_price(code, period), and Saginko is 111.15 through
    // 2026-09 and 170.52 from 2026-10 while the master stays 111.15 (see Crosswalks.prices).
    const value = profile.valueSource === "sheet"
      ? sheetValue
      : (Number.isFinite(qty)
        ? qty * (product ? (maps.prices?.priceFor(productCode, rowPeriod) ?? product.factoryPrice) : 0)
        : 0);

    // A cell the parser cannot read must NOT become a zero.
    //
    // qty and value were written as `Number.isFinite(x) ? x : 0`, so "1,2OO" (letter O), an Arabic-
    // Indic numeral or "n/a" silently became 0 on the path that carries 99.6% of production rows — the
    // sale vanished from every total with nothing to review. (A European "1.234,56" never failed to
    // parse at all: the commas were stripped blind and it was read as 1.23456. parseNum now reads it
    // as 1234.56 and refuses a text "1.234" or "12,5", which it would have to guess at.) parseNum
    // returns NaN for an EMPTY cell too, and an empty quantity legitimately means zero, so only a
    // NON-EMPTY cell that fails to parse is an error.
    const nonEmpty = (raw: unknown) => String(raw ?? "").trim() !== "";
    const badQty = !Number.isFinite(qty) && nonEmpty(qtyRaw);
    const badValue = profile.valueSource === "sheet" && !Number.isFinite(sheetValue) && nonEmpty(valueRaw);
    // discountFrac returns NaN when the cell is present but out of range. It used to clamp silently
    // into [0,1], which both hid the typo and let a "150" become a 100% discount that zeroed the row
    // — and made upload-validation's discount_out_of_range check unreachable, because nothing
    // out-of-range ever survived to be validated.
    const badDiscount = !Number.isFinite(discount) && nonEmpty(discountRaw);
    // The cell exactly as written, so the refusal can say what is wrong in this row.
    const rawCell = badQty ? qtyRaw : badValue ? valueRaw : discountRaw;

    if (badQty || badValue || badDiscount) {
      exceptions.push({
        rawProduct,
        rawProductName: productValues.slice(1).find(Boolean) ?? "",
        rawTerritory: territoryValues.find(Boolean) ?? "",
        rawCustomerCode: customerCode,
        rawCustomerName: firstValue(row, header, profile.customerNameColumns),
        rawCustomerAddress: firstValue(row, header, profile.customerAddressColumns),
        rawRowNumber: r,
        reason: badQty ? "unparseable_qty" : badValue ? "unparseable_value" : "discount_out_of_range",
        rawCell,
      });
      continue;
    }

    // A cell read only because normalizeNumberText rewrote it is listed, so the upload says what it read.
    const noteCorrection = (field: CellCorrection["field"], raw: string, read: number) => {
      if (normalizeNumberText(raw) !== raw.trim()) cellCorrections.push({ rawRowNumber: r, field, raw: raw.trim(), read });
    };
    noteCorrection("quantity", qtyRaw, qty);
    if (profile.valueSource === "sheet") noteCorrection("value", valueRaw, sheetValue);
    noteCorrection("discount", discountRaw, discount);

    coded.push({
      areaCode: hierarchy.areaCode,
      areaName: hierarchy.areaName,
      brickId: hierarchy.brickId,
      brickName: hierarchy.brickName,
      bonusQty: Number.isFinite(bonusQty) ? bonusQty : 0,
      clientAddress: firstValue(row, header, profile.customerAddressColumns) || null,
      clientCode: customerCode || null,
      clientName: firstValue(row, header, profile.customerNameColumns) || null,
      discount,
      distributorCode: profile.distributorCode,
      invoiceDate: rowPeriod ?? "",
      // The exact date the sheet carries, kept alongside the month so a mislabelled file is visible
      // in the data rather than only after someone reconciles it against the source workbook.
      invoiceDay: dateFrom(firstValue(row, header, profile.dateColumns), dayFirst),
      invoiceNumber: null,
      isDirect: profile.valueSource === "sheet",
      officialLine: product?.line || "Unknown",
      productCode,
      productName: product?.productName ?? productCode,
      qty: Number.isFinite(qty) ? qty : 0,
      rawRow: rawSourceRow(row, columnLabels),
      rawRowNumber: r,
      regionCode: hierarchy.regionCode,
      regionName: hierarchy.regionName,
      value: Number.isFinite(value) ? value : 0,
    });
  }

  return {
    coded,
    distributorCode: profile.distributorCode,
    exceptions,
    ignoredRows,
    blankCustomerRows,
    customerBrickCorrections: [...customerBrickCorrections.values()],
    cellCorrections,
    summary: { brickResolved, blankCustomerSkipped, fullyCoded: coded.length, ignored, productResolved, totalRows: coded.length + exceptions.length + ignored + blankCustomerSkipped, scannedDataRows },
  };
}

// Choose the worksheet that actually carries this distributor's data. Many exports lead with a cover /
// summary / pivot sheet and put the real rows on a later tab; the old "worksheets[0]" assumption then
// read the wrong sheet. We score each sheet by how many KNOWN profile headers its best header row
// carries (via buildHeaderMap) and pick the richest; ties keep the earliest sheet. With no profile
// knowledge we fall back to the widest header row, and to the first sheet when nothing qualifies.
export function pickBestSheet(workbook: ExcelJS.Workbook, profile?: DistributorProfile): ExcelJS.Worksheet | undefined {
  const sheets = workbook.worksheets.filter((ws) => ws && ws.rowCount > 0 && ws.columnCount > 0);
  if (sheets.length <= 1) return sheets[0] ?? workbook.worksheets[0];
  const known = knownHeaderKeys(profile);
  let best = sheets[0];
  let bestHits = -1;
  for (const ws of sheets) {
    const header = buildHeaderMap(ws, profile);
    let hits = 0;
    if (known.size > 0) { for (const key of header.col.keys()) if (known.has(key)) hits += 1; }
    else hits = header.col.size; // no profile: prefer the widest header row
    if (hits > bestHits) { bestHits = hits; best = ws; }
  }
  return best;
}

/**
 * The layout a workbook actually wears, for a distributor that has a second template. The old layout
 * keeps its place when the sheet carries it, and the second is taken only when the sheet carries all
 * of its required columns, so a sheet that fits neither is still refused against the old template.
 */
export function profileForWorkbook(workbook: ExcelJS.Workbook, profile: DistributorProfile): DistributorProfile {
  const second = secondLayoutProfile(profile.distributorCode);
  if (!second) return profile;
  const sheet = pickBestSheet(workbook, second);
  if (!sheet || validateSheetHeaders(sheet, profile, []).valid) return profile;
  return validateSheetHeaders(sheet, second, []).valid ? second : profile;
}

export async function normalizeRawWorkbook(
  buffer: ArrayBuffer | Buffer,
  profile: DistributorProfile,
  maps: Crosswalks,
): Promise<NormalizeResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const sheet = pickBestSheet(workbook, profile);
  if (!sheet) {
    return { coded: [], distributorCode: profile.distributorCode, exceptions: [], ignoredRows: [], blankCustomerRows: [], customerBrickCorrections: [], summary: { brickResolved: 0, blankCustomerSkipped: 0, fullyCoded: 0, ignored: 0, productResolved: 0, totalRows: 0, scannedDataRows: 0 } };
  }
  return normalizeRows(sheet, profile, maps);
}
