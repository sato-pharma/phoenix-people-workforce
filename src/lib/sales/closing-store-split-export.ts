// Preparing the store split for a Monthly Closing EXPORT.
//
// The rule itself lives in store-sales-city-split.ts and the matrix write-back in
// store-split-matrix.ts. This module owns the one thing neither of them can see: the ORDER the
// export has to do them in when the reader has filtered the screen.
//
// THE OWNER'S RULE (2026-08-04). A store in Alex East selling 750 boxes is 250 / 250 / 250 across
// Alex East, Alex West and Alex Center — a wholesaler supplies its whole city, so its sell-in is
// shared evenly across every area of that city. That allocation is a property of the MONTH. It
// must not change because someone filtered the export to one area.
//
// SO: allocate over the whole month FIRST, narrow to the exported areas SECOND. Doing it the other
// way round loses money in both directions — an in-scope store's share to excluded areas is
// dropped, and an in-scope area never receives its share from an excluded store in the same city.
// Filtering to one Cairo area used to delete 83% of that area's store sales from the headline.
//
// Whatever share still belongs to areas outside the export does NOT disappear: applyStoreSplitToMatrix
// reports it, and the workbook states it on the Total sheet as its own reconciliation line, so the
// Difference row still proves the audit sheet reproduces the headline.

import {
  narrowClosingDetailsToAreas,
  type ClosingDetailsResult,
} from "@/lib/sales/monthly-closing-details";
import {
  netStoreSplitByAreaProduct,
  splitStoreSalesAcrossCityAreas,
} from "@/lib/sales/store-sales-city-split";

export type ClosingStoreSplitExport = {
  /**
   * The rows every sheet in the workbook is written from — the month narrowed to the areas the
   * filtered matrix kept. Identical to `monthRows` when nothing was filtered.
   */
  details: ClosingDetailsResult;
  /**
   * Per area and product, what the split moves — derived from the WHOLE month, so it carries
   * deltas for areas outside the export on purpose. applyStoreSplitToMatrix skips those and reports
   * the amount, which is what lets the workbook name it instead of losing it.
   */
  net: ReturnType<typeof netStoreSplitByAreaProduct>;
};

/**
 * Split the month, then narrow to what is on show.
 *
 * `monthRows` must be the export's rows WITHOUT place narrowing. Row-level filters (distributor,
 * Included/Excluded, free-text search) belong on it already — they define the population being
 * allocated. `scopeAreaCodes` is the areas the filtered matrix kept; empty means the whole month.
 */
export function prepareClosingStoreSplit(
  monthRows: ClosingDetailsResult,
  scopeAreaCodes: readonly string[],
): ClosingStoreSplitExport {
  return {
    details: narrowClosingDetailsToAreas(monthRows, scopeAreaCodes),
    net: netStoreSplitByAreaProduct(splitStoreSalesAcrossCityAreas(monthRows.rows).movements),
  };
}
