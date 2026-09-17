// UNITS OF DIFFERENT PRODUCTS ARE NEVER ADDED (owner rule, 2026-08-27): "If you choose units, you
// don't add units of different concentration or different products to each other. You add their
// values." A unit total means something for ONE product code only; above that the aggregate is value.
//
// How Weekly Sales applies it (owner, 2026-09-16): the Sales Units and Stock Units tiles appear only
// when the numbers on screen cover exactly one product, and the Export's unit totals follow the same
// rule so the file matches the screen. A unit column on a table of regions or distributors is a total
// too, and follows the same test. Every surface asks the questions below rather than re-deriving "one
// product" itself, because the totals are added over DIFFERENT rows.
//
// The admin shell's Weekly Sales Dashboard and its Export Excel (the Weekly BI workbook) follow the same
// rule (owner, 2026-09-17): every unit figure that adds rows appears only while those rows are one
// product's, and the workbook, whose design is locked, keeps its cells and holds a dash in them instead.

import type { WeeklyDashboard, WeeklyFactExportRow } from "@/lib/sales/weekly/types";

/**
 * `kpis.salesUnits` and `kpis.stockUnits` add every row of the selected week(s). `kpis.productCount`
 * counts the distinct product codes over those same rows, so the totals are one product's units
 * exactly when it is 1.
 */
export function weeklyKpiUnitsAreOneProduct(data: Pick<WeeklyDashboard, "kpis">): boolean {
  return data.kpis.productCount === 1;
}

/** The three cuts of the dashboard's Breakdown table. */
export type WeeklyBreakdownCut = "product" | "region" | "distributor";

/**
 * Every cut a table of totals can take: the managers' Breakdown table's three, and the branch cut of the
 * admin dashboard's Branches comparison and Stock on hand watchlist. Kept apart from WeeklyBreakdownCut,
 * which the managers' portal also uses to index its own per-cut lookups, where there is no branch.
 */
export type WeeklyTotalsCut = WeeklyBreakdownCut | "branch";

/**
 * A Breakdown row's units. A PRODUCT row is keyed by one product code, so its units are always one
 * product's. A region, distributor or branch row adds every product it carried over the same rows as the
 * KPI totals (`regions`, `distributorBreakdown`, `branchBreakdown` and `zeroSalesBranches` are all
 * built from them), so its units are one product's only when the whole selection is.
 */
export function weeklyBreakdownUnitsAreOneProduct(
  data: Pick<WeeklyDashboard, "kpis">,
  cut: WeeklyTotalsCut,
): boolean {
  return cut === "product" || weeklyKpiUnitsAreOneProduct(data);
}

/**
 * `weekComparison` adds units over EVERY week in scope, not only the selected one, so a single product
 * in this week proves nothing about the weeks beside it. Only a product filter pinned to one code makes
 * every scoped row the same product, and `appliedFilters.productCode` is set in exactly that case (an
 * include filter holding one code). A viewer whose SCOPE is one product but who set no filter is not
 * covered, and loses nothing true: a hidden total is safe, an added one is the defect.
 */
export function weeklyWeekComparisonUnitsAreOneProduct(data: Pick<WeeklyDashboard, "appliedFilters">): boolean {
  return Boolean(data.appliedFilters.productCode);
}

/**
 * The change against the previous week on a unit tile (`compare.salesUnits`, `compare.stockUnits`). The
 * prior figure adds the previous week's rows, and one product this week proves nothing about that week,
 * so the change is one product's only when the tile is AND a product filter pins every scoped row to
 * that product — the same reason as the week-by-week comparison.
 */
export function weeklyKpiUnitDeltaIsOneProduct(data: Pick<WeeklyDashboard, "kpis" | "appliedFilters">): boolean {
  return weeklyKpiUnitsAreOneProduct(data) && weeklyWeekComparisonUnitsAreOneProduct(data);
}

/**
 * The Weekly BI workbook's own totals. Its formulas add over its hidden Data sheet, which holds
 * `factRows` — the export's grain, which is not always the rows behind `kpis` (the stock grain is lifted
 * for it). So the workbook asks about the rows it actually adds: its unit totals are one product's
 * exactly when those rows carry one product, keyed the way `kpis.productCount` keys it.
 */
export function weeklyFactRowUnitsAreOneProduct(
  rows: readonly Pick<WeeklyFactExportRow, "productCode" | "productName">[],
): boolean {
  return new Set(rows.map((row) => row.productCode || row.productName)).size === 1;
}
