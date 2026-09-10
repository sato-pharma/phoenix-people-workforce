// The quarter gap, as a sheet in the premium workbook.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Pure, and separate from `closing-quarter-gap.ts` for the same reason `closing-review-sheets.ts`
// is separate from the review: the arithmetic that decides what a gap is has no business knowing
// about column widths, and the sheet has no business reaching a database.
//
// TWO THINGS ABOUT THE COLUMN HEADINGS ARE LOAD-BEARING, not cosmetic.
//
//  - The filler picks each column's NUMBER FORMAT from its heading (`reviewColumnStyle`), and the
//    only heading it treats as a percentage is one starting with "Achievement" or "Share". So the
//    last column is called Achievement and nothing else, or a ratio of 0.86 prints as "1" beside a
//    sibling sheet reading 86.3%.
//  - Every other numeric column takes the money format, `#,##0;-#,##0;"—"`. That em dash is why a
//    unit cell on an AREA row is written as null rather than as 0: null prints the dash, which says
//    "not a figure this row can carry", while a 0 would say "sold none".
//
// THE GAP'S SIGN IS STATED ON THE SHEET, in the subtitle, because it is the one thing a reader
// cannot infer from a number: positive is still to sell, negative is already past target. Naming
// the columns "still to sell" instead would have read as a lie on every area that is ahead.

import { closingSheetMonthLabel, type ReviewSheet } from "@/lib/sales/closing-review-sheets";
import type { ClosingQuarterGap } from "@/lib/sales/closing-quarter-gap";
import type { EngineValue } from "@/lib/sales/closing-engine-fill";

/** The tab's name, and the key its colour is looked up by in the executive palette. */
export const QUARTER_GAP_SHEET = "Gap to Quarter Target";

/** The contents-page heading this tab is listed under — its own, not the review's. */
export const QUARTER_GAP_BAND = "Against the quarter";

/** Money and unit columns alike: the format prints no decimals, so a rounded value loses nothing. */
const figure = (value: number | null | undefined): EngineValue =>
  typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;

/** A ratio stays a ratio — the sheet formats it, so rounding here would lose the percentage. */
const ratio = (value: number | null | undefined): EngineValue =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** `["2026-07","2026-08","2026-09"]` as `Jul 2026 to Sep 2026`. */
function span(months: string[]): string {
  if (months.length === 0) return "";
  const first = closingSheetMonthLabel(months[0]!);
  const last = closingSheetMonthLabel(months[months.length - 1]!);
  return first === last ? first : `${first} to ${last}`;
}

/**
 * The quarter gap tab, or null when there is nothing to put on it.
 *
 * Null rather than an empty sheet, exactly as the review's own builder does: a tab promised by the
 * contents page and holding nothing reads as a number that failed to load rather than as a question
 * that does not arise.
 */
export function buildQuarterGapSheet(
  gap: ClosingQuarterGap | null,
  input: { line: string | null; period: string | null },
): ReviewSheet | null {
  if (!gap || gap.rows.length === 0) return null;

  const stamp = [input.period ? closingSheetMonthLabel(input.period) : null, input.line]
    .filter(Boolean)
    .join("   ");

  // ⚠ THE MASTHEAD IS THE NAME, THE MONTH AND THE LINE — nothing else. The emblem is anchored
  // against the end of the last column on this same row, and a descriptive tail here is what left
  // the review's three tabs with no room for a mark at all.
  const title = [QUARTER_GAP_SHEET, stamp].filter(Boolean).join("   ");

  const missing =
    gap.monthsMissing.length > 0
      ? ` ${gap.monthsMissing.map(closingSheetMonthLabel).join(" and ")} `
        + `${gap.monthsMissing.length === 1 ? "has" : "have"} no closing yet, so the sold columns do not count `
        + `${gap.monthsMissing.length === 1 ? "it" : "them"}.`
      : "";

  const subtitle =
    `${gap.quarterLabel} (${span(gap.months)}). Sold is the quarter to date through `
    + `${closingSheetMonthLabel(gap.through)}; the target is all ${gap.months.length} months of the quarter. `
    + "Gap is target minus sold, so a positive number is still to sell and a negative one is past target. "
    + "An area row carries value only — units are never added across products."
    + missing;

  return {
    band: QUARTER_GAP_BAND,
    headers: [
      "Area",
      "Region",
      "Product",
      "Sold units",
      "Sold value",
      "Target units",
      "Target value",
      "Gap units",
      "Gap value",
      "Achievement",
    ],
    name: QUARTER_GAP_SHEET,
    rows: gap.rows.map((row) => [
      row.areaName,
      row.regionName,
      row.productName,
      figure(row.salesUnits),
      figure(row.salesValue),
      figure(row.targetUnits),
      figure(row.targetValue),
      figure(row.gapUnits),
      figure(row.gapValue),
      ratio(row.achievement),
    ]),
    subtitle,
    title,
    what:
      "Each area against its whole-quarter target, product by product — sold so far in units and value,"
      + " and what is left to sell.",
    widths: [24, 17, 26, 13, 16, 13, 16, 13, 16, 13],
  };
}
