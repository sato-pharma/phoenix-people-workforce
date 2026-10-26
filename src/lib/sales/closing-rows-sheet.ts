// THE ROWS TAB — every counted row of a closing, at invoice grain, with its full data.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Owner, 2026-10-13: "put the Rows tab in the premium closing download and in the ranking … I want
// the raw detailed sheet to be in the export rep ranking in monthly closing."
//
// Every other tab in both workbooks is an AGGREGATE — area x product, seat, district, month. This
// one is the layer underneath: one line per imported invoice row, so the matrix above it can be
// re-added by hand. Until now that layer existed only on the Details screen, which has no download,
// and the premium engine's own `Data` sheet is one row per area x product, not per invoice.
//
// 🔴 IT COUNTS WHAT THE CLOSING COUNTS, AND THE TOTAL IS PROOF OF THAT. The Value column is
// `salesValue` — the row's own contribution to the closing, the figure the matrix sums — so the
// sheet's total equals the line's headline for the month to the cent. It is NOT `sheetValue`, the
// number the distributor's own file printed: the two differ wherever Phoenix revalues a row at its
// own price, and a detail sheet whose total disagreed with the Closing tab beside it would read as
// a broken workbook rather than as two different questions. Pinned by
// `tests/closing-rows-sheet.test.ts`.
//
// 🔴 UNITS ARE NEVER TOTALLED HERE, and that is the owner's standing rule rather than an omission
// (AGENTS.md §4): each row is one product code, so its own units are meaningful, and a column total
// across different products and concentrations is not a quantity of anything. Value spans products
// safely, so the total row carries value alone.
//
// 🔒 EL QEMA IS BLANKED ON THIS SHEET FOR EVERY READER, including the Super Admin whose own screen
// keeps the trace — owner, 2026-09-09: "no any traces for Al Qimma detail. Never anyone know." The
// loader already removes those rows for viewers who may not reveal them and substitutes Main Stores
// (closing-source-mask.ts); what this module adds is that a workbook built by a reader who CAN
// reveal still goes out blanked, because the file is forwarded — "any one who receive the closing
// can export" (2026-09-14) — and a forwarded file carries no access context with it.
//
// THE SIZE OF IT, MEASURED RATHER THAN GUESSED: CNS is the heaviest line in the system at 21,181
// counted rows for September 2026 — 381,258 cells, about 26 MB of sheet XML before the zip deflates
// it. Anti Infective, the line the ranking workbook is built for, is 1,913. There is deliberately NO
// row cap: a truncated audit sheet is worse than a large one, because its total would then disagree
// with the Closing tab and nothing on the page would say why.
//
// 🔴 THE GEOGRAPHY COLUMNS ARE AS INVOICED, NOT AS RESOLVED. Area and Region here are what the
// distributor's own sheet stated; the closing resolves an area from the BRICK, so summing this tab
// per area need not match the Who tab area for area. The line total does match, exactly. Saying so
// on the sheet is cheaper than the hour it costs a reader to discover it.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

import { classifyCustomerChannel, type CustomerChannel } from "@/lib/sales/customer-channel";
import { invoiceRefAbsence } from "@/lib/sales/closing-detail-invoice-ref";
import { UNNAMED_DISTRIBUTOR_LABEL } from "@/lib/sales/closing-details-distributor-names";
import { MASKED_SOURCE_DISTRIBUTORS } from "@/lib/sales/closing-source-mask";
import { MAIN_STORES_LABEL } from "@/lib/sales/closing-main-stores";
import { isOfficeDistributorCode } from "@/lib/sales/office-distributor";
import type { EngineValue, ReviewColumnFormat } from "@/lib/sales/closing-engine-fill";
import type { ReviewSheet } from "@/lib/sales/closing-review-sheets";
import type { ClosingDetailRow } from "@/lib/sales/monthly-closing-details";

/** The tab name, in both workbooks. Short because it is read dozens of times a day. */
export const CLOSING_ROWS_SHEET_NAME = "Rows" as const;

/**
 * The contents-page heading it is listed under in the premium workbook.
 *
 * Its own band, not "Performance review": this is the audit layer under every other tab, and
 * filing it under the review would put it beside three sheets that answer a different question.
 */
export const CLOSING_ROWS_SHEET_BAND = "The counted rows" as const;

/** Column headings, in order. The Rows sheet is the same 18 columns in both workbooks. */
export const CLOSING_ROWS_HEADERS: readonly string[] = [
  "Invoice date",
  "Invoice reference",
  "Route",
  "Customer channel",
  "Distributor",
  "Customer code",
  "Customer name",
  "Customer address",
  "Brick",
  "Area as invoiced",
  "Region as invoiced",
  "Product",
  "Units",
  "Bonus units",
  "Value EGP",
  "Discount",
  "Ex-factory price",
  "Row id",
];

/** One per heading, in Excel's own character units. */
export const CLOSING_ROWS_WIDTHS: readonly number[] = [
  12, 22, 15, 15, 18, 13, 34, 38, 10, 16, 15, 26, 9, 11, 13, 10, 13, 11,
];

/**
 * Which columns must NOT take the engine's money format.
 *
 * `plain` is the general format: it prints a number exactly as it is. The money format rounds to
 * whole pounds and writes an em dash for zero — right for Value, wrong for four of these columns.
 * An Office allocation row legitimately carries 0.442381 units (the Office channel's money spread
 * across areas by the golden rule), and rounded to "—" it would read as a row that sold nothing.
 * A row id is an identifier, so thousands separators in it are noise.
 */
const PLAIN_COLUMNS: ReadonlySet<string> = new Set([
  "Units",
  "Bonus units",
  "Discount",
  "Ex-factory price",
  "Row id",
]);

export const CLOSING_ROWS_COLUMN_FORMATS: readonly (ReviewColumnFormat | null)[] =
  CLOSING_ROWS_HEADERS.map((heading) => (PLAIN_COLUMNS.has(heading) ? "plain" : null));

/** How a row reached the closing — three different answers, and a reader can act on each. */
export type ClosingRowRoute = "Distributor" | "Direct order" | "Office allocation";

/** The channel words the sheet prints, from Phoenix's own classifier rather than a second rule. */
const CHANNEL_LABEL: Record<CustomerChannel, string> = {
  hospital: "Hospital",
  pharmacy: "Pharmacy",
  store: "Store / warehouse",
};

function masked(distributorCode: string): boolean {
  return MASKED_SOURCE_DISTRIBUTORS.has(distributorCode.trim().toUpperCase());
}

export function closingRowRoute(row: ClosingDetailRow): ClosingRowRoute {
  if (isOfficeDistributorCode(row.distributorCode)) return "Office allocation";
  return row.isDirect ? "Direct order" : "Distributor";
}

/**
 * The distributor as the sheet names it: the master's name, never the code (owner's standing rule).
 *
 * 🔴 A MASKED ROW GETS NO DISTRIBUTOR AT ALL — not El Qema's name, not another distributor's, and
 * not "Unnamed distributor" either, which would announce that a supplier is being hidden. Blank is
 * exactly what the substituted Main Stores rows carry (closing-main-stores.ts), so a row blanked
 * here is indistinguishable from one that arrived blanked.
 */
export function closingRowDistributor(
  row: ClosingDetailRow,
  names: ReadonlyMap<string, string>,
): string {
  const code = row.distributorCode.trim();
  if (code === "" || masked(code)) return "";
  return names.get(code.toUpperCase()) ?? UNNAMED_DISTRIBUTOR_LABEL;
}

/** A number, or null where the sheet must print nothing at all. */
const figure = (value: number | null | undefined): EngineValue =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * One sheet row, positional against `CLOSING_ROWS_HEADERS`.
 *
 * Bonus units print the word "none" rather than a zero, as the build the owner approved does: a
 * zero in that column reads as a quantity, and the question a reader asks of it ("was there a
 * bonus?") has a yes/no answer.
 */
export function closingRowsRecord(
  row: ClosingDetailRow,
  names: ReadonlyMap<string, string>,
): EngineValue[] {
  const route = closingRowRoute(row);
  const isMasked = masked(row.distributorCode);
  const reference = row.invoiceRef ?? null;
  return [
    row.invoiceDate ?? "",
    isMasked
      ? ""
      : reference
        ?? invoiceRefAbsence({ isDirect: row.isDirect, isOfficeAllocation: route === "Office allocation" }),
    route,
    CHANNEL_LABEL[classifyCustomerChannel(row.clientName, row.clientCode, row.distributorCode)],
    closingRowDistributor(row, names),
    isMasked ? "" : row.clientCode,
    // The buyer on a masked row is the words "Main Stores", with no code and no address — the same
    // row the masked read substitutes, so the two are indistinguishable in a finished file.
    isMasked ? MAIN_STORES_LABEL : row.clientName,
    isMasked ? "" : row.clientAddress,
    row.brickName || row.brickId,
    row.sheetAreaName || row.sheetAreaCode,
    row.sheetRegionName || row.sheetRegionCode,
    row.productName,
    figure(row.effectiveUnits),
    row.bonusQty > 0 ? figure(row.bonusQty) : "none",
    figure(row.salesValue),
    figure(row.discount),
    isMasked ? "" : figure(row.factoryPrice),
    row.id,
  ];
}

export type ClosingRowsSheetSpec = {
  headers: readonly string[];
  widths: readonly number[];
  columnFormats: readonly (ReviewColumnFormat | null)[];
  records: EngineValue[][];
  /** How many counted rows the sheet carries. */
  rowCount: number;
  /** Their value, which is the line's headline for the month. */
  totalValue: number;
  /** The caption under the masthead, naming both figures. */
  caption: string;
  /** What the sheet says about itself at the foot. */
  notes: readonly string[];
};

/**
 * The sheet, as data — no Excel in here.
 *
 * Built once and rendered twice: the premium engine takes it as a `ReviewSheet` (declarative XML,
 * written by `addReviewSheets`), and the rep-ranking workbook writes it with ExcelJS beside its own
 * tabs. Two renderers, one arrangement, so the two files cannot drift into disagreeing about what a
 * counted row is.
 */
export function closingRowsSheetSpec(input: {
  rows: readonly ClosingDetailRow[];
  distributorNames: ReadonlyMap<string, string>;
  line: string | null;
  /** The month, or the span, this sheet covers — printed in the caption. */
  periodLabel: string | null;
  /** The filter the workbook was built under, where it carries one. */
  filterNote?: string | null;
}): ClosingRowsSheetSpec | null {
  if (input.rows.length === 0) return null;

  const records = input.rows.map((row) => closingRowsRecord(row, input.distributorNames));
  const totalValue = input.rows.reduce((total, row) => total + (row.salesValue || 0), 0);
  const maskedRows = input.rows.filter((row) => masked(row.distributorCode)).length;
  const withoutReference = input.rows.filter((row) => !row.invoiceRef).length;

  const span = [input.line, input.periodLabel].filter(Boolean).join(", ");
  const counted = input.rows.length.toLocaleString("en-US");
  const money = Math.round(totalValue).toLocaleString("en-US");

  const notes: string[] = [
    // The counts are COUNTED, never stated: a sentence that names a figure it did not measure is
    // true only until the data changes under it, and then it is a confident lie.
    `UNITS ARE NOT TOTALLED. Each row is one product code, so its units are meaningful; a column total across different products and concentrations would not be.`,
    `AREA AND REGION HERE ARE AS INVOICED — what the distributor's own sheet stated. The closing resolves an area from the BRICK, so a per-area sum of this tab need not match the tabs beside it, area for area. The line total does match, exactly: these ${counted} rows add to ${money} EGP.`,
    withoutReference === 0
      ? `Every row carries its supplier's own invoice reference.`
      : `${withoutReference.toLocaleString("en-US")} of these rows carry no invoice reference, and the column names the reason instead of leaving the cell blank — a feed that does not supply the column, a direct order identified by its request, or the Office allocation, which is not an invoice at all.`,
    maskedRows === 0
      ? `El Qema never appears in a closing detail (owner, 2026-09-09): no row in this selection is theirs, so none is masked.`
      : `El Qema never appears in a closing detail (owner, 2026-09-09): ${maskedRows.toLocaleString("en-US")} rows here carry no distributor and read "${MAIN_STORES_LABEL}" as the buyer, with no code, address or price, and they are never relabelled as another distributor. Their money is in every total on every tab.`,
  ];
  if (input.filterNote) notes.push(`This workbook was built under a filter: ${input.filterNote}. The rows below are that same selection.`);

  return {
    caption:
      `All ${counted} rows the closing counts${span ? ` — ${span}` : ""}, with their full data. `
      + `They total ${money} EGP, the Closing tab's figure for this line. `
      + `An invoice reference is carried wherever the feed supplies one; where it does not, the reason is named rather than left blank.`,
    columnFormats: CLOSING_ROWS_COLUMN_FORMATS,
    headers: CLOSING_ROWS_HEADERS,
    notes,
    records,
    rowCount: input.rows.length,
    totalValue,
    widths: CLOSING_ROWS_WIDTHS,
  };
}

/**
 * The premium workbook's Rows tab.
 *
 * Null rather than an empty sheet, exactly as the review's and the Office-free matrix's builders do:
 * a tab the contents page promises and that holds nothing reads as a figure that failed to load.
 *
 * No `after` — it appends at the end of the tab strip. A sheet inserted mid-strip silently
 * re-attaches every print area and print title at or after its position to the neighbour, and this
 * tab has no reason to sit beside a particular one.
 */
export function buildClosingRowsSheet(input: {
  rows: readonly ClosingDetailRow[];
  distributorNames: ReadonlyMap<string, string>;
  line: string | null;
  periodLabel: string | null;
  filterNote?: string | null;
}): ReviewSheet | null {
  const spec = closingRowsSheetSpec(input);
  if (spec === null) return null;

  const stamp = [input.periodLabel, input.line].filter(Boolean).join("   ");
  return {
    band: CLOSING_ROWS_SHEET_BAND,
    columnFormats: spec.columnFormats,
    headers: [...spec.headers],
    name: CLOSING_ROWS_SHEET_NAME,
    rows: spec.records,
    subtitle: spec.caption,
    title: `Every counted row   ${stamp}`,
    what: `Every row the closing counted, at invoice grain — the layer under every other tab, and the one the matrix can be re-added from by hand.`,
    widths: [...spec.widths],
  };
}
