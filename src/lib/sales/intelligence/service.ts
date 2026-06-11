import { listSalesPeriods } from "@/lib/sales/executive-report";
import { type SalesAccessScope } from "@/lib/sales/access-scope";
import {
  aggregateByArea,
  aggregateByDistributor,
  aggregateByLine,
  aggregateByProduct,
  aggregateByRegion,
  aggregateCustomers,
  computeMonthCompleteness,
  sumTotals,
} from "@/lib/sales/intelligence/derive";
import {
  loadSiCustomers,
  loadSiDistProduct,
  loadSiReference,
  type SiDistProductRow,
  type SiReference,
} from "@/lib/sales/intelligence/loader";
import type {
  SiCustomerInsights,
  SiDashboardBundle,
  SiDetailsBundle,
  SiDistributorPerformance,
  SiGeography,
  SiKpiSummary,
  SiProductPerformance,
  SiTransactionRow,
  SiTrend,
  SiTrendPoint,
} from "@/lib/sales/intelligence/types";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// ─────────────────────────────────────────────────────────────────────────────
// Sales Intelligence — server orchestrators. Each loads the SI rows (already scope-filtered
// and restricted-excluded by the loader/RPCs) and derives a BY-NAME response. Raw fact rows
// never leave the server. The page calls these as separate endpoints, so each loads its own
// reference; within an endpoint the reference is loaded once.
// ─────────────────────────────────────────────────────────────────────────────

const distinct = <T>(rows: T[], pick: (row: T) => string) => {
  const set = new Set<string>();
  for (const row of rows) {
    const value = pick(row);
    if (value) set.add(value);
  }
  return set.size;
};

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

/**
 * One-pass loader for the Executive Dashboard (Page 1). Scans the selected period's
 * distributor×product rows ONCE and derives the KPI strip, product, geography and distributor
 * sections from it; the multi-period trend reuses that scan for the selected month and scans
 * the others sequentially. Customers (the heaviest aggregate) are loaded lazily by the client.
 */
export async function getSiDashboardBundle(period: string | null, scope: SalesAccessScope): Promise<SiDashboardBundle> {
  const reference = await loadSiReference();
  const availablePeriods = await listSalesPeriods();
  const selectedPeriod = period && availablePeriods.includes(period) ? period : availablePeriods[0] ?? null;

  const rows = await loadSiDistProduct(selectedPeriod, scope, reference);
  const batches = await loadValidatedBatchKeys();
  const completeness = computeMonthCompleteness(batches, [...reference.distributorName.keys()], reference.distributorName);

  const totals = sumTotals(rows);
  const byRegion = aggregateByRegion(rows, reference);
  const byProduct = aggregateByProduct(rows);
  const selectedCompleteness = selectedPeriod ? completeness.get(selectedPeriod) : undefined;

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

  // Trend across every validated month (oldest → newest). Reuse the already-loaded selected
  // period to avoid re-scanning it.
  const trendPeriods = availablePeriods.slice(0, 12).reverse();
  const points: SiTrendPoint[] = [];
  for (const trendPeriod of trendPeriods) {
    const trendRows = trendPeriod === selectedPeriod ? rows : await loadSiDistProduct(trendPeriod, scope, reference);
    const trendTotals = sumTotals(trendRows);
    const entry = completeness.get(trendPeriod);
    points.push({
      period: trendPeriod,
      value: trendTotals.value,
      units: trendTotals.units,
      monthComplete: entry?.complete ?? true,
      expected: entry?.expected.length ?? 0,
      uploaded: entry?.uploaded.length ?? 0,
    });
  }

  return {
    period: selectedPeriod,
    availablePeriods,
    kpis,
    products: { period: selectedPeriod, products: byProduct.slice(0, 50), lineMix: aggregateByLine(rows) },
    geography: { period: selectedPeriod, regions: byRegion, areas: aggregateByArea(rows, reference).slice(0, 100) },
    distributors: { period: selectedPeriod, distributors: aggregateByDistributor(rows, reference) },
    trend: { points },
    access: {
      role: scope.role,
      canViewAllSales: scope.canViewAllSales,
      includeRestrictedAllowed: scope.includeRestrictedProductsAllowed,
      restrictedIncluded: scope.restrictedIncluded,
      restrictedExcluded: scope.excludedProductCodes.length > 0,
      lineNames: scope.allowedLineNames ? [...scope.allowedLineNames] : [],
      regionNames: scope.allowedRegionNames ? [...scope.allowedRegionNames] : [],
    },
  };
}

/** Map scoped distributor×product rows to the named transaction rows shown on Page 2. */
function toTransactionRows(rows: Awaited<ReturnType<typeof loadSiDistProduct>>, reference: SiReference): SiTransactionRow[] {
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

/** One-pass loader for Page 2 (Sales Details). Bounds transactions to the top 500 by value. */
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
    access: {
      role: scope.role,
      canViewAllSales: scope.canViewAllSales,
      includeRestrictedAllowed: scope.includeRestrictedProductsAllowed,
      restrictedIncluded: scope.restrictedIncluded,
      restrictedExcluded: scope.excludedProductCodes.length > 0,
      lineNames: scope.allowedLineNames ? [...scope.allowedLineNames] : [],
      regionNames: scope.allowedRegionNames ? [...scope.allowedRegionNames] : [],
    },
  };
}

export async function getSiTrend(scope: SalesAccessScope, maxPoints = 12): Promise<SiTrend> {
  const reference = await loadSiReference();
  const periods = (await listSalesPeriods()).slice(0, maxPoints).reverse(); // oldest → newest
  const batches = await loadValidatedBatchKeys();
  const completeness = computeMonthCompleteness(batches, [...reference.distributorName.keys()], reference.distributorName);

  const points: SiTrendPoint[] = [];
  // Sequential: each period is a full fact-scan; parallel would multiply DB contention.
  for (const period of periods) {
    const rows: SiDistProductRow[] = await loadSiDistProduct(period, scope, reference);
    const totals = sumTotals(rows);
    const entry = completeness.get(period);
    points.push({
      period,
      value: totals.value,
      units: totals.units,
      monthComplete: entry?.complete ?? true,
      expected: entry?.expected.length ?? 0,
      uploaded: entry?.uploaded.length ?? 0,
    });
  }
  return { points };
}
