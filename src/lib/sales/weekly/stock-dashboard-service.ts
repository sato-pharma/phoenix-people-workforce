// Weekly Stock — the scoped loader shared by the admin shell (/sales/weekly/stock) and the employee
// portal (/employee-portals/weekly-stock), and by both exports.
//
// Scope is resolved from the SESSION with the same resolveWeeklyAccessScope Weekly Sales uses, and it
// is enforced inside loadWeeklyDashboard (applyWeeklyAccessScope, then the tracked-line golden rule
// that keeps Head Office out). Query params only narrow inside what the viewer may already see, so a
// caller cannot widen past their role by editing the URL. The screen and the export call this one
// function with the same filters, which is what keeps the download identical to the page.

import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";

import { unstable_cache } from "next/cache.js";

import type { AccessContext, PhoenixRole } from "@/lib/auth/permissions";
import { serveWithoutCaching, unwrapServedWithoutCaching } from "@/lib/cache/serve-uncached";
import { WEEKLY_STOCK_CACHE_TAG } from "@/lib/dashboard/invalidation";
import { yieldToEventLoop } from "@/lib/platform/yield-to-event-loop";
import { resolveWeeklyAccessScope, type WeeklyAccessScope } from "@/lib/sales/weekly/access";
import { loadWeeklyAreaSplitIndex } from "@/lib/sales/weekly/branch-area-split";
import { narrowStockRowsToGovernorate, viewerGovernorates } from "@/lib/sales/weekly/branch-governorate-scope";
import {
  admitWeeklyStockRows,
  mayLiftWeeklyGeography,
  resolveWeeklyOwnAreaKeys,
  weeklyStockProductPredicate,
  withExtraWeeklyOptions,
} from "@/lib/sales/weekly/own-area-scope";
import { loadFieldForceSeatIndex } from "@/lib/sales/weekly/portal-weekly-field-force";
import { loadWeeklyScopeRegionNames, weeklyScopeRegionPart } from "@/lib/sales/weekly/scope-region-names";
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

/** The scope line on the screen and in the workbook, in names: a single bound region is named from the organogram. Pure. */
export function buildStockScopeSummary(
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
      parts.push(weeklyScopeRegionPart(scope.allowedRegionCodes, regionNames));
      break;
    case "none":
      parts.push("No access");
      break;
  }
  parts.push(role);
  return parts.join(" · ");
}

/**
 * How long one Weekly Stock payload is remembered (2 Nov 2026, the speed root cause, Stage 2). On
 * production the page spent 12.9 s of server render per open: every weekly row of the viewer's scope
 * read, re-priced, de-cumulated and folded into the view, for a screen whose numbers change only
 * when a distributor sheet is uploaded or a price is edited. Five minutes is the backstop; the real
 * freshness is the tag, dropped by every weekly write (bumpWeeklyRowsGeneration in row-cache.ts) and
 * by a Product Master price edit (invalidatePriceDependentSalesCaches).
 */
export const WEEKLY_STOCK_CACHE_SECONDS = 300;

/**
 * The largest packed payload the data cache may keep; a bigger one is served and NOT stored (the
 * Sales vs Target cache set the precedent: Next refuses an entry over 2 MB, and refuses it loudly on
 * every render). Stored gzipped and base64, as that cache stores its rows, so a 400 KB view is a
 * ~40 KB entry and the size checked here is the size Next measures.
 */
export const WEEKLY_STOCK_CACHE_MAX_BYTES = 1_500_000;

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/**
 * The data-cache key of one Weekly Stock payload: the viewer's SCOPE and filters, never the viewer.
 * Two reps on one seat, or a DM and the NSM over the same region, read one entry. Everything the
 * build below reads from the viewer is here — the role (the scope line names it, and a Marketing
 * Manager sees the line filter), the scope tier with its sets, the Head Office flag, his own-area
 * keys, whether the load is lifted, and every filter with its mode. Exported so a test can pin that
 * the HR id never enters it. The array order IS the key — do not reorder casually.
 */
export function weeklyStockCacheKeyParts(
  role: PhoenixRole,
  scope: WeeklyAccessScope,
  ownAreaKeys: ReadonlySet<string>,
  liftGrain: boolean,
  filters: WeeklyStockRequestFilters,
): string[] {
  const list = (values: Iterable<string> | null | undefined): string => (values ? [...values].sort().join(",") : "*");
  const tierParts =
    scope.tier === "full"
      ? [`restricted:${scope.canViewRestricted}`]
      : scope.tier === "product"
        ? [`scope-products:${list(scope.productCodes)}`]
        : scope.tier === "territory"
          ? [`scope-lines:${list(scope.allowedLineNames)}`, `scope-regions:${list(scope.allowedRegionCodes)}`, `scope-areas:${list(scope.allowedAreaCodes)}`]
          : [];
  return [
    "weekly-stock-payload",
    `role:${role}`,
    `tier:${scope.tier}`,
    `head-office:${scope.canViewHeadOffice}`,
    ...tierParts,
    `own-areas:${list(ownAreaKeys)}`,
    `lift:${liftGrain}`,
    `as-of:${filters.asOfWeekStart ?? ""}`,
    `distributors:${filters.distributorFilterMode ?? "include"}:${list(filters.distributorCodes)}`,
    `regions:${filters.regionFilterMode ?? "include"}:${list(filters.regionCodes)}`,
    `products:${filters.productFilterMode ?? "include"}:${list(filters.productCodes)}`,
    `lines:${filters.lineFilterMode ?? "include"}:${list(filters.lineCodes)}`,
    `areas:${list(filters.areaCodes)}`,
    `depots:${list(filters.branchKeys)}`,
    `statuses:${list(filters.statuses)}`,
  ];
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

  // The scope above is resolved on every open — it is the viewer's and it is cheap. Everything from
  // here on is the heavy build, remembered per scope and filters (weeklyStockCacheKeyParts) for
  // WEEKLY_STOCK_CACHE_SECONDS and dropped by the writes that change its numbers. A payload too large
  // to store is served to this viewer without being kept (serve-uncached.ts).
  const remembered = unstable_cache(
    async (): Promise<string> => {
      const payload = await buildWeeklyStockPayload();
      const packed = (await gzipAsync(JSON.stringify(payload))).toString("base64");
      if (packed.length > WEEKLY_STOCK_CACHE_MAX_BYTES) {
        serveWithoutCaching(payload, `the Weekly Stock payload is ${packed.length} bytes packed, over WEEKLY_STOCK_CACHE_MAX_BYTES`);
      }
      return packed;
    },
    weeklyStockCacheKeyParts(ctx.role, accessScope, ownAreaKeys, liftGrain, filters),
    { revalidate: WEEKLY_STOCK_CACHE_SECONDS, tags: [WEEKLY_STOCK_CACHE_TAG] },
  );
  const served = await unwrapServedWithoutCaching<string | WeeklyStockPayload>(remembered());
  if (typeof served !== "string") return served;
  return JSON.parse((await gunzipAsync(Buffer.from(served, "base64"))).toString("utf8")) as WeeklyStockPayload;

  async function buildWeeklyStockPayload(): Promise<WeeklyStockPayload> {
    const [data, areaNames, areaSplit, regionNames] = await Promise.all([
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
      // The scope line's region name, from the organogram: a depot keeps the region label it was mapped with, so
      // the load's own region options never name Upper Egypt 1, Upper Egypt 2 or Delta (3). Fails soft.
      loadWeeklyScopeRegionNames(accessScope),
    ]);

    // Each step below walks every stock row; pause between them so nine reps opening at once take turns
    // with everyone else instead of holding the server end to end (yield-to-event-loop.ts).
    await yieldToEventLoop();
    const liftedStockRows =
      liftGrain && accessScope.tier === "territory"
        ? admitWeeklyStockRows(data.stockRows ?? [], { bound: accessScope, ownAreaKeys, areaSplit })
        : (data.stockRows ?? []);
    // Governorate scope (owner, 2026-09-23): a territory viewer sees only the depots in his OWN
    // governorate, not his whole region. Kibar Omala depots and depots whose name states no
    // governorate stay visible. Visibility only — attribution is untouched. A viewer with no
    // governorate bound (full/product/region-only) is not narrowed. See branch-governorate-scope.ts.
    // Narrowed here so the product filter and the option lists below still read the scoped rows.
    const scopedStockRows = narrowStockRowsToGovernorate(
      liftedStockRows,
      viewerGovernorates(accessScope, ownAreaKeys),
    );
    await yieldToEventLoop();
    const stockRows = productFilterInLoad ? scopedStockRows : scopedStockRows.filter(weeklyStockProductPredicate(filters));

    await yieldToEventLoop();
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
}
