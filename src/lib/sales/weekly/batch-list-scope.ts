import type { WeeklyAccessScope } from "@/lib/sales/weekly/access";
import type { WeeklyBatch } from "@/lib/sales/weekly/types";

// The Upload screen's history list.
//
// Every upload carries STORED totals — units, stock and sales value — that add every row the sheet
// holds, the restricted products (Lacto Basic 1 and 2, Satoslim) and the Head Office line included.
// The list is read with the service-role client, so nothing below the route trims it, and it is
// offered to every holder of weekly_sales:import: the SFE Manager among them, who sees everything
// EXCEPT those (weekly/access.ts). Until 2026-09-20 the list handed him each upload's stored totals
// in the response and in the page's own props, so the restricted and Head Office value was one
// network tab away, even though the screen only prints the row count and dashes for the units.
//
// A viewer who is not scoped to see every row gets those figures as null — withheld, never zero,
// because a zero reads as "this upload sold nothing" — instead of a recomputed figure: the screen
// prints none of them, and re-adding a scope-cut total per upload would mean reading every row of
// every upload on each page load. The row count stays: it is the length of the file, not a sale.

/** The stored figures of an upload that add the rows a scope may hide. */
export const WEEKLY_BATCH_HIDDEN_FIGURES = [
  "totalSalesQty",
  "totalReturnQty",
  "totalNetQty",
  "totalBonusQty",
  "totalSalesValue",
  "totalStockQty",
] as const satisfies readonly (keyof WeeklyBatch)[];

/**
 * True only for a viewer who sees every row of every upload: the full tier that reveals the
 * restricted products AND the Head Office line (CEO, Super Admin, the exception accounts). Any
 * other tier — a product list, a territory, no access — is bounded, and so is a full-tier viewer
 * missing either reveal (the SFE Manager).
 */
export function weeklyScopeSeesEveryRow(scope: WeeklyAccessScope): boolean {
  return scope.tier === "full" && scope.canViewRestricted && scope.canViewHeadOffice;
}

/**
 * The upload list as this viewer may read it. The scope is a required argument with no default: a
 * caller that forgets it does not compile, where a default would be a fail-open.
 */
export function scopeWeeklyBatchesForViewer(
  batches: readonly WeeklyBatch[],
  scope: WeeklyAccessScope,
): WeeklyBatch[] {
  if (weeklyScopeSeesEveryRow(scope)) return [...batches];
  return batches.map((batch) => {
    const scoped: WeeklyBatch = { ...batch };
    for (const figure of WEEKLY_BATCH_HIDDEN_FIGURES) scoped[figure] = null;
    return scoped;
  });
}
