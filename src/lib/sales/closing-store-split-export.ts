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

import { buildBulkAllocation, epdaUnitsLanded, mergeBulkAllocationIntoSplit } from "@/lib/sales/closing-bulk-allocation";
import { buildOfficeRespread, mergeOfficeRespreadIntoSplit } from "@/lib/sales/closing-office-respread";
import type { ClosingStoreSplit } from "@/lib/sales/closing-store-split-net";
import {
  narrowClosingDetailsToAreas,
  type ClosingDetailsResult,
} from "@/lib/sales/monthly-closing-details";
import {
  netStoreSplitByAreaProduct,
  splitStoreSalesAcrossCityAreas,
  type SplitRegions,
  type StoreSplitAreaMovement,
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
  /**
   * The OFFICE CHANNEL's own slice of `net` — already inside it, carried out separately because the
   * workbook's Office grid ("of wh. Office", and the Closing Matrix (No Office) tab that subtracts it
   * from the matrix cell by cell) must take that part and nothing else: the city split and the bulk
   * rule never touch an Office row, and an Office grid left on the upload's geography while the
   * matrix moves to today's turns that subtraction into negative sales. See
   * closing-office-respread.ts. Empty on every line but CNS and every month before 2026-09.
   */
  officeNet: ReturnType<typeof netStoreSplitByAreaProduct>;
  /**
   * The movements `net` was folded from, per area, line and product.
   *
   * Exposed because the Channel Breakdown grids need the SAME movement the Closing Matrix gets, at
   * area grain rather than area×product. Deriving it a second time from the breakdown's own figures
   * looked equivalent and was not — the two disagreed about which customers are wholesalers and put
   * six Anti Infective areas and eleven Pedia areas out of step with the Matrix on 2026-07. One
   * computation, handed to both write-backs.
   */
  movements: StoreSplitAreaMovement[];
  /**
   * Per brick, the store money of a hand-apportioned customer — money the split deliberately did
   * NOT move. Handed to planChannelBreakdownStoreSplit, whose brick grid reads its own figures and
   * would otherwise debit a brick for a customer the Closing Matrix left alone.
   */
  exemptStoreValueByBrick: ReadonlyMap<string, number>;
  /** Per area|product, the EPDA units rule 2 landed there, whole month. For the EPDA tab only. */
  epdaUnits: ReadonlyMap<string, number>;
};

/**
 * Split the month, then narrow to what is on show.
 *
 * `monthRows` must be the export's rows WITHOUT place narrowing. Row-level filters (distributor,
 * Included/Excluded, free-text search) belong on it already — they define the population being
 * allocated. `scopeAreaCodes` is the areas the filtered matrix kept; empty means the whole month.
 *
 * `shared` is the SCREEN's own split (loadClosingStoreSplit), and passing it is what stops the
 * workbook and the Closing Matrix disagreeing. Until 2026-08-11 this function always derived its
 * own, so the export ran live while the screen read a cache with a 1h TTL — a cross-city customer
 * re-point moved the workbook's area rows and left the screen's alone. Pass it whenever
 * `monthRows` really is the whole month; pass nothing when a row-level filter has narrowed the
 * population, because then the two are legitimately describing different sets of rows and the
 * workbook says so in its filter note.
 */
export function prepareClosingStoreSplit(
  monthRows: ClosingDetailsResult,
  scopeAreaCodes: readonly string[],
  shared?: ClosingStoreSplit | null,
  regions?: SplitRegions,
): ClosingStoreSplitExport {
  // Split ONCE. Both write-backs — the matrix's and the channel grids' — read this one result, so
  // the two sheets cannot describe different movements of the same money.
  const split = shared ?? deriveSplit(monthRows, regions);
  return {
    details: narrowClosingDetailsToAreas(monthRows, scopeAreaCodes),
    exemptStoreValueByBrick: split.exemptStoreValueByBrick,
    movements: split.movements,
    net: split.net,
    officeNet: split.officeNet,
    epdaUnits: split.epdaUnits ?? new Map(),
  };
}

function deriveSplit(
  monthRows: ClosingDetailsResult,
  regions?: SplitRegions,
): ClosingStoreSplit {
  // Others take no share of an El Qema split (owner, 2026-09-08). This is the FALLBACK path —
  // the shared result above already carries the exclusion — so it has to be handed the same set,
  // or a caller that skipped the cache would produce a different workbook from the screen.
  const { exemptStoreValueByBrick, movements } = splitStoreSalesAcrossCityAreas(
    monthRows.rows,
    monthRows.period,
    regions,
  );
  // The EPDA-BULK allocation is folded in HERE TOO (owner, 2026-10-09). This path runs when the
  // screen's shared split could not be used — a failed read, or a row-level filter that narrowed the
  // population — and leaving it out would print a workbook whose Pedia areas disagree with the
  // screen's by exactly the bulk book, on the one path that exists because the two once disagreed.
  // The Office channel's read-time respread is folded in HERE TOO (owner, 2026-10-09), for the same
  // reason and on the same path: a workbook built from this fallback would otherwise print CNS areas
  // that disagree with the screen's by exactly the Office drift, on the one path that exists because
  // the two once disagreed. It also carries the Office-only net out, which this path's Office grid
  // needs — see ClosingStoreSplitExport.officeNet.
  const bulk = buildBulkAllocation(monthRows.rows, monthRows.period, monthRows.line);
  const merged = mergeOfficeRespreadIntoSplit(
    mergeBulkAllocationIntoSplit(
      { exemptStoreValueByBrick, movements, net: netStoreSplitByAreaProduct(movements) },
      bulk,
    ),
    buildOfficeRespread(monthRows.rows, monthRows.period, monthRows.line),
  );
  return { ...merged, epdaUnits: epdaUnitsLanded(bulk, monthRows.period, monthRows.rows) };
}
