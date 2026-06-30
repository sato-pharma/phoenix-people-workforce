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
  canViewHeadOfficeLine,
  canViewRestrictedProducts,
  canonicalizeRegionName,
  isHeadOfficeLine,
  normalizeLineKey,
  resolveSalesAccessScope,
} from "@/lib/sales/access-scope";
import { listMonthlyClosingPeriods, loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import { getSupabaseAdmin, rpcAll } from "@/lib/supabase/server";

const TREND_WINDOW = 6; // most-recent months shown in the trend
const RESTRICTED_SET = new Set(RESTRICTED_PRODUCT_CODES.map((code) => code.toUpperCase()));

export type SosDashboardFilters = Partial<{
  period: string;
  /** Single-line filter (legacy/admin). Prefer `lines` for multi-select. */
  line: string;
  /** Multi-line filter — keeps a row when its official line is in this set. */
  lines: string[];
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

/**
 * Optional server-resolved scope overrides. Used by the employee-portal Source-of-Sales
 * wrapper (getPortalSosDashboard) to tighten visibility beyond the role's base scope. Both
 * are resolved from the SESSION, never from user input, so a caller can never widen via the
 * URL/API. Omitting the option (admin /sales) leaves behavior byte-identical.
 */
export type SosScopeOverrides = {
  /** Restrict to these product codes. null = no restriction; empty Set = show nothing. */
  allowedProductCodes?: Set<string> | null;
  /**
   * Override the scope-derived region codes. When the KEY is present it replaces the base
   * region lockdown (e.g. widen a Regional Manager from his single own-region to his managed
   * region set). null = no region restriction; a Set = restrict to those codes.
   */
  allowedRegionCodes?: Set<string> | null;
};

export async function getSosDashboard(
  filters: SosDashboardFilters,
  accessContext: AccessContext,
  options?: SosScopeOverrides,
): Promise<SosDashboardData> {
  const supabase = getSupabaseAdmin();
  const canSeeRestricted = canViewRestrictedProducts(accessContext.role);
  // Head Office line + its products are confidential — CEO / Super Admin only. Stripped below
  // from rows, filter options and the trend for every other role (incl. company-scope SFE).
  const canSeeHeadOffice = canViewHeadOfficeLine(accessContext.role);

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
  // Region lockdown: a portal-supplied override (server-resolved) takes precedence over the
  // role's base region scope so e.g. a Regional Manager can be widened to his full managed
  // region set. Otherwise fall back to the base scope (company = all; else the viewer's region).
  const scopeRegionCodes: Set<string> | null =
    options && "allowedRegionCodes" in options
      ? options.allowedRegionCodes
        ? new Set([...options.allowedRegionCodes].map((code) => code.trim().toUpperCase()))
        : null
      : salesScope.canViewAllSales || !salesScope.allowedRegionNames
        ? null
        : new Set(
            references.regions
              .filter((r) => salesScope.allowedRegionNames!.has(canonicalizeRegionName(r.regionName)))
              .map((r) => r.regionCode.toUpperCase()),
          );
  // Product lockdown (server-resolved): null/undefined = no restriction; empty Set = show
  // nothing (the strict "PM with no assigned products" case); non-empty = only those codes.
  const scopeProductCodes: Set<string> | null =
    options?.allowedProductCodes == null
      ? null
      : new Set([...options.allowedProductCodes].map((code) => code.trim().toUpperCase()));

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
  // Coverage denominator is scoped to the viewer: a region-locked caller (DSM / RM) measures
  // coverage against THEIR regions' areas, not the whole company — otherwise "3 / 120 areas"
  // reads as poor coverage when they only own a handful. Company / line-only callers keep all areas.
  const masterAreas = (references.areas ?? [])
    .filter((a) => a.areaCode)
    .filter((a) => !scopeRegionCodes || scopeRegionCodes.has((a.regionCode ?? "").toUpperCase()));
  const totalAreas = masterAreas.length;

  const selectedPeriod =
    filters.period && availablePeriods.includes(filters.period) ? filters.period : availablePeriods[0] ?? null;

  // Filter option lists (stable, from masters — products stripped of confidential codes for non-CEO).
  const filterOptions: SosFilterOptions = {
    periods: availablePeriods,
    lines: [...new Set(references.products.map((p) => norm(p.line)).filter(Boolean))]
      .filter((line) => line.toUpperCase() !== "IGNORE")
      .filter((line) => canSeeHeadOffice || !isHeadOfficeLine(line))
      .sort(),
    distributors: references.distributors.map((d) => ({ code: d.code, label: d.name || d.code })),
    regions: references.regions.map((r) => ({ code: r.regionCode, label: r.regionName || r.regionCode })),
    areas: (references.areas ?? []).map((a) => ({ code: a.areaCode, label: a.areaName || a.areaCode, region: a.regionCode })),
    products: references.products
      .filter((p) => p.productCode.toUpperCase() !== "IGNORE")
      .filter((p) => canSeeRestricted || !RESTRICTED_SET.has(p.productCode.toUpperCase()))
      .filter((p) => canSeeHeadOffice || !isHeadOfficeLine(p.line))
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

  // The trend RPC takes explicit line/region/product arrays (empty = "all"), so a scoped caller
  // must pass the INTERSECTION of their user filters and their access scope — otherwise the 6-month
  // history would silently span lines/regions/products the viewer can't see (and the selected-period
  // point, which reuses the scoped detail total, wouldn't match). Head Office is stripped here too.
  const intersect = (a: string[] | null, b: string[] | null): string[] | null => {
    if (a === null) return b;
    if (b === null) return a;
    const bSet = new Set(b.map((value) => value.toUpperCase()));
    return a.filter((value) => bSet.has(value.toUpperCase()));
  };
  const userLineNames = filters.lines?.length ? filters.lines : filters.line ? [filters.line] : null;
  const userRegionCodes = filters.regions?.length ? filters.regions.map((c) => c.toUpperCase()) : null;
  const userProductCodes = filters.products?.length ? filters.products.map((c) => c.toUpperCase()) : null;

  const scopeLineNamesArr = scopeLineKeys ? (salesScope.allowedLineNames ? [...salesScope.allowedLineNames] : []) : null;
  const scopeRegionArr = scopeRegionCodes ? [...scopeRegionCodes] : null;
  const scopeProductArr = scopeProductCodes ? [...scopeProductCodes] : null;

  const trendLineNames = intersect(userLineNames, scopeLineNamesArr);
  const trendRegionCodes = intersect(userRegionCodes, scopeRegionArr);
  const trendProductCodes = intersect(userProductCodes, scopeProductArr);

  // Head Office lock for the trend: exclude HO by PRODUCT CODE (matching the rollup's product_code)
  // instead of by line name — this sidesteps any product-master line vs official_line label
  // divergence. keepExec already strips HO from the detail by official_line; this keeps the 6-month
  // trend consistent (the confidential line never contributes for non-CEO/Super-Admin viewers).
  const headOfficeProductCodes = canSeeHeadOffice
    ? []
    : references.products
        .filter((p) => isHeadOfficeLine(p.line))
        .map((p) => p.productCode.toUpperCase());
  const trendExcludeCodes = headOfficeProductCodes.length > 0 ? [...excludeCodes, ...headOfficeProductCodes] : excludeCodes;

  // An empty (but non-null) effective set means the viewer's scope ∩ filter is disjoint — the
  // detail is empty too, so the trend must be empty rather than fall back to RPC "all".
  const trendForcedEmpty =
    (trendLineNames !== null && trendLineNames.length === 0) ||
    (trendRegionCodes !== null && trendRegionCodes.length === 0) ||
    (trendProductCodes !== null && trendProductCodes.length === 0);

  const trendResultPromise = trendForcedEmpty
    ? Promise.resolve([] as Array<Record<string, unknown>>)
    : safeRpcAll(
        "phx_exec_sos_trend",
        () =>
          (async () => {
            const response = await supabase.rpc("phx_exec_sos_trend", {
              p_areas: filters.areas ?? [],
              p_distributors: filters.distributors ?? [],
              p_exclude_codes: trendExcludeCodes,
              p_lines: trendLineNames ?? [],
              p_periods: windowPeriods,
              p_products: trendProductCodes ?? [],
              p_regions: trendRegionCodes ?? [],
            });
            if (response.error) throw response.error;
            return (response.data ?? []) as Array<Record<string, unknown>>;
          })(),
      );

  // Brick + customer aggregates carry no LINE dimension, so they are only ever shown to
  // company-scope callers (see canSeeCrossLineGeography below). Skip those two heavy RPCs
  // entirely for every scoped caller (portal roles) — their results would be discarded anyway,
  // so this is a pure latency win with no behavior change.
  const canSeeCrossLineGeography = salesScope.canViewAllSales;
  const emptyRpcRows = Promise.resolve([] as Array<Record<string, unknown>>);

  // Push the viewer's scope ∩ user-filter selection INTO the detail RPC so the database
  // only aggregates the rows this caller can see, instead of returning the whole company
  // and letting keepExec drop the rest. The arrays reuse the exact intersections already
  // computed for the trend (scope-derived line/region/product ∩ user filters), plus the
  // raw distributor/area user filters and the restricted-code exclusion. keepExec below is
  // KEPT as the authoritative backstop — these params can only remove rows it would remove
  // anyway (Head Office stripping intentionally stays in keepExec, not pushed here). When
  // the intersection is disjoint (trendForcedEmpty) the detail is empty too, so skip the
  // call entirely rather than fetch the full company only to discard every row.
  const detailRowsPromise = trendForcedEmpty
    ? emptyRpcRows
    : rpcAll(
        supabase,
        "phx_exec_distributor_product",
        {
          p_period: selectedPeriod,
          p_lines: trendLineNames ?? [],
          p_distributors: filters.distributors ?? [],
          p_regions: trendRegionCodes ?? [],
          p_areas: filters.areas ?? [],
          p_products: trendProductCodes ?? [],
          p_exclude_codes: excludeCodes,
        },
        ["distributor_code", "region_code", "area_code", "product_code"],
      );

  const [detailRows, trendRowsRaw, brickRaw, customerRaw] = await Promise.all([
    detailRowsPromise,
    trendResultPromise,
    canSeeCrossLineGeography
      ? safeRpcAll(
          "phx_exec_brick",
          () => rpcAll(supabase, "phx_exec_brick", { p_period: selectedPeriod }, ["distributor_code", "region_code", "area_code", "brick_id"]),
        )
      : emptyRpcRows,
    canSeeCrossLineGeography
      ? safeRpcAll(
          "phx_exec_customers",
          () => rpcAll(supabase, "phx_exec_customers", { p_period: selectedPeriod }, ["client_code", "distributor_code"]),
        )
      : emptyRpcRows,
  ]);

  // Shared leaf-row filter (line / distributor / region / area / product + restricted stripping).
  const distSet = toFilterSet(filters.distributors);
  const regionSet = toFilterSet(filters.regions);
  const areaSet = toFilterSet(filters.areas);
  const productSet = toFilterSet(filters.products);
  const lineFilter = filters.line ? norm(filters.line).toLowerCase() : null;
  const lineFilterSet =
    filters.lines && filters.lines.length > 0
      ? new Set(filters.lines.map((value) => norm(value).toLowerCase()))
      : null;

  const keepExec = (row: ExecRow): boolean => {
    if (!canSeeRestricted && RESTRICTED_SET.has(row.productCode.toUpperCase())) return false;
    // Head Office line is confidential — strip it (and its products) for non-CEO/Super-Admin.
    if (!canSeeHeadOffice && isHeadOfficeLine(row.officialLine)) return false;
    // Access-scope lockdown (line/region/product) — applied before user-supplied filters so a
    // scoped caller can never widen past their own line/region/products via query params.
    if (scopeLineKeys && !scopeLineKeys.has(normalizeLineKey(row.officialLine))) return false;
    if (scopeRegionCodes && !scopeRegionCodes.has(row.regionCode.toUpperCase())) return false;
    if (scopeProductCodes && !scopeProductCodes.has(row.productCode.toUpperCase())) return false;
    if (lineFilterSet) {
      if (!lineFilterSet.has(row.officialLine.toLowerCase())) return false;
    } else if (lineFilter && row.officialLine.toLowerCase() !== lineFilter) return false;
    if (distSet && !distSet.has(row.distributorCode.toUpperCase())) return false;
    if (regionSet && !regionSet.has(row.regionCode.toUpperCase())) return false;
    if (areaSet && !areaSet.has(row.areaCode.toUpperCase())) return false;
    if (productSet && !productSet.has(row.productCode.toUpperCase())) return false;
    return true;
  };

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
