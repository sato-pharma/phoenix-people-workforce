import { getSupabaseAdmin, rpcAll } from "@/lib/supabase/server";
import { loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";

// Distributor comparison + insights for the Monthly Closing report. The on-screen matrix
// MERGES all distributors; here we split them (PS / IS / IS-S) and derive rankings, mix,
// white-space and insight tables. Value is ALWAYS recomputed in the RPCs (Qty x (1 - discount)
// x live factory_price); the stored value is never used. All higher-level numbers are DERIVED
// from the leaf rows the RPCs return — never by summing subtotals (no double counting).

export type DistProductRow = {
  areaCode: string;
  distributorCode: string;
  productCode: string;
  productName: string;
  regionCode: string;
  units: number;
  value: number;
};

export type BrickRow = {
  areaCode: string;
  brickId: string;
  distributorCode: string;
  regionCode: string;
  units: number;
  value: number;
};

export type CustomerRow = {
  areaCode: string;
  brickId: string;
  clientCode: string;
  clientName: string;
  distributorCode: string;
  regionCode: string;
  units: number;
  value: number;
};

export type DistributorRollup = {
  areaCount: number;
  avgValuePerCustomer: number;
  brickCount: number;
  customerCount: number;
  distributorCode: string;
  distributorName: string;
  productCount: number;
  units: number;
  value: number;
  valueShare: number; // ratio 0..1
};

export type LeaderCell = { distributorCode: string; distributorName: string; share: number } | null;

export type ValueGridRow = {
  byDistributor: Record<string, number>;
  key: string;
  label: string;
  leader: LeaderCell;
  total: number;
};

export type MixSlice = { label: string; share: number; value: number };
export type RankedRow = { key: string; label: string; rank: number; share: number; sublabel: string; units: number; value: number };
export type ParetoResult = { rows: { cumulativeShare: number; label: string; value: number }[]; share: number; topValue: number; total: number };
export type WhiteSpaceArea = { areaCode: string; areaName: string; regionName: string };
export type WhiteSpaceBrick = { areaName: string; brickId: string; brickName: string; regionName: string };
export type SingleDistributorArea = { areaCode: string; areaName: string; distributorName: string; regionName: string; value: number };
export type ProductGap = { missingRegions: string[]; productCode: string; productName: string; soldRegions: string[] };
export type AvgPriceRow = { avgPrice: number; distributorCode: string; distributorName: string; productCode: string; productName: string; units: number; value: number };
export type CoverageRow = { areaShare: number; areasReached: number; brickShare: number; bricksReached: number; distributorName: string };
export type InsightBullet = { category: string; text: string };

// Raw fact blocks written to the hidden "Data" sheet; every report cell is a live formula
// that references these (SUMIFS / COUNTIFS / division), so the workbook recalculates.
export type ClosingExportData = {
  areaByDist: { areaCode: string; distributorCode: string; value: number }[];
  bricks: { brickId: string; brickName: string; distributorCode: string; units: number; value: number }[];
  customers: { clientCode: string; clientName: string; distributorCode: string; units: number; value: number }[];
  distProduct: { areaCode: string; areaName: string; distributorCode: string; distributorName: string; productCode: string; productName: string; regionCode: string; regionName: string; units: number; value: number }[];
  masterAreas: { areaCode: string; areaName: string; regionName: string }[];
  masterBricks: { areaName: string; brickId: string; brickName: string; regionName: string }[];
  productByDist: { distributorCode: string; productCode: string; value: number }[];
};

export type MonthlyClosingComparison = {
  areaByDistributor: ValueGridRow[];
  data: ClosingExportData;
  avgPrice: AvgPriceRow[];
  byDistributor: DistributorRollup[];
  coverage: CoverageRow[];
  distributors: { code: string; name: string }[];
  insights: InsightBullet[];
  line: string | null;
  mix: { distributor: MixSlice[]; product: MixSlice[]; region: MixSlice[] };
  national: { areaCount: number; customerCount: number; productCount: number; units: number; value: number };
  pareto: { customers: ParetoResult };
  period: string | null;
  productByDistributor: ValueGridRow[];
  rankings: { areas: RankedRow[]; bricks: RankedRow[]; customers: RankedRow[]; products: RankedRow[]; regions: RankedRow[] };
  regionByDistributor: ValueGridRow[];
  totalAreas: number;
  totalBricks: number;
  whiteSpace: {
    productGaps: ProductGap[];
    singleDistributorAreas: SingleDistributorArea[];
    zeroSalesAreas: WhiteSpaceArea[];
    zeroSalesBricks: WhiteSpaceBrick[];
  };
};

const round = (value: number) => Number((value || 0).toFixed(6));

export type ComparisonNameMaps = {
  areaName: Map<string, string>;
  distributorName: Map<string, string>;
  regionName: Map<string, string>;
};

function nameOf(map: Map<string, string>, code: string) {
  return map.get(code) ?? code;
}

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

export function distinctDistributors(rows: { distributorCode: string }[], maps: ComparisonNameMaps) {
  const seen = new Map<string, { code: string; name: string }>();
  rows.forEach((row) => {
    if (row.distributorCode && !seen.has(row.distributorCode)) {
      seen.set(row.distributorCode, { code: row.distributorCode, name: nameOf(maps.distributorName, row.distributorCode) });
    }
  });
  return [...seen.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function rollupByDistributor(input: {
  brickRows: BrickRow[];
  customerRows: CustomerRow[];
  distProductRows: DistProductRow[];
  maps: ComparisonNameMaps;
}): DistributorRollup[] {
  const byCode = new Map<string, DistributorRollup & { areas: Set<string>; bricks: Set<string>; customers: Set<string>; products: Set<string> }>();
  const ensure = (code: string) => {
    let entry = byCode.get(code);
    if (!entry) {
      entry = {
        areaCount: 0, areas: new Set(), avgValuePerCustomer: 0, brickCount: 0, bricks: new Set(),
        customerCount: 0, customers: new Set(), distributorCode: code, distributorName: nameOf(input.maps.distributorName, code),
        productCount: 0, products: new Set(), units: 0, value: 0, valueShare: 0,
      };
      byCode.set(code, entry);
    }
    return entry;
  };
  input.distProductRows.forEach((row) => {
    const entry = ensure(row.distributorCode);
    entry.units += row.units;
    entry.value += row.value;
    if (row.value > 0 || row.units > 0) {
      entry.products.add(row.productCode);
      entry.areas.add(row.areaCode);
    }
  });
  input.brickRows.forEach((row) => {
    if (row.value > 0 || row.units > 0) ensure(row.distributorCode).bricks.add(row.brickId);
  });
  input.customerRows.forEach((row) => {
    ensure(row.distributorCode).customers.add(`${row.clientCode}`);
  });

  const nationalValue = [...byCode.values()].reduce((sum, entry) => sum + entry.value, 0);
  return [...byCode.values()]
    .map((entry) => ({
      areaCount: entry.areas.size,
      avgValuePerCustomer: entry.customers.size > 0 ? round(entry.value / entry.customers.size) : 0,
      brickCount: entry.bricks.size,
      customerCount: entry.customers.size,
      distributorCode: entry.distributorCode,
      distributorName: entry.distributorName,
      productCount: entry.products.size,
      units: round(entry.units),
      value: round(entry.value),
      valueShare: nationalValue > 0 ? round(entry.value / nationalValue) : 0,
    }))
    .sort((left, right) => right.value - left.value);
}

export function computeMix(items: { label: string; value: number }[]): MixSlice[] {
  const total = items.reduce((sum, item) => sum + item.value, 0);
  return items
    .map((item) => ({ label: item.label, share: total > 0 ? round(item.value / total) : 0, value: round(item.value) }))
    .sort((left, right) => right.value - left.value);
}

export function buildValueGrid(
  rows: { distributorCode: string; key: string; label: string; value: number }[],
  distributorCodes: string[],
  maps: ComparisonNameMaps,
): ValueGridRow[] {
  const byKey = new Map<string, ValueGridRow>();
  rows.forEach((row) => {
    let entry = byKey.get(row.key);
    if (!entry) {
      entry = { byDistributor: {}, key: row.key, label: row.label, leader: null, total: 0 };
      distributorCodes.forEach((code) => { entry!.byDistributor[code] = 0; });
      byKey.set(row.key, entry);
    }
    entry.byDistributor[row.distributorCode] = (entry.byDistributor[row.distributorCode] ?? 0) + row.value;
    entry.total += row.value;
  });
  return [...byKey.values()]
    .map((entry) => {
      let leader: LeaderCell = null;
      let best = -1;
      distributorCodes.forEach((code) => {
        const value = entry.byDistributor[code] ?? 0;
        if (value > best) {
          best = value;
          leader = best > 0 ? { distributorCode: code, distributorName: nameOf(maps.distributorName, code), share: entry.total > 0 ? round(value / entry.total) : 0 } : null;
        }
      });
      distributorCodes.forEach((code) => { entry.byDistributor[code] = round(entry.byDistributor[code] ?? 0); });
      return { ...entry, leader, total: round(entry.total) };
    })
    .sort((left, right) => right.total - left.total);
}

export function topN(
  items: { key: string; label: string; sublabel?: string; units: number; value: number }[],
  count: number,
): RankedRow[] {
  const total = items.reduce((sum, item) => sum + item.value, 0);
  return [...items]
    .sort((left, right) => right.value - left.value)
    .slice(0, count)
    .map((item, index) => ({
      key: item.key,
      label: item.label,
      rank: index + 1,
      share: total > 0 ? round(item.value / total) : 0,
      sublabel: item.sublabel ?? "",
      units: round(item.units),
      value: round(item.value),
    }));
}

export function pareto(items: { label: string; value: number }[], count: number): ParetoResult {
  const sorted = [...items].sort((left, right) => right.value - left.value);
  const total = sorted.reduce((sum, item) => sum + item.value, 0);
  const top = sorted.slice(0, count);
  const topValue = top.reduce((sum, item) => sum + item.value, 0);
  let cumulative = 0;
  const rows = top.map((item) => {
    cumulative += item.value;
    return { cumulativeShare: total > 0 ? round(cumulative / total) : 0, label: item.label, value: round(item.value) };
  });
  return { rows, share: total > 0 ? round(topValue / total) : 0, topValue: round(topValue), total: round(total) };
}

export function whiteSpaceAreas(
  masterAreas: { areaCode: string; areaName: string; regionCode: string }[],
  soldAreaCodes: Set<string>,
  maps: ComparisonNameMaps,
): WhiteSpaceArea[] {
  return masterAreas
    .filter((area) => !soldAreaCodes.has(area.areaCode))
    .map((area) => ({ areaCode: area.areaCode, areaName: area.areaName || area.areaCode, regionName: nameOf(maps.regionName, area.regionCode) }))
    .sort((left, right) => left.regionName.localeCompare(right.regionName) || left.areaName.localeCompare(right.areaName));
}

export function whiteSpaceBricks(
  masterBricks: { areaCode: string; brickId: string; brickName: string; regionCode: string }[],
  soldBrickIds: Set<string>,
  maps: ComparisonNameMaps & { areaName: Map<string, string> },
): WhiteSpaceBrick[] {
  return masterBricks
    .filter((brick) => !soldBrickIds.has(brick.brickId))
    .map((brick) => ({
      areaName: nameOf(maps.areaName, brick.areaCode),
      brickId: brick.brickId,
      brickName: brick.brickName || brick.brickId,
      regionName: nameOf(maps.regionName, brick.regionCode),
    }))
    .sort((left, right) => left.regionName.localeCompare(right.regionName) || left.brickName.localeCompare(right.brickName));
}

export function singleDistributorAreas(
  distProductRows: DistProductRow[],
  maps: ComparisonNameMaps & { areaName: Map<string, string>; areaRegion: Map<string, string> },
): SingleDistributorArea[] {
  const byArea = new Map<string, { distributors: Map<string, number>; total: number }>();
  distProductRows.forEach((row) => {
    if (row.value <= 0) return;
    let entry = byArea.get(row.areaCode);
    if (!entry) { entry = { distributors: new Map(), total: 0 }; byArea.set(row.areaCode, entry); }
    entry.distributors.set(row.distributorCode, (entry.distributors.get(row.distributorCode) ?? 0) + row.value);
    entry.total += row.value;
  });
  const result: SingleDistributorArea[] = [];
  byArea.forEach((entry, areaCode) => {
    if (entry.distributors.size === 1) {
      const [code] = [...entry.distributors.keys()];
      result.push({
        areaCode,
        areaName: nameOf(maps.areaName, areaCode),
        distributorName: nameOf(maps.distributorName, code),
        regionName: nameOf(maps.regionName, maps.areaRegion.get(areaCode) ?? ""),
        value: round(entry.total),
      });
    }
  });
  return result.sort((left, right) => right.value - left.value);
}

export function productGaps(
  distProductRows: DistProductRow[],
  allRegionCodes: string[],
  maps: ComparisonNameMaps,
): ProductGap[] {
  const byProduct = new Map<string, { name: string; regions: Set<string> }>();
  distProductRows.forEach((row) => {
    if (row.value <= 0) return;
    let entry = byProduct.get(row.productCode);
    if (!entry) { entry = { name: row.productName || row.productCode, regions: new Set() }; byProduct.set(row.productCode, entry); }
    entry.regions.add(row.regionCode);
  });
  const result: ProductGap[] = [];
  byProduct.forEach((entry, productCode) => {
    const missing = allRegionCodes.filter((code) => !entry.regions.has(code));
    if (missing.length > 0 && entry.regions.size > 0) {
      result.push({
        missingRegions: missing.map((code) => nameOf(maps.regionName, code)).sort(),
        productCode,
        productName: entry.name,
        soldRegions: [...entry.regions].map((code) => nameOf(maps.regionName, code)).sort(),
      });
    }
  });
  return result.sort((left, right) => right.missingRegions.length - left.missingRegions.length);
}

export function avgRealizedPrice(distProductRows: DistProductRow[], maps: ComparisonNameMaps): AvgPriceRow[] {
  const byKey = new Map<string, { name: string; units: number; value: number; distributorCode: string; productCode: string }>();
  distProductRows.forEach((row) => {
    const key = `${row.productCode}\u0000${row.distributorCode}`;
    let entry = byKey.get(key);
    if (!entry) { entry = { distributorCode: row.distributorCode, name: row.productName || row.productCode, productCode: row.productCode, units: 0, value: 0 }; byKey.set(key, entry); }
    entry.units += row.units;
    entry.value += row.value;
  });
  return [...byKey.values()]
    .filter((entry) => entry.value > 0)
    .map((entry) => ({
      avgPrice: entry.units > 0 ? round(entry.value / entry.units) : 0,
      distributorCode: entry.distributorCode,
      distributorName: nameOf(maps.distributorName, entry.distributorCode),
      productCode: entry.productCode,
      productName: entry.name,
      units: round(entry.units),
      value: round(entry.value),
    }))
    .sort((left, right) => left.productName.localeCompare(right.productName) || left.distributorName.localeCompare(right.distributorName));
}

export function coverage(
  byDistributor: DistributorRollup[],
  totalAreas: number,
  totalBricks: number,
): CoverageRow[] {
  return byDistributor.map((entry) => ({
    areaShare: totalAreas > 0 ? round(entry.areaCount / totalAreas) : 0,
    areasReached: entry.areaCount,
    brickShare: totalBricks > 0 ? round(entry.brickCount / totalBricks) : 0,
    bricksReached: entry.brickCount,
    distributorName: entry.distributorName,
  }));
}

export function buildInsights(comparison: Omit<MonthlyClosingComparison, "insights">): InsightBullet[] {
  const bullets: InsightBullet[] = [];
  const pct = (ratio: number) => `${(ratio * 100).toFixed(1)}%`;

  const leader = comparison.byDistributor[0];
  if (leader && leader.value > 0) {
    bullets.push({ category: "Distributors", text: `${leader.distributorName} leads the line with ${pct(leader.valueShare)} of value (EGP ${Math.round(leader.value).toLocaleString("en-US")}).` });
  }
  if (comparison.byDistributor.length > 1) {
    bullets.push({ category: "Distributors", text: `${comparison.byDistributor.length} distributors active: ${comparison.byDistributor.map((d) => `${d.distributorName} ${pct(d.valueShare)}`).join(", ")}.` });
  }
  const topProduct = comparison.rankings.products[0];
  if (topProduct) {
    bullets.push({ category: "Products", text: `Top product ${topProduct.label} = ${pct(topProduct.share)} of the line.` });
  }
  const topRegion = comparison.rankings.regions[0];
  if (topRegion) {
    bullets.push({ category: "Geography", text: `Top region ${topRegion.label} = ${pct(topRegion.share)} of value.` });
  }
  if (comparison.whiteSpace.zeroSalesAreas.length > 0) {
    bullets.push({ category: "White-space", text: `${comparison.whiteSpace.zeroSalesAreas.length} of ${comparison.totalAreas} areas had ZERO sales this month.` });
  }
  if (comparison.whiteSpace.zeroSalesBricks.length > 0) {
    bullets.push({ category: "White-space", text: `${comparison.whiteSpace.zeroSalesBricks.length} of ${comparison.totalBricks} bricks had no sales.` });
  }
  if (comparison.whiteSpace.singleDistributorAreas.length > 0) {
    bullets.push({ category: "Risk", text: `${comparison.whiteSpace.singleDistributorAreas.length} areas are served by only ONE distributor.` });
  }
  if (comparison.pareto.customers.total > 0) {
    bullets.push({ category: "Customers", text: `Top 10 customers = ${pct(comparison.pareto.customers.share)} of sales (concentration).` });
  }
  if (comparison.whiteSpace.productGaps.length > 0) {
    bullets.push({ category: "Coverage", text: `${comparison.whiteSpace.productGaps.length} products are missing from one or more regions.` });
  }
  return bullets;
}

// ── Shared assembly ──────────────────────────────────────────────────────────

export type AssembleComparisonInput = {
  brickRows: BrickRow[];
  customerRows: CustomerRow[];
  distProductRows: DistProductRow[];
  line: string | null;
  maps: { areaName: Map<string, string>; areaRegion: Map<string, string>; distributorName: Map<string, string>; regionName: Map<string, string> };
  masterAreas: { areaCode: string; areaName: string; regionCode: string }[];
  masterBricks: { areaCode: string; brickId: string; brickName: string; regionCode: string }[];
  period: string | null;
};

/** The on-screen filter, in the dimensions the comparison's leaf rows actually carry. */
export type ComparisonScope = {
  areaCodes?: string[];
  distributorCodes?: string[];
  productCodes?: string[];
  regionCodes?: string[];
  /** Free text over the area's code or name — the same match the closing matrix filter uses. */
  search?: string;
};

const scopeCodeSet = (values?: string[]) => {
  const codes = (values ?? []).map((value) => value.trim().toUpperCase()).filter(Boolean);
  return codes.length > 0 ? new Set(codes) : null;
};

/**
 * Narrows the comparison's leaf rows to the filter the reader has on screen, so the Comparison,
 * Rankings, Gaps and Summary sheets cover the same slice as the Matrix and Data sheets instead of
 * always covering the whole month. Pure, and it only ever DROPS rows — every derived number stays
 * a real sum over real leaves, because assembleComparison recomputes them all from what is left.
 *
 * The masters are narrowed with the same predicate, and that is the part worth understanding:
 * masterAreas/masterBricks are the denominator for white space ("areas with zero sales") and for
 * totalAreas/totalBricks. Leaving them national while the leaf rows are filtered to one region
 * would report every area in the rest of the country as an unsold gap.
 *
 * Two dimensions cannot be honoured here, because the RPC rows do not carry them:
 *  - product — only distProductRows has a productCode, so a product filter narrows the product
 *    tables while the customer and brick rankings stay at their full-line values.
 *  - inclusion — the closing RPCs already return only the rows that feed the closing, so there is
 *    no excluded bucket here to slice.
 */
export function scopeComparisonInput(
  input: AssembleComparisonInput,
  scope: ComparisonScope | undefined,
): AssembleComparisonInput {
  if (!scope) return input;
  const regions = scopeCodeSet(scope.regionCodes);
  const areas = scopeCodeSet(scope.areaCodes);
  const products = scopeCodeSet(scope.productCodes);
  const distributors = scopeCodeSet(scope.distributorCodes);
  const search = (scope.search ?? "").trim().toLowerCase();
  if (!regions && !areas && !products && !distributors && !search) return input;

  const { areaName } = input.maps;
  // One place predicate for every leaf set and both masters, so a filter can never narrow one
  // sheet and quietly leave another at its whole-month numbers.
  const keepPlace = (regionCode: string, areaCode: string) => {
    if (regions && !regions.has(regionCode.trim().toUpperCase())) return false;
    if (areas && !areas.has(areaCode.trim().toUpperCase())) return false;
    if (search) {
      const haystack = `${areaCode.trim().toLowerCase()} ${(areaName.get(areaCode) ?? "").toLowerCase()}`;
      if (!haystack.includes(search)) return false;
    }
    return true;
  };
  const keepDistributor = (distributorCode: string) =>
    !distributors || distributors.has(distributorCode.trim().toUpperCase());

  const brickRows = input.brickRows.filter(
    (row) => keepPlace(row.regionCode, row.areaCode) && keepDistributor(row.distributorCode),
  );
  const customerRows = input.customerRows.filter(
    (row) => keepPlace(row.regionCode, row.areaCode) && keepDistributor(row.distributorCode),
  );
  const distProductRows = input.distProductRows.filter(
    (row) =>
      keepPlace(row.regionCode, row.areaCode)
      && keepDistributor(row.distributorCode)
      && (!products || products.has(row.productCode.trim().toUpperCase())),
  );
  const masterAreas = input.masterAreas.filter((area) => keepPlace(area.regionCode, area.areaCode));
  const masterBricks = input.masterBricks.filter((brick) => keepPlace(brick.regionCode, brick.areaCode));

  // The region NAME MAP is a universe, not just a lookup: productGaps asks "which regions is this
  // product missing from?" against every key in it. Left whole, a Delta 2 export would report
  // "missing from Cairo" — a gap outside the slice the reader asked for, and one they cannot act
  // on. Narrow it to the regions that survived, which also keeps their own labels resolving.
  const survivingRegions = new Set<string>([
    ...masterAreas.map((area) => area.regionCode),
    ...distProductRows.map((row) => row.regionCode),
    ...brickRows.map((row) => row.regionCode),
    ...customerRows.map((row) => row.regionCode),
  ]);
  const regionName = new Map(
    [...input.maps.regionName].filter(([code]) => survivingRegions.has(code)),
  );

  return {
    ...input,
    brickRows,
    customerRows,
    distProductRows,
    maps: { ...input.maps, regionName },
    masterAreas,
    masterBricks,
  };
}

/**
 * `productGaps` reads "every region that exists" off the region-name map's keys, so a
 * geography-filtered export would otherwise report every OTHER region in the company as a gap —
 * naming regions the reader deliberately filtered out. Narrow the map to the regions the scoped
 * area master still covers. With no geography filter the map is returned as-is, so an unfiltered
 * export is unchanged.
 */
export function scopeRegionNames(
  regionName: Map<string, string>,
  scopedMasterAreas: { regionCode: string }[],
  scope: ComparisonScope | undefined,
): Map<string, string> {
  if (!scope?.areaCodes && !scope?.regionCodes) return regionName;
  const kept = new Set(scopedMasterAreas.map((area) => area.regionCode).filter(Boolean));
  return new Map([...regionName].filter(([code]) => kept.has(code)));
}

// Turns the mapped leaf rows + masters into the full comparison. Shared by the Monthly Closing
// loader (one line) and the Executive Report loader (all lines, line label "All Lines"). Every
// higher-level number is DERIVED from the leaf rows the RPCs return — never by summing
// subtotals (no double counting).
export function assembleComparison(input: AssembleComparisonInput): MonthlyClosingComparison {
  const { brickRows, customerRows, distProductRows, line, masterAreas, masterBricks, period } = input;
  const { areaName, areaRegion, distributorName, regionName } = input.maps;
  const baseMaps: ComparisonNameMaps = { areaName, distributorName, regionName };

  const distributors = distinctDistributors(distProductRows, baseMaps);
  const distributorCodes = distributors.map((d) => d.code);
  const byDistributor = rollupByDistributor({ brickRows, customerRows, distProductRows, maps: baseMaps });
  const nationalValue = byDistributor.reduce((sum, d) => sum + d.value, 0);
  const nationalUnits = byDistributor.reduce((sum, d) => sum + d.units, 0);

  // Aggregations for grids / rankings (derive from the leaf rows).
  const productAgg = new Map<string, { units: number; value: number; name: string }>();
  const regionAgg = new Map<string, { units: number; value: number }>();
  const areaAgg = new Map<string, { units: number; value: number }>();
  distProductRows.forEach((row) => {
    const p = productAgg.get(row.productCode) ?? { name: row.productName, units: 0, value: 0 };
    p.units += row.units; p.value += row.value; productAgg.set(row.productCode, p);
    const r = regionAgg.get(row.regionCode) ?? { units: 0, value: 0 };
    r.units += row.units; r.value += row.value; regionAgg.set(row.regionCode, r);
    const a = areaAgg.get(row.areaCode) ?? { units: 0, value: 0 };
    a.units += row.units; a.value += row.value; areaAgg.set(row.areaCode, a);
  });
  const brickAgg = new Map<string, { units: number; value: number }>();
  brickRows.forEach((row) => {
    const entry = brickAgg.get(row.brickId) ?? { units: 0, value: 0 };
    entry.units += row.units; entry.value += row.value; brickAgg.set(row.brickId, entry);
  });
  const customerAgg = new Map<string, { name: string; units: number; value: number; distributorCode: string }>();
  customerRows.forEach((row) => {
    const key = `${row.clientCode} ${row.distributorCode}`;
    const entry = customerAgg.get(key) ?? { distributorCode: row.distributorCode, name: row.clientName, units: 0, value: 0 };
    entry.units += row.units; entry.value += row.value; customerAgg.set(key, entry);
  });

  const productByDistributor = buildValueGrid(
    distProductRows.map((row) => ({ distributorCode: row.distributorCode, key: row.productCode, label: row.productName, value: row.value })),
    distributorCodes, baseMaps,
  );
  const regionByDistributor = buildValueGrid(
    distProductRows.map((row) => ({ distributorCode: row.distributorCode, key: row.regionCode, label: nameOf(regionName, row.regionCode), value: row.value })),
    distributorCodes, baseMaps,
  );
  const areaByDistributor = buildValueGrid(
    distProductRows.map((row) => ({ distributorCode: row.distributorCode, key: row.areaCode, label: nameOf(areaName, row.areaCode), value: row.value })),
    distributorCodes, baseMaps,
  );

  const soldAreaCodes = new Set([...areaAgg.entries()].filter(([, v]) => v.value > 0 || v.units > 0).map(([code]) => code));
  const soldBrickIds = new Set([...brickAgg.entries()].filter(([, v]) => v.value > 0 || v.units > 0).map(([code]) => code));

  // Fact blocks for the workbook's hidden Data sheet (the formulas' source of truth).
  const brickNameMap = new Map(masterBricks.map((b) => [b.brickId, b.brickName]));
  const productByDistMap = new Map<string, { distributorCode: string; productCode: string; value: number }>();
  const areaByDistMap = new Map<string, { areaCode: string; distributorCode: string; value: number }>();
  distProductRows.forEach((row) => {
    const pKey = `${row.distributorCode} ${row.productCode}`;
    const p = productByDistMap.get(pKey) ?? { distributorCode: row.distributorCode, productCode: row.productCode, value: 0 };
    p.value += row.value; productByDistMap.set(pKey, p);
    const aKey = `${row.distributorCode} ${row.areaCode}`;
    const a = areaByDistMap.get(aKey) ?? { areaCode: row.areaCode, distributorCode: row.distributorCode, value: 0 };
    a.value += row.value; areaByDistMap.set(aKey, a);
  });
  const exportData: ClosingExportData = {
    areaByDist: [...areaByDistMap.values()].map((a) => ({ areaCode: a.areaCode, distributorCode: a.distributorCode, value: round(a.value) })),
    bricks: brickRows.map((b) => ({ brickId: b.brickId, brickName: nameOf(brickNameMap, b.brickId), distributorCode: b.distributorCode, units: round(b.units), value: round(b.value) })),
    customers: customerRows.map((cr) => ({ clientCode: cr.clientCode, clientName: cr.clientName, distributorCode: cr.distributorCode, units: round(cr.units), value: round(cr.value) })),
    distProduct: distProductRows.map((row) => ({
      areaCode: row.areaCode, areaName: nameOf(areaName, row.areaCode), distributorCode: row.distributorCode, distributorName: nameOf(distributorName, row.distributorCode),
      productCode: row.productCode, productName: row.productName, regionCode: row.regionCode, regionName: nameOf(regionName, row.regionCode), units: round(row.units), value: round(row.value),
    })),
    masterAreas: masterAreas.map((a) => ({ areaCode: a.areaCode, areaName: a.areaName, regionName: nameOf(regionName, a.regionCode) })),
    masterBricks: masterBricks.map((b) => ({ areaName: nameOf(areaName, b.areaCode), brickId: b.brickId, brickName: b.brickName, regionName: nameOf(regionName, b.regionCode) })),
    productByDist: [...productByDistMap.values()].map((p) => ({ distributorCode: p.distributorCode, productCode: p.productCode, value: round(p.value) })),
  };

  const base: Omit<MonthlyClosingComparison, "insights"> = {
    areaByDistributor,
    data: exportData,
    avgPrice: avgRealizedPrice(distProductRows, baseMaps),
    byDistributor,
    coverage: coverage(byDistributor, masterAreas.length, masterBricks.length),
    distributors,
    line,
    mix: {
      distributor: computeMix(byDistributor.map((d) => ({ label: d.distributorName, value: d.value }))),
      product: computeMix([...productAgg.entries()].map(([, v]) => ({ label: v.name, value: v.value }))),
      region: computeMix([...regionAgg.entries()].map(([code, v]) => ({ label: nameOf(regionName, code), value: v.value }))),
    },
    national: { areaCount: soldAreaCodes.size, customerCount: customerAgg.size, productCount: productAgg.size, units: round(nationalUnits), value: round(nationalValue) },
    pareto: { customers: pareto([...customerAgg.values()].map((c) => ({ label: c.name, value: c.value })), 10) },
    period,
    productByDistributor,
    rankings: {
      areas: topN([...areaAgg.entries()].map(([code, v]) => ({ key: code, label: nameOf(areaName, code), sublabel: nameOf(regionName, areaRegion.get(code) ?? ""), units: v.units, value: v.value })), 10),
      bricks: topN([...brickAgg.entries()].map(([code, v]) => ({ key: code, label: nameOf(brickNameMap, code), sublabel: code, units: v.units, value: v.value })), 10),
      customers: topN([...customerAgg.values()].map((c) => ({ key: c.name, label: c.name, sublabel: nameOf(distributorName, c.distributorCode), units: c.units, value: c.value })), 10),
      products: topN([...productAgg.entries()].map(([code, v]) => ({ key: code, label: v.name, sublabel: code, units: v.units, value: v.value })), 10),
      regions: topN([...regionAgg.entries()].map(([code, v]) => ({ key: code, label: nameOf(regionName, code), units: v.units, value: v.value })), 10),
    },
    regionByDistributor,
    totalAreas: masterAreas.length,
    totalBricks: masterBricks.length,
    whiteSpace: {
      productGaps: productGaps(distProductRows, [...regionName.keys()], baseMaps),
      singleDistributorAreas: singleDistributorAreas(distProductRows, { ...baseMaps, areaName, areaRegion }),
      zeroSalesAreas: whiteSpaceAreas(masterAreas, soldAreaCodes, baseMaps),
      zeroSalesBricks: whiteSpaceBricks(masterBricks, soldBrickIds, { ...baseMaps, areaName }),
    },
  };

  return { ...base, insights: buildInsights(base) };
}

// ── Server orchestrator ──────────────────────────────────────────────────────

function emptyComparison(line: string | null, period: string | null): MonthlyClosingComparison {
  return {
    areaByDistributor: [], avgPrice: [], byDistributor: [], coverage: [],
    data: { areaByDist: [], bricks: [], customers: [], distProduct: [], masterAreas: [], masterBricks: [], productByDist: [] },
    distributors: [], insights: [], line,
    mix: { distributor: [], product: [], region: [] },
    national: { areaCount: 0, customerCount: 0, productCount: 0, units: 0, value: 0 },
    pareto: { customers: { rows: [], share: 0, topValue: 0, total: 0 } },
    period,
    productByDistributor: [], rankings: { areas: [], bricks: [], customers: [], products: [], regions: [] },
    regionByDistributor: [], totalAreas: 0, totalBricks: 0,
    whiteSpace: { productGaps: [], singleDistributorAreas: [], zeroSalesAreas: [], zeroSalesBricks: [] },
  };
}

/** Reference data every comparison needs regardless of where its leaf rows come from. */
type ComparisonMasters = {
  maps: AssembleComparisonInput["maps"];
  masterAreas: AssembleComparisonInput["masterAreas"];
  masterBricks: AssembleComparisonInput["masterBricks"];
};

async function loadComparisonMasters(): Promise<ComparisonMasters> {
  const supabase = getSupabaseAdmin();
  const [references, brickMasterResult] = await Promise.all([
    loadSalesReferenceData(),
    supabase.from("source_of_sales_bricks").select("brick_id,brick_name,area_code,region_code").eq("active", true),
  ]);

  const regionName = new Map<string, string>();
  const areaName = new Map<string, string>();
  const distributorName = new Map<string, string>();
  const areaRegion = new Map<string, string>();
  references.regions.forEach((r) => { if (r.regionCode) regionName.set(r.regionCode, r.regionName || r.regionCode); });
  (references.areas ?? []).forEach((a) => {
    if (a.areaCode) { areaName.set(a.areaCode, a.areaName || a.areaCode); areaRegion.set(a.areaCode, a.regionCode); }
  });
  references.distributors.forEach((d) => { if (d.code) distributorName.set(d.code, d.name || d.code); });

  const masterAreas = (references.areas ?? []).map((a) => ({ areaCode: a.areaCode, areaName: a.areaName || a.areaCode, regionCode: a.regionCode }));
  const masterBricks = ((brickMasterResult.error ? [] : brickMasterResult.data ?? []) as Array<Record<string, unknown>>).map((b) => ({
    areaCode: String(b.area_code ?? ""), brickId: String(b.brick_id ?? ""), brickName: String(b.brick_name ?? "") || String(b.brick_id ?? ""), regionCode: String(b.region_code ?? ""),
  }));

  return { maps: { areaName, areaRegion, distributorName, regionName }, masterAreas, masterBricks };
}

export async function loadMonthlyClosingComparison(
  line: string | null,
  period: string | null,
  scope?: ComparisonScope,
): Promise<MonthlyClosingComparison> {
  if (!line || !period) return emptyComparison(line, period);

  const supabase = getSupabaseAdmin();
  // Paginated reads — these aggregates can exceed PostgREST's 1000-row cap (e.g. a line with
  // thousands of customers), which would otherwise truncate the comparison.
  const [masters, distProductData, brickData, customerData] = await Promise.all([
    loadComparisonMasters(),
    rpcAll(supabase, "phx_closing_distributor_product", { p_line: line, p_period: period }, ["distributor_code", "region_code", "area_code", "product_code"]),
    rpcAll(supabase, "phx_closing_brick", { p_line: line, p_period: period }, ["distributor_code", "region_code", "area_code", "brick_id"]),
    rpcAll(supabase, "phx_closing_customers", { p_line: line, p_period: period }, ["client_code", "distributor_code"]),
  ]);

  const distProductRows: DistProductRow[] = (distProductData as Array<Record<string, unknown>>).map((row) => ({
    areaCode: String(row.area_code ?? ""), distributorCode: String(row.distributor_code ?? ""), productCode: String(row.product_code ?? ""),
    productName: String(row.product_name ?? "") || String(row.product_code ?? ""), regionCode: String(row.region_code ?? ""),
    units: Number(row.units ?? 0), value: Number(row.value ?? 0),
  }));
  const brickRows: BrickRow[] = (brickData as Array<Record<string, unknown>>).map((row) => ({
    areaCode: String(row.area_code ?? ""), brickId: String(row.brick_id ?? ""), distributorCode: String(row.distributor_code ?? ""),
    regionCode: String(row.region_code ?? ""), units: Number(row.units ?? 0), value: Number(row.value ?? 0),
  }));
  const customerRows: CustomerRow[] = (customerData as Array<Record<string, unknown>>).map((row) => ({
    areaCode: String(row.area_code ?? ""), brickId: String(row.brick_id ?? ""), clientCode: String(row.client_code ?? ""),
    clientName: String(row.client_name ?? "") || String(row.client_code ?? ""), distributorCode: String(row.distributor_code ?? ""),
    regionCode: String(row.region_code ?? ""), units: Number(row.units ?? 0), value: Number(row.value ?? 0),
  }));

  // Scope BEFORE assembling: every ranking, mix, gap and insight is derived inside
  // assembleComparison, so narrowing the leaves here narrows all of them at once — including the
  // hidden Calc sheet the report formulas read from.
  const scoped = scopeComparisonInput({
    brickRows,
    customerRows,
    distProductRows,
    line,
    maps: masters.maps,
    masterAreas: masters.masterAreas,
    masterBricks: masters.masterBricks,
    period,
  }, scope);

  // The region NAME map is scoped separately because productGaps treats its keys as "every region
  // that exists" — left whole, a Delta-only export names every other region as a gap.
  return assembleComparison({
    ...scoped,
    maps: {
      ...scoped.maps,
      regionName: scopeRegionNames(scoped.maps.regionName, scoped.masterAreas, scope),
    },
  });
}

/** The slice of a detail row the from-rows comparison needs — structural, so this module never
 * imports the details module (which would be a cycle). */
export type ComparisonSourceRow = {
  areaCode: string;
  brickId: string;
  brickName: string;
  clientCode: string;
  clientName: string;
  distributorCode: string;
  includedInClosing: boolean;
  productCode: string;
  productName: string;
  qty: number;
  regionCode: string;
  salesValue: number;
};

/**
 * Groups filtered invoice rows into the same three leaf shapes the closing RPCs return, using the
 * same measures (`units` = Σ qty, mirroring the RPCs' sum(total_qty); `value` = Σ salesValue,
 * mirroring sum(effective_units x factory_price)). Only rows feeding the closing count — the RPCs
 * never see excluded rows either, so a from-rows comparison stays comparable to an RPC one.
 *
 * Rows with no brick stay out of the brick leaves and rows with no customer code stay out of the
 * customer leaves, exactly as they are absent from phx_closing_brick / phx_closing_customers.
 */
export function comparisonLeavesFromRows(
  rows: ComparisonSourceRow[],
): Pick<AssembleComparisonInput, "brickRows" | "customerRows" | "distProductRows"> {
  const distProduct = new Map<string, DistProductRow>();
  const bricks = new Map<string, BrickRow>();
  const customers = new Map<string, CustomerRow>();

  rows.forEach((row) => {
    if (!row.includedInClosing) return;

    const dpKey = `${row.distributorCode}|${row.regionCode}|${row.areaCode}|${row.productCode}`;
    const dp = distProduct.get(dpKey) ?? {
      areaCode: row.areaCode, distributorCode: row.distributorCode, productCode: row.productCode,
      productName: row.productName || row.productCode, regionCode: row.regionCode, units: 0, value: 0,
    };
    dp.units += row.qty;
    dp.value += row.salesValue;
    distProduct.set(dpKey, dp);

    if (row.brickId.trim()) {
      const brickKey = `${row.distributorCode}|${row.regionCode}|${row.areaCode}|${row.brickId}`;
      const brick = bricks.get(brickKey) ?? {
        areaCode: row.areaCode, brickId: row.brickId, distributorCode: row.distributorCode,
        regionCode: row.regionCode, units: 0, value: 0,
      };
      brick.units += row.qty;
      brick.value += row.salesValue;
      bricks.set(brickKey, brick);
    }

    if (row.clientCode.trim()) {
      const customerKey = `${row.distributorCode}|${row.clientCode}`;
      const customer = customers.get(customerKey) ?? {
        areaCode: row.areaCode, brickId: row.brickId, clientCode: row.clientCode,
        clientName: row.clientName || row.clientCode, distributorCode: row.distributorCode,
        regionCode: row.regionCode, units: 0, value: 0,
      };
      customer.units += row.qty;
      customer.value += row.salesValue;
      customers.set(customerKey, customer);
    }
  });

  const rounded = <T extends { units: number; value: number }>(leaf: T): T => ({
    ...leaf, units: round(leaf.units), value: round(leaf.value),
  });
  return {
    brickRows: [...bricks.values()].map(rounded),
    customerRows: [...customers.values()].map(rounded),
    distProductRows: [...distProduct.values()].map(rounded),
  };
}

/**
 * The comparison for a ROW-LEVEL filtered export: same masters, same assembly, but the leaves come
 * from the exact invoice rows the Data sheet will show instead of from the whole-month RPCs. This
 * is what lets the Comparison / Rankings / Gaps / Summary sheets — and the hidden Calc sheet the
 * Closing Matrix sheet's live formulas read — follow a distributor, Included/Excluded, free-text
 * or product filter that the aggregates cannot express. `scope` still narrows the masters, so the
 * white-space denominators cover the filtered place, not the whole country.
 */
export async function loadMonthlyClosingComparisonFromRows(
  line: string | null,
  period: string | null,
  rows: ComparisonSourceRow[],
  scope?: ComparisonScope,
): Promise<MonthlyClosingComparison> {
  if (!line || !period) return emptyComparison(line, period);
  const masters = await loadComparisonMasters();
  return assembleComparison(scopeComparisonInput({
    ...comparisonLeavesFromRows(rows),
    line,
    maps: masters.maps,
    masterAreas: masters.masterAreas,
    masterBricks: masters.masterBricks,
    period,
  }, scope));
}
