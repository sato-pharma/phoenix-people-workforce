// Per-viewer scope for the /admin/analytics dashboards.
//
// The analytics_* RPCs return the whole company; the pages currently apply only the confidential
// locks (Head Office line + restricted products). This module adds LINE / REGION / PRODUCT scoping
// so the dashboards can be opened to every sales role while each viewer sees only their own slice —
// mirroring the established portal pattern (src/lib/sales/sos-dashboard.ts + portal wrappers).
//
// The primary mechanism is FILTER-ARG injection: fold the viewer's allowed lines/regions/products
// into the RPC filter args (as the intersection with any user selection). Because every analytics_*
// RPC accepts p_lines / p_regions / p_products, this scopes the query in SQL even for the loaders
// that aggregate the line dimension away (analytics_sos_by_period / _by_area). It also folds cleanly
// into the existing scope-safe unstable_cache (the cache key is the filter set), so a scoped viewer
// never shares a cache entry with a company-wide viewer.
//
// A company-wide viewer (CEO / Super Admin / SFE Manager / Finance, or system scope) has all-null
// allowed sets → every helper here is a NO-OP → their behaviour is unchanged.
//
// NOTE: this scope core is now wired into the analytics dashboards (e.g. reconciliation-dashboard.tsx
// and the shared page loaders call scopeAnalyticsFilters / scopeAnalyticsDimensions /
// computeAnalyticsFilterVisibility), so it DOES run in production — a company-wide viewer (all allowed
// sets null) is a no-op, while a scoped viewer is narrowed to their own line/region/product slice.

import type { AccessContext } from "@/lib/auth/permissions";
import {
  canonicalizeRegionName,
  resolveSalesAccessScope,
  type SalesAccessScope,
} from "@/lib/sales/access-scope";
import { loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import type { AnalyticsDimensions } from "./service";

export type AnalyticsViewerScope = {
  /** COMPANY / system scope — sees every line & region (all sets null). */
  canViewAllSales: boolean;
  /** Allowed Source-of-Sales official line names (verbatim, for the p_lines arg); null = all. Empty = nothing. */
  allowedLineNames: Set<string> | null;
  /** Allowed region CODES (upper-cased, for the p_regions arg); null = all. Empty = nothing. */
  allowedRegionCodes: Set<string> | null;
  /**
   * Allowed area CODES (upper-cased, for the p_areas arg); null = all. Non-null only for a District /
   * Regional Manager whose organogram seat resolved, in which case it is the AUTHORITATIVE geography
   * bound and `allowedRegionCodes` is merely wide enough to reach those areas — see
   * src/lib/sales/seat-area-scope.ts. Every analytics_* RPC accepts p_areas, so this scopes in SQL.
   */
  allowedAreaCodes: Set<string> | null;
  /** Per-user product-code allowlist (product_scope_override); null = all. Empty = nothing. */
  allowedProductCodes: Set<string> | null;
};

/**
 * Pure transform: SalesAccessScope (+ a canonical-region-name → region-code map) → AnalyticsViewerScope.
 * The analytics RPCs filter regions by CODE but the sales scope carries region NAMES, so this resolves
 * names to codes. Line names are already SoS official line names, used verbatim. Unit-tested directly.
 */
export function computeAnalyticsViewerScope(
  sales: Pick<
    SalesAccessScope,
    | "canViewAllSales"
    | "allowedLineNames"
    | "allowedRegionNames"
    | "allowedAreaCodes"
    | "allowedAreaFactRegionCodes"
    | "allowedProductCodes"
  >,
  regionCodeByCanonicalName: Map<string, string>,
): AnalyticsViewerScope {
  const allowedProductCodes = sales.allowedProductCodes ?? null;
  if (sales.canViewAllSales) {
    return {
      canViewAllSales: true,
      allowedLineNames: null,
      allowedRegionCodes: null,
      allowedAreaCodes: null,
      allowedProductCodes,
    };
  }
  const allowedLineNames = sales.allowedLineNames ? new Set(sales.allowedLineNames) : null;

  // Seat-derived AREA bound (District / Regional Manager): the area set is authoritative and the
  // region set comes from the areas themselves, so an area operationally owned by this viewer but
  // sitting in a foreign region is reachable — while that region's other areas stay filtered out by
  // the area bound. Both are pushed into the RPC filter args (p_areas / p_regions).
  if (sales.allowedAreaCodes) {
    return {
      canViewAllSales: false,
      allowedLineNames,
      allowedRegionCodes: new Set([...(sales.allowedAreaFactRegionCodes ?? [])].map((c) => c.trim().toUpperCase())),
      allowedAreaCodes: new Set([...sales.allowedAreaCodes].map((c) => c.trim().toUpperCase())),
      allowedProductCodes,
    };
  }

  let allowedRegionCodes: Set<string> | null = null;
  if (sales.allowedRegionNames) {
    allowedRegionCodes = new Set<string>();
    for (const name of sales.allowedRegionNames) {
      const code = regionCodeByCanonicalName.get(name);
      if (code) allowedRegionCodes.add(code.trim().toUpperCase());
    }
    // A restricted-but-unresolvable region set stays an EMPTY set (fail-closed = nothing), never null.
  }
  return { canViewAllSales: false, allowedLineNames, allowedRegionCodes, allowedAreaCodes: null, allowedProductCodes };
}

/** Resolve the analytics scope for a page/request: sales scope + region-name→code map from the master. */
export async function resolveAnalyticsViewerScope(access: AccessContext): Promise<AnalyticsViewerScope> {
  const sales = await resolveSalesAccessScope(access);
  // Region resolution is only needed when the viewer is region-scoped (HIERARCHY/TEAM/SELF) AND has
  // no seat-derived area bound — a seat bound already carries its own region codes.
  if (sales.canViewAllSales || !sales.allowedRegionNames || sales.allowedAreaCodes) {
    return computeAnalyticsViewerScope(sales, new Map());
  }
  const references = await loadSalesReferenceData({ includeCustomerBricks: false });
  const regionCodeByCanonicalName = new Map<string, string>();
  for (const region of references.regions) {
    if (region.regionName && region.regionCode) {
      regionCodeByCanonicalName.set(canonicalizeRegionName(region.regionName), region.regionCode);
    }
  }
  return computeAnalyticsViewerScope(sales, regionCodeByCanonicalName);
}

// ── Pure filter scoping ─────────────────────────────────────────────────────────

/**
 * Intersect a user's selected values for one dimension with the viewer's allowed set (case-insensitive).
 * - allowed === null   → no restriction: return the selection unchanged.
 * - allowed is empty    → fail-closed: nothing (empty=true).
 * - user selected none  → scope to the full allowed set.
 * - user selected some  → selection ∩ allowed; empty=true when that intersection is empty.
 */
export function intersectDimension(
  selection: string[] | undefined,
  allowed: Set<string> | null,
): { values: string[]; empty: boolean } {
  const sel = selection ?? [];
  if (!allowed) return { values: sel, empty: false };
  if (allowed.size === 0) return { values: [], empty: true };
  if (sel.length === 0) return { values: [...allowed], empty: false };
  const allowedLower = new Set([...allowed].map((v) => v.trim().toLowerCase()));
  const values = sel.filter((v) => allowedLower.has(v.trim().toLowerCase()));
  return { values, empty: values.length === 0 };
}

export type ScopedAnalyticsFilters<F> = {
  /** Filters with lines/regions/products replaced by the scoped intersection. */
  filters: F;
  /** True when the viewer's scope leaves no valid value for some dimension → the loader must return []. */
  empty: boolean;
};

/**
 * Fold the viewer's scope into an analytics filter object. Company-wide viewers (all allowed sets
 * null) get their filters back untouched. Otherwise lines/regions/products are intersected with the
 * allowed sets; `empty` signals the caller to skip the query and render an empty result.
 */
export function scopeAnalyticsFilters<
  F extends { lines?: string[]; regions?: string[]; products?: string[]; areas?: string[] },
>(filters: F, scope: AnalyticsViewerScope): ScopedAnalyticsFilters<F> {
  if (
    !scope.allowedLineNames &&
    !scope.allowedRegionCodes &&
    !scope.allowedAreaCodes &&
    !scope.allowedProductCodes
  ) {
    return { filters, empty: false };
  }
  const line = intersectDimension(filters.lines, scope.allowedLineNames);
  const region = intersectDimension(filters.regions, scope.allowedRegionCodes);
  const product = intersectDimension(filters.products, scope.allowedProductCodes);
  // The area intersection is what makes a widened region set safe — without it, reaching an
  // out-of-region owned area would also expose that region's other areas.
  const area = intersectDimension(filters.areas, scope.allowedAreaCodes);
  return {
    filters: {
      ...filters,
      lines: line.values,
      regions: region.values,
      products: product.values,
      areas: area.values,
    },
    empty: line.empty || region.empty || area.empty || product.empty,
  };
}

// ── Filter contextualisation ────────────────────────────────────────────────────

/**
 * Which filter controls to SHOW a viewer. A viewer bound to a single line (or single region) can't
 * change that dimension, so its picker is hidden ("no irrelevant filter"). Company-wide viewers, and
 * viewers who span 2+ lines/regions, keep the control. Pure.
 */
export type AnalyticsFilterVisibility = { line: boolean; region: boolean };

export function computeAnalyticsFilterVisibility(scope: AnalyticsViewerScope): AnalyticsFilterVisibility {
  const singleLine = scope.allowedLineNames != null && scope.allowedLineNames.size <= 1;
  const singleRegion = scope.allowedRegionCodes != null && scope.allowedRegionCodes.size <= 1;
  return { line: !singleLine, region: !singleRegion };
}

/**
 * Trim the filter DROPDOWN options to the viewer's scope, so they can only pick in-scope values.
 * Company-wide viewers get the full lists. Periods/weeks/distributors are not line/region-bound and
 * are left as-is. Families are re-derived from the trimmed product set. Pure.
 */
export function scopeAnalyticsDimensions(
  dimensions: AnalyticsDimensions,
  scope: AnalyticsViewerScope,
): AnalyticsDimensions {
  if (scope.canViewAllSales) return dimensions;
  const lineSet = scope.allowedLineNames
    ? new Set([...scope.allowedLineNames].map((l) => l.trim().toLowerCase()))
    : null;
  const regionSet = scope.allowedRegionCodes
    ? new Set([...scope.allowedRegionCodes].map((c) => c.trim().toUpperCase()))
    : null;
  const productSet = scope.allowedProductCodes
    ? new Set([...scope.allowedProductCodes].map((c) => c.trim().toUpperCase()))
    : null;

  const areaSet = scope.allowedAreaCodes
    ? new Set([...scope.allowedAreaCodes].map((c) => c.trim().toUpperCase()))
    : null;

  const lines = lineSet ? dimensions.lines.filter((l) => lineSet.has(l.trim().toLowerCase())) : dimensions.lines;
  const regions = regionSet ? dimensions.regions.filter((r) => regionSet.has(r.code.trim().toUpperCase())) : dimensions.regions;
  // Prefer the explicit area bound: trimming areas by region would both hide an owned out-of-region
  // area and offer a sibling manager's areas from a region this viewer only partly owns.
  const areas = areaSet
    ? dimensions.areas.filter((a) => areaSet.has(a.areaCode.trim().toUpperCase()))
    : regionSet
      ? dimensions.areas.filter((a) => regionSet.has(a.regionCode.trim().toUpperCase()))
      : dimensions.areas;
  const products =
    lineSet || productSet
      ? dimensions.products.filter(
          (p) =>
            (!lineSet || lineSet.has(p.line.trim().toLowerCase())) &&
            (!productSet || productSet.has(p.code.trim().toUpperCase())),
        )
      : dimensions.products;
  const families =
    lineSet || productSet ? [...new Set(products.map((p) => p.family).filter(Boolean))].sort() : dimensions.families;

  return { ...dimensions, lines, regions, areas, products, families };
}
