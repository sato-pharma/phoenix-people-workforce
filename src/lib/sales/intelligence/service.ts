import { listSalesPeriods } from "@/lib/sales/executive-report";
import { isRestrictedProductCode, type SalesAccessScope } from "@/lib/sales/access-scope";
import {
  aggregateByArea,
  aggregateByDistributor,
  aggregateByDistributorKeyed,
  aggregateByLine,
  aggregateByProduct,
  aggregateByProductKeyed,
  aggregateByRegion,
  aggregateByRegionKeyed,
  aggregateCustomers,
  buildDailyCurve,
  buildKpiSparks,
  computeMonthCompleteness,
  computeMovers,
  computeRunRate,
  concentrationIndices,
  diffCustomerSets,
  makeDelta,
  sumTotals,
} from "@/lib/sales/intelligence/derive";
import {
  loadSiCustomerProduct,
  loadSiCustomers,
  loadSiDaily,
  loadSiDistProduct,
  loadSiPeriodTotals,
  loadSiReference,
  type SiDistProductRow,
  type SiPeriodTotalRow,
  type SiReference,
} from "@/lib/sales/intelligence/loader";
import { shiftPeriod } from "@/lib/sales/periods";
import type {
  SiCompare,
  SiCustomerChurn,
  SiCustomerDrill,
  SiCustomerInsights,
  SiDashboardBundle,
  SiDetailsBundle,
  SiDistributorPerformance,
  SiGeography,
  SiInsight,
  SiKpiSummary,
  SiMonthCompleteness,
  SiMovers,
  SiProductDrill,
  SiProductPerformance,
  SiTransactionRow,
  SiTrend,
  SiTrendPoint,
} from "@/lib/sales/intelligence/types";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// ─────────────────────────────────────────────────────────────────────────────
// Sales Intelligence — server orchestrators. Heavy fact-scans run SEQUENTIALLY (DB contention +
// the authenticator's 8s cap on plain statements); everything else derives in memory. Raw fact
// rows never leave the server, and every loader path is scope-filtered + restricted-excluded.
// The dashboard bundle costs at most TWO heavy scans (current month + the one-scan period totals)
// plus two cheap day-grain reads — the old O(months) per-period trend loop is gone for good.
// ─────────────────────────────────────────────────────────────────────────────

const distinct = <T>(rows: T[], pick: (row: T) => string) => {
  const set = new Set<string>();
  for (const row of rows) {
    const value = pick(row);
    if (value) set.add(value);
  }
  return set.size;
};

const normCode = (value: string) => value.trim().toUpperCase();

/** Validated batches reduced to (period, distributorCode) for month-completeness. */
async function loadValidatedBatchKeys(): Promise<Array<{ period: string; distributorCode: string }>> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("source_of_sales_import_batches")
    .select("period,distributor_code")
    .eq("status", "validated")
    .not("period", "is", null);
  if (error) return [];
  return ((data ?? []) as Array<Record<string, unknown>>)
    .map((row) => ({ period: String(row.period ?? ""), distributorCode: String(row.distributor_code ?? "") }))
    .filter((row) => row.period && row.distributorCode);
}

async function monthCompletenessFor(period: string | null, reference: SiReference) {
  const batches = await loadValidatedBatchKeys();
  const activeCodes = [...reference.distributorName.keys()];
  const map = computeMonthCompleteness(batches, activeCodes, reference.distributorName);
  if (!period) return { complete: true, missing: [] as string[] };
  const entry = map.get(period);
  return { complete: entry?.complete ?? true, missing: entry?.missing ?? [] };
}

function buildCompare(
  periodTotals: SiPeriodTotalRow[],
  selectedPeriod: string | null,
  availablePeriods: string[],
): SiCompare {
  const totalsByPeriod = new Map(periodTotals.map((row) => [row.period, row]));
  const current = selectedPeriod ? totalsByPeriod.get(selectedPeriod) : undefined;
  const resolveBaseline = (monthsBack: number) => {
    if (!selectedPeriod) return { period: null as string | null, row: undefined as SiPeriodTotalRow | undefined };
    const shifted = shiftPeriod(selectedPeriod, monthsBack);
    if (!shifted || !availablePeriods.includes(shifted)) return { period: null, row: undefined };
    return { period: shifted, row: totalsByPeriod.get(shifted) };
  };
  const mom = resolveBaseline(1);
  const yoy = resolveBaseline(12);
  return {
    priorPeriod: mom.period,
    yoyPeriod: yoy.period,
    value: {
      mom: makeDelta(current?.value ?? 0, mom.row ? mom.row.value : null),
      yoy: makeDelta(current?.value ?? 0, yoy.row ? yoy.row.value : null),
    },
    units: {
      mom: makeDelta(current?.units ?? 0, mom.row ? mom.row.units : null),
      yoy: makeDelta(current?.units ?? 0, yoy.row ? yoy.row.units : null),
    },
  };
}

function buildSiInsights(input: {
  lineMix: ReturnType<typeof aggregateByLine>;
  regions: ReturnType<typeof aggregateByRegion>;
  products: ReturnType<typeof aggregateByProduct>;
  distributors: ReturnType<typeof aggregateByDistributor>;
  compare: SiCompare;
  monthComplete: boolean;
  missingDistributors: string[];
  zeroSalesAreas: string[];
  period: string | null;
}): SiInsight[] {
  const insights: SiInsight[] = [];
  const pctText = (share: number) => `${(share * 100).toFixed(1)}%`;

  if (input.compare.value.mom.pct !== null) {
    const pct = input.compare.value.mom.pct;
    insights.push({
      category: pct >= 0 ? "products" : "risk",
      headline: `Sales ${pct >= 0 ? "up" : "down"} ${(Math.abs(pct) * 100).toFixed(1)}% vs last month`,
      detail: `Net value moved from the prior month's baseline`,
      anchor: "#rhythm",
      deltaPct: pct,
    });
  }
  if (input.distributors[0] && input.distributors[0].share > 0.4) {
    insights.push({
      category: "risk",
      headline: `${input.distributors[0].name} carries ${pctText(input.distributors[0].share)} of value`,
      detail: "Distributor dependency above the 40% concentration threshold",
      anchor: "#distributors",
    });
  }
  if (input.lineMix[0]) {
    insights.push({
      category: "products",
      headline: `${input.lineMix[0].name} leads the mix at ${pctText(input.lineMix[0].share)}`,
      detail: `${input.products.length} active products in scope`,
      anchor: "#products",
    });
  }
  if (input.regions[0]) {
    insights.push({
      category: "geography",
      headline: `${input.regions[0].name} is the top region`,
      detail: `${pctText(input.regions[0].share)} of scoped value`,
      anchor: "#geography",
    });
  }
  if (input.zeroSalesAreas.length > 0) {
    insights.push({
      category: "coverage",
      headline: `${input.zeroSalesAreas.length} areas with zero sales`,
      detail: input.zeroSalesAreas.slice(0, 4).join(", ") + (input.zeroSalesAreas.length > 4 ? "…" : ""),
      anchor: "#geography",
    });
  }
  if (!input.monthComplete) {
    insights.push({
      category: "risk",
      headline: `${input.period} is incomplete`,
      detail: `Missing: ${input.missingDistributors.join(", ") || "—"}`,
      anchor: "#risks",
    });
  }
  return insights.slice(0, 6);
}

function accessBadge(scope: SalesAccessScope) {
  return {
    role: scope.role,
    canViewAllSales: scope.canViewAllSales,
    includeRestrictedAllowed: scope.includeRestrictedProductsAllowed,
    restrictedIncluded: scope.restrictedIncluded,
    restrictedExcluded: scope.excludedProductCodes.length > 0,
    lineNames: scope.allowedLineNames ? [...scope.allowedLineNames] : [],
    regionNames: scope.allowedRegionNames ? [...scope.allowedRegionNames] : [],
  };
}

// ── Page 1: the executive bundle ─────────────────────────────────────────────────────────────

export async function getSiDashboardBundle(period: string | null, scope: SalesAccessScope): Promise<SiDashboardBundle> {
  const reference = await loadSiReference();
  const availablePeriods = await listSalesPeriods();
  const selectedPeriod = period && availablePeriods.includes(period) ? period : availablePeriods[0] ?? null;

  // Heavy scan #1: the selected month at distributor×product grain.
  const rows = await loadSiDistProduct(selectedPeriod, scope, reference);
  // Heavy scan #2: ONE grouped scan over all validated months → trend + sparks + MoM/YoY.
  const periodTotals = await loadSiPeriodTotals(scope, reference);
  // Cheap day-grain reads (≤ ~320 rows each), sequential after the heavy scans.
  const compare = buildCompare(periodTotals, selectedPeriod, availablePeriods);
  const daily = selectedPeriod
    ? buildDailyCurve(await loadSiDaily(selectedPeriod, scope, reference), selectedPeriod)
    : null;
  const dailyPrior = compare.priorPeriod
    ? buildDailyCurve(await loadSiDaily(compare.priorPeriod, scope, reference), compare.priorPeriod)
    : null;

  const batches = await loadValidatedBatchKeys();
  const completeness = computeMonthCompleteness(batches, [...reference.distributorName.keys()], reference.distributorName);
  const selectedCompleteness = selectedPeriod ? completeness.get(selectedPeriod) : undefined;

  const totals = sumTotals(rows);
  const byRegion = aggregateByRegion(rows, reference);
  const byProduct = aggregateByProduct(rows);
  const byArea = aggregateByArea(rows, reference);
  const byDistributor = aggregateByDistributor(rows, reference);
  const lineMix = aggregateByLine(rows);

  // White-space: master areas (inside the viewer's region scope when set) with no sales rows.
  const soldAreaNames = new Set(byArea.map((area) => area.name));
  const zeroSalesAreas: string[] = [];
  for (const [, name] of reference.areaName) {
    if (name && name !== "Direct (company)" && !soldAreaNames.has(name)) zeroSalesAreas.push(name);
  }
  zeroSalesAreas.sort((left, right) => left.localeCompare(right));

  const kpis: SiKpiSummary = {
    period: selectedPeriod,
    totals,
    distributorCount: distinct(rows, (row) => row.distributorCode),
    lineCount: distinct(rows, (row) => row.officialLine),
    productCount: distinct(rows, (row) => row.productCode),
    areaCount: distinct(rows, (row) => row.areaCode),
    regionCount: distinct(rows, (row) => row.regionCode),
    topRegion: byRegion[0] ? { name: byRegion[0].name, value: byRegion[0].value } : null,
    topProduct: byProduct[0] ? { name: byProduct[0].name, value: byProduct[0].value } : null,
    restrictedExcluded: scope.excludedProductCodes.length > 0,
    restrictedIncluded: scope.restrictedIncluded,
    monthComplete: selectedCompleteness?.complete ?? true,
    missingDistributors: selectedCompleteness?.missing ?? [],
  };

  const trendPoints: SiTrendPoint[] = periodTotals.slice(-12).map((row) => {
    const entry = completeness.get(row.period);
    return {
      period: row.period,
      value: row.value,
      units: row.units,
      monthComplete: entry?.complete ?? true,
      expected: entry?.expected.length ?? 0,
      uploaded: entry?.uploaded.length ?? 0,
    };
  });

  const nowPeriod = new Date().toISOString().slice(0, 7);
  const runRate = computeRunRate(daily, totals, {
    monthComplete: kpis.monthComplete,
    isCurrentCalendarMonth: selectedPeriod === nowPeriod,
  });

  const insights = buildSiInsights({
    lineMix,
    regions: byRegion,
    products: byProduct,
    distributors: byDistributor,
    compare,
    monthComplete: kpis.monthComplete,
    missingDistributors: kpis.missingDistributors,
    zeroSalesAreas,
    period: selectedPeriod,
  });

  return {
    period: selectedPeriod,
    availablePeriods,
    kpis,
    products: { period: selectedPeriod, products: byProduct.slice(0, 50), lineMix },
    geography: { period: selectedPeriod, regions: byRegion, areas: byArea.slice(0, 100) },
    distributors: { period: selectedPeriod, distributors: byDistributor },
    trend: { points: trendPoints },
    access: accessBadge(scope),
    compare,
    kpiSparks: buildKpiSparks(periodTotals, completeness),
    daily,
    dailyPrior,
    runRate,
    concentration: {
      products: concentrationIndices(byProduct),
      distributors: concentrationIndices(byDistributor),
    },
    insights,
    zeroSalesAreas: zeroSalesAreas.slice(0, 50),
  };
}

// ── Lazy executive endpoints ─────────────────────────────────────────────────────────────────

/** Movers vs the prior month across products / distributors / regions (one extra heavy scan). */
export async function getSiMovers(period: string | null, scope: SalesAccessScope): Promise<SiMovers> {
  const reference = await loadSiReference();
  const availablePeriods = await listSalesPeriods();
  const selectedPeriod = period && availablePeriods.includes(period) ? period : availablePeriods[0] ?? null;
  const priorPeriod = selectedPeriod ? shiftPeriod(selectedPeriod, 1) : null;
  const priorAvailable = priorPeriod && availablePeriods.includes(priorPeriod) ? priorPeriod : null;

  // ONE scope, BOTH loads — current and baseline can never disagree on exclusion/scope.
  const current = await loadSiDistProduct(selectedPeriod, scope, reference);
  const prior = priorAvailable ? await loadSiDistProduct(priorAvailable, scope, reference) : null;

  return {
    priorPeriod: priorAvailable,
    products: computeMovers(aggregateByProductKeyed(current), prior ? aggregateByProductKeyed(prior) : null),
    distributors: computeMovers(
      aggregateByDistributorKeyed(current, reference),
      prior ? aggregateByDistributorKeyed(prior, reference) : null,
    ),
    regions: computeMovers(
      aggregateByRegionKeyed(current, reference),
      prior ? aggregateByRegionKeyed(prior, reference) : null,
    ),
  };
}

/** Daily curve for one concrete month (thin wrapper for the /daily endpoint). */
export async function getSiDailyCurve(period: string, scope: SalesAccessScope) {
  const reference = await loadSiReference();
  return buildDailyCurve(await loadSiDaily(period, scope, reference), period);
}

/** Everything about ONE product: splits, customers, daily curve, MoM. Restricted-guarded. */
export async function getSiProductDrill(
  period: string,
  scope: SalesAccessScope,
  productCode: string,
): Promise<SiProductDrill> {
  if (isRestrictedProductCode(productCode) && scope.excludedProductCodes.length > 0) {
    throw new Error("Forbidden: restricted product.");
  }
  const reference = await loadSiReference();
  const target = normCode(productCode);
  const matches = (row: SiDistProductRow) => normCode(row.productCode) === target;

  const rows = await loadSiDistProduct(period, scope, reference);
  const productRows = rows.filter(matches);
  if (productRows.length === 0) {
    throw new Error("Product not found in this period for your scope.");
  }
  const totals = sumTotals(productRows);
  const scopedTotal = sumTotals(rows).value;

  const availablePeriods = await listSalesPeriods();
  const priorPeriod = shiftPeriod(period, 1);
  const prior = priorPeriod && availablePeriods.includes(priorPeriod)
    ? sumTotals((await loadSiDistProduct(priorPeriod, scope, reference)).filter(matches))
    : null;

  const customers = aggregateCustomers(
    (await loadSiCustomerProduct(period, scope, reference, { productCodes: [productCode], limit: 100 }))
      .map((row) => ({
        clientCode: row.clientCode,
        clientName: row.clientName,
        distributorCode: row.distributorCode,
        regionCode: row.regionCode,
        areaCode: row.areaCode,
        brickId: "",
        units: row.units,
        value: row.value,
      })),
    reference,
    25,
  ).customers;

  const dailyRows = await loadSiDaily(period, scope, reference, { productCodes: [productCode] });

  return {
    period,
    productCode: target,
    productName: productRows[0].productName || target,
    officialLine: productRows[0].officialLine || "—",
    totals,
    shareOfScopedTotal: scopedTotal > 0 ? Number((totals.value / scopedTotal).toFixed(6)) : 0,
    avgRealizedPrice: totals.units > 0 ? Number((totals.value / totals.units).toFixed(2)) : null,
    compare: {
      value: makeDelta(totals.value, prior ? prior.value : null),
      units: makeDelta(totals.units, prior ? prior.units : null),
    },
    regions: aggregateByRegion(productRows, reference).slice(0, 10),
    distributors: aggregateByDistributor(productRows, reference).slice(0, 10).map((distributor) => ({
      name: distributor.name,
      value: distributor.value,
      units: distributor.units,
      share: distributor.share,
    })),
    customers,
    daily: buildDailyCurve(dailyRows, period),
  };
}

/** ONE customer's product basket with per-product MoM. */
export async function getSiCustomerDrill(
  period: string,
  scope: SalesAccessScope,
  clientCode: string,
  distributorCode: string,
): Promise<SiCustomerDrill> {
  const reference = await loadSiReference();
  const wantDistributor = normCode(distributorCode);
  const ofDistributor = <T extends { distributorCode: string }>(rows: T[]) =>
    rows.filter((row) => normCode(row.distributorCode) === wantDistributor);

  const current = ofDistributor(
    await loadSiCustomerProduct(period, scope, reference, { clientCodes: [clientCode], limit: 500 }),
  );
  if (current.length === 0) {
    throw new Error("Customer not found in this period for your scope.");
  }
  const availablePeriods = await listSalesPeriods();
  const priorPeriod = shiftPeriod(period, 1);
  const prior = priorPeriod && availablePeriods.includes(priorPeriod)
    ? ofDistributor(await loadSiCustomerProduct(priorPeriod, scope, reference, { clientCodes: [clientCode], limit: 500 }))
    : null;
  const priorByProduct = prior ? new Map(prior.map((row) => [normCode(row.productCode), row.value])) : null;

  const totalValue = current.reduce((sum, row) => sum + row.value, 0);
  const lineByProduct = new Map<string, string>();
  // official_line is not in the customer_product output; resolve from the product master names map
  // is unnecessary — basket lines come from the period scan only when needed. Keep "—" fallback.
  const basket = [...current]
    .sort((left, right) => right.value - left.value)
    .map((row) => {
      const priorValue = priorByProduct ? priorByProduct.get(normCode(row.productCode)) ?? null : null;
      return {
        productName: row.productName,
        officialLine: lineByProduct.get(normCode(row.productCode)) ?? "—",
        units: Number(row.units.toFixed(2)),
        value: Number(row.value.toFixed(2)),
        share: totalValue > 0 ? Number((row.value / totalValue).toFixed(6)) : 0,
        priorValue: priorValue === null ? null : Number(priorValue.toFixed(2)),
        deltaPct: priorValue !== null && priorValue !== 0 ? Number(((row.value - priorValue) / Math.abs(priorValue)).toFixed(6)) : null,
      };
    });

  return {
    period,
    clientCode,
    customerName: current[0].clientName,
    distributorName: reference.distributorName.get(current[0].distributorCode) || current[0].distributorCode,
    regionName: reference.regionName.get(current[0].regionCode) || current[0].regionCode || "—",
    areaName: reference.areaName.get(current[0].areaCode) || current[0].areaCode || "—",
    totals: { value: Number(totalValue.toFixed(2)), units: Number(current.reduce((sum, row) => sum + row.units, 0).toFixed(2)) },
    basket,
  };
}

/** New / lost / retained customers vs the prior month (the heaviest pair — own lazy endpoint). */
export async function getSiCustomerChurn(period: string | null, scope: SalesAccessScope): Promise<SiCustomerChurn> {
  const reference = await loadSiReference();
  const availablePeriods = await listSalesPeriods();
  const selectedPeriod = period && availablePeriods.includes(period) ? period : availablePeriods[0] ?? null;
  const priorPeriod = selectedPeriod ? shiftPeriod(selectedPeriod, 1) : null;
  const priorAvailable = priorPeriod && availablePeriods.includes(priorPeriod) ? priorPeriod : null;

  const current = await loadSiCustomers(selectedPeriod, scope, reference);
  const prior = priorAvailable ? await loadSiCustomers(priorAvailable, scope, reference) : null;
  const diff = diffCustomerSets(current, prior, reference);
  return { period: selectedPeriod ?? "", priorPeriod: priorAvailable, ...diff };
}

// ── Existing endpoints (kept; trend now rides the one-scan totals) ───────────────────────────

export async function getSiKpiSummary(period: string | null, scope: SalesAccessScope): Promise<SiKpiSummary> {
  const reference = await loadSiReference();
  const [rows, completeness] = await Promise.all([
    loadSiDistProduct(period, scope, reference),
    monthCompletenessFor(period, reference),
  ]);
  const totals = sumTotals(rows);
  const byRegion = aggregateByRegion(rows, reference);
  const byProduct = aggregateByProduct(rows);
  return {
    period,
    totals,
    distributorCount: distinct(rows, (row) => row.distributorCode),
    lineCount: distinct(rows, (row) => row.officialLine),
    productCount: distinct(rows, (row) => row.productCode),
    areaCount: distinct(rows, (row) => row.areaCode),
    regionCount: distinct(rows, (row) => row.regionCode),
    topRegion: byRegion[0] ? { name: byRegion[0].name, value: byRegion[0].value } : null,
    topProduct: byProduct[0] ? { name: byProduct[0].name, value: byProduct[0].value } : null,
    restrictedExcluded: scope.excludedProductCodes.length > 0,
    restrictedIncluded: scope.restrictedIncluded,
    monthComplete: completeness.complete,
    missingDistributors: completeness.missing,
  };
}

export async function getSiProductPerformance(period: string | null, scope: SalesAccessScope): Promise<SiProductPerformance> {
  const reference = await loadSiReference();
  const rows = await loadSiDistProduct(period, scope, reference);
  return {
    period,
    products: aggregateByProduct(rows).slice(0, 50),
    lineMix: aggregateByLine(rows),
  };
}

export async function getSiGeography(period: string | null, scope: SalesAccessScope): Promise<SiGeography> {
  const reference = await loadSiReference();
  const rows = await loadSiDistProduct(period, scope, reference);
  return {
    period,
    regions: aggregateByRegion(rows, reference),
    areas: aggregateByArea(rows, reference).slice(0, 100),
  };
}

export async function getSiDistributorPerformance(period: string | null, scope: SalesAccessScope): Promise<SiDistributorPerformance> {
  const reference = await loadSiReference();
  const rows = await loadSiDistProduct(period, scope, reference);
  return { period, distributors: aggregateByDistributor(rows, reference) };
}

export async function getSiCustomerInsights(period: string | null, scope: SalesAccessScope): Promise<SiCustomerInsights> {
  const reference = await loadSiReference();
  const rows = await loadSiCustomers(period, scope, reference);
  return { period, ...aggregateCustomers(rows, reference, 50) };
}

export async function getSiTrend(scope: SalesAccessScope, maxPoints = 12): Promise<SiTrend> {
  const reference = await loadSiReference();
  const periodTotals = await loadSiPeriodTotals(scope, reference);
  const batches = await loadValidatedBatchKeys();
  const completeness = computeMonthCompleteness(batches, [...reference.distributorName.keys()], reference.distributorName);
  const points: SiTrendPoint[] = periodTotals.slice(-maxPoints).map((row) => {
    const entry: SiMonthCompleteness | undefined = completeness.get(row.period);
    return {
      period: row.period,
      value: row.value,
      units: row.units,
      monthComplete: entry?.complete ?? true,
      expected: entry?.expected.length ?? 0,
      uploaded: entry?.uploaded.length ?? 0,
    };
  });
  return { points };
}

// ── Page 2: details bundle (unchanged behavior) ──────────────────────────────────────────────

function toTransactionRows(rows: SiDistProductRow[], reference: SiReference): SiTransactionRow[] {
  return rows
    .map((row) => ({
      distributorName: reference.distributorName.get(row.distributorCode) || row.distributorCode || "—",
      officialLine: row.officialLine || "—",
      regionName: reference.regionName.get(row.regionCode) || row.regionCode || "—",
      areaName: reference.areaName.get(row.areaCode) || row.areaCode || "—",
      productName: row.productName || row.productCode || "—",
      units: Number(row.units.toFixed(2)),
      value: Number(row.value.toFixed(2)),
    }))
    .sort((left, right) => right.value - left.value);
}

export async function getSiDetailsBundle(period: string | null, scope: SalesAccessScope): Promise<SiDetailsBundle> {
  const reference = await loadSiReference();
  const availablePeriods = await listSalesPeriods();
  const selectedPeriod = period && availablePeriods.includes(period) ? period : availablePeriods[0] ?? null;
  const rows = await loadSiDistProduct(selectedPeriod, scope, reference);

  return {
    period: selectedPeriod,
    availablePeriods,
    transactions: toTransactionRows(rows, reference).slice(0, 500),
    products: aggregateByProduct(rows).slice(0, 200),
    distributors: aggregateByDistributor(rows, reference),
    regions: aggregateByRegion(rows, reference),
    areas: aggregateByArea(rows, reference).slice(0, 200),
    access: accessBadge(scope),
  };
}
