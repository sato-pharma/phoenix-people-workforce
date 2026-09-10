// The quarter gap, as a sheet in the premium workbook.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Pure, and separate from `closing-quarter-gap.ts` for the same reason `closing-review-sheets.ts`
// is separate from the review: the arithmetic that decides what a gap is has no business knowing
// about column widths, and the sheet has no business reaching a database.
//
// GROUPED BY PRODUCT, and the rows arrive in that order already — a product bar, then its areas,
// then the next product. This file's job is to say which rows are BARS, so the filler can style
// them and fold the areas under them; it never re-orders anything.
//
// TWO THINGS ABOUT THE COLUMN HEADINGS ARE LOAD-BEARING, not cosmetic.
//
//  - The filler picks each column's NUMBER FORMAT from its heading (`reviewColumnStyle`), and the
//    only heading it treats as a percentage is one starting with "Achievement" or "Share". So the
//    last column is called Achievement and nothing else, or a ratio of 0.86 prints as "1" beside a
//    sibling sheet reading 86.3%.
//  - Every other numeric column takes the money format, `#,##0;-#,##0;"—"`. That em dash is why a
//    unit cell on the LINE TOTAL row is written as null rather than as 0: null prints the dash,
//    which says "not a figure this row can carry", while a 0 would say "sold none".
//
// THE GAP'S SIGN IS STATED ON THE SHEET, in the subtitle, because it is the one thing a reader
// cannot infer from a number: positive is still to sell, negative is already past target. Naming
// the columns "still to sell" instead would have read as a lie on every area that is ahead.

import { closingSheetMonthLabel, type ReviewSheet, type ReviewSheetRowKind } from "@/lib/sales/closing-review-sheets";
import type { AccessContext } from "@/lib/auth/permissions";
import type { ClosingQuarterGap } from "@/lib/sales/closing-quarter-gap";
import type { EngineValue } from "@/lib/sales/closing-engine-fill";

/**
 * 🔒 SUPER ADMIN ONLY — owner, 2026-09-10: "make it only in super admin export."
 *
 * The premium workbook goes to a wider room than this tab does. Its route admits everyone whose
 * sales scope is company-wide: Super Admin, the CEO, the SFE Manager, the Finance Manager and the
 * Marketing Manager. A quarter's gap is a forward-looking number about what a line still owes, and
 * he wants it in his own file and nobody else's, so the tab is built for him and is simply ABSENT
 * from every other copy of the same workbook.
 *
 * ⚠ IT ASKS THE ROLE, AND ONLY THE ROLE — no `scope` clause, unlike `canRevealClosingSource` one
 * module over. That is not an oversight and it is not a second gate either: `systemAccessContext`
 * already carries the Super Admin ROLE, so anything running as system passes this too. Adding a
 * scope clause would therefore change nothing today and would only read as a second rule to keep in
 * step. What actually holds the line is that ONE file builds this tab, and the sweep in
 * `closing-quarter-gap.test.ts` names it: a future automated build of this workbook would inherit
 * the tab, and it has to be reviewed into that list before it can.
 *
 * The contents page lists only the tabs a workbook actually carries, so a copy without it has
 * nothing dangling: no heading over nothing, and no link to a page that is not there. Measured on
 * real workbooks — Super Admin gets eighteen tabs, the CEO and the Finance Manager seventeen.
 */
export function canSeeQuarterGapTab(access: Pick<AccessContext, "role">): boolean {
  return access.role === "Super Admin";
}

/** The tab's name, and the key its colour and geometry are looked up by in the executive look. */
export const QUARTER_GAP_SHEET = "Gap to Quarter Target";

/** The contents-page heading this tab is listed under — its own, not the review's. */
export const QUARTER_GAP_BAND = "Against the quarter";

/**
 * The column widths, in Excel's own units.
 *
 * Exported because `EXECUTIVE_GEOMETRY` has to describe the same eleven columns: the navy masthead
 * band is drawn to the width of the LAST column in that table, so a table that stops short paints a
 * band that stops short, and the mark then sits past the end of its own colour.
 */
export const QUARTER_GAP_WIDTHS = [26, 18, 22, 16, 13, 15, 13, 15, 13, 15, 12];

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
    + "One product per block — press the minus in the margin to fold its areas away. "
    + "Only the line total spans products, which is why it alone carries no units."
    + missing;

  return {
    band: QUARTER_GAP_BAND,
    // The areas fold under the product bar above them, which is where the bars have to sit for the
    // margin's own controls to point at the right block.
    grouped: true,
    headers: [
      "Product",
      "Family",
      "Area",
      "Region",
      "Sold units",
      "Sold value",
      "Target units",
      "Target value",
      "Gap units",
      "Gap value",
      "Achievement",
    ],
    name: QUARTER_GAP_SHEET,
    rowKinds: gap.rows.map((row): ReviewSheetRowKind =>
      row.kind === "area" ? "detail" : row.kind === "product" ? "group" : "total",
    ),
    rows: gap.rows.map((row) => [
      row.productName,
      row.family,
      row.areaName,
      row.regionName,
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
      "Every product against its whole-quarter target, area by area — sold so far in units and value,"
      + " and what is left to sell.",
    widths: QUARTER_GAP_WIDTHS,
  };
}
