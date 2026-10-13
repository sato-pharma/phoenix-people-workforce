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
import { isSyntheticDirectArea } from "@/lib/sales/closing-direct-area";
import { foldAreaCodeForLine } from "@/lib/sales/closing-area-merges";
import { resolveTargetLineCode } from "@/lib/sales/monthly-targets";
import { areaProductKey } from "@/lib/sales/store-sales-city-split";

type NetMap = ReadonlyMap<string, { qty: number; value: number }>;

/**
 * The first month whose split net is re-keyed onto a merged area row — owner, 2026-10-13: "widen the
 * CNS Qena merge to January too", overruling the recommendation to leave it at July.
 *
 * Dated for the same reason every money rule in this module is: a correction with no start period
 * restates every month the system can still read, published ones included. It shipped at 2026-07
 * the same day ("ship the fold fix dated from july") and he moved it back hours later so the CNS
 * Qena fold could reach January with it. 🔴 THE TWO DATES ARE TIED — the CNS Qena rule in
 * `CLOSING_AREA_MERGES` also starts at 2026-01, and a merge in force OUTSIDE this window drops the
 * folded-away area's leg, so widening either one alone re-opens the defect this function closes.
 *
 * What it moves, measured against production on both days:
 *
 *   2026-08       Pedia Fayoum - Beni Suef 53,632.99 -> 99,192.98, and the line's August total up by
 *                 the same 45,559.99 EGP it was losing. That is the original fix.
 *   2026-01..06   CNS QENA ALONE. Before 2026-07 `au.monthly_store_split_net` holds CNS rows ONLY —
 *                 49 areas a month, summing to exactly 0.00 — because the Office read-time respread
 *                 is CNS-only and the city split begins in August (`isStoreCitySplitActive`). So
 *                 Pedia's GZ6/UE9 fold, which IS in force in those months, has no leg to re-key, and
 *                 Anti Infective's rule starts in September. UE8's own legs are January +155.30
 *                 packs, February -74.58, March -36.09, April -0.54, May -102.33, June +6.46.
 *
 * No month before 2026-07 carries a `monthly_closing_publications` row, so widening it restated
 * nothing that has been sent out. Moving this constant is his word, never a session's.
 */
export const MERGED_AREA_SPLIT_FOLD_START_PERIOD = "2026-01";

/**
 * Re-key a split net onto the area rows this matrix actually renders.
 *
 * 🔴 A MERGED AREA ROW IS THE ONE CASE WHERE "NOWHERE TO LAND" IS A DEFECT RATHER THAN A FILTER.
 * `applyStoreSplitToMatrix` asks the net one question per row it renders — `areaProductKey(area
 * .areaCode, product)` — and skips a delta no row claims. Correct for a FILTERED export, where the
 * net covers the whole month and the sheet covers three areas. But `applyClosingAreaMerges` folds
 * Fayoum (`GZ6`) + Beni Suef (`UE9`) into ONE row keyed `GZ6` (Pedia up to and including 2026-08,
 * CNS from 2026-08) and Suez + Ismailia into one keyed `OT2` (Anti Infective from 2026-09) — so on a
 * WHOLE-MONTH read the folded-away code has no row either, and its share of the city split, the
 * EPDA-BULK allocation and the Office respread had nowhere to go.
 *
 * Measured on production 2026-10-13, Pedia 2026-08: the net took 25,720.02 EGP off Fayoum and put
 * 45,559.99 on Beni Suef; the first landed, the second was dropped, and the line's national total
 * fell by it. Two independent surfaces — Source of Sales and `phx_sales_vs_target_range` — both read
 * the 99,192.98 the closing was printing as 53,632.99. A redistribution that changes the grand total
 * is the whole defect in one sentence, and this module's own invariant says it cannot happen.
 *
 * So each key's area is folded exactly the way its ROW was, through the same dated helper
 * (`foldAreaCodeForLine`), and two legs that collide on one row are ADDED rather than overwritten —
 * Fayoum's own leg and Beni Suef's both belong to the merged row. The returned keys are therefore
 * the codes the sheet uses, which is also what `cells` must carry: the workbook's Total sheet adds
 * each landed delta to that area's Data rows, and those rows are folded the same way by
 * `applyClosingAreaMergesToDetails`.
 *
 * Returns the SAME map when nothing folds, so every line and month without a merge rule in force is
 * byte-identical to before.
 */
export function foldNetOntoMergedAreas(
  matrix: Pick<MonthlyClosingMatrix, "line" | "period">,
  net: NetMap,
): NetMap {
  const period = String(matrix.period ?? "").trim();
  // A malformed or absent period falls back to NOT folding, which is the pre-fix behaviour: failing
  // to fold leaves a number that has been wrong since the merge rule landed, while folding a month
  // this was never dated for would restate one the owner published.
  if (!/^\d{4}-\d{2}$/.test(period) || period < MERGED_AREA_SPLIT_FOLD_START_PERIOD) return net;
  const lineCode = resolveTargetLineCode(matrix.line);
  if (!lineCode) return net;

  const folded = new Map<string, { qty: number; value: number }>();
  let anyFolded = false;
  for (const [key, delta] of net) {
    // Area first, product after the separator. An area code never carries "|", so the first one is
    // the only separator that matters.
    const cut = key.indexOf("|");
    const area = cut < 0 ? key : key.slice(0, cut);
    // The row's own code for this line and month — `UE9` -> `GZ6` where the pair is folded, and the
    // code itself everywhere else, including every line and month with no rule in force.
    const rowArea = cut < 0 ? area : foldAreaCodeForLine(lineCode, area, period);
    const rowKey = rowArea === area ? key : areaProductKey(rowArea, key.slice(cut + 1));
    if (rowKey !== key) anyFolded = true;
    const soFar = folded.get(rowKey);
    folded.set(
      rowKey,
      soFar ? { qty: soFar.qty + delta.qty, value: soFar.value + delta.value } : delta,
    );
  }
  return anyFolded ? folded : net;
}

export type StoreSplitApplication = {
  matrix: MonthlyClosingMatrix;
  /**
   * What the split actually moved INTO this matrix — the exact amount its grand total shifted by.
   *
   * On a whole-month export this is zero: every share of a store's sale lands on an area that is
   * present, so the ins and outs cancel. On a FILTERED export it is not, and the sign is the
   * reader's answer: negative means store sales in these areas belong to city areas the filter
   * excluded; positive means these areas received a share from a store the filter excluded.
   *
   * It is reported rather than recomputed because this function is the only thing that knows which
   * deltas found a home: a delta for an area row or product column that is not in this matrix is
   * skipped here, and a second implementation of that rule would be free to drift from it.
   */
  applied: { qty: number; value: number };
  /**
   * The same landed deltas cell by cell, keyed by areaProductKey(area, product). `applied` is
   * their sum. The admin workbook's Total sheet adds each one to that area's Data rows, so every
   * area there agrees with the Closing Matrix and not only the grand total (owner, 2026-09-18).
   * Only deltas that found a cell appear; the map is empty when nothing moved.
   */
  cells: ReadonlyMap<string, { qty: number; value: number }>;
};

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
 *
 * `net` is computed over the WHOLE month's rows, never over the filtered ones — see
 * narrowClosingDetailsToAreas. So on a filtered export this deliberately receives deltas for areas
 * that are not in `matrix`; they have nowhere to land and are skipped, and the amount skipped is
 * exactly what `applied` lets the caller state out loud instead of losing.
 *
 * A MERGED area row is the one case where that skip is a defect instead of a filter, so the net is
 * re-keyed onto the rows this matrix renders first — see foldNetOntoMergedAreas.
 */
export function applyStoreSplitToMatrix(matrix: MonthlyClosingMatrix, net: NetMap): StoreSplitApplication {
  const nothingApplied = { qty: 0, value: 0 };
  if (net.size === 0) return { applied: nothingApplied, cells: new Map(), matrix };
  // Folded BEFORE anything is read, so the area rows, their region subtotals, the grand total,
  // `applied` and `cells` all describe one population. The same map comes back untouched for every
  // line and month with no merge rule in force.
  const effectiveNet = foldNetOntoMergedAreas(matrix, net);

  // Per product column, the total delta applied across every area — used to move the grand total
  // by exactly the same amount the areas moved (which is zero, but derived rather than assumed).
  const columnDelta = matrix.columns.map(() => ({ qty: 0, value: 0 }));
  // Every delta that landed, by the key it was looked up under. Accumulated rather than set, so an
  // area the matrix happens to list twice reports what its two rows received between them.
  const landed = new Map<string, { qty: number; value: number }>();
  let anyChange = false;

  const regions = matrix.regions.map((region) => {
    const regionDelta = matrix.columns.map(() => ({ qty: 0, value: 0 }));

    const areas = region.areas.map((area) => {
      // The synthetic "Direct orders (company)" row has no real area and never participates —
      // identified by its areaCode, NEVER by `isDirect` alone.
      //
      // `isDirect` means two different things on an area row, exactly as monthly-closing-export.ts
      // already spells out: the synthetic Direct pseudo-area (areaCode "DIRECT"), and — in July
      // 2026 — a REAL area that absorbed hand-mapped direct money and is still Kafr El-Sheikh or
      // Menoufia. Treating the second as the first skipped those areas' city split on the master
      // while the Retail tab and the Store Split sheet still applied it, so the redistribution
      // stopped netting to zero and the master's own grand total moved: Anti Infective 2026-07
      // came out 22,336.87 EGP short. A total-preserving move that changes the total is the whole
      // bug in one sentence.
      if (isSyntheticDirectArea(area)) return area;
      let areaChanged = false;
      const cells = area.cells.map((cell, index) => {
        const column = matrix.columns[index];
        if (!column) return cell;
        const key = areaProductKey(area.areaCode, column.productCode);
        const delta = effectiveNet.get(key);
        if (!delta || (delta.qty === 0 && delta.value === 0)) return cell;
        areaChanged = true;
        anyChange = true;
        const soFar = landed.get(key) ?? { qty: 0, value: 0 };
        landed.set(key, { qty: soFar.qty + delta.qty, value: soFar.value + delta.value });
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

  if (!anyChange) return { applied: nothingApplied, cells: new Map(), matrix };

  // A non-zero net at grand level only happens on a filtered matrix — a one-sided move whose
  // counterpart areas were filtered out. A whole-month split cancels to zero here, and an
  // unflagged grand total keeps its live formula in the export.
  const grandChanged = columnDelta.some((delta) => delta.qty !== 0 || delta.value !== 0);
  const grandCells = matrix.grandTotal.cells.map((cell, index) => adjustCell(cell, columnDelta[index]));
  // Summed across every product column, this IS the shift in the grand total — the same deltas
  // were added to the areas, their region subtotals and the grand total, so one sum covers all three.
  const applied = columnDelta.reduce(
    (total, delta) => ({ qty: total.qty + delta.qty, value: total.value + delta.value }),
    { qty: 0, value: 0 },
  );
  return {
    // Rounded because the per-cell nets accumulate in floating point: summing the same money in a
    // different ORDER is not bit-identical, so a whole-month split can leave a ~1e-9 EGP residue
    // here. Without this a filtered-export disclosure line would appear on an unfiltered workbook
    // reading 0.000000, which in a reconciliation reads as a defect rather than as reassurance.
    applied: { qty: Number(applied.qty.toFixed(6)), value: Number(applied.value.toFixed(6)) },
    cells: landed,
    matrix: {
      ...matrix,
      grandTotal: {
        ...matrix.grandTotal,
        cells: grandCells,
        rowTotal: sumClosingRowTotal(grandCells),
        ...(grandChanged ? { storeSplitAdjusted: true } : {}),
      },
      regions,
    },
  };
}

/** Sum a matrix's whole sales value — used by tests to prove the split never moves the headline. */
export function matrixSalesValue(matrix: MonthlyClosingMatrix): number {
  const total = emptyClosingCell();
  matrix.regions.forEach((region) => region.areas.forEach((area) => area.cells.forEach((cell) => addClosingSales(total, cell))));
  return Number(total.salesValue.toFixed(6));
}
