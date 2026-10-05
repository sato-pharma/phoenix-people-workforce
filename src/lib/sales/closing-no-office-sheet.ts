// The Office-free Closing Matrix, as a tab in the PREMIUM workbook.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Owner, 2026-10-05: "Only in CNS ... you will add another tab, which will follow the closing
// matrix. Will be exactly as the closing matrix, but without the office ... in the premium and in
// the normal xlsx monthly closing." The arithmetic is `closing-matrix-without-office.ts` and is
// shared with the normal workbook; this file only lays it out, exactly as `closing-quarter-gap-sheet.ts`
// lays out a gap it does not compute.
//
// ⚠ IT MIRRORS THE PREMIUM'S OWN CLOSING MATRIX, NOT THE NORMAL WORKBOOK'S. The two grids are not
// the same grid: the normal export's matrix carries Units, Value, Tgt Units, Tgt Value, Ach % and
// two contribution columns per product, while the premium's is a PIVOT whose data fields are
// exactly `Sales Value`, `Target Value` and `Ach` (read from `pivotTable1.xml`: rows Region then
// Area, columns Product crossed with those three). "Exactly as the closing matrix" therefore means
// a different set of columns in each file, and copying the normal workbook's shape in here would
// put a grid beside the premium matrix that answers a different question with the same title.
//
// ⚠ AUTHORED AS A STATIC GRID, NOT AS A SECOND PIVOT, and that is not a shortcut. A pivot needs its
// own cache, and the cache in this package is built from the `SalesData` table — which carries no
// Office column at all, because the Office slice reaches the closing as a separate aggregate. A
// second pivot would therefore need a second cache part authored from scratch inside the owner's
// own .xlsm, which is precisely the "never rebuild the engine" line this module sits behind.
//
// 🔴 NO UNITS ANYWHERE ON IT, and that is the owner's standing rule rather than an omission: a
// Grand Total column spans every product code, and units of different products are never added
// (AGENTS.md §4). Value spans concentrations safely, which is why the premium matrix is a value
// grid in the first place. The Units Matrix is where units belong, and it keeps its Office.
//
// THE HEADINGS ARE LOAD-BEARING. `reviewColumnStyle` picks each column's number format from its
// heading, and a percentage column has to be recognisable as one or a ratio of 0.86 prints as "1".
// Every achievement column here ends in "Ach", which that function matches on; renaming one to
// "Achievement %" or "Ach." silently turns the whole column into money.

import {
  CLOSING_MATRIX_NO_OFFICE_BAND,
  CLOSING_MATRIX_NO_OFFICE_SHEET,
  matrixWithoutOffice,
} from "@/lib/sales/closing-matrix-without-office";
import { closingSheetMonthLabel, type ReviewSheet, type ReviewSheetRowKind } from "@/lib/sales/closing-review-sheets";
import { isSyntheticDirectArea } from "@/lib/sales/closing-direct-area";
import { lineHasOfficeChannel } from "@/lib/sales/office-distributor";
import type { EngineValue } from "@/lib/sales/closing-engine-fill";
import type { MonthlyClosingCell, MonthlyClosingMatrix } from "@/lib/sales/monthly-distributor-import";

/** The two columns that name the row, before the first product block. */
const LEAD_WIDTHS = [24, 22];
/** One product block: Sales Value, Target Value, Ach — the premium matrix's own 13 / 14 / 11. */
const PRODUCT_WIDTHS = [13, 14, 11];
/** The Grand Total block, a shade wider because it carries the biggest number on the sheet. */
const GRAND_WIDTHS = [15, 15, 11];

/** Money and target columns alike: the format prints no decimals, so rounding loses nothing. */
const figure = (value: number | null | undefined): EngineValue =>
  typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;

/** A ratio stays a ratio — the sheet formats it, so rounding here would lose the percentage. */
const ratio = (value: number | null | undefined): EngineValue =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** One product block's three cells, in heading order. */
function cellTriple(cell: MonthlyClosingCell | undefined): EngineValue[] {
  return [figure(cell?.salesValue), figure(cell?.targetValue), ratio(cell?.achievement)];
}

/** Every column heading, and the widths that go with them — one list so they cannot drift apart. */
export function closingNoOfficeColumns(
  matrix: MonthlyClosingMatrix,
): { headers: string[]; widths: number[] } {
  const headers = ["Region", "Area"];
  const widths = [...LEAD_WIDTHS];
  for (const column of matrix.columns) {
    headers.push(`${column.productName} Sales`, `${column.productName} Target`, `${column.productName} Ach`);
    widths.push(...PRODUCT_WIDTHS);
  }
  headers.push("Grand Total Sales", "Grand Total Target", "Grand Total Ach");
  widths.push(...GRAND_WIDTHS);
  return { headers, widths };
}

/**
 * The Office-free matrix tab, or null when this workbook must not carry one.
 *
 * Null rather than an empty sheet, exactly as the review's and the quarter gap's builders do: a tab
 * the contents page promises and that holds nothing reads as a figure that failed to load.
 *
 * Three ways it comes back null, and each is a correct answer rather than a failure:
 *   - the line has no Office channel at all (Office is CNS-only — owner, 2026-08-25), so the tab
 *     would be a byte-identical copy of the Closing Matrix beside it;
 *   - the Office read came back empty, so there is nothing to take out;
 *   - the matrix has no product columns or no areas, which is a line with nothing uploaded yet.
 */
export function buildClosingNoOfficeSheet(
  matrix: MonthlyClosingMatrix,
  office: MonthlyClosingMatrix | null | undefined,
  input: { filterNote?: string; periodLabel?: string } = {},
): ReviewSheet | null {
  if (!office) return null;
  if (!lineHasOfficeChannel(matrix.line)) return null;
  if (matrix.columns.length === 0 || matrix.regions.length === 0) return null;

  const reduced = matrixWithoutOffice(matrix, office);
  const { headers, widths } = closingNoOfficeColumns(reduced);

  const rows: EngineValue[][] = [];
  const rowKinds: ReviewSheetRowKind[] = [];
  const push = (kind: ReviewSheetRowKind, region: string, area: string, cells: MonthlyClosingCell[], rowTotal: MonthlyClosingCell) => {
    rows.push([
      region,
      area,
      ...reduced.columns.flatMap((_column, index) => cellTriple(cells[index])),
      ...cellTriple(rowTotal),
    ]);
    rowKinds.push(kind);
  };

  // A REGION BAR, THEN ITS AREAS — the bar above its detail, which is where `grouped` needs it for
  // the fold controls in the margin to point at the block they collapse. It is also the premium
  // matrix's own reading order: region, then the areas inside it.
  for (const region of reduced.regions) {
    push("group", region.regionName, "All areas", region.subtotal.cells, region.subtotal.rowTotal);
    for (const area of region.areas) {
      // The synthetic pseudo-area keeps the name the matrix gives it. A REAL area that merely
      // absorbed hand-mapped direct money is still its own area and keeps its own name — asking
      // the raw `isDirect` flag instead renames eleven real areas on Anti Infective.
      const synthetic = isSyntheticDirectArea(area);
      push(
        "detail",
        region.regionName,
        synthetic ? "Direct orders (company)" : area.areaName,
        area.cells,
        area.rowTotal,
      );
    }
  }

  // The same three closing rows the Closing Matrix ends with, in the same order and under the same
  // names, so the two grids can be read against each other line for line.
  const soleRegion = reduced.regions.length === 1 ? reduced.regions[0] : null;
  push(
    "total",
    soleRegion ? `${soleRegion.regionName} — Region Total` : "National Grand Total",
    "",
    reduced.grandTotal.cells,
    reduced.grandTotal.rowTotal,
  );
  if (reduced.directNational) {
    push("total", "Direct – National", "", reduced.directNational.cells, reduced.directNational.rowTotal);
  }
  if (reduced.companyTotal) {
    push("total", "Grand Total (incl. Direct)", "", reduced.companyTotal.cells, reduced.companyTotal.rowTotal);
  }

  // ⚠ THE MASTHEAD IS THE NAME, THE MONTH AND THE LINE — nothing else. The emblem is anchored
  // against the end of the last column on this same row, and a descriptive tail is what left the
  // review's own tabs with no room for a mark at all. The description goes in the subtitle.
  // 🔴 `periodLabel` IS WHAT A CONSOLIDATED SPAN NEEDS, and leaving it out is a wrong label rather
  // than a missing one: `mergeMonthlyClosingMatrices` keeps the LATEST month in `period`, so a
  // three-month workbook would head this grid "Sep 2026" while every figure on it is the sum of
  // three. The review sheets take the span the same way (`consolidatedSpanLabel`).
  const stamp = [input.periodLabel ?? (reduced.period ? closingSheetMonthLabel(reduced.period) : null), reduced.line]
    .filter(Boolean)
    .join("   ");

  return {
    after: "Closing Matrix",
    band: CLOSING_MATRIX_NO_OFFICE_BAND,
    grouped: true,
    headers,
    name: CLOSING_MATRIX_NO_OFFICE_SHEET,
    rowKinds,
    rows,
    subtitle:
      "Distributor sell-out only — the Office channel's value is taken out of every cell, subtotal"
      + " and total. Targets are NOT reduced with it, so the achievement here is the real money over"
      + " the whole target and is lower than the Closing Matrix by exactly the Office share. One"
      + " region per block — press the minus in the margin to fold its areas away."
      + " The Closing Matrix is the published closing; this grid is a lens on it."
      + (input.filterNote ? ` ${input.filterNote}` : ""),
    title: [CLOSING_MATRIX_NO_OFFICE_SHEET, stamp].filter(Boolean).join("   "),
    // ⚠ IT MUST NOT CONTAIN THE BAND'S OWN WORDS. The contents page is checked for its heading
    // appearing exactly once, which is how a folded-in band is told from a duplicated one — and a
    // description that happens to read "area by area" counts as a second heading.
    what:
      "The Closing Matrix with the Office channel taken out — distributor sell-out for every area,"
      + " against the whole target. CNS only.",
    widths,
  };
}
