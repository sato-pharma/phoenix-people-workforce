// The three matrix pages, as plain rows, for a phone.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS SHEET EXISTS. `Closing Matrix`, `Units Matrix` and `Area x Product` are PIVOT TABLES, and
// a pivot table holds no cells of its own in the file — the whole grid is materialised by Excel from
// the pivot cache when the workbook opens. The template ships that cache EMPTY on purpose (its
// contents were one line's real areas and reps, and shipping those inside another line's export is a
// leak) and sets `refreshOnLoad="1"` so Excel rebuilds it. Measured on the emitted workbook, those
// three sheets carry 2, 2 and 6 cells: their title row, and nothing else.
//
// Desktop Excel honours `refreshOnLoad` and the matrices appear. **Excel for iOS/Android and WPS
// Office on a phone do not refresh a pivot cache at all** — they open a PivotTable read-only from
// the records it already has, and there are none. So on the two apps the owner actually reads this
// workbook on, those three tabs are permanently blank, and the numbers behind them are unreachable:
// the `Data` sheet that feeds the pivots is `veryHidden`, which a phone cannot unhide.
//
// The contents page already carried a line saying the matrices are built on open. That was written
// for "a machine that has not recalculated" — a state that passes. On a phone it never passes.
//
// WHY ROWS RATHER THAN A GRID. Reproducing the pivots' own grid would mean writing cells INSIDE the
// pivots' declared ranges, and their `<rowItems>`/`<colItems>` enumerations would then have to agree
// with what was written — the exact mismatch that made Excel offer to repair this workbook once
// already (see `restorePivotCacheSharedItems`). Worse, the desktop refresh would rewrite that range
// on open and any row of ours it did not cover would be left stranded below a working pivot. So
// nothing here touches a pivot, a cache or a slicer. This is a separate sheet, and one long-form
// table answers all three pivots at once, because each of the three is a different arrangement of
// exactly these columns:
//
//   Closing Matrix  — area x product, VALUE against target
//   Units Matrix    — area x product, UNITS against target
//   Area x Product  — the same value figures, one region at a time
//
// It is also the better shape for a phone: nine columns you scroll down, rather than a fifty-column
// grid you scroll sideways.
//
// UNITS ARE NEVER SUMMED HERE, and the layout is what guarantees it rather than a rule anyone has to
// remember: every row is ONE product code, so a unit figure on it is a unit figure for one product.
// There is deliberately NO totals row — a totals row is where a units column would silently become a
// sum across concentrations. The month's totals are on `Overview`, which is a static sheet and opens
// on a phone.

import type { EngineValue } from "./closing-engine-fill";
import type { ReviewSheet } from "./closing-review-sheets";

/** The tab name. Also what the contents page links to, so the two must not drift apart. */
export const MOBILE_MATRIX_SHEET = "Matrix (Mobile)";

/**
 * The line the contents page prints beside the tab name.
 *
 * Exported so the contents page and the sheet itself cannot end up describing it differently — the
 * sheet is listed from `INDEX_SECTIONS` (in the "By area" band, beside the pages it stands in for)
 * rather than from its own `what`, so without this there would be two strings and only one of them
 * would ever be read.
 */
export const MOBILE_MATRIX_WHAT =
  "The same figures as plain rows — the page to open on a phone, where the three above stay blank.";

/**
 * The owner's own words for an absent target, matching every presentation sheet in the engine.
 *
 * A blank reads as a number nobody filled in and a zero scores the area as having failed, so the
 * text is the honest answer. The pivots say the same thing a different way: their `Ach` field
 * returns -1 for it and the conditional formatting hides that, which is a device only a live pivot
 * has.
 */
const NO_TARGET = "no target";

/**
 * SalesData's columns, by position.
 *
 * These are the `Data` sheet's own A:N block — the pivot cache reads the same table, so cache field
 * n and column n here are one thing. Named rather than indexed inline because a positional read of
 * the wrong column produces a perfectly plausible number.
 */
const COLUMN = {
  region: 0,
  area: 1,
  product: 5,
  units: 6,
  targetUnits: 7,
  salesValue: 9,
  targetValue: 10,
} as const;

/**
 * The headings, in order.
 *
 * BOTH ACHIEVEMENT COLUMNS ARE SPELLED "Achievement …" ON PURPOSE. `reviewColumnStyle` in the filler
 * picks a number format from the HEADING, and only a heading beginning "achievement" gets the
 * percentage format; "Units achievement" would have been formatted as money and rendered `0.86`
 * beside a sibling sheet reading `86.3%` — unreadable rather than wrong, which is the harder kind of
 * defect to notice.
 */
const HEADERS = [
  "Region",
  "Area",
  "Product",
  "Units",
  "Target units",
  "Achievement (units)",
  "Sales value",
  "Target value",
  "Achievement (value)",
] as const;

const WIDTHS = [18, 24, 32, 12, 13, 19, 16, 16, 19];

/** A finite number, or null — `EngineValue` accepts anything and a NaN would render as a broken cell. */
function figure(value: EngineValue): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Achievement the way the pivots compute it: actual over target, and nothing at all when there is no
 * target to divide by.
 *
 * The pivots' calculated fields are `IF('Target Value'>0,'Sales Value'/'Target Value',-1)` and the
 * units equivalent, so the guard is `> 0` rather than `!= null` — a target of zero is not something
 * to divide by either.
 */
function achievement(actual: number | null, target: number | null): EngineValue {
  if (target == null || target <= 0) return NO_TARGET;
  return (actual ?? 0) / target;
}

/**
 * Build the sheet, or nothing when the month has no rows.
 *
 * Returning null rather than an empty sheet is deliberate and matches `buildReviewSheets`: an empty
 * tab reads as a missing number rather than as an absent question, and the contents page would then
 * promise a page with nothing on it.
 *
 * The rows arrive in `salesData`'s own order, which is the MATRIX's order — region by region, area
 * by area, product by product — so this sheet reads down in the same sequence the Closing Matrix
 * reads across. It is not re-sorted here: a second ordering in the same workbook is a second answer
 * to "where is Cairo 1", and there is no reason for the two to disagree.
 */
export function buildMobileMatrixSheet(input: { salesData: EngineValue[][]; title: string }): ReviewSheet | null {
  const rows: EngineValue[][] = [];

  for (const record of input.salesData) {
    const units = figure(record[COLUMN.units] ?? null);
    const targetUnits = figure(record[COLUMN.targetUnits] ?? null);
    const salesValue = figure(record[COLUMN.salesValue] ?? null);
    const targetValue = figure(record[COLUMN.targetValue] ?? null);

    rows.push([
      String(record[COLUMN.region] ?? ""),
      String(record[COLUMN.area] ?? ""),
      String(record[COLUMN.product] ?? ""),
      units,
      targetUnits ?? NO_TARGET,
      achievement(units, targetUnits),
      salesValue,
      targetValue ?? NO_TARGET,
      achievement(salesValue, targetValue),
    ]);
  }

  if (rows.length === 0) return null;

  return {
    headers: [...HEADERS],
    name: MOBILE_MATRIX_SHEET,
    rows,
    subtitle:
      "One row per area and product. The three matrix tabs are pivot tables and stay blank on a phone;"
      + " this page holds the same figures as ordinary cells.",
    title: input.title,
    what: MOBILE_MATRIX_WHAT,
    widths: [...WIDTHS],
  };
}
