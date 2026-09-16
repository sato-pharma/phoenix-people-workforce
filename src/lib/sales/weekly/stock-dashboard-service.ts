// Weekly Stock — the scoped loader shared by the admin shell (/sales/weekly/stock) and the employee
// portal (/employee-portals/weekly-stock), and by both exports.
//
// Scope is resolved from the SESSION with the same resolveWeeklyAccessScope Weekly Sales uses, and it
// is enforced inside loadWeeklyDashboard (applyWeeklyAccessScope, then the tracked-line golden rule
// that keeps Head Office out). Query params only narrow inside what the viewer may already see, so a
// caller cannot widen past their role by editing the URL. The screen and the export call this one
// function with the same filters, which is what keeps the download identical to the page.

import type { AccessContext, PhoenixRole } from "@/lib/auth/permissions";
import { resolveWeeklyAccessScope, type WeeklyAccessScope } from "@/lib/sales/weekly/access";
import { loadWeeklyAreaSplitIndex } from "@/lib/sales/weekly/branch-area-split";
import {
  admitWeeklyStockRows,
  mayLiftWeeklyGeography,
  resolveWeeklyOwnAreaKeys,
  weeklyStockProductPredicate,
  withExtraWeeklyOptions,
} from "@/lib/sales/weekly/own-area-scope";
import { loadFieldForceSeatIndex } from "@/lib/sales/weekly/portal-weekly-field-force";
import { loadWeeklyDashboard } from "@/lib/sales/weekly/service";
import {
  WEEKLY_STOCK_STATUS_LABELS,
  buildWeeklyStockView,
  type WeeklyStockStatus,
  type WeeklyStockView,
} from "@/lib/sales/weekly/stock-dashboard";
import type { WeeklyDistributorOption, WeeklyFilterMode } from "@/lib/sales/weekly/types";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * Portal roles that may open Weekly Stock. Medical Reps are included (owner, 2026-09-14): a rep sees
 * the stock at the depots of his own line and region.
 * `showWeeklyStockTab` in src/lib/employee-portal/navigation.ts mirrors this list.
 */
export const PORTAL_WEEKLY_STOCK_ROLES = [
  "Medical Rep",
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
  "Marketing Manager",
] as const satisfies readonly PhoenixRole[];

const PORTAL_WEEKLY_STOCK_ROLE_SET = new Set<PhoenixRole>(PORTAL_WEEKLY_STOCK_ROLES);

export function isPortalWeeklyStockRole(role: PhoenixRole): boolean {
  return PORTAL_WEEKLY_STOCK_ROLE_SET.has(role);
}

export type WeeklyStockRequestFilters = {
  asOfWeekStart?: string | null;
  distributorCodes?: string[];
  distributorFilterMode?: WeeklyFilterMode;
  regionCodes?: string[];
  regionFilterMode?: WeeklyFilterMode;
  productCodes?: string[];
  productFilterMode?: WeeklyFilterMode;
  lineCodes?: string[];
  lineFilterMode?: WeeklyFilterMode;
  areaCodes?: string[];
  branchKeys?: string[];
  statuses?: WeeklyStockStatus[];
};

/** Which filters apply to this viewer — a filter with one possible answer is hidden, not shown locked. */
export type WeeklyStockFilterVisibility = {
  line: boolean;
  region: boolean;
};

export type WeeklyStockPayload = {
  view: WeeklyStockView;
  options: {
    distributors: WeeklyDistributorOption[];
    regions: WeeklyDistributorOption[];
    products: WeeklyDistributorOption[];
    lines: string[];
  };
  scope: {
    summary: string;
    visibility: WeeklyStockFilterVisibility;
  };
};

const STATUS_SET = new Set<string>(Object.keys(WEEKLY_STOCK_STATUS_LABELS));

function splitList(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/** One query-string contract for both shells' feeds, both exports and the client. */
export function parseWeeklyStockSearchParams(params: URLSearchParams): WeeklyStockRequestFilters {
  const mode = (key: string): WeeklyFilterMode => (params.get(key)?.trim() === "exclude" ? "exclude" : "include");
  const asOf = params.get("asOf")?.trim() ?? "";
  return {
    asOfWeekStart: /^\d{4}-\d{2}-\d{2}$/.test(asOf) ? asOf : null,
    distributorCodes: splitList(params.get("distributors")),
    distributorFilterMode: mode("distributorsMode"),
    regionCodes: splitList(params.get("regions")),
    regionFilterMode: mode("regionsMode"),
    productCodes: splitList(params.get("products")),
    productFilterMode: mode("productsMode"),
    lineCodes: splitList(params.get("lines")),
    lineFilterMode: mode("linesMode"),
    areaCodes: splitList(params.get("areas")),
    branchKeys: splitList(params.get("depots")),
    statuses: splitList(params.get("statuses")).filter((status): status is WeeklyStockStatus => STATUS_SET.has(status)),
  };
}

/** Page-component variant of the same contract. */
export function parseWeeklyStockPageParams(params: { [key: string]: string | string[] | undefined }): WeeklyStockRequestFilters {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) search.set(key, value.join(","));
    else if (typeof value === "string") search.set(key, value);
  }
  return parseWeeklyStockSearchParams(search);
}

async function loadAreaNames(): Promise<Map<string, string>> {
  const { data, error } = await getSupabaseAdmin().from("source_of_sales_areas").select("area_code, area_name");
  const names = new Map<string, string>();
  // Fails soft: without names a depot shows its area code rather than the whole page failing.
  if (error) return names;
  for (const row of (data ?? []) as { area_code: string | null; area_name: string | null }[]) {
    const code = row.area_code?.trim().toUpperCase();
    if (code && row.area_name?.trim() && !names.has(code)) names.set(code, row.area_name.trim());
  }
  return names;
}

function buildStockScopeSummary(
  scope: WeeklyAccessScope,
  role: PhoenixRole,
  regionNames: ReadonlyMap<string, string>,
): string {
  const parts: string[] = [];
  switch (scope.tier) {
    case "full":
      parts.push("All tracked lines", "all regions");
      break;
    case "product":
      parts.push(`${scope.productCodes.size} product${scope.productCodes.size === 1 ? "" : "s"}`);
      break;
    case "territory":
      parts.push(scope.allowedLineNames && scope.allowedLineNames.size > 0 ? [...scope.allowedLineNames].join(" · ") : "All tracked lines");
      if (!scope.allowedRegionCodes) parts.push("all regions");
      else if (scope.allowedRegionCodes.size === 1) {
        const code = [...scope.allowedRegionCodes][0];
        parts.push(regionNames.get(code) ?? code);
      } else parts.push(`${scope.allowedRegionCodes.size} regions`);
      break;
    case "none":
      parts.push("No access");
      break;
  }
  parts.push(role);
  return parts.join(" · ");
}

export async function loadWeeklyStockDashboard(
  filters: WeeklyStockRequestFilters,
  ctx: AccessContext,
): Promise<WeeklyStockPayload> {
  const [accessScope, seatIndex] = await Promise.all([
    resolveWeeklyAccessScope(ctx),
    // A medical rep's own areas are his filled rep seats; every other viewer's come from his scope.
    ctx.role === "Medical Rep" ? loadFieldForceSeatIndex() : Promise.resolve(null),
  ]);

  // A territory viewer's depots load with his region bound LIFTED and are narrowed straight back to the
  // ones that serve his own areas (own-area-scope.ts). Depot rows keep the region label they were mapped
  // with, so an Upper Egypt 1, Upper Egypt 2 or Delta (3) viewer's region-bound load held almost none of
  // the depots that stock his areas. Everyone else loads exactly as before.
  const ownAreaKeys = await resolveWeeklyOwnAreaKeys(ctx, accessScope, seatIndex?.seats);
  const liftGrain = mayLiftWeeklyGeography(accessScope, ownAreaKeys);
  // A lifted load applies the product filter after the narrowing instead of inside the load, so the
  // product list can still offer every product his depots carry while one of them is chosen.
  const productFilterInLoad = !liftGrain;

  const [data, areaNames, areaSplit] = await Promise.all([
    loadWeeklyDashboard({
      // Every week: the snapshot is each distributor's own latest stock upload, and the cover average
      // looks back across month boundaries.
      allWeeks: true,
      // Owner rule for every weekly report and export: unmapped products never reach a total.
      excludeUnmapped: true,
      includeStockRows: true,
      distributorCodes: filters.distributorCodes,
      distributorFilterMode: filters.distributorFilterMode,
      regionCodes: filters.regionCodes,
      regionFilterMode: filters.regionFilterMode,
      productCodes: productFilterInLoad ? filters.productCodes : undefined,
      productFilterMode: productFilterInLoad ? filters.productFilterMode : undefined,
      lineCodes: filters.lineCodes,
      lineFilterMode: filters.lineFilterMode,
      accessScope,
      liftRowGrainGeography: liftGrain,
    }),
    loadAreaNames(),
    // The owner's depot-split rule, which says which areas a depot serves. Fails soft to no index, which
    // leaves only depots mapped by hand to one of his areas.
    liftGrain ? loadWeeklyAreaSplitIndex().catch(() => null) : Promise.resolve(null),
  ]);

  const scopedStockRows =
    liftGrain && accessScope.tier === "territory"
      ? admitWeeklyStockRows(data.stockRows ?? [], { bound: accessScope, ownAreaKeys, areaSplit })
      : (data.stockRows ?? []);
  const stockRows = productFilterInLoad ? scopedStockRows : scopedStockRows.filter(weeklyStockProductPredicate(filters));

  const view = buildWeeklyStockView(stockRows, areaNames, {
    asOfWeekStart: filters.asOfWeekStart,
    areaCodes: filters.areaCodes,
    branchKeys: filters.branchKeys,
    statuses: filters.statuses,
  });

  // Option universes trimmed to the viewer's scope, the same way the portal Weekly Sales trims them.
  const allowedRegions = accessScope.tier === "territory" ? accessScope.allowedRegionCodes : null;
  const allowedProducts = accessScope.tier === "product" ? accessScope.productCodes : null;
  const regions = allowedRegions
    ? data.availableRegions.filter((region) => allowedRegions.has(region.code.toUpperCase()))
    : data.availableRegions;
  const scopedProducts = allowedProducts
    ? data.availableProducts.filter((product) => allowedProducts.has(product.code.toUpperCase()))
    : data.availableProducts;
  // The load's option lists are the region-bound ones, so a lifted viewer also gets what his narrowed
  // depots carry — read before the product filter, so choosing one product never hides the others.
  const products = liftGrain
    ? withExtraWeeklyOptions(
        scopedProducts,
        scopedStockRows.map((row) => ({ code: row.productCode, name: row.productName })),
      )
    : scopedProducts;
  const distributorUniverse = liftGrain
    ? withExtraWeeklyOptions(
        data.distributors,
        scopedStockRows.map((row) => ({ code: row.distributorCode, name: row.distributorName })),
      )
    : data.distributors;
  const showLines = accessScope.tier === "full" || ctx.role === "Marketing Manager";
  const regionNames = new Map(data.availableRegions.map((region) => [region.code.toUpperCase(), region.name]));

  return {
    view,
    options: {
      // Only distributors that actually carry stock in scope — POS and Direct report none.
      distributors: distributorUniverse.filter((distributor) =>
        view.distributors.some((row) => row.code === distributor.code.toUpperCase()) ||
        (filters.distributorCodes ?? []).some((code) => code.toUpperCase() === distributor.code.toUpperCase()),
      ),
      regions,
      products,
      lines: showLines ? data.availableLines : [],
    },
    scope: {
      summary: buildStockScopeSummary(accessScope, ctx.role, regionNames),
      visibility: {
        line: showLines,
        region: !(allowedRegions !== null && allowedRegions.size === 1),
      },
    },
  };
}
