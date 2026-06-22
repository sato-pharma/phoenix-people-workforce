// Source-of-Sales (distributor) dashboard — analytics driven ONLY by the distributor invoice
// pipeline (source_of_sales_import_rows via the phx_exec_* RPCs), NOT the closing-sheet/targets
// pipeline. There are no targets and no employee/manager attribution in this data, so the
// dashboard pivots to distributor / channel / region / area / brick / customer / product analytics
// with value + units over time.
//
// Value semantics (encapsulated by the RPCs): distributor rows = qty*(1-discount)*factory_price;
// Direct rows = the stored sheet value; bonus qty is always excluded. Confidential products
// (LA003/LA004/SS001) are stripped at leaf level for everyone except CEO / Super Admin.

import type { AccessContext } from "@/lib/auth/permissions";
import {
  RESTRICTED_PRODUCT_CODES,
  canViewRestrictedProducts,
  canonicalizeRegionName,
  normalizeLineKey,
  resolveSalesAccessScope,
} from "@/lib/sales/access-scope";
import { listMonthlyClosingPeriods, loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import { getSupabaseAdmin, rpcAll } from "@/lib/supabase/server";

const TREND_WINDOW = 6; // most-recent months shown in the trend
const RESTRICTED_SET = new Set(RESTRICTED_PRODUCT_CODES.map((code) => code.toUpperCase()));

export type SosDashboardFilters = Partial<{
  period: string;
  line: string;
  distributors: string[];
  regions: string[];
  areas: string[];
  products: string[];
}>;

export type SosOption = { code: string; label: string; line?: string | null; region?: string | null };

export type SosFilterOptions = {
  periods: string[];
  lines: string[];
  distributors: SosOption[];
  regions: SosOption[];
  areas: SosOption[];
  products: SosOption[];
};

export type SosGroupRow = { code: string; label: string; line: string | null; value: number; units: number; share: number };
export type SosDistributorRow = SosGroupRow & { regions: number; areas: number; products: number };
export type SosTrendPoint = { period: string; value: number; units: number };
export type SosCustomerRow = { code: string; name: string; distributor: string; region: string; area: string; value: number; units: number; share: number };
export type SosWhiteSpaceRow = { code: string; label: string; region: string | null };

export type SosDashboardData = {
  period: string | null;
  availablePeriods: string[];
  filters: SosFilterOptions;
  summary: {
    totalValue: number;
    totalUnits: number;
    avgPricePerUnit: number;
    distributorCount: number;
    productCount: number;
    customerCount: number;
    directValue: number;
    distributorValue: number;
    directShare: number;
    areasReached: number;
    totalAreas: number;
    bricksReached: number;
    totalBricks: number;
  };
  trend: SosTrendPoint[];
  channelMix: { name: string; value: number }[];
  byDistributor: SosDistributorRow[];
  byRegion: SosGroupRow[];
  byArea: SosGroupRow[];
  byProduct: SosGroupRow[];
  byLine: SosGroupRow[];
  topBricks: SosGroupRow[];
  topCustomers: SosCustomerRow[];
  customerTop10Share: number;
  whiteSpaceAreas: SosWhiteSpaceRow[];
  insights: { tone: "neutral" | "success" | "warning" | "danger"; text: string }[];
};

type ExecRow = {
  distributorCode: string;
  officialLine: string;
  regionCode: string;
  areaCode: string;
  productCode: string;
  productName: string;
  units: number;
  value: number;
};
type BrickRow = { distributorCode: string; regionCode: string; areaCode: string; brickId: string; units: number; value: number };
type CustomerRow = { clientCode: string; clientName: string; distributorCode: string; regionCode: string; areaCode: string; units: number; value: number };

const norm = (value: string | null | undefined) => String(value ?? "").trim();
const isDirect = (distributorCode: string) => norm(distributorCode).toLowerCase() === "direct";

function toFilterSet(values: string[] | undefined): Set<string> | null {
  if (!values || values.length === 0) return null;
  return new Set(values.map((value) => norm(value).toUpperCase()));
}

function share(value: number, total: number): number {
  return total > 0 ? value / total : 0;
}

async function safeRpcAll<T>(
  label: string,
  supplier: () => Promise<T[]>,
): Promise<T[]> {
  try {
    return await supplier();
  } catch (error) {
    console.warn(`[sales dashboard] Non-blocking RPC failed: ${label}`, error);
    return [];
  }
}

export async function getSosDashboard(
  filters: SosDashboardFilters,
  accessContext: AccessContext,
): Promise<SosDashboardData> {
  const supabase = getSupabaseAdmin();
  const canSeeRestricted = canViewRestrictedProducts(accessContext.role);

  const [availablePeriods, references, salesScope] = await Promise.all([
    listMonthlyClosingPeriods(),
    loadSalesReferenceData({ includeCustomerBricks: false }),
    resolveSalesAccessScope(accessContext),
  ]);

  // Per-viewer LINE/REGION lockdown. The SoS RPCs return the WHOLE company; without this any
  // role holding `sales:read` (e.g. Product/Group Product Manager) could fetch every line/region
  // via /api/sales/sos-dashboard. Company-scope roles (CEO / Super Admin / SFE / Marketing) keep
  // the full view; everyone else is bounded to their own line (and region, when the role carries
  // a region bound). A missing line fails CLOSED (empty set → no rows), never company-wide.
  const scopeLineKeys: Set<string> | null =
    salesScope.canViewAllSales || !salesScope.allowedLineNames
      ? null
      : new Set([...salesScope.allowedLineNames].map(normalizeLineKey));
  const scopeRegionCodes: Set<string> | null =
    salesScope.canViewAllSales || !salesScope.allowedRegionNames
      ? null
      : new Set(
          references.regions
            .filter((r) => salesScope.allowedRegionNames!.has(canonicalizeRegionName(r.regionName)))
            .map((r) => r.regionCode.toUpperCase()),
        );

  // Label + master maps.
  const regionLabel = new Map<string, string>();
  references.regions.forEach((r) => regionLabel.set(r.regionCode, r.regionName || r.regionCode));
  const areaLabel = new Map<string, string>();
  const areaRegion = new Map<string, string>();
  (references.areas ?? []).forEach((a) => {
    areaLabel.set(a.areaCode, a.areaName || a.areaCode);
    areaRegion.set(a.areaCode, a.regionCode);
  });
  const distributorLabel = new Map<string, string>();
  references.distributors.forEach((d) => distributorLabel.set(d.code, d.name || d.code));
  const productLabel = new Map<string, string>();
  const productLine = new Map<string, string>();
  references.products.forEach((p) => {
    productLabel.set(p.productCode, p.productName || p.productCode);
    productLine.set(p.productCode, p.line);
  });
  const masterAreas = (references.areas ?? []).filter((a) => a.areaCode);
  const totalAreas = masterAreas.length;

  const selectedPeriod =
    filters.period && availablePeriods.includes(filters.period) ? filters.period : availablePeriods[0] ?? null;

  // Filter option lists (stable, from masters — products stripped of confidential codes for non-CEO).
  const filterOptions: SosFilterOptions = {
    periods: availablePeriods,
    lines: [...new Set(references.products.map((p) => norm(p.line)).filter(Boolean))].sort(),
    distributors: references.distributors.map((d) => ({ code: d.code, label: d.name || d.code })),
    regions: references.regions.map((r) => ({ code: r.regionCode, label: r.regionName || r.regionCode })),
    areas: (references.areas ?? []).map((a) => ({ code: a.areaCode, label: a.areaName || a.areaCode, region: a.regionCode })),
    products: references.products
      .filter((p) => canSeeRestricted || !RESTRICTED_SET.has(p.productCode.toUpperCase()))
      .map((p) => ({ code: p.productCode, label: p.productName || p.productCode, line: p.line })),
  };

  if (!selectedPeriod) {
    return emptyDashboard(filterOptions, totalAreas);
  }

  // Trend window = the most-recent N months, always including the selected period.
  const windowPeriods = [...new Set([...availablePeriods.slice(0, TREND_WINDOW), selectedPeriod])].sort();

  // Detail leaf rows for the SELECTED period only — drives every breakdown table below. The 6-month
  // trend is fetched separately as lightweight per-period totals (phx_exec_sos_trend) instead of
  // re-running the heavy per-distributor/product aggregate once per window month. The old pattern
  // fired ~6 heavy aggregates concurrently, saturated the DB (16–26s each) and timed the page out.
  const excludeCodes = canSeeRestricted ? [] : [...RESTRICTED_PRODUCT_CODES];
  const trendResultPromise = safeRpcAll(
    "phx_exec_sos_trend",
    () =>
      (async () => {
        const response = await supabase.rpc("phx_exec_sos_trend", {
          p_areas: filters.areas ?? [],
          p_distributors: filters.distributors ?? [],
          p_exclude_codes: excludeCodes,
          p_lines: filters.line ? [filters.line] : [],
          p_periods: windowPeriods,
          p_products: filters.products ?? [],
          p_regions: filters.regions ?? [],
        });
        if (response.error) throw response.error;
        return (response.data ?? []) as Array<Record<string, unknown>>;
      })(),
  );

  const [detailRows, trendRowsRaw, brickRaw, customerRaw] = await Promise.all([
    rpcAll(supabase, "phx_exec_distributor_product", { p_period: selectedPeriod }, ["distributor_code", "region_code", "area_code", "product_code"]),
    trendResultPromise,
    safeRpcAll(
      "phx_exec_brick",
      () => rpcAll(supabase, "phx_exec_brick", { p_period: selectedPeriod }, ["distributor_code", "region_code", "area_code", "brick_id"]),
    ),
    safeRpcAll(
      "phx_exec_customers",
      () => rpcAll(supabase, "phx_exec_customers", { p_period: selectedPeriod }, ["client_code", "distributor_code"]),
    ),
  ]);

  // Shared leaf-row filter (line / distributor / region / area / product + restricted stripping).
  const distSet = toFilterSet(filters.distributors);
  const regionSet = toFilterSet(filters.regions);
  const areaSet = toFilterSet(filters.areas);
  const productSet = toFilterSet(filters.products);
  const lineFilter = filters.line ? norm(filters.line).toLowerCase() : null;

  const keepExec = (row: ExecRow): boolean => {
    if (!canSeeRestricted && RESTRICTED_SET.has(row.productCode.toUpperCase())) return false;
    // Access-scope lockdown (line/region) — applied before user-supplied filters so a scoped
    // caller can never widen past their own line/region via query params.
    if (scopeLineKeys && !scopeLineKeys.has(normalizeLineKey(row.officialLine))) return false;
    if (scopeRegionCodes && !scopeRegionCodes.has(row.regionCode.toUpperCase())) return false;
    if (lineFilter && row.officialLine.toLowerCase() !== lineFilter) return false;
    if (distSet && !distSet.has(row.distributorCode.toUpperCase())) return false;
    if (regionSet && !regionSet.has(row.regionCode.toUpperCase())) return false;
    if (areaSet && !areaSet.has(row.areaCode.toUpperCase())) return false;
    if (productSet && !productSet.has(row.productCode.toUpperCase())) return false;
    return true;
  };

  // Brick + customer aggregates come from RPCs that carry no LINE dimension, so they cannot be
  // line-attributed. For a non-company (line/region scoped) caller, returning them would leak
  // cross-line customer/brick totals — so they are suppressed entirely for those callers. Company
  // roles (canViewAllSales) keep the full sections.
  const canSeeCrossLineGeography = salesScope.canViewAllSales;

  // Detail = selected period (the only month we pull full leaf rows for).
  const detail = (detailRows as Array<Record<string, unknown>>)
    .map((row) => ({
      distributorCode: norm(row.distributor_code as string),
      officialLine: norm(row.official_line as string),
      regionCode: norm(row.region_code as string),
      areaCode: norm(row.area_code as string),
      productCode: norm(row.product_code as string),
      productName: norm(row.product_name as string),
      units: Number(row.units ?? 0),
      value: Number(row.value ?? 0),
    }))
    .filter(keepExec);

  const totalValue = detail.reduce((sum, row) => sum + row.value, 0);
  const totalUnits = detail.reduce((sum, row) => sum + row.units, 0);

  // Trend across the window: lightweight per-period totals from phx_exec_sos_trend (filter-aware,
  // restricted-stripped in SQL). The SELECTED period reuses the detail totals so the last point
  // always matches the KPI summary exactly. Non-fatal: a trend failure never blocks the dashboard.
  const trendByPeriod = new Map<string, { units: number; value: number }>();
  const trendRows = trendRowsRaw as Array<Record<string, unknown>>;
  for (const row of trendRows) {
    trendByPeriod.set(String(row.period ?? ""), { units: Number(row.units ?? 0), value: Number(row.value ?? 0) });
  }
  const trend: SosTrendPoint[] = windowPeriods.map((period) =>
    period === selectedPeriod
      ? { period, units: totalUnits, value: totalValue }
      : { period, units: trendByPeriod.get(period)?.units ?? 0, value: trendByPeriod.get(period)?.value ?? 0 },
  );
  const directValue = detail.filter((row) => isDirect(row.distributorCode)).reduce((sum, row) => sum + row.value, 0);
  const distributorValue = totalValue - directValue;

  // Generic grouper.
  const group = (
    rows: ExecRow[],
    keyOf: (row: ExecRow) => string,
    labelOf: (code: string, row: ExecRow) => string,
    lineOf: (code: string, row: ExecRow) => string | null,
  ): SosGroupRow[] => {
    const map = new Map<string, { value: number; units: number; line: string | null; label: string }>();
    for (const row of rows) {
      const code = keyOf(row);
      if (!code) continue;
      const current = map.get(code) ?? { value: 0, units: 0, line: lineOf(code, row), label: labelOf(code, row) };
      current.value += row.value;
      current.units += row.units;
      map.set(code, current);
    }
    return [...map.entries()]
      .map(([code, v]) => ({ code, label: v.label, line: v.line, value: v.value, units: v.units, share: share(v.value, totalValue) }))
      .sort((a, b) => b.value - a.value);
  };

  const byRegion = group(
    detail,
    (row) => row.regionCode,
    (code) => regionLabel.get(code) ?? code,
    () => null,
  );
  const byArea = group(
    detail,
    (row) => row.areaCode,
    (code) => (code === "DIRECT" ? "Direct (National)" : areaLabel.get(code) ?? code),
    (code) => regionLabel.get(areaRegion.get(code) ?? "") ?? null,
  );
  const byProduct = group(
    detail,
    (row) => row.productCode,
    (code, row) => productLabel.get(code) ?? row.productName ?? code,
    (code, row) => productLine.get(code) ?? row.officialLine ?? null,
  );
  const byLine = group(
    detail,
    (row) => row.officialLine,
    (code) => code,
    (code) => code,
  );

  // Distributors carry reach counts (distinct regions / real areas / products).
  const distAccum = new Map<string, { value: number; units: number; regions: Set<string>; areas: Set<string>; products: Set<string> }>();
  for (const row of detail) {
    const code = row.distributorCode;
    if (!code) continue;
    const current = distAccum.get(code) ?? { value: 0, units: 0, regions: new Set(), areas: new Set(), products: new Set() };
    current.value += row.value;
    current.units += row.units;
    if (row.regionCode) current.regions.add(row.regionCode);
    if (row.areaCode && row.areaCode !== "DIRECT") current.areas.add(row.areaCode);
    if (row.productCode) current.products.add(row.productCode);
    distAccum.set(code, current);
  }
  const byDistributor: SosDistributorRow[] = [...distAccum.entries()]
    .map(([code, v]) => ({
      code,
      label: distributorLabel.get(code) ?? code,
      line: null,
      value: v.value,
      units: v.units,
      share: share(v.value, totalValue),
      regions: v.regions.size,
      areas: v.areas.size,
      products: v.products.size,
    }))
    .sort((a, b) => b.value - a.value);

  // Bricks (exclude Direct already; respect region/area/distributor filters).
  const brickRows: BrickRow[] = (canSeeCrossLineGeography ? (brickRaw as Array<Record<string, unknown>>) : [])
    .map((row) => ({
      distributorCode: norm(row.distributor_code as string),
      regionCode: norm(row.region_code as string),
      areaCode: norm(row.area_code as string),
      brickId: norm(row.brick_id as string),
      units: Number(row.units ?? 0),
      value: Number(row.value ?? 0),
    }))
    .filter((row) => {
      if (distSet && !distSet.has(row.distributorCode.toUpperCase())) return false;
      if (regionSet && !regionSet.has(row.regionCode.toUpperCase())) return false;
      if (areaSet && !areaSet.has(row.areaCode.toUpperCase())) return false;
      return true;
    });
  const brickAccum = new Map<string, { value: number; units: number }>();
  for (const row of brickRows) {
    if (!row.brickId) continue;
    const current = brickAccum.get(row.brickId) ?? { value: 0, units: 0 };
    current.value += row.value;
    current.units += row.units;
    brickAccum.set(row.brickId, current);
  }
  const brickTotalValue = brickRows.reduce((sum, row) => sum + row.value, 0);
  const topBricks: SosGroupRow[] = [...brickAccum.entries()]
    .map(([code, v]) => ({ code, label: code, line: null, value: v.value, units: v.units, share: share(v.value, brickTotalValue) }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 12);

  // Customers (exclude Direct; respect region/area/distributor filters; no product dimension).
  const customerRows: CustomerRow[] = (canSeeCrossLineGeography ? (customerRaw as Array<Record<string, unknown>>) : [])
    .map((row) => ({
      clientCode: norm(row.client_code as string),
      clientName: norm(row.client_name as string),
      distributorCode: norm(row.distributor_code as string),
      regionCode: norm(row.region_code as string),
      areaCode: norm(row.area_code as string),
      units: Number(row.units ?? 0),
      value: Number(row.value ?? 0),
    }))
    .filter((row) => {
      if (distSet && !distSet.has(row.distributorCode.toUpperCase())) return false;
      if (regionSet && !regionSet.has(row.regionCode.toUpperCase())) return false;
      if (areaSet && !areaSet.has(row.areaCode.toUpperCase())) return false;
      return true;
    });
  const customerTotalValue = customerRows.reduce((sum, row) => sum + row.value, 0);
  const sortedCustomers = [...customerRows].sort((a, b) => b.value - a.value);
  const topCustomers: SosCustomerRow[] = sortedCustomers.slice(0, 15).map((row) => ({
    code: row.clientCode,
    name: row.clientName || row.clientCode,
    distributor: distributorLabel.get(row.distributorCode) ?? row.distributorCode,
    region: regionLabel.get(row.regionCode) ?? row.regionCode,
    area: row.areaCode === "DIRECT" ? "Direct" : areaLabel.get(row.areaCode) ?? row.areaCode,
    value: row.value,
    units: row.units,
    share: share(row.value, customerTotalValue),
  }));
  const customerTop10Share = share(
    sortedCustomers.slice(0, 10).reduce((sum, row) => sum + row.value, 0),
    customerTotalValue,
  );

  // Coverage + white-space (real areas only; Direct placeholder excluded).
  const soldAreaCodes = new Set(detail.map((row) => row.areaCode).filter((code) => code && code !== "DIRECT"));
  const soldBrickIds = new Set(brickRows.map((row) => row.brickId).filter(Boolean));
  const whiteSpaceAreas: SosWhiteSpaceRow[] = masterAreas
    .filter((a) => !soldAreaCodes.has(a.areaCode))
    .map((a) => ({ code: a.areaCode, label: a.areaName || a.areaCode, region: regionLabel.get(a.regionCode) ?? a.regionCode }))
    .slice(0, 20);

  const summary = {
    totalValue,
    totalUnits,
    avgPricePerUnit: totalUnits > 0 ? totalValue / totalUnits : 0,
    distributorCount: distAccum.size,
    productCount: new Set(detail.map((row) => row.productCode).filter(Boolean)).size,
    customerCount: new Set(customerRows.map((row) => `${row.distributorCode}::${row.clientCode}`)).size,
    directValue,
    distributorValue,
    directShare: share(directValue, totalValue),
    areasReached: soldAreaCodes.size,
    totalAreas,
    bricksReached: soldBrickIds.size,
    totalBricks: new Set(brickRows.map((row) => row.brickId).filter(Boolean)).size,
  };

  const channelMix = [
    { name: "Distributors", value: distributorValue },
    { name: "Direct (Company)", value: directValue },
  ].filter((slice) => slice.value > 0);

  return {
    period: selectedPeriod,
    availablePeriods,
    filters: filterOptions,
    summary,
    trend,
    channelMix,
    byDistributor,
    byRegion,
    byArea,
    byProduct,
    byLine,
    topBricks,
    topCustomers,
    customerTop10Share,
    whiteSpaceAreas,
    insights: buildInsights({ byDistributor, byRegion, byProduct, summary, customerTop10Share, whiteSpaceAreas }),
  };
}

function buildInsights(input: {
  byDistributor: SosDistributorRow[];
  byRegion: SosGroupRow[];
  byProduct: SosGroupRow[];
  summary: SosDashboardData["summary"];
  customerTop10Share: number;
  whiteSpaceAreas: SosWhiteSpaceRow[];
}): SosDashboardData["insights"] {
  const out: SosDashboardData["insights"] = [];
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  const lead = input.byDistributor[0];
  if (lead) out.push({ tone: "neutral", text: `${lead.label} leads distribution with ${pct(lead.share)} of value across ${lead.regions} region(s).` });
  const topRegion = input.byRegion[0];
  if (topRegion) out.push({ tone: "neutral", text: `${topRegion.label} is the top region at ${pct(topRegion.share)} of value.` });
  const topProduct = input.byProduct[0];
  if (topProduct) out.push({ tone: "neutral", text: `${topProduct.label} is the top product at ${pct(topProduct.share)} of value.` });
  if (input.summary.directShare > 0) out.push({ tone: "neutral", text: `Direct (company) sales are ${pct(input.summary.directShare)} of total value; distributors are the rest.` });
  if (input.customerTop10Share >= 0.5) out.push({ tone: "warning", text: `Customer concentration is high — the top 10 customers are ${pct(input.customerTop10Share)} of customer value.` });
  if (input.summary.totalAreas > 0) {
    const uncovered = input.summary.totalAreas - input.summary.areasReached;
    if (uncovered > 0) out.push({ tone: uncovered > input.summary.totalAreas * 0.25 ? "danger" : "warning", text: `${uncovered} of ${input.summary.totalAreas} areas had zero distributor sales this month (white-space).` });
  }
  return out;
}

function emptyDashboard(filters: SosFilterOptions, totalAreas: number): SosDashboardData {
  return {
    period: null,
    availablePeriods: filters.periods,
    filters,
    summary: {
      totalValue: 0,
      totalUnits: 0,
      avgPricePerUnit: 0,
      distributorCount: 0,
      productCount: 0,
      customerCount: 0,
      directValue: 0,
      distributorValue: 0,
      directShare: 0,
      areasReached: 0,
      totalAreas,
      bricksReached: 0,
      totalBricks: 0,
    },
    trend: [],
    channelMix: [],
    byDistributor: [],
    byRegion: [],
    byArea: [],
    byProduct: [],
    byLine: [],
    topBricks: [],
    topCustomers: [],
    customerTop10Share: 0,
    whiteSpaceAreas: [],
    insights: [],
  };
}
