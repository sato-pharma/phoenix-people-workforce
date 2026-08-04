// Applying the store split to the Closing Matrix.
//
// The rule itself lives in store-sales-city-split.ts and is pure. This module is the one place
// that pushes its result into the area x product grid, and it is kept separate so the rule stays
// free of any dependency on the 4,000-line matrix module.
//
// WHAT MOVES AND WHAT DOES NOT (owner, 2026-08-04):
//   - Sales move. A store's sell-in is shared across its city's areas, so area cells change.
//   - TARGETS ARE NEVER TOUCHED. targetUnits and targetValue are carried through untouched.
//   - Achievement therefore recomputes as NEW sales / the SAME target, which is exactly what the
//     owner asked for: "targets as it is never touch it, and yes of course sales will differ."
//     roundedClosingCell already re-derives achievement that way, so nothing here computes a
//     percentage by hand.
//   - Direct rows never move: they carry no area and are attributed to line+region only. The
//     synthetic in-region Direct row, directNational and companyTotal are all passed through.
//
// THE GRAND TOTAL CANNOT CHANGE. A store's sale leaves its origin area and is distributed, in
// full and for the same product, among areas of the same city — so the net for any product across
// all areas is zero. Subtotals and the grand total are adjusted by the SAME deltas rather than
// rebuilt from scratch, so a cell the split never touches is byte-identical to before.
//
// EVERY ROW THE SPLIT TOUCHES IS FLAGGED (`storeSplitAdjusted`) — area, region subtotal and
// grand total each only when its own net delta is non-zero. The export's Closing Matrix sheet
// writes live SUMIFS formulas over the RAW distributor rows, which know nothing of this
// redistribution; on a touched row that formula would recalculate straight back to the pre-split
// value on the first edit in Excel, so the export renders flagged rows as static values instead.
// On a whole-month export the region and grand deltas cancel to zero and those rows keep their
// live formulas — only rows whose cached number actually differs from the raw rows lose them.

import {
  addClosingSales,
  emptyClosingCell,
  roundedClosingCell,
  sumClosingRowTotal,
  type MonthlyClosingCell,
  type MonthlyClosingMatrix,
} from "@/lib/sales/monthly-distributor-import";
import { areaProductKey } from "@/lib/sales/store-sales-city-split";

type NetMap = ReadonlyMap<string, { qty: number; value: number }>;

/** Add a delta to one cell, leaving both target columns exactly as they were. */
function adjustCell(cell: MonthlyClosingCell, delta: { qty: number; value: number }): MonthlyClosingCell {
  return roundedClosingCell({
    achievement: cell.achievement,
    salesUnits: cell.salesUnits + delta.qty,
    salesValue: cell.salesValue + delta.value,
    // Untouched, on the owner's instruction. roundedClosingCell re-derives achievement from the
    // new sales over this same target.
    targetUnits: cell.targetUnits,
    targetValue: cell.targetValue,
  });
}

/**
 * Redistribute the matrix's non-direct area cells by the store split. Returns the matrix
 * unchanged when there is nothing to move, so a month with no store customers is untouched.
 */
export function applyStoreSplitToMatrix(matrix: MonthlyClosingMatrix, net: NetMap): MonthlyClosingMatrix {
  if (net.size === 0) return matrix;

  // Per product column, the total delta applied across every area — used to move the grand total
  // by exactly the same amount the areas moved (which is zero, but derived rather than assumed).
  const columnDelta = matrix.columns.map(() => ({ qty: 0, value: 0 }));
  let anyChange = false;

  const regions = matrix.regions.map((region) => {
    const regionDelta = matrix.columns.map(() => ({ qty: 0, value: 0 }));

    const areas = region.areas.map((area) => {
      // The synthetic Direct row inside a region has no real area and never participates.
      if (area.isDirect) return area;
      let areaChanged = false;
      const cells = area.cells.map((cell, index) => {
        const column = matrix.columns[index];
        if (!column) return cell;
        const delta = net.get(areaProductKey(area.areaCode, column.productCode));
        if (!delta || (delta.qty === 0 && delta.value === 0)) return cell;
        areaChanged = true;
        anyChange = true;
        regionDelta[index].qty += delta.qty;
        regionDelta[index].value += delta.value;
        columnDelta[index].qty += delta.qty;
        columnDelta[index].value += delta.value;
        return adjustCell(cell, delta);
      });
      if (!areaChanged) return area;
      // Flagged so the export writes this row as static values — see the module note above.
      return { ...area, cells, rowTotal: sumClosingRowTotal(cells), storeSplitAdjusted: true };
    });

    const regionChanged = regionDelta.some((delta) => delta.qty !== 0 || delta.value !== 0);
    if (!regionChanged) return { ...region, areas };

    const subtotalCells = region.subtotal.cells.map((cell, index) => adjustCell(cell, regionDelta[index]));
    return {
      ...region,
      areas,
      subtotal: {
        ...region.subtotal,
        cells: subtotalCells,
        rowTotal: sumClosingRowTotal(subtotalCells),
        // regionChanged gated this branch, so this subtotal's cached numbers moved off the raw rows.
        storeSplitAdjusted: true,
      },
    };
  });

  if (!anyChange) return matrix;

  // A non-zero net at grand level only happens on a filtered matrix — a one-sided move whose
  // counterpart areas were filtered out. A whole-month split cancels to zero here, and an
  // unflagged grand total keeps its live formula in the export.
  const grandChanged = columnDelta.some((delta) => delta.qty !== 0 || delta.value !== 0);
  const grandCells = matrix.grandTotal.cells.map((cell, index) => adjustCell(cell, columnDelta[index]));
  return {
    ...matrix,
    grandTotal: {
      ...matrix.grandTotal,
      cells: grandCells,
      rowTotal: sumClosingRowTotal(grandCells),
      ...(grandChanged ? { storeSplitAdjusted: true } : {}),
    },
    regions,
  };
}

/** Sum a matrix's whole sales value — used by tests to prove the split never moves the headline. */
export function matrixSalesValue(matrix: MonthlyClosingMatrix): number {
  const total = emptyClosingCell();
  matrix.regions.forEach((region) => region.areas.forEach((area) => area.cells.forEach((cell) => addClosingSales(total, cell))));
  return Number(total.salesValue.toFixed(6));
}
