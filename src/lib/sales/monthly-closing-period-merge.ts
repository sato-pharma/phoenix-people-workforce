import {
  addClosingSales,
  emptyClosingCell,
  roundedClosingCell,
  sumClosingRowTotal,
  type MonthlyClosingAreaRow,
  type MonthlyClosingCell,
  type MonthlyClosingColumn,
  type MonthlyClosingGrandTotalRow,
  type MonthlyClosingMatrix,
  type MonthlyClosingRegionGroup,
  type MonthlyClosingSubtotalRow,
} from "@/lib/sales/monthly-distributor-import";

// ─────────────────────────────────────────────────────────────────────────────
// Monthly Closing — several months read as one.
//
// PURE — nothing here reads the database, so the period pickers and their labels are safe to import
// from a client component. The loader that actually fetches the months sits beside it in
// monthly-closing-period-load.ts, which is server-only by virtue of what it imports.
//
// The closing is built one month at a time. This folds N of those monthly matrices into a single
// matrix of the same shape, so every screen, filter and export that already understands a closing
// matrix understands a multi-month selection for free — no parallel "multi" rendering path.
//
// THREE RULES GOVERN THE ARITHMETIC HERE.
//
// 1. MERGE BY PRODUCT CODE, NEVER BY COLUMN POSITION. Two months do not carry the same columns: a
//    product with no sales in July is simply absent from July's matrix, so July's column 3 can be
//    Rispadex while August's column 3 is Dopaminict. A positional merge would add one product's
//    units to another's — the exact thing the owner's rule forbids — and it would do it silently,
//    producing a plausible number. Every cell below is placed by its product code.
//
// 2. ADDING UNITS ACROSS MONTHS IS LEGITIMATE; ADDING THEM ACROSS PRODUCTS IS NOT. A column here is
//    still exactly one product code — July's Tebofortin 40mg plus August's Tebofortin 40mg is the
//    same physical pack counted twice over. That is why this file may sum units at all, and why
//    rule 1 is not a nicety.
//
// 3. REUSE THE CLOSING'S OWN ROLL-UP, NEVER A SECOND COPY OF IT. addClosingSales is null-preserving
//    (a missing target stays "—" and never becomes a zero that divides), achievement is always
//    re-derived from summed value ÷ summed target rather than averaged, and the national row is
//    derived from the AREA rows only so no area is counted twice. Re-implementing any of that here
//    would be free to drift from the single-month screen it has to agree with.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read a `periods=` value into an ordered, de-duplicated list.
 *
 * Accepts the comma-separated form the pickers send. Returns oldest-first so the merged label and
 * every "X to Y" span read in the direction people say them.
 */
export function parsePeriodSelection(raw: string | string[] | null | undefined): string[] {
  return parseCodeList(raw);
}

/**
 * Read a code list into an ordered, de-duplicated list.
 *
 * Two callers, two shapes: a query string arrives comma-separated, a JSON body (the export POST)
 * arrives as a real array. Both land here rather than each route inventing its own reading, because
 * a filter that parsed differently on the export path would produce a workbook narrowed differently
 * from the screen that asked for it.
 *
 * Sorted, so a selection produces the same URL however the boxes were ticked — which keeps the
 * request cacheable and makes two identical selections compare equal. For periods that ordering is
 * also chronological, because `YYYY-MM` sorts the way time runs.
 */
export function parseCodeList(raw: string | string[] | null | undefined): string[] {
  const parts = Array.isArray(raw)
    ? raw.flatMap((entry) => String(entry ?? "").split(","))
    : String(raw ?? "").split(",");
  return Array.from(new Set(parts.map((value) => value.trim()).filter((value) => value !== ""))).sort();
}

/**
 * How many months one selection may fold together.
 *
 * Each month is its own round trip to the closing RPCs, so an unbounded selection turns one screen
 * into a dozen sequential heavy reads. Twelve is a full year — beyond that a reader wants a trend,
 * not a total. The cap is enforced where the months are LOADED, not here, so the parser stays a
 * parser.
 */
export const MAX_PERIOD_SELECTION = 12;

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "2026-07" → "July 2026". Anything unparseable is handed back untouched rather than guessed at. */
export function periodLabel(period: string | null | undefined): string {
  const match = /^(\d{4})-(\d{2})$/.exec(String(period ?? "").trim());
  if (!match) return String(period ?? "").trim();
  const month = Number(match[2]);
  if (!Number.isInteger(month) || month < 1 || month > 12) return String(period ?? "").trim();
  return `${MONTH_NAMES[month - 1]} ${match[1]}`;
}

/**
 * How a period selection is named on screen and in a workbook.
 *
 * One month is just that month. Two are joined. Three or more state the count first, because the
 * count is the thing a reader needs before they trust a total that is several months deep.
 */
export function describePeriodSelection(periods: string[]): string {
  const ordered = Array.from(new Set(periods.filter(Boolean))).sort();
  if (ordered.length === 0) return "";
  if (ordered.length === 1) return periodLabel(ordered[0]);
  const first = periodLabel(ordered[0]);
  const last = periodLabel(ordered[ordered.length - 1]);
  if (ordered.length === 2) return `${first} and ${last}`;
  return `${ordered.length} months · ${first} to ${last}`;
}

/** True when this matrix is several months folded together — the signal single-month actions read. */
export function isMultiPeriodMatrix(matrix: Pick<MonthlyClosingMatrix, "periods">): boolean {
  return (matrix.periods?.length ?? 0) > 1;
}

type ColumnIndex = { columns: MonthlyClosingColumn[]; indexOf: Map<string, number> };

function productKey(productCode: string): string {
  return String(productCode ?? "").trim().toUpperCase();
}

/**
 * The union of every month's columns, in first-seen order.
 *
 * A product that sold in August but not July still earns a column, and it lands in the same place
 * for every row — that is what makes the by-code placement below safe.
 */
function mergeColumns(matrices: MonthlyClosingMatrix[]): ColumnIndex {
  const columns: MonthlyClosingColumn[] = [];
  const indexOf = new Map<string, number>();
  matrices.forEach((matrix) => {
    matrix.columns.forEach((column) => {
      const key = productKey(column.productCode);
      if (indexOf.has(key)) return;
      indexOf.set(key, columns.length);
      columns.push(column);
    });
  });
  return { columns, indexOf };
}

/** Per-matrix map from a merged column index back to that matrix's own cell for the same product. */
function projectRow(
  cells: MonthlyClosingCell[],
  matrixColumns: MonthlyClosingColumn[],
  index: ColumnIndex,
  into: MonthlyClosingCell[],
) {
  matrixColumns.forEach((column, position) => {
    const target = index.indexOf.get(productKey(column.productCode));
    if (target === undefined) return;
    const source = cells[position];
    if (!source) return;
    addClosingSales(into[target], source);
  });
}

function freshRow(width: number): MonthlyClosingCell[] {
  return Array.from({ length: width }, () => emptyClosingCell());
}

type AreaAccumulator = {
  cells: MonthlyClosingCell[];
  seed: MonthlyClosingAreaRow;
  storeSplitAdjusted: boolean;
};

type RegionAccumulator = {
  areas: Map<string, AreaAccumulator>;
  order: string[];
  regionCode: string;
  regionName: string;
  storeSplitAdjusted: boolean;
};

/**
 * Fold several single-month closing matrices into one matrix of the same shape.
 *
 * Hands back the single matrix untouched when there is only one, so a one-month selection is
 * byte-for-byte what the closing already renders rather than a re-derived lookalike.
 *
 * Throws on an empty list: a caller with no months to merge has a bug, and returning an empty
 * matrix would render as a real closing that happens to be all zeros.
 */
export function mergeMonthlyClosingMatrices(matrices: MonthlyClosingMatrix[]): MonthlyClosingMatrix {
  const usable = matrices.filter((matrix): matrix is MonthlyClosingMatrix => Boolean(matrix));
  if (usable.length === 0) {
    throw new Error("Cannot merge an empty list of Monthly Closing matrices.");
  }

  const periods = Array.from(
    new Set(usable.map((matrix) => matrix.period).filter((period): period is string => Boolean(period))),
  ).sort();

  if (usable.length === 1) {
    return { ...usable[0], periods: periods.length > 0 ? periods : undefined };
  }

  const index = mergeColumns(usable);
  const width = index.columns.length;

  const regions = new Map<string, RegionAccumulator>();
  const regionOrder: string[] = [];

  usable.forEach((matrix) => {
    matrix.regions.forEach((region) => {
      const regionKey = String(region.regionCode ?? "").trim().toUpperCase();
      let bucket = regions.get(regionKey);
      if (!bucket) {
        bucket = {
          areas: new Map(),
          order: [],
          regionCode: region.regionCode,
          regionName: region.regionName,
          storeSplitAdjusted: false,
        };
        regions.set(regionKey, bucket);
        regionOrder.push(regionKey);
      }

      region.areas.forEach((area) => {
        const areaKey = String(area.areaCode ?? "").trim().toUpperCase();
        let target = bucket.areas.get(areaKey);
        if (!target) {
          target = { cells: freshRow(width), seed: area, storeSplitAdjusted: false };
          bucket.areas.set(areaKey, target);
          bucket.order.push(areaKey);
        }
        projectRow(area.cells, matrix.columns, index, target.cells);
        // Once ANY month in the selection was store-split adjusted, the merged row's numbers no
        // longer match a live SUMIFS over the raw rows — so the flag rides through, and the export
        // keeps rendering static values instead of a formula that would recalculate back.
        if (area.storeSplitAdjusted) {
          target.storeSplitAdjusted = true;
          bucket.storeSplitAdjusted = true;
        }
      });
    });
  });

  const mergedRegions: MonthlyClosingRegionGroup[] = regionOrder.map((regionKey) => {
    const bucket = regions.get(regionKey)!;
    const areas: MonthlyClosingAreaRow[] = bucket.order.map((areaKey) => {
      const accumulator = bucket.areas.get(areaKey)!;
      const cells = accumulator.cells.map((cell) => roundedClosingCell(cell));
      return {
        ...accumulator.seed,
        cells,
        rowTotal: sumClosingRowTotal(cells),
        ...(accumulator.storeSplitAdjusted ? { storeSplitAdjusted: true } : {}),
      };
    });

    // Region subtotals come from the AREA rows, never from summing each month's own subtotal —
    // identical arithmetic to buildMonthlyClosingMatrix and filterMonthlyClosingMatrix, so a
    // merged screen and a single-month screen roll up the same way.
    const subtotalCells = index.columns.map((_column, columnIndex) => {
      const cell = emptyClosingCell();
      areas.forEach((area) => addClosingSales(cell, area.cells[columnIndex]));
      return roundedClosingCell(cell);
    });

    const subtotal: MonthlyClosingSubtotalRow = {
      cells: subtotalCells,
      kind: "regionSubtotal",
      regionCode: bucket.regionCode,
      regionName: bucket.regionName,
      rowTotal: sumClosingRowTotal(subtotalCells),
      ...(bucket.storeSplitAdjusted ? { storeSplitAdjusted: true } : {}),
    };

    return { areas, regionCode: bucket.regionCode, regionName: bucket.regionName, subtotal };
  });

  const grandCells = index.columns.map((_column, columnIndex) => {
    const cell = emptyClosingCell();
    mergedRegions.forEach((region) => region.areas.forEach((area) => addClosingSales(cell, area.cells[columnIndex])));
    return roundedClosingCell(cell);
  });

  // Direct – National rides alongside the regions (it belongs to no area), so it merges on its own
  // and the company total is rebuilt from grand + direct exactly as the single-month filter does.
  const directSeed = usable.find((matrix) => matrix.directNational)?.directNational ?? null;
  let directNational: MonthlyClosingSubtotalRow | null = null;
  if (directSeed) {
    const accumulated = freshRow(width);
    usable.forEach((matrix) => {
      if (!matrix.directNational) return;
      projectRow(matrix.directNational.cells, matrix.columns, index, accumulated);
    });
    const cells = accumulated.map((cell) => roundedClosingCell(cell));
    directNational = { ...directSeed, cells, rowTotal: sumClosingRowTotal(cells) };
  }

  let companyTotal: MonthlyClosingGrandTotalRow | null = null;
  if (directNational) {
    const companyCells = index.columns.map((_column, columnIndex) => {
      const cell = emptyClosingCell();
      addClosingSales(cell, grandCells[columnIndex]);
      addClosingSales(cell, directNational!.cells[columnIndex]);
      return roundedClosingCell(cell);
    });
    companyTotal = { cells: companyCells, kind: "grandTotal", rowTotal: sumClosingRowTotal(companyCells) };
  }

  return {
    availableLines: usable[0].availableLines,
    availablePeriods: usable[0].availablePeriods,
    columns: index.columns,
    companyTotal,
    directNational,
    grandTotal: { cells: grandCells, kind: "grandTotal", rowTotal: sumClosingRowTotal(grandCells) },
    line: usable[0].line,
    // The LATEST month is the merged matrix's identity, so anything that still needs one month
    // (the publish and lock routes) reads a real period rather than a synthetic range string.
    // `periods` beside it is what tells those callers to refuse a multi-month selection outright.
    period: periods.length > 0 ? periods[periods.length - 1] : usable[0].period,
    periods,
    regions: mergedRegions,
  };
}
