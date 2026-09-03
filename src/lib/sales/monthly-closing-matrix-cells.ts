// The Monthly Closing matrix's cell arithmetic and its pure client-side filter — split out of
// monthly-distributor-import.ts into their own dependency-free module, for the same reason
// official-lines.ts is. Several CLIENT components (Monthly Closing, the portal closing view, the
// closing period picker, the Performance Review — the last two via monthly-closing-period-merge.ts)
// need only this pure roll-up/filter, but monthly-distributor-import.ts also imports
// invalidateSalesDashboardCache (dashboard/invalidation.ts), which reaches
// employee-directory.ts → employee-photo.ts → `node:crypto`. Webpack refuses that in a browser
// bundle (UnhandledSchemeError) — deliberately, employee-photo.ts keeps that import as its
// client-bundle tripwire — but it poisons the whole dev server the moment one of those pages is
// compiled: every later request, /api/healthz included, then 500s. `next build` tree-shakes the
// unused chain away, so production always rendered the pages and only local dev was broken, which
// is why it went unnoticed.
//
// Values and behaviour are unchanged; monthly-distributor-import.ts re-exports all of these so
// every existing server caller keeps importing them from where it already does.

import type {
  MonthlyClosingCell,
  MonthlyClosingColumn,
  MonthlyClosingGrandTotalRow,
  MonthlyClosingMatrix,
  MonthlyClosingRegionGroup,
} from "./monthly-distributor-import";

// Duplicated from monthly-distributor-import.ts's own (module-private) normalizeKey/normalizeCode —
// both one line, unlikely to drift, and duplicating them here avoids pulling this module's runtime
// dependency back onto the 4,000-line file this split exists to get away from.
function normalizeKey(value: unknown) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeCode(value: unknown) {
  return String(value ?? "").trim().toUpperCase();
}

// Exported so the store-split matrix adjustment rolls up with the EXACT same arithmetic the
// matrix was built with — a second, parallel implementation would be free to drift.
export function emptyClosingCell(): MonthlyClosingCell {
  return { achievement: null, salesUnits: 0, salesValue: 0, targetUnits: null, targetValue: null };
}

/**
 * Null-preserving addition for the target columns.
 *
 * A missing target is NOT zero. If a region's areas all lack targets, the subtotal must stay
 * null so the UI renders "—"; folding them in as 0 would both assert "the target is zero" and
 * make every achievement % a division by nothing. Only once at least one contributing cell
 * actually carries a target does the sum become a number.
 */
function addTarget(left: number | null, right: number | null): number | null {
  if (left === null && right === null) return null;
  return (left ?? 0) + (right ?? 0);
}

/** Roll-up adds the sales figures AND the targets; achievement is re-derived from the sums. */
export function addClosingSales(target: MonthlyClosingCell, source: MonthlyClosingCell) {
  target.salesUnits += source.salesUnits;
  target.salesValue += source.salesValue;
  target.targetUnits = addTarget(target.targetUnits, source.targetUnits);
  target.targetValue = addTarget(target.targetValue, source.targetValue);
}

/**
 * Achievement is ALWAYS recomputed from summed value ÷ summed target — never averaged from the
 * per-cell percentages (which would weight a tiny area the same as a whole region), and never
 * emitted against a null or zero target.
 */
function closingAchievement(cell: MonthlyClosingCell): number | null {
  if (cell.targetValue === null || cell.targetValue === 0) return null;
  return cell.salesValue / cell.targetValue;
}

export function roundedClosingCell(cell: MonthlyClosingCell): MonthlyClosingCell {
  const rounded: MonthlyClosingCell = {
    achievement: null,
    salesUnits: Number(cell.salesUnits.toFixed(6)),
    salesValue: Number(cell.salesValue.toFixed(6)),
    targetUnits: cell.targetUnits === null ? null : Number(cell.targetUnits.toFixed(6)),
    targetValue: cell.targetValue === null ? null : Number(cell.targetValue.toFixed(6)),
  };
  rounded.achievement = closingAchievement(rounded);
  return rounded;
}

export function sumClosingRowTotal(cells: MonthlyClosingCell[]): MonthlyClosingCell {
  const total = emptyClosingCell();
  cells.forEach((cell) => addClosingSales(total, cell));
  return roundedClosingCell(total);
}

/**
 * Pure client-side filter. Keeps the selected regions/areas/products (+ free-text area
 * search) and RE-DERIVES region subtotals and the national grand total from the surviving
 * AREA rows only — so the filtered totals stay exact and each area is still counted once.
 * Empty selections mean "all". This mirrors buildMonthlyClosingMatrix's roll-up.
 */
export function filterMonthlyClosingMatrix(
  matrix: MonthlyClosingMatrix,
  filter: { areaCodes?: string[]; productCodes?: string[]; regionCodes?: string[]; search?: string },
): MonthlyClosingMatrix {
  const regionSet = new Set((filter.regionCodes ?? []).map((code) => normalizeCode(code)));
  const areaSet = new Set((filter.areaCodes ?? []).map((code) => normalizeCode(code)));
  const productSet = new Set((filter.productCodes ?? []).map((code) => normalizeCode(code)));
  const search = normalizeKey(filter.search ?? "");

  const keptColumnIndexes: number[] = [];
  const columns: MonthlyClosingColumn[] = [];
  matrix.columns.forEach((column, index) => {
    if (productSet.size === 0 || productSet.has(normalizeCode(column.productCode))) {
      keptColumnIndexes.push(index);
      columns.push(column);
    }
  });

  const projectCells = (cells: MonthlyClosingCell[]) => keptColumnIndexes.map((index) => cells[index]);

  const regions: MonthlyClosingRegionGroup[] = [];
  matrix.regions.forEach((region) => {
    if (regionSet.size > 0 && !regionSet.has(normalizeCode(region.regionCode))) return;

    const areas = region.areas
      .filter((area) => {
        if (areaSet.size > 0 && !areaSet.has(normalizeCode(area.areaCode))) return false;
        if (search) {
          const haystack = `${normalizeKey(area.areaCode)} ${normalizeKey(area.areaName)}`;
          if (!haystack.includes(search)) return false;
        }
        return true;
      })
      .map((area) => {
        const cells = projectCells(area.cells);
        return { ...area, cells, rowTotal: sumClosingRowTotal(cells) };
      });

    if (areas.length === 0) return;

    const subtotalCells = columns.map((_column, columnIndex) => {
      const cell = emptyClosingCell();
      areas.forEach((area) => addClosingSales(cell, area.cells[columnIndex]));
      return roundedClosingCell(cell);
    });

    regions.push({
      areas,
      regionCode: region.regionCode,
      regionName: region.regionName,
      subtotal: {
        cells: subtotalCells,
        kind: "regionSubtotal",
        regionCode: region.regionCode,
        regionName: region.regionName,
        rowTotal: sumClosingRowTotal(subtotalCells),
      },
    });
  });

  const grandCells = columns.map((_column, columnIndex) => {
    const cell = emptyClosingCell();
    regions.forEach((region) => region.areas.forEach((area) => addClosingSales(cell, area.cells[columnIndex])));
    return roundedClosingCell(cell);
  });

  // Carry the Direct – National row through (project to the kept columns) and recompute the
  // company total = filtered grand total + Direct National.
  const directNational = matrix.directNational
    ? (() => {
      const cells = projectCells(matrix.directNational!.cells);
      return { ...matrix.directNational!, cells, rowTotal: sumClosingRowTotal(cells) };
    })()
    : null;
  let companyTotal: MonthlyClosingGrandTotalRow | null = null;
  if (directNational) {
    const companyCells = columns.map((_column, columnIndex) => {
      const cell = emptyClosingCell();
      addClosingSales(cell, grandCells[columnIndex]);
      addClosingSales(cell, directNational.cells[columnIndex]);
      return roundedClosingCell(cell);
    });
    companyTotal = { cells: companyCells, kind: "grandTotal", rowTotal: sumClosingRowTotal(companyCells) };
  }

  return {
    availableLines: matrix.availableLines,
    availablePeriods: matrix.availablePeriods,
    columns,
    companyTotal,
    directNational,
    grandTotal: {
      cells: grandCells,
      kind: "grandTotal",
      rowTotal: sumClosingRowTotal(grandCells),
    },
    line: matrix.line,
    period: matrix.period,
    regions,
  };
}
