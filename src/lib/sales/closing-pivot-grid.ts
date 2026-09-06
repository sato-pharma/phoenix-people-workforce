// The three pivot pages, computed as ordinary cells, so they are readable where a pivot is not.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS. `Closing Matrix`, `Units Matrix` and `Area x Product` are pivot tables, and a
// pivot table stores no cells of its own: Excel materialises the grid from the pivot cache when the
// workbook opens. The template ships that cache EMPTY on purpose — its contents were one line's real
// areas and rep names, and shipping those inside another line's export is a leak — and sets
// `refreshOnLoad="1"` so Excel rebuilds it. Measured on the emitted workbook, those three sheets
// carried 2, 2 and 6 cells: their title row and nothing else.
//
// Desktop Excel rebuilds them. **Excel for iOS/Android and WPS Office cannot refresh a pivot table
// at all** — on a phone a PivotTable is view-only, read from records that are not there — so on the
// two apps the owner reads this workbook on, all three pages were permanently blank. The `Data`
// sheet behind them is `veryHidden`, which a phone cannot unhide, so the numbers were in his hand
// and unreachable.
//
// So the grid is written into the cells as well. On DESKTOP nothing changes: `refreshOnLoad` still
// fires and Excel redraws the pivot over these cells, exactly as it does today, with its slicers and
// its fold-by-region intact. On a PHONE, no refresh happens, and these cells are what is displayed.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE LAYOUT IS DERIVED FROM THE PIVOT DEFINITION, NEVER FROM A RENDER. Three separate readings of
// this workbook lie, and the third one lies about exactly this:
//
//   - `--convert-to png` renders only the leftmost columns.
//   - an ExcelJS load-and-save "review copy" drops the merges.
//   - `--convert-to html` REBUILDS every pivot from its declared source on load — and LibreOffice
//     does not support Excel's CALCULATED fields, so it renders `Ach` out of existence and its
//     column count comes out one short PER PRODUCT. Its grid looks entirely plausible and is wrong.
//
// The shape below is read from `xl/pivotTables/*.xml` instead, and it cross-checks against the
// template's own stored extents, which is what makes it verifiable rather than assumed:
//
//   Closing Matrix   2 row-label cols + 15 products x 3 data fields + 3 grand-total cols = 50 = AX
//   Units Matrix     2 row-label cols + 15 products x 3 data fields + 0 (colGrandTotals=0) = 47 = AU
//   Area x Product   3 row-label cols + 3 data fields                                      =  6 = F
//
// All three match `location ref` in the template byte for byte.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// UNITS ARE NEVER ADDED ACROSS PRODUCTS, and the Units Matrix is the sheet where that rule is easiest
// to break. It is safe here for a structural reason, not a remembered one: every unit column belongs
// to ONE product, so a column total sums one product code across areas, which is legitimate. The
// pivot itself says the same thing by carrying `colGrandTotals="0"` — that is the flag that stops a
// "Total Units" column existing at all — and `columnTotals` below is read from it rather than set by
// hand, so the rule cannot be lost by someone editing this file.

import type { EngineValue } from "./closing-engine-fill";

/** SalesData's columns, by position — the same block the pivot cache reads. */
export const SALES_COLUMN = {
  region: 0,
  area: 1,
  product: 5,
  units: 6,
  targetUnits: 7,
  salesValue: 9,
  targetValue: 10,
} as const;

/**
 * The owner's own words for an absent target, matching every presentation sheet in the engine.
 *
 * The live pivot says this differently: its `Ach` field returns -1 and conditional formatting hides
 * that, which is a device only a live pivot has. On a phone the formatting is all that would be
 * left, so the text is written instead — a blank reads as a number nobody filled in, and a zero
 * would score an area as having failed at something nobody asked of it.
 */
const NO_TARGET = "no target";

/** What a cell is, so the writer can pick the engine's own format for it without re-deciding. */
export type GridCellKind = "blank" | "corner" | "header" | "label" | "money" | "percent" | "text";

export type GridCell = { kind: GridCellKind; value: EngineValue };

export type PivotGrid = {
  /** Row-major, starting at the pivot's own top-left cell. Ragged rows are padded by the writer. */
  cells: GridCell[][];
  /** How many columns the widest row has — the grid's own extent, used to re-declare `location`. */
  width: number;
};

type Measure = {
  /** The heading this measure prints under each column item, e.g. "Sales Value". */
  label: string;
  /** A summed SalesData column, or a ratio computed from two of them. */
  source: { kind: "sum"; column: number } | { kind: "ratio"; over: number; under: number };
};

export type PivotGridSpec = {
  /** SalesData columns that group the rows, outermost first. */
  rowFields: number[];
  /** The SalesData column spread across the columns, or null when every measure is one column. */
  columnField: number | null;
  measures: Measure[];
  /** A "Grand Total" row under everything. False on Area x Product, which sets rowGrandTotals="0". */
  rowTotals: boolean;
  /** A total column per measure. False on the Units Matrix, which sets colGrandTotals="0". */
  columnTotals: boolean;
};

/**
 * The three sheets, exactly as `xl/pivotTables/pivotTable{1,2,3}.xml` declare them.
 *
 * Read from the definition and pinned by `runClosingEngineExportTests`, which re-reads the template
 * and fails if a pivot is ever re-saved with a different shape — because the failure mode otherwise
 * is silent: the desktop refresh would repair the difference on open and only the phone would show
 * the stale layout.
 */
export const PIVOT_GRID_SPECS: Readonly<Record<string, PivotGridSpec>> = {
  "Area x Product": {
    columnField: null,
    measures: [
      { label: "Sales Value", source: { kind: "sum", column: SALES_COLUMN.salesValue } },
      { label: "Target Value", source: { kind: "sum", column: SALES_COLUMN.targetValue } },
      { label: "Ach", source: { kind: "ratio", over: SALES_COLUMN.salesValue, under: SALES_COLUMN.targetValue } },
    ],
    columnTotals: true,
    rowFields: [SALES_COLUMN.region, SALES_COLUMN.area, SALES_COLUMN.product],
    rowTotals: false,
  },
  "Closing Matrix": {
    columnField: SALES_COLUMN.product,
    measures: [
      { label: "Sales Value", source: { kind: "sum", column: SALES_COLUMN.salesValue } },
      { label: "Target Value", source: { kind: "sum", column: SALES_COLUMN.targetValue } },
      { label: "Ach", source: { kind: "ratio", over: SALES_COLUMN.salesValue, under: SALES_COLUMN.targetValue } },
    ],
    columnTotals: true,
    rowFields: [SALES_COLUMN.region, SALES_COLUMN.area],
    rowTotals: true,
  },
  "Units Matrix": {
    columnField: SALES_COLUMN.product,
    measures: [
      { label: "Units", source: { kind: "sum", column: SALES_COLUMN.units } },
      { label: "Target Units", source: { kind: "sum", column: SALES_COLUMN.targetUnits } },
      { label: "Units Ach", source: { kind: "ratio", over: SALES_COLUMN.units, under: SALES_COLUMN.targetUnits } },
    ],
    // colGrandTotals="0" in the pivot. Keeping it false is what stops a "Total Units" column that
    // would add different products together — see the header note.
    columnTotals: false,
    rowFields: [SALES_COLUMN.region, SALES_COLUMN.area],
    rowTotals: true,
  },
};

const text = (row: EngineValue[], column: number): string => String(row[column] ?? "");

const figure = (value: EngineValue): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * Distinct values of a column, in the order they are first met.
 *
 * FIRST-APPEARANCE ORDER IS NOT AN ARBITRARY CHOICE — it is what the live pivot does. The cache
 * pools each column's values in the order it meets them and the pivot's axes follow that pool, which
 * is precisely why `buildSalesData` writes its rows in the MATRIX's order rather than in rank order.
 * Sorting here would put this grid in a different sequence from the pivot the same file draws on a
 * desktop, and nothing would ever report the difference.
 */
function distinct(rows: EngineValue[][], column: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    const value = text(row, column);
    if (value === "" || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * One measure over a set of rows.
 *
 * The ratio is computed from the SUMMED numerator and denominator, never as an average of per-row
 * ratios — that is what Excel's calculated field does (`IF('Target Value'>0, 'Sales Value' /
 * 'Target Value', -1)` evaluates against the aggregated values), and it is also the closing's own
 * arithmetic: all of an area's money over the target it was given.
 */
function measure(rows: EngineValue[][], spec: Measure): GridCell {
  if (spec.source.kind === "sum") {
    const column = spec.source.column;
    let total = 0;
    let any = false;
    for (const row of rows) {
      const value = figure(row[column] ?? null);
      if (value === null) continue;
      total += value;
      any = true;
    }
    // Nothing to add is NOT a zero. On the target columns it is the difference between "was given a
    // target of nothing" and "was never given one", and only one of those is a fact about the month.
    return any ? { kind: "money", value: total } : { kind: "text", value: NO_TARGET };
  }

  let over = 0;
  let under = 0;
  for (const row of rows) {
    over += figure(row[spec.source.over] ?? null) ?? 0;
    under += figure(row[spec.source.under] ?? null) ?? 0;
  }
  if (under <= 0) return { kind: "text", value: NO_TARGET };
  return { kind: "percent", value: over / under };
}

/** Every row whose grouping columns match the given path, in SalesData order. */
function slice(rows: EngineValue[][], fields: number[], path: string[]): EngineValue[][] {
  return rows.filter((row) => path.every((value, depth) => text(row, fields[depth]!) === value));
}

/**
 * Build one sheet's grid.
 *
 * Returns null when the month has no rows: an empty grid would replace three blank pages with three
 * blank pages carrying headings, which reads as a broken export rather than as an empty month.
 */
export function buildPivotGrid(salesData: EngineValue[][], spec: PivotGridSpec): PivotGrid | null {
  if (salesData.length === 0) return null;

  const columnItems = spec.columnField === null ? [] : distinct(salesData, spec.columnField);
  const blank: GridCell = { kind: "blank", value: null };
  const header = (value: string): GridCell => ({ kind: "header", value });
  const label = (value: string): GridCell => ({ kind: "label", value });

  const cells: GridCell[][] = [];
  const rowLabelWidth = spec.rowFields.length;

  // ── The header block ────────────────────────────────────────────────────────────────────────
  //
  // A pivot with a column field carries THREE header rows and a pivot without one carries a single
  // row — which is not a stylistic choice: it is `firstDataRow` in the pivot's own `<location>`,
  // 3 on both matrices and 1 on Area x Product. Getting it wrong shifts every number down or up a
  // row against the pivot the desktop draws over it.
  if (spec.columnField === null) {
    cells.push([
      ...spec.rowFields.map((_field, depth) => header(["Region", "Area", "Product"][depth] ?? "Group")),
      ...spec.measures.map((one) => header(one.label)),
    ]);
  } else {
    const measuresWide = spec.measures.length;
    cells.push([blank, blank, header("Product"), header("Data")]);
    cells.push([
      blank,
      blank,
      // The item's name sits over the FIRST of its measure columns and the rest are left empty,
      // which is how Excel lays a column field out. No merges: a merged cell whose count disagrees
      // with the cells beneath it is a workbook Excel offers to repair, and this grid is rewritten
      // every month.
      ...columnItems.flatMap((item) => [header(item), ...Array<GridCell>(measuresWide - 1).fill(blank)]),
      ...(spec.columnTotals ? spec.measures.map((one) => header(`Total ${one.label}`)) : []),
    ]);
    cells.push([
      header("Region"),
      header("Area"),
      ...columnItems.flatMap(() => spec.measures.map((one) => header(one.label))),
      ...(spec.columnTotals ? spec.measures.map(() => blank) : []),
    ]);
  }

  /** One body row: its labels, then a measure block per column item, then the row's own totals. */
  const bodyRow = (labels: Array<string | null>, rows: EngineValue[][]): GridCell[] => {
    const line: GridCell[] = labels.map((one) => (one === null ? blank : label(one)));
    while (line.length < rowLabelWidth) line.push(blank);
    if (spec.columnField === null) {
      line.push(...spec.measures.map((one) => measure(rows, one)));
      return line;
    }
    for (const item of columnItems) {
      const cut = rows.filter((row) => text(row, spec.columnField!) === item);
      line.push(...spec.measures.map((one) => measure(cut, one)));
    }
    if (spec.columnTotals) line.push(...spec.measures.map((one) => measure(rows, one)));
    return line;
  };

  // ── The body ────────────────────────────────────────────────────────────────────────────────
  //
  // Walks the row fields outermost-first and emits a subtotal after every group EXCEPT the innermost
  // one, which is what `defaultSubtotal="1"` on the outer fields and none on the last produces. The
  // outer label is printed only on the first row of its group, as Excel's tabular form does.
  const walk = (depth: number, path: string[]): void => {
    const values = distinct(slice(salesData, spec.rowFields, path), spec.rowFields[depth]!);
    const innermost = depth === spec.rowFields.length - 1;

    for (const value of values) {
      const branch = [...path, value];
      if (innermost) {
        const labels: Array<string | null> = Array<string | null>(rowLabelWidth).fill(null);
        labels[depth] = value;
        cells.push(bodyRow(labels, slice(salesData, spec.rowFields, branch)));
        continue;
      }

      // An OUTER label is printed ONCE, on the first row of its group, and left blank on the rest —
      // which is what Excel's tabular form does and what makes a long matrix readable. Writing it on
      // every row was the first version here, and it is the kind of mistake that would never be
      // seen: the desktop refresh redraws this range on open, so only the phone would show it.
      //
      // The group's first row is the first row of its first descendant, so the row is stamped after
      // the recursion rather than predicted before it.
      const groupStartsAt = cells.length;
      walk(depth + 1, branch);
      const firstRow = cells[groupStartsAt];
      if (firstRow) firstRow[depth] = label(value);

      // The group's own subtotal, under it. `<value> Total` is Excel's wording for a tabular
      // subtotal row; LibreOffice calls the same row "<value> Result", which is one more reason its
      // render cannot be used as the reference for this file.
      const subtotal: Array<string | null> = Array<string | null>(rowLabelWidth).fill(null);
      subtotal[depth] = `${value} Total`;
      cells.push(bodyRow(subtotal, slice(salesData, spec.rowFields, branch)));
    }
  };

  walk(0, []);

  if (spec.rowTotals) {
    const grand: Array<string | null> = Array<string | null>(rowLabelWidth).fill(null);
    grand[0] = "Grand Total";
    cells.push(bodyRow(grand, salesData));
  }

  const width = cells.reduce((widest, row) => Math.max(widest, row.length), 0);
  for (const row of cells) while (row.length < width) row.push(blank);
  return { cells, width };
}
