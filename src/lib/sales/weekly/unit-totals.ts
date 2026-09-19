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
//
// ONE PRODUCT AT A TIME (owner, 2026-09-19): a screen no longer hides or dashes a unit figure its rows
// would add across products. It shows that figure for ONE product — the one picked in its "Units for" bar,
// else the top product by value — and names the product beside it. Units are still never added across
// products; only what the screen shows in their place changed. The exports keep the rule above.

import type {
  WeeklyBranchRow,
  WeeklyBranchSummary,
  WeeklyDashboard,
  WeeklyDashboardUnitView,
  WeeklyDelta,
  WeeklyFactExportRow,
  WeeklyRegionSummary,
  WeeklySalesValidationResult,
  WeeklyTotals,
  WeeklyUnitFigures,
} from "@/lib/sales/weekly/types";

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

/** What the Upload screen's unit tiles, By branch and By region print. */
export type WeeklyUploadUnitScope = {
  /** the picked product's key; null when the whole sheet is one product, so nothing needs picking */
  productKey: string | null;
  productName: string | null;
  totals: Pick<WeeklyTotals, "salesQty" | "returnQty" | "netQty" | "stockQty">;
  byBranch: WeeklyBranchSummary[];
  byRegion: WeeklyRegionSummary[];
};

/**
 * The Upload screen's unit figures (owner, 2026-09-19). A sheet of ONE product prints its own totals, By
 * branch and By region as they stand. A sheet of several products never adds their units, so it prints
 * them for the ONE product picked on the screen — the Upload screen's counterpart of the dashboard's
 * Product filter. A pick this result does not hold (another file was validated since) falls back to its
 * first product, the largest by value. null only when there is no product to show, and the screen then
 * keeps its dashes.
 */
export function weeklyUploadUnitScope(
  result: Pick<WeeklySalesValidationResult, "totals" | "byProduct" | "byBranch" | "byRegion" | "byProductGeography">,
  pickedProductKey: string | null,
): WeeklyUploadUnitScope | null {
  if (weeklyProductKeysAreOne(result.byProduct.map((product) => product.productCode || product.productName))) {
    return { productKey: null, productName: null, totals: result.totals, byBranch: result.byBranch, byRegion: result.byRegion };
  }
  const product = result.byProduct.find((entry) => entry.productCode === pickedProductKey) ?? result.byProduct[0];
  const geography = product && result.byProductGeography.find((entry) => entry.productCode === product.productCode);
  if (!product || !geography) return null;
  return {
    productKey: product.productCode,
    productName: product.productName || product.productCode,
    totals: product,
    byBranch: geography.byBranch,
    byRegion: geography.byRegion,
  };
}

/** The key of one week of `weekComparison`, and of WeeklyDashboardUnitView.weeks. */
export function weeklyWeekKey(cycleMonth: string, weekNumber: number): string {
  return `${cycleMonth}||${weekNumber}`;
}

/**
 * Which product a "Units for" figure shows (owner, 2026-09-19): the one picked on the screen while the
 * list still holds it, else the list's first. Every list this is asked of is sorted by value, so the
 * default is the top product by value, and a pick another filter has since removed falls back to it
 * rather than showing a product the screen no longer lists. null only for an empty list.
 */
export function weeklyUnitViewProduct<T extends { code: string }>(
  products: readonly T[],
  pickedCode: string | null | undefined,
): T | null {
  const picked = (pickedCode ?? "").trim().toUpperCase();
  return (picked && products.find((product) => product.code.trim().toUpperCase() === picked)) || products[0] || null;
}

/** How a unit figure names the product it counts: " · <product>" for the "Units for" product, "" for its own. */
export function weeklyUnitsOfLabel(unitView: Pick<WeeklyDashboardUnitView, "productName"> | null): string {
  return unitView ? ` · ${unitView.productName}` : "";
}

/** The two unit tiles, and the change each shows against the previous week (null: no change shown). */
export type WeeklyUnitTiles = {
  /** appended to each tile's label: "" for the selection's own units, " · <product>" for the picked one's */
  of: string;
  salesUnits: number;
  stockUnits: number;
  compare: { salesUnits: WeeklyDelta; stockUnits: WeeklyDelta } | null;
};

/**
 * The Sales Units and Stock Units tiles (owner, 2026-09-19). A selection of ONE product shows its own
 * totals. A selection of several shows the "Units for" product's own (unitView), named on the tile, where
 * it used to show nothing. null only when there is neither — no product at all.
 *
 * The change against the previous week is one product's only when the prior figure is too: the
 * selection's own change while a product filter pins every week to one product
 * (weeklyKpiUnitDeltaIsOneProduct), else the picked product's own change, which the server works out
 * over that product's rows alone.
 */
export function weeklyUnitTiles(
  data: Pick<WeeklyDashboard, "kpis" | "compare" | "appliedFilters" | "unitView">,
): WeeklyUnitTiles | null {
  const unitView = data.unitView ?? null;
  if (weeklyKpiUnitsAreOneProduct(data)) {
    return {
      of: "",
      salesUnits: data.kpis.salesUnits,
      stockUnits: data.kpis.stockUnits,
      compare: weeklyKpiUnitDeltaIsOneProduct(data)
        ? { salesUnits: data.compare.salesUnits, stockUnits: data.compare.stockUnits }
        : (unitView?.compare ?? null),
    };
  }
  if (!unitView) return null;
  return {
    of: weeklyUnitsOfLabel(unitView),
    salesUnits: unitView.kpis.salesUnits,
    stockUnits: unitView.kpis.stockUnits,
    compare: unitView.compare,
  };
}

/** A table's unit column: its rows' own units, or the "Units for" product's at each row's key. */
export type WeeklyCutUnits = {
  /** appended to the column's label */
  of: string;
  /** the picked product's units by row key; null while the rows' own units are one product's */
  byKey: Readonly<Record<string, WeeklyUnitFigures>> | null;
};

/**
 * The unit column of a table cut by product, region, distributor or branch (owner, 2026-09-19). A
 * product row's units, and any row of a one-product selection, are the row's own. Otherwise the column
 * shows the "Units for" product's units at each row — every other figure on the row stays the row's
 * own. null only when there is neither.
 */
export function weeklyCutUnits(data: Pick<WeeklyDashboard, "kpis" | "unitView">, cut: WeeklyTotalsCut): WeeklyCutUnits | null {
  if (weeklyBreakdownUnitsAreOneProduct(data, cut)) return { of: "", byKey: null };
  const unitView = data.unitView ?? null;
  if (!unitView) return null;
  const byKey = cut === "region" ? unitView.regions : cut === "distributor" ? unitView.distributors : unitView.branches;
  return { of: weeklyUnitsOfLabel(unitView), byKey };
}

/** One row's figures under a table's unit column: its own, or the picked product's at its key (zero where it never reached). */
export function weeklyCutUnitsOf(cut: WeeklyCutUnits, key: string, own: WeeklyUnitFigures): WeeklyUnitFigures {
  if (!cut.byKey) return own;
  const picked = cut.byKey[key];
  return { salesUnits: picked?.salesUnits ?? 0, stockUnits: picked?.stockUnits ?? 0 };
}

/**
 * A table's rows as its unit column shows them: unchanged while their own units are one product's, else
 * with the "Units for" product's units at each row's own key. Every other field of a row — its value, its
 * share — stays its own.
 */
export function weeklyRowsWithCutUnits<T extends WeeklyUnitFigures>(
  rows: readonly T[],
  cut: WeeklyCutUnits | null,
  keyOf: (row: T) => string,
): readonly T[] {
  if (!cut?.byKey) return rows;
  return rows.map((row) => ({ ...row, ...weeklyCutUnitsOf(cut, keyOf(row), row) }));
}

/** The week-by-week comparison's unit columns. */
export type WeeklyWeekUnits = {
  of: string;
  /** the picked product's units by weeklyWeekKey; null while a product filter makes every week's own units one product's */
  byWeek: Readonly<Record<string, { salesUnits: number | null; stockUnits: number }>> | null;
};

/**
 * The week-by-week comparison adds units over every week in scope, so its own units are one product's
 * only under a product filter (weeklyWeekComparisonUnitsAreOneProduct). Otherwise it shows the "Units
 * for" product's units in each week, gap-nulled exactly as the week's own figures are. null only when
 * there is neither.
 */
export function weeklyWeekUnits(data: Pick<WeeklyDashboard, "appliedFilters" | "unitView">): WeeklyWeekUnits | null {
  if (weeklyWeekComparisonUnitsAreOneProduct(data)) return { of: "", byWeek: null };
  const unitView = data.unitView ?? null;
  return unitView ? { of: weeklyUnitsOfLabel(unitView), byWeek: unitView.weeks } : null;
}

/**
 * The week-by-week comparison's rows as its unit columns show them: unchanged under a product filter,
 * else with the "Units for" product's units in each week. A week that product never reached reads zero,
 * and a week whose own figure is gap-nulled stays null.
 */
export function weeklyWeekRowsWithUnits<
  T extends { cycleMonth: string; weekNumber: number; salesUnits: number | null; stockUnits: number },
>(rows: readonly T[], units: WeeklyWeekUnits | null): readonly T[] {
  const byWeek = units?.byWeek;
  if (!byWeek) return rows;
  return rows.map((row) => {
    const picked = byWeek[weeklyWeekKey(row.cycleMonth, row.weekNumber)];
    return {
      ...row,
      salesUnits: picked ? picked.salesUnits : row.salesUnits == null ? null : 0,
      stockUnits: picked?.stockUnits ?? 0,
    };
  });
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
