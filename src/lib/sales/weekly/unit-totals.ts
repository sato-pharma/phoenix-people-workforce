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

import type { WeeklyBranchRow, WeeklyDashboard, WeeklyFactExportRow } from "@/lib/sales/weekly/types";

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

/**
 * Any other total, asked by the product keys of the rows it adds: its units are one product's exactly
 * when those keys collapse to one. Keys are compared trimmed and upper-cased. A blank key still counts
 * as a key of its own, so a row nobody named can never be folded into a named product's total.
 */
export function weeklyProductKeysAreOne(keys: Iterable<string | null | undefined>): boolean {
  const seen = new Set<string>();
  for (const key of keys) {
    seen.add((key ?? "").trim().toUpperCase());
    if (seen.size > 1) return false;
  }
  return seen.size === 1;
}

/**
 * The Weekly Summarized Report's Month vs Target tab (owner, 2026-09-17: dash every figure). Its sales
 * and its targets are both units, and both are added up the line → region → area tree, so its figures
 * are one product's only when the sales rows AND the target rows of every month it shows name one
 * product between them. The targets count as much as the sales: one product's sales against a line's
 * target set over five products still divides by five products' units.
 */
export function weeklyMonthVsTargetUnitsAreOneProduct(
  months: readonly {
    monthRows: readonly Pick<WeeklyFactExportRow, "productCode" | "productName">[];
    targets: readonly { productCode: string }[];
  }[],
): boolean {
  return weeklyProductKeysAreOne(
    months.flatMap((month) => [
      ...month.monthRows.map((row) => row.productCode || row.productName),
      ...month.targets.map((target) => target.productCode),
    ]),
  );
}

/** One product's movement at one place, for the stock-with-no-sales test below. */
export type WeeklyProductMovement = { netUnits: number; stockUnits: number };

/**
 * STOCK WITH NO SALES (owner, 2026-09-17). A place — a branch — sold nothing only when NO product sold
 * there, each product checked on its own. Adding its products' units first lets one product's returns
 * cancel another product's sales, and a branch that is selling then reads as one that sold nothing. A
 * product has sold once its net units reach half a unit, so returns on their own are not a sale, and
 * the place holds stock when any one product's stock does. The admin dashboard's Stock on hand
 * watchlist and the NSM/DSM export's Stock tab both ask this, and both rank the places that qualify by
 * stock VALUE, never by adding their stock units.
 */
export function weeklyHoldsStockWithNoSales(products: Iterable<WeeklyProductMovement>): boolean {
  let holdsStock = false;
  for (const product of products) {
    if (product.netUnits >= 0.5) return false;
    if (product.stockUnits > 0.5) holdsStock = true;
  }
  return holdsStock;
}

/** The fields of one weekly row the Stock on hand watchlist reads. */
export type WeeklyZeroSalesSourceRow = {
  branchCode: string;
  branchName: string;
  regionName: string;
  productCode: string;
  productName: string;
  salesValue: number;
  netQty: number;
  stockQty: number;
};

/**
 * The admin dashboard's Stock on hand watchlist (`zeroSalesBranches`): branches holding stock that sold
 * nothing, asked per product by weeklyHoldsStockWithNoSales, and ranked by their stock VALUE at the
 * Product Master price (`priceOf`; a product with no price adds nothing). Branchless rows are skipped
 * so the list never shows a "—" branch. The units on each row stay as they were; the screen decides
 * whether to show them (weeklyBreakdownUnitsAreOneProduct).
 */
export function weeklyZeroSalesBranches(
  rows: readonly WeeklyZeroSalesSourceRow[],
  priceOf: (productCode: string) => number | undefined,
): WeeklyBranchRow[] {
  type Branch = {
    branchName: string;
    regionName: string;
    salesValue: number;
    salesUnits: number;
    stockUnits: number;
    stockValue: number;
    products: Map<string, WeeklyProductMovement>;
  };
  const branches = new Map<string, Branch>();
  for (const row of rows) {
    const key = row.branchCode || row.branchName;
    if (!key) continue;
    let branch = branches.get(key);
    if (!branch) {
      branch = {
        branchName: row.branchName || key,
        regionName: row.regionName,
        salesValue: 0,
        salesUnits: 0,
        stockUnits: 0,
        stockValue: 0,
        products: new Map(),
      };
      branches.set(key, branch);
    }
    branch.salesValue += row.salesValue;
    branch.salesUnits += row.netQty;
    branch.stockUnits += row.stockQty;
    branch.stockValue += row.stockQty * (priceOf(row.productCode) ?? 0);
    const productKey = row.productCode || row.productName;
    const product = branch.products.get(productKey) ?? { netUnits: 0, stockUnits: 0 };
    product.netUnits += row.netQty;
    product.stockUnits += row.stockQty;
    branch.products.set(productKey, product);
  }
  return [...branches.entries()]
    .filter(([, branch]) => weeklyHoldsStockWithNoSales(branch.products.values()))
    .sort(([leftKey, left], [rightKey, right]) => right.stockValue - left.stockValue || leftKey.localeCompare(rightKey))
    .map(([branchCode, branch]) => ({
      branchCode,
      branchName: branch.branchName,
      regionName: branch.regionName,
      salesValue: Number(branch.salesValue.toFixed(2)),
      salesUnits: Number(branch.salesUnits.toFixed(2)),
      stockUnits: Number(branch.stockUnits.toFixed(2)),
    }));
}
