// Weekly Stock — pure builder for the stock-on-hand dashboard (admin shell + employee portal).
//
// Input is the weekly engine's own rows AFTER live price sync, de-cumulation, the viewer's access
// scope, the tracked-line golden rule (no Head Office) and the distributor/region/product/line
// filters — see loadWeeklyStockDashboard in stock-dashboard-service.ts. Everything here is in-memory
// and deterministic so it stays unit-testable (tests/weekly-stock-dashboard.test.ts).
//
// Owner rules this module encodes (2026-09-14):
//   • The grain people read is ONE product code (one concentration) at ONE depot. Stock is a
//     point-in-time snapshot: each distributor's LATEST upload on or before the as-of week, never a
//     sum across weeks.
//   • Units are NEVER added across different product codes. Any figure that spans products — a
//     depot, an area, a region, a distributor, the whole scope — is a VALUE (units × the live
//     Product Master factory price — or the dated price covering the snapshot's month where one
//     does, e.g. Saginko 170.52 from 2026-10; live-price.ts), never a unit total.
//   • Weeks of cover = stock ÷ average weekly net sales over the last 4 weeks.
//     Low < 2 weeks · Healthy 2–8 · Overstock > 8 · stock with no sales in the window = No sales.
//   • A depot with no area mapping is reported under "Area not mapped", never dropped.
//   • One product at a time (owner, 2026-09-19): a group row still totals VALUE only, and beside it the
//     screen shows ONE picked product's own units there (weeklyStockProductUnitsByGroup).

import { weeklyDistributorLabel } from "@/lib/sales/weekly/display-labels";

export const WEEKLY_STOCK_COVER_LOW_WEEKS = 2;
export const WEEKLY_STOCK_COVER_OVER_WEEKS = 8;
/** How many week-of-month slots the average weekly sales looks back over. */
export const WEEKLY_STOCK_SALES_WINDOW_WEEKS = 4;
/** A distributor whose latest stock upload is this many days older than the newest one is flagged stale. */
export const WEEKLY_STOCK_STALE_AFTER_DAYS = 14;
/** Filter code for depots that carry no area mapping. */
export const WEEKLY_STOCK_UNMAPPED_AREA = "__unmapped__";
export const WEEKLY_STOCK_UNMAPPED_AREA_LABEL = "Area not mapped";

export type WeeklyStockStatus = "low" | "healthy" | "over" | "no_sales";

export const WEEKLY_STOCK_STATUS_LABELS: Record<WeeklyStockStatus, string> = {
  low: "Low stock",
  healthy: "Healthy",
  over: "Overstock",
  no_sales: "No sales",
};

/** One de-cumulated, access-scoped weekly row (a product at a depot in one upload). */
export type WeeklyStockSourceRow = {
  distributorCode: string;
  distributorName: string;
  regionCode: string;
  regionName: string;
  areaCode: string | null;
  branchCode: string;
  branchName: string;
  productCode: string;
  productName: string;
  line: string;
  cycleMonth: string;
  weekNumber: number | null;
  weekStart: string;
  /** real (de-cumulated) net units sold in this upload's week(s) */
  netUnits: number;
  /** stock-on-hand snapshot for this upload */
  stockUnits: number;
  /** the price covering this upload's month (liveUnitPrice); null when the master has none */
  factoryPrice: number | null;
};

export type WeeklyStockFilters = {
  /** YYYY-MM-DD. Each distributor's snapshot is its latest stock upload on or before this date. */
  asOfWeekStart?: string | null;
  /** Area codes, plus WEEKLY_STOCK_UNMAPPED_AREA for depots with no area. Empty = all. */
  areaCodes?: string[] | null;
  /** Depot keys (see depotKey). Empty = all. */
  branchKeys?: string[] | null;
  statuses?: WeeklyStockStatus[] | null;
};

export type WeeklyStockCell = {
  distributorCode: string;
  distributorName: string;
  regionCode: string;
  regionName: string;
  areaCode: string | null;
  areaName: string;
  branchKey: string;
  branchName: string;
  productCode: string;
  productName: string;
  line: string;
  asOfWeekStart: string;
  stockUnits: number;
  stockValue: number;
  /** average weekly net units over the sales window; 0 when nothing sold */
  avgWeeklyUnits: number;
  /** null when nothing sold in the window */
  coverWeeks: number | null;
  status: WeeklyStockStatus;
  priceMissing: boolean;
};

/** A product code across every in-scope depot — the one place a unit total is valid. */
export type WeeklyStockProductRow = {
  productCode: string;
  productName: string;
  line: string;
  stockUnits: number;
  stockValue: number;
  avgWeeklyUnits: number;
  coverWeeks: number | null;
  status: WeeklyStockStatus;
  depotCount: number;
  lowDepots: number;
  overDepots: number;
  noSalesDepots: number;
};

/** Any grouping that spans several products — value only, never units. */
export type WeeklyStockGroupRow = {
  code: string;
  name: string;
  /** region name for depot/area rows; empty otherwise */
  parentName: string;
  stockValue: number;
  avgWeeklyValue: number;
  /** stock value ÷ average weekly sales value; null when nothing sold */
  coverWeeks: number | null;
  status: WeeklyStockStatus;
  productCount: number;
  lowCount: number;
  overCount: number;
  noSalesCount: number;
};

export type WeeklyStockDistributorRow = WeeklyStockGroupRow & {
  asOfWeekStart: string;
  /** latest upload is WEEKLY_STOCK_STALE_AFTER_DAYS+ older than the newest distributor's */
  stale: boolean;
};

export type WeeklyStockView = {
  asOfWeekStart: string | null;
  kpis: {
    stockValue: number;
    avgWeeklyValue: number;
    coverWeeks: number | null;
    depotCount: number;
    productCount: number;
    lowCount: number;
    overCount: number;
    noSalesCount: number;
    priceMissingCount: number;
  };
  cells: WeeklyStockCell[];
  products: WeeklyStockProductRow[];
  depots: WeeklyStockGroupRow[];
  areas: WeeklyStockGroupRow[];
  regions: WeeklyStockGroupRow[];
  distributors: WeeklyStockDistributorRow[];
  availableAsOfWeeks: string[];
  availableAreas: { code: string; name: string }[];
  availableBranches: { code: string; name: string }[];
};

const up = (value: string | null | undefined) => (value ?? "").trim().toUpperCase();
const round2 = (value: number) => Number(value.toFixed(2));

/** Stable depot identity inside one distributor: its code, or its name when it has no code. */
export function depotKey(row: { distributorCode: string; branchCode: string; branchName: string }): string {
  return `${up(row.distributorCode)}|${up(row.branchCode) || up(row.branchName)}`;
}

/** The tables that group several products — a branch, an area, a region, a distributor. */
export type WeeklyStockGroupCut = "depots" | "areas" | "regions" | "distributors";

/** A cell's key in one grouping: exactly the `code` its group row carries. */
export function weeklyStockGroupKey(
  cell: Pick<WeeklyStockCell, "branchKey" | "areaCode" | "regionCode" | "regionName" | "distributorCode">,
  cut: WeeklyStockGroupCut,
): string {
  if (cut === "depots") return cell.branchKey;
  if (cut === "areas") return cell.areaCode ?? WEEKLY_STOCK_UNMAPPED_AREA;
  if (cut === "regions") return up(cell.regionCode) || cell.regionName;
  return up(cell.distributorCode);
}

/** One product's own stock at one group. */
export type WeeklyStockProductUnits = { stockUnits: number; avgWeeklyUnits: number };

/**
 * "Units for" (owner, 2026-09-19): a group row adds several products, so its value is the only total it
 * carries — but ONE product's units at each group are valid, and this is that product's stock and average
 * weekly sales in units at every group, keyed as weeklyStockGroupKey keys it. Built from the view's own
 * cells, so it follows every filter the rows do. A group the product never reached is absent (zero).
 */
export function weeklyStockProductUnitsByGroup(
  cells: readonly WeeklyStockCell[],
  productCode: string,
  cut: WeeklyStockGroupCut,
): Record<string, WeeklyStockProductUnits> {
  const code = up(productCode);
  const groups: Record<string, WeeklyStockProductUnits> = {};
  for (const cell of cells) {
    if (up(cell.productCode) !== code) continue;
    const key = weeklyStockGroupKey(cell, cut);
    const group = groups[key] ?? { stockUnits: 0, avgWeeklyUnits: 0 };
    group.stockUnits += cell.stockUnits;
    group.avgWeeklyUnits += cell.avgWeeklyUnits;
    groups[key] = group;
  }
  for (const group of Object.values(groups)) {
    group.stockUnits = round2(group.stockUnits);
    group.avgWeeklyUnits = round2(group.avgWeeklyUnits);
  }
  return groups;
}

/** The "Units for" product: the one picked while the view still holds it, else the one with the most stock value. */
export function weeklyStockUnitProduct(
  products: readonly WeeklyStockProductRow[],
  pickedCode: string | null | undefined,
): WeeklyStockProductRow | null {
  const picked = up(pickedCode);
  const found = picked ? products.find((product) => up(product.productCode) === picked) : undefined;
  if (found) return found;
  return [...products].sort((a, b) => b.stockValue - a.stockValue || a.productName.localeCompare(b.productName))[0] ?? null;
}

export function classifyWeeklyStock(stockUnits: number, avgWeeklyUnits: number): {
  coverWeeks: number | null;
  status: WeeklyStockStatus;
} {
  if (!(avgWeeklyUnits > 0)) {
    return { coverWeeks: null, status: stockUnits > 0 ? "no_sales" : "healthy" };
  }
  const coverWeeks = Math.max(0, stockUnits) / avgWeeklyUnits;
  if (coverWeeks < WEEKLY_STOCK_COVER_LOW_WEEKS) return { coverWeeks: round2(coverWeeks), status: "low" };
  if (coverWeeks > WEEKLY_STOCK_COVER_OVER_WEEKS) return { coverWeeks: round2(coverWeeks), status: "over" };
  return { coverWeeks: round2(coverWeeks), status: "healthy" };
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

/**
 * Which uploads feed the average, and how many WEEKS they really cover.
 *
 * De-cumulation subtracts each upload from the previous PRESENT upload of the same month-cycle, so an
 * upload after a gap carries every missing week too, and the first upload of a cycle carries weeks
 * 1..n. Dividing by the number of uploads would therefore overstate the weekly rate; dividing by the
 * week-of-month slots each upload spans is exact under that telescoping.
 */
export function weeklyStockSalesWindow(
  uploads: { weekStart: string; cycleMonth: string; weekNumber: number | null }[],
  snapshotWeekStart: string,
): { weekStarts: Set<string>; coveredWeeks: number } {
  const ordered = [...new Map(uploads.map((u) => [u.weekStart, u])).values()]
    .filter((u) => u.weekStart <= snapshotWeekStart)
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  const spans = new Map<string, number>();
  const lastWeekByCycle = new Map<string, number>();
  for (const upload of ordered) {
    if (!upload.cycleMonth || upload.weekNumber == null) {
      spans.set(upload.weekStart, 1);
      continue;
    }
    const previous = lastWeekByCycle.get(upload.cycleMonth);
    spans.set(upload.weekStart, Math.max(1, upload.weekNumber - (previous ?? 0)));
    lastWeekByCycle.set(upload.cycleMonth, upload.weekNumber);
  }
  const weekStarts = new Set<string>();
  let coveredWeeks = 0;
  for (let i = ordered.length - 1; i >= 0 && coveredWeeks < WEEKLY_STOCK_SALES_WINDOW_WEEKS; i--) {
    weekStarts.add(ordered[i].weekStart);
    coveredWeeks += spans.get(ordered[i].weekStart) ?? 1;
  }
  return { weekStarts, coveredWeeks };
}

type GroupAccumulator = {
  code: string;
  name: string;
  parentName: string;
  stockValue: number;
  avgWeeklyValue: number;
  products: Set<string>;
  lowCount: number;
  overCount: number;
  noSalesCount: number;
};

function accumulate(map: Map<string, GroupAccumulator>, code: string, name: string, parentName: string, cell: WeeklyStockCell, avgWeeklyValue: number) {
  const current =
    map.get(code) ??
    { code, name, parentName, stockValue: 0, avgWeeklyValue: 0, products: new Set<string>(), lowCount: 0, overCount: 0, noSalesCount: 0 };
  current.stockValue += cell.stockValue;
  current.avgWeeklyValue += avgWeeklyValue;
  current.products.add(cell.productCode);
  if (cell.status === "low") current.lowCount += 1;
  if (cell.status === "over") current.overCount += 1;
  if (cell.status === "no_sales") current.noSalesCount += 1;
  map.set(code, current);
}

function finishGroups(map: Map<string, GroupAccumulator>): WeeklyStockGroupRow[] {
  return [...map.values()]
    .map((group) => {
      const { coverWeeks, status } = classifyWeeklyStock(group.stockValue, group.avgWeeklyValue);
      return {
        code: group.code,
        name: group.name,
        parentName: group.parentName,
        stockValue: round2(group.stockValue),
        avgWeeklyValue: round2(group.avgWeeklyValue),
        coverWeeks,
        status,
        productCount: group.products.size,
        lowCount: group.lowCount,
        overCount: group.overCount,
        noSalesCount: group.noSalesCount,
      };
    })
    .sort((a, b) => b.stockValue - a.stockValue || a.name.localeCompare(b.name));
}

export function buildWeeklyStockView(
  rows: WeeklyStockSourceRow[],
  areaNames: ReadonlyMap<string, string>,
  filters: WeeklyStockFilters = {},
): WeeklyStockView {
  const asOf = filters.asOfWeekStart?.trim() || null;

  // Uploads that actually carry stock. A distributor that never reports stock (POS, Direct) has no
  // snapshot and stays off this dashboard instead of showing a misleading zero.
  const stockWeeksByDistributor = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.stockUnits === 0 || !row.weekStart) continue;
    const key = up(row.distributorCode);
    const weeks = stockWeeksByDistributor.get(key) ?? new Set<string>();
    weeks.add(row.weekStart);
    stockWeeksByDistributor.set(key, weeks);
  }
  const availableAsOfWeeks = [...new Set([...stockWeeksByDistributor.values()].flatMap((weeks) => [...weeks]))].sort(
    (a, b) => b.localeCompare(a),
  );

  const snapshotByDistributor = new Map<string, string>();
  for (const [distributor, weeks] of stockWeeksByDistributor) {
    const eligible = [...weeks].filter((week) => !asOf || week <= asOf).sort();
    if (eligible.length > 0) snapshotByDistributor.set(distributor, eligible[eligible.length - 1]);
  }

  const rowsByDistributor = new Map<string, WeeklyStockSourceRow[]>();
  for (const row of rows) {
    const key = up(row.distributorCode);
    if (!snapshotByDistributor.has(key)) continue;
    const bucket = rowsByDistributor.get(key) ?? [];
    bucket.push(row);
    rowsByDistributor.set(key, bucket);
  }

  const areaFilter = new Set((filters.areaCodes ?? []).map(up).filter(Boolean));
  const branchFilter = new Set((filters.branchKeys ?? []).map(up).filter(Boolean));
  const statusFilter = new Set(filters.statuses ?? []);
  const areaOptions = new Map<string, string>();
  const branchOptions = new Map<string, string>();

  const allCells: WeeklyStockCell[] = [];
  // The unit price comes from the uploads, never from the filtered cells: a stocked-out depot has no
  // stock value to divide, and a "Low stock" filter can leave a product with only such depots — its
  // weekly sales would then be valued at zero and the depot would read Healthy. A product's price is
  // read off its NEWEST snapshot, so where distributors' snapshots straddle a month whose price differs
  // (Saginko: 111.15 in September, 170.52 from October) the answer does not depend on row order.
  const productPrice = new Map<string, number>();
  const productPriceWeek = new Map<string, string>();
  for (const [distributor, distributorRows] of rowsByDistributor) {
    const snapshot = snapshotByDistributor.get(distributor)!;
    const window = weeklyStockSalesWindow(distributorRows, snapshot);
    const cells = new Map<string, { row: WeeklyStockSourceRow; stockUnits: number; windowUnits: number; hasSnapshot: boolean }>();
    for (const row of distributorRows) {
      const inSnapshot = row.weekStart === snapshot;
      const inWindow = window.weekStarts.has(row.weekStart);
      if (!inSnapshot && !inWindow) continue;
      const key = `${depotKey(row)}|${up(row.productCode)}`;
      const current = cells.get(key) ?? { row, stockUnits: 0, windowUnits: 0, hasSnapshot: false };
      if (inSnapshot) {
        current.stockUnits += row.stockUnits;
        current.hasSnapshot = true;
        current.row = row; // the snapshot row names the depot as it reads today
      }
      if (inWindow) current.windowUnits += row.netUnits;
      cells.set(key, current);
    }
    for (const cell of cells.values()) {
      // A depot/product that sold in the window but is absent from the snapshot upload is not a
      // reading of zero stock — the sheet simply did not list it. Only the snapshot speaks for stock.
      if (!cell.hasSnapshot) continue;
      const avgWeeklyUnits = window.coveredWeeks > 0 ? Math.max(0, cell.windowUnits) / window.coveredWeeks : 0;
      if (cell.stockUnits === 0 && !(avgWeeklyUnits > 0)) continue;
      const { row } = cell;
      const { coverWeeks, status } = classifyWeeklyStock(cell.stockUnits, avgWeeklyUnits);
      const areaCode = row.areaCode?.trim() ? row.areaCode.trim().toUpperCase() : null;
      const areaName = areaCode ? areaNames.get(areaCode) ?? areaCode : WEEKLY_STOCK_UNMAPPED_AREA_LABEL;
      const price = row.factoryPrice != null && row.factoryPrice > 0 ? row.factoryPrice : null;
      const productKey = up(row.productCode);
      if (price != null && snapshot >= (productPriceWeek.get(productKey) ?? "")) {
        productPrice.set(productKey, price);
        productPriceWeek.set(productKey, snapshot);
      }
      allCells.push({
        distributorCode: row.distributorCode,
        distributorName: row.distributorName || row.distributorCode,
        regionCode: row.regionCode,
        regionName: row.regionName || row.regionCode,
        areaCode,
        areaName,
        branchKey: depotKey(row),
        branchName: row.branchName || row.branchCode,
        productCode: up(row.productCode),
        productName: row.productName || row.productCode,
        line: row.line,
        asOfWeekStart: snapshot,
        stockUnits: round2(cell.stockUnits),
        stockValue: round2(price == null ? 0 : cell.stockUnits * price),
        avgWeeklyUnits: round2(avgWeeklyUnits),
        coverWeeks,
        status,
        priceMissing: price == null,
      });
    }
  }

  const cells = allCells
    .filter((cell) => {
      areaOptions.set(cell.areaCode ?? WEEKLY_STOCK_UNMAPPED_AREA, cell.areaName);
      if (areaFilter.size > 0 && !areaFilter.has(up(cell.areaCode ?? WEEKLY_STOCK_UNMAPPED_AREA))) return false;
      branchOptions.set(cell.branchKey, `${cell.branchName} · ${weeklyDistributorLabel(cell.distributorName, cell.distributorCode)}`);
      if (branchFilter.size > 0 && !branchFilter.has(up(cell.branchKey))) return false;
      if (statusFilter.size > 0 && !statusFilter.has(cell.status)) return false;
      return true;
    })
    .sort(
      (a, b) =>
        a.regionName.localeCompare(b.regionName) ||
        a.areaName.localeCompare(b.areaName) ||
        a.branchName.localeCompare(b.branchName) ||
        a.productName.localeCompare(b.productName),
    );

  const products = new Map<string, WeeklyStockProductRow & { price: number | null }>();
  const depots = new Map<string, GroupAccumulator>();
  const areas = new Map<string, GroupAccumulator>();
  const regions = new Map<string, GroupAccumulator>();
  const distributors = new Map<string, GroupAccumulator>();
  const distributorSnapshot = new Map<string, string>();
  const depotKeys = new Set<string>();

  for (const cell of cells) {
    const price = productPrice.get(cell.productCode) ?? null;
    const avgWeeklyValue = price == null ? 0 : cell.avgWeeklyUnits * price;
    depotKeys.add(cell.branchKey);
    const product =
      products.get(cell.productCode) ??
      {
        productCode: cell.productCode,
        productName: cell.productName,
        line: cell.line,
        stockUnits: 0,
        stockValue: 0,
        avgWeeklyUnits: 0,
        coverWeeks: null,
        status: "healthy" as WeeklyStockStatus,
        depotCount: 0,
        lowDepots: 0,
        overDepots: 0,
        noSalesDepots: 0,
        price,
      };
    product.stockUnits += cell.stockUnits;
    product.stockValue += cell.stockValue;
    product.avgWeeklyUnits += cell.avgWeeklyUnits;
    product.depotCount += 1;
    if (cell.status === "low") product.lowDepots += 1;
    if (cell.status === "over") product.overDepots += 1;
    if (cell.status === "no_sales") product.noSalesDepots += 1;
    products.set(cell.productCode, product);

    accumulate(depots, weeklyStockGroupKey(cell, "depots"), cell.branchName, cell.regionName, cell, avgWeeklyValue);
    accumulate(areas, weeklyStockGroupKey(cell, "areas"), cell.areaName, cell.regionName, cell, avgWeeklyValue);
    accumulate(regions, weeklyStockGroupKey(cell, "regions"), cell.regionName, "", cell, avgWeeklyValue);
    accumulate(distributors, weeklyStockGroupKey(cell, "distributors"), cell.distributorName, "", cell, avgWeeklyValue);
    distributorSnapshot.set(up(cell.distributorCode), cell.asOfWeekStart);
  }

  const productRows: WeeklyStockProductRow[] = [...products.values()]
    .map(({ price: _price, ...product }) => {
      const { coverWeeks, status } = classifyWeeklyStock(product.stockUnits, product.avgWeeklyUnits);
      return {
        ...product,
        stockUnits: round2(product.stockUnits),
        stockValue: round2(product.stockValue),
        avgWeeklyUnits: round2(product.avgWeeklyUnits),
        coverWeeks,
        status,
      };
    })
    .sort((a, b) => a.line.localeCompare(b.line) || a.productName.localeCompare(b.productName));

  const newestSnapshot = [...distributorSnapshot.values()].sort().at(-1) ?? null;
  const distributorRows: WeeklyStockDistributorRow[] = finishGroups(distributors).map((group) => {
    const asOfWeekStart = distributorSnapshot.get(group.code) ?? "";
    return {
      ...group,
      asOfWeekStart,
      stale: Boolean(newestSnapshot && asOfWeekStart && daysBetween(asOfWeekStart, newestSnapshot) >= WEEKLY_STOCK_STALE_AFTER_DAYS),
    };
  });

  const stockValue = cells.reduce((sum, cell) => sum + cell.stockValue, 0);
  const avgWeeklyValue = cells.reduce((sum, cell) => {
    const price = productPrice.get(cell.productCode);
    return sum + (price == null ? 0 : cell.avgWeeklyUnits * price);
  }, 0);
  const totalCover = classifyWeeklyStock(stockValue, avgWeeklyValue);

  return {
    asOfWeekStart: asOf ?? newestSnapshot,
    kpis: {
      stockValue: round2(stockValue),
      avgWeeklyValue: round2(avgWeeklyValue),
      coverWeeks: totalCover.coverWeeks,
      depotCount: depotKeys.size,
      productCount: products.size,
      lowCount: cells.filter((cell) => cell.status === "low").length,
      overCount: cells.filter((cell) => cell.status === "over").length,
      noSalesCount: cells.filter((cell) => cell.status === "no_sales").length,
      priceMissingCount: cells.filter((cell) => cell.priceMissing).length,
    },
    cells,
    products: productRows,
    depots: finishGroups(depots),
    areas: finishGroups(areas),
    regions: finishGroups(regions),
    distributors: distributorRows,
    availableAsOfWeeks,
    availableAreas: [...areaOptions.entries()]
      .map(([code, name]) => ({ code, name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    availableBranches: [...branchOptions.entries()]
      .map(([code, name]) => ({ code, name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}
