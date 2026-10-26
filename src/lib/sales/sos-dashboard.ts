// Source-of-Sales (distributor) dashboard — analytics driven ONLY by the distributor invoice
// pipeline (source_of_sales_import_rows via the phx_exec_* RPCs), NOT the closing-sheet/targets
// pipeline. There are no targets and no employee/manager attribution in this data, so the
// dashboard pivots to distributor / channel / region / area / brick / customer / product analytics
// with value + units over time.
//
// Value semantics (encapsulated by the RPCs): distributor rows = qty*factory_price;
// Direct rows = the stored sheet value; bonus qty and the discount column are both excluded. Confidential products
// (LA003/LA004/SS001) are stripped at leaf level for everyone except CEO / Super Admin.

import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";

import { unstable_cache } from "next/cache.js";

import type { AccessContext } from "@/lib/auth/permissions";
import {
  RESTRICTED_PRODUCT_CODES,
  canViewHeadOfficeLine,
  canViewRestrictedProducts,
  canonicalizeRegionName,
  isHeadOfficeLine,
  normalizeLineKey,
  resolveSalesAccessScope,
  resolveSalesGeographyBound,
} from "@/lib/sales/access-scope";
import { listMonthlyClosingPeriods, loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import {
  DIRECT_CHANNEL_CODE,
  DIRECT_CHANNEL_LABEL,
  canonicalDistributorKey,
  expandDirectChannelFilter,
  foldDirectDistributorCode,
  isDirectChannelCode,
} from "@/lib/sales/direct-channel";
import { loadOperationalRegionResolver } from "@/lib/sales/closing-organogram-regions";
import {
  expandAreaCodesForLine,
  foldAreaCodeForLine,
  foldAreaOptionsForLine,
  getMergedAreaName,
  hasClosingAreaMerges,
} from "@/lib/sales/closing-area-merges";
import {
  areaMatchesRegionFilter,
  buildRegionOptions,
  operationalRegionFor,
  rowIsInRegionScope,
  rowMatchesRegionFilter,
  widenRegionsToGeography,
} from "@/lib/sales/sos-region-basis";
import { isFuturePeriod, latestNonFuturePeriod, shiftPeriod } from "@/lib/sales/periods";
import {
  buildSosCoverageReport,
  describeSosCoverageGaps,
  type SosCoverageReport,
} from "@/lib/sales/sos-coverage";
import { maskSosCoverageReport } from "@/lib/sales/closing-source-mask";
import {
  computeContribution,
  computeDelta,
  computeDeltaPctByCode,
  computeMovers,
  computeNewAndLost,
  computePareto,
  resolvePriorPeriod,
  type SosContributionRow,
  type SosDelta,
  type SosMovers,
  type SosNewLostRow,
  type SosParetoRow,
} from "@/lib/sales/sos-analytics";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin, rpcAll } from "@/lib/supabase/server";

export type {
  SosContributionRow,
  SosDelta,
  SosMoverRow,
  SosMovers,
  SosNewLostRow,
  SosOutlierRow,
  SosParetoRow,
} from "@/lib/sales/sos-analytics";

const TREND_WINDOW = 6; // most-recent months shown in the trend
const RESTRICTED_SET = new Set(RESTRICTED_PRODUCT_CODES.map((code) => code.toUpperCase()));

/** Hard cap on how many months a single dashboard load may aggregate (each month is one extra
 *  pushed-down detail RPC). Keeps a "select everything" click bounded; newest months win. */
export const MAX_SELECTED_PERIODS = 12;

export type SosDashboardFilters = Partial<{
  /** Single-period filter (legacy). Prefer `periods` for multi-select. */
  period: string;
  /** Multi-period filter — the dashboard sums leaf rows across every selected month. Empty = latest. */
  periods: string[];
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
  /** The primary (newest) month in scope. Kept for back-compat / single-month labels. */
  period: string | null;
  /** Every month currently aggregated (newest-first). Length > 1 = a multi-month view. */
  selectedPeriods: string[];
  availablePeriods: string[];
  filters: SosFilterOptions;
  /**
   * True only when this response actually includes the confidential products (LA003/LA004/SS001)
   * — i.e. the caller both requested `revealRestrictedProducts` AND holds a CEO/Super-Admin role.
   * Reflects the engine's own decision, not the client's toggle state, so the UI/export footer can
   * never mis-state what a payload contains.
   */
  restrictedRevealed: boolean;
  /**
   * Aggregates that errored while building this payload (RPC error, statement timeout, …).
   * Non-empty ⇒ the figures below are INCOMPLETE and must not be presented as real zeros. Empty on
   * every healthy load, so `incompleteReason.length > 0` is the UI's error signal.
   */
  incompleteReason: string[];
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
  bottomBricks: SosGroupRow[];
  topCustomers: SosCustomerRow[];
  customerTop10Share: number;
  whiteSpaceAreas: SosWhiteSpaceRow[];
  insights: { tone: "neutral" | "success" | "warning" | "danger"; text: string }[];
  /**
   * Month-over-month intelligence vs the prior validated period. Present only when the caller
   * passes `options.includeMomComparison` (admin dashboard + BI export); `null` means it was
   * requested but no prior validated period exists. The portal never requests it, so the portal
   * payload is byte-identical to before this field existed.
   */
  momComparison?: SosMomComparison | null;
  /**
   * Year-over-year intelligence vs the same month last year. Present only when the caller
   * passes `options.includeYoY`; `null` means it was requested but no same-month-last-year
   * period exists yet (or the selection spans more than one month). Same shape as
   * `momComparison` — the type is agnostic to "prior = last month" vs "prior = last year".
   */
  yoyComparison?: SosMomComparison | null;
  /** Pareto / ABC classification of byProduct. Computed only with `includeMomComparison`. */
  paretoProducts?: SosParetoRow[];
  /** Scoped leaf rows for the BI export's hidden Data sheet. Only with `includeDetailRows`. */
  detailRows?: SosDetailLeafRow[];
};

export type SosSummaryDeltas = {
  totalValue: SosDelta;
  totalUnits: SosDelta;
  avgPricePerUnit: SosDelta;
  distributorCount: SosDelta;
  productCount: SosDelta;
  directShare: SosDelta;
  areasReached: SosDelta;
};

export type SosMomComparison = {
  priorPeriod: string;
  summaryDeltas: SosSummaryDeltas;
  movers: { products: SosMovers; regions: SosMovers; distributors: SosMovers };
  /**
   * EVERY member's deltaPct keyed by normalized code (not just the top-5 movers), so the full
   * product/distributor tables can show each row's real % change instead of "—" for everything
   * outside the movers cap. A code absent here has no comparable prior value → the table shows "—".
   */
  deltaPctByCode: { products: Record<string, number>; regions: Record<string, number>; distributors: Record<string, number> };
  /** Growth-contribution decomposition — each member's share of the total absolute movement. */
  contribution: { products: SosContributionRow[]; regions: SosContributionRow[] };
  newProducts: SosNewLostRow[];
  lostProducts: SosNewLostRow[];
  newAreas: SosNewLostRow[];
  lostAreas: SosNewLostRow[];
};

/** Labeled leaf grain (one row per month × distributor × line × region × area × product). */
export type SosDetailLeafRow = {
  period: string;
  distributorCode: string;
  distributorName: string;
  officialLine: string;
  /** ORGANOGRAM region — the DM territory that owned this area, on this line, in this month. */
  regionCode: string;
  regionName: string;
  areaCode: string;
  areaName: string;
  productCode: string;
  productName: string;
  channel: "Direct" | "Distributor";
  units: number;
  value: number;
  /**
   * GEOGRAPHIC region — where the area sits on the map, the code the fact row itself carries.
   * Carried alongside so the export states which basis produced its subtotals, instead of leaving
   * a reader to discover that two screens split the same month differently. Equal to `regionCode`
   * for every row the organogram does not move. Same vocabulary as `applyOperationalRegions`.
   */
  sourceRegionCode: string;
  sourceRegionName: string;
};

type ExecRow = {
  distributorCode: string;
  officialLine: string;
  /**
   * GEOGRAPHIC region — the code the fact row itself carries, i.e. where the area sits on the map.
   * This is the ACCESS dimension: `scopeRegionCodes` is resolved against it, because that is what
   * the RPC push-down filters on. Never group or display on it for an organogram line.
   */
  regionCode: string;
  /**
   * ORGANOGRAM region — which DM territory owned this area, on this line, in this month. Falls back
   * to `regionCode` for a line outside the organogram set (Head Office), for an area the org chart
   * does not cover, and whenever the org chart could not be read at all.
   *
   * This is the DISPLAY and USER-FILTER dimension, and the split is the whole point: the two
   * disagree on 23 (line, area) pairs as of 2026-07-31, moving 807k EGP between regions in July
   * alone — CNS Others +335k, CNS Delta (1) −214k — while the grand total stays identical, so
   * nothing about the disagreement looks wrong on either screen.
   */
  operationalRegionCode: string;
  areaCode: string;
  productCode: string;
  productName: string;
  units: number;
  value: number;
  /** The month this leaf row belongs to — tagged at fetch time so the trend can reconcile each
   *  selected month's point to its own detail total, and so `operationalRegionCode` is dated at the
   *  row's OWN month. Tagged on every detail fetch including the MoM and YoY comparison months. */
  period: string;
};
type BrickRow = { distributorCode: string; regionCode: string; areaCode: string; brickId: string; units: number; value: number };
export type CustomerRow = { clientCode: string; clientName: string; distributorCode: string; regionCode: string; areaCode: string; units: number; value: number };

const norm = (value: string | null | undefined) => String(value ?? "").trim();
/** Both vintages of the Direct channel — DIRECT (uploaded, ≤2026-07) and DirectReq (the module,
 *  2026-08 on). Matching the literal "direct" alone reported every module-sourced direct sale as a
 *  distributor. See src/lib/sales/direct-channel.ts. */
const isDirect = isDirectChannelCode;

/** A client_code is only unique WITHIN a distributor — two distributors reuse the same code for two
 *  different pharmacies, so the identity of a customer is always the composite pair. */
const customerKey = (row: { clientCode: string; distributorCode: string }) =>
  `${row.distributorCode}::${row.clientCode}`;

/**
 * Collapse the per-period customer rows into one row per customer.
 *
 * phx_exec_customers is called once per selected month and the results are flattened, so a customer
 * that bought in N of the selected months arrives as N rows. Ranking that list directly splits one
 * customer's revenue across several rows: on 2026-06 + 2026-07 the true #3 (184,140.00) showed as
 * 132,570.00 at rank 5 plus 51,570.00 off the bottom, and two genuine top-15 customers were pushed
 * off the panel entirely. Aggregate BEFORE ranking, exactly as brickAccum does for bricks.
 *
 * `rows` arrive newest-month-first (selectedPeriods is sorted descending), so the first non-empty
 * name/region/area wins — a customer who stopped buying keeps the newest label the RPC resolved for
 * them, and a month with a blank field cannot blank out a label another month supplied.
 */
export function aggregateCustomerRows(rows: CustomerRow[]): CustomerRow[] {
  const accum = new Map<string, CustomerRow>();
  for (const row of rows) {
    const key = customerKey(row);
    const current = accum.get(key);
    if (!current) {
      accum.set(key, { ...row });
      continue;
    }
    current.units += row.units;
    current.value += row.value;
    if (!current.clientName) current.clientName = row.clientName;
    if (!current.regionCode) current.regionCode = row.regionCode;
    if (!current.areaCode) current.areaCode = row.areaCode;
  }
  return [...accum.values()];
}

function toFilterSet(values: string[] | undefined): Set<string> | null {
  if (!values || values.length === 0) return null;
  return new Set(values.map((value) => norm(value).toUpperCase()));
}

// Sort a copy of a nullable string array (null = "no restriction" is preserved). Used only to build
// a stable cache key for the SoS RPC fan-out — the phx_exec_* RPCs treat these arrays as sets, so
// ordering never changes the result, only the cache-key bytes.
const sortedOrNull = (values: string[] | null): string[] | null => (values === null ? null : [...values].sort());

function share(value: number, total: number): number {
  return total > 0 ? value / total : 0;
}

/**
 * Run one aggregate RPC, degrading to no rows instead of taking the whole dashboard down.
 *
 * The empty array is NOT the whole story: the label is recorded in `failures` so the caller can tell
 * the viewer that this panel is incomplete. Without that, a 45s statement timeout was indistinguish-
 * able from "no sales", and the zero was then cached for 300 seconds.
 */
async function safeRpcAll<T>(
  label: string,
  supplier: () => Promise<T[]>,
  failures: string[],
): Promise<T[]> {
  try {
    return await supplier();
  } catch (error) {
    console.error(`[sales dashboard] RPC failed, panel will be marked incomplete: ${label}`, error);
    failures.push(label);
    return [];
  }
}

type SosRpcInputs = {
  windowPeriods: string[];
  selectedPeriods: string[];
  priorPeriod: string | null;
  yoyPeriod: string | null;
  trendLineNames: string[] | null;
  trendRegionCodes: string[] | null;
  trendProductCodes: string[] | null;
  filterAreas: string[];
  filterDistributors: string[];
  excludeCodes: string[];
  trendExcludeCodes: string[];
  trendForcedEmpty: boolean;
  canSeeCrossLineGeography: boolean;
};

export type SosRpcRows = {
  detailRows: Array<Record<string, unknown>>;
  trendRowsRaw: Array<Record<string, unknown>>;
  brickRaw: Array<Record<string, unknown>>;
  customerRaw: Array<Record<string, unknown>>;
  priorDetailRaw: Array<Record<string, unknown>>;
  yoyDetailRaw: Array<Record<string, unknown>>;
  /** Labels of aggregates that errored. Non-empty ⇒ the numbers below are incomplete. */
  failedRpcs: string[];
};

const DETAIL_ORDER_BY = ["distributor_code", "region_code", "area_code", "product_code"];

// Cached phx_exec_* RPC fan-out — the heavy part of the SoS dashboard (each aggregate is 2–11s
// against the rollup tables). unstable_cache keys on the fully scope-resolved `inputs`, so a second
// identical load (same viewer scope ∩ filters) is served from cache instead of re-running the
// aggregates. The inputs already fold in the caller's line/region/product scope (the trend*/exclude
// arrays + the canSeeCrossLineGeography gate), so two callers share a cache entry ONLY when they are
// entitled to identical rows; keepExec in getSosDashboard stays the authoritative per-request
// authorization backstop. Invalidated on any validated SoS/marketing import via
// invalidateSalesDashboardCache (tag "sos-dashboard").
const fetchSosDashboardRpcRowsUncached = async (inputs: SosRpcInputs): Promise<SosRpcRows> => {
    const {
      windowPeriods,
      selectedPeriods,
      priorPeriod,
      yoyPeriod,
      trendLineNames,
      trendRegionCodes,
      trendProductCodes,
      filterAreas,
      filterDistributors,
      excludeCodes,
      trendExcludeCodes,
      trendForcedEmpty,
      canSeeCrossLineGeography,
    } = inputs;
    const supabase = getSupabaseAdmin();
    const emptyRpcRows = Promise.resolve([] as Array<Record<string, unknown>>);
    const failedRpcs: string[] = [];

    const trendResultPromise = trendForcedEmpty
      ? emptyRpcRows
      : safeRpcAll("phx_exec_sos_trend", async () => {
          const response = await supabase.rpc("phx_exec_sos_trend", {
            p_areas: filterAreas,
            p_distributors: filterDistributors,
            p_exclude_codes: trendExcludeCodes,
            p_lines: trendLineNames ?? [],
            p_periods: windowPeriods,
            p_products: trendProductCodes ?? [],
            p_regions: trendRegionCodes ?? [],
          });
          if (response.error) throw response.error;
          return (response.data ?? []) as Array<Record<string, unknown>>;
        }, failedRpcs);

    const detailArgsFor = (period: string) => ({
      p_period: period,
      p_lines: trendLineNames ?? [],
      p_distributors: filterDistributors,
      p_regions: trendRegionCodes ?? [],
      p_areas: filterAreas,
      p_products: trendProductCodes ?? [],
      p_exclude_codes: excludeCodes,
    });
    const fetchDetail = (periods: string[]) =>
      Promise.all(
        periods.map((period) =>
          rpcAll(supabase, "phx_exec_distributor_product", detailArgsFor(period), DETAIL_ORDER_BY).then((rows) =>
            rows.map((row) => ({ ...row, __period: period })),
          ),
        ),
      ).then((arrays) => arrays.flat());
    const detailRowsPromise = trendForcedEmpty ? emptyRpcRows : fetchDetail(selectedPeriods);

    // Both comparison fetches tag `__period` for the same reason the selected months do. It used to
    // be left off because the trend only ever reconciles SELECTED months — but the row's month is
    // now what dates its organogram lookup, and an untagged row would resolve the prior or year-ago
    // month against TODAY's structure, silently crediting a territory move to a month it predates.
    const priorDetailRowsPromise =
      !priorPeriod || trendForcedEmpty
        ? emptyRpcRows
        : safeRpcAll(
            "phx_exec_distributor_product (prior period)",
            () =>
              rpcAll(supabase, "phx_exec_distributor_product", detailArgsFor(priorPeriod), DETAIL_ORDER_BY).then(
                (rows) => rows.map((row) => ({ ...row, __period: priorPeriod })),
              ),
            failedRpcs,
          );

    const yoyDetailRowsPromise =
      !yoyPeriod || trendForcedEmpty
        ? emptyRpcRows
        : safeRpcAll(
            "phx_exec_distributor_product (YoY period)",
            () =>
              rpcAll(supabase, "phx_exec_distributor_product", detailArgsFor(yoyPeriod), DETAIL_ORDER_BY).then(
                (rows) => rows.map((row) => ({ ...row, __period: yoyPeriod })),
              ),
            failedRpcs,
          );

    // The brick/customer panels take the SAME line/product/region/area bound as the headline total.
    // They used to receive only the period, so "Top Bricks" and "Top Customers" showed company-wide
    // rows directly beneath a line-scoped total — and neither line nor product is even present in
    // the result set, so no amount of post-filtering in TS could have corrected it.
    //
    // Cache-safe: every array below is already a field of SosRpcInputs (the unstable_cache key), so
    // two differently-scoped viewers still cannot share an entry.
    const geoArgsFor = (period: string): Record<string, unknown> => ({
      p_period: period,
      // ALWAYS pass the array, including when it is empty. Omitting it let the SQL DEFAULT
      // (ARRAY['LA003','LA004','SS001']) apply, so a CEO who ticked "include confidential products"
      // — where excludeCodes and headOfficeProductCodes are both empty — got the panels computed
      // WITH the exclusion while the headline beside them was computed without it. The trend RPC
      // above always passes it, which is precisely why only these two panels disagreed.
      p_exclude_codes: trendExcludeCodes,
      p_lines: trendLineNames ?? null,
      p_products: trendProductCodes ?? null,
      p_regions: trendRegionCodes ?? null,
      p_areas: filterAreas.length > 0 ? filterAreas : null,
    });
    const fetchGeo = (fn: "phx_exec_brick" | "phx_exec_customers", orderBy: string[]) =>
      // trendForcedEmpty means the viewer's scope ∩ filters resolved to nothing. Every other RPC
      // here already short-circuits on it; the geography panels did not, and only the TS keepExec
      // backstop stopped them rendering rows. Skipping the call is both correct and cheaper.
      canSeeCrossLineGeography && !trendForcedEmpty
        ? Promise.all(
            selectedPeriods.map((period) =>
              safeRpcAll(fn, () => rpcAll(supabase, fn, geoArgsFor(period), orderBy), failedRpcs),
            ),
          ).then((arrays) => arrays.flat())
        : emptyRpcRows;

    const [detailRows, trendRowsRaw, brickRaw, customerRaw, priorDetailRaw, yoyDetailRaw] = await Promise.all([
      detailRowsPromise,
      trendResultPromise,
      fetchGeo("phx_exec_brick", ["distributor_code", "region_code", "area_code", "brick_id"]),
      fetchGeo("phx_exec_customers", ["client_code", "distributor_code"]),
      priorDetailRowsPromise,
      yoyDetailRowsPromise,
    ]);
    return {
      detailRows,
      trendRowsRaw,
      brickRaw,
      customerRaw,
      priorDetailRaw,
      yoyDetailRaw,
      failedRpcs: [...new Set(failedRpcs)],
    };
};

/**
 * The ceiling for one packed SoS dashboard entry — well under Next's hard 2MB data-cache limit.
 *
 * The SAME number and the same reasoning as ACHIEVEMENT_CACHE_MAX_BYTES in vs-target.ts: Next
 * refuses any entry over 2MB, by THROWING an unhandled rejection that kills the dev server, and in
 * production by a console.warn and a skipped write — the cache silently stops existing. The raw
 * rows crossed that line (PERF-004, measured 2026-10-04: a CNS cross-line view for 2026-08 was
 * 2.08 MB raw, so it was never cached in production). Compressed, the same rows are a fraction of it.
 */
export const SOS_DASHBOARD_CACHE_MAX_BYTES = 1_500_000;

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/**
 * Rows -> a base64 gzip payload, or null when the rows must NOT be cached.
 *
 * Null in two cases, and both are load-bearing. (1) A FAILED aggregate (`failedRpcs` non-empty):
 * caching it would serve the same incomplete numbers for the whole TTL, so the caller reads live
 * instead and a transient timeout heals on the next load. (2) Even compressed the entry would not
 * fit — never hand the data cache an oversize entry (see SOS_DASHBOARD_CACHE_MAX_BYTES).
 *
 * base64 because the entry is stored through JSON.stringify and base64 needs no escaping, so the
 * size checked here is the size Next measures. Async so the deflate runs off the event loop.
 */
export async function packSosRows(rows: SosRpcRows): Promise<string | null> {
  if (rows.failedRpcs.length > 0) return null;
  const packed = (await gzipAsync(JSON.stringify(rows))).toString("base64");
  return packed.length > SOS_DASHBOARD_CACHE_MAX_BYTES ? null : packed;
}

/** The exact inverse of packSosRows. Every caller gets its own copy of the rows. */
export async function unpackSosRows(packed: string): Promise<SosRpcRows> {
  const json = (await gunzipAsync(Buffer.from(packed, "base64"))).toString("utf8");
  return JSON.parse(json) as SosRpcRows;
}

// The data cache holds the PACKED rows only — never the raw SosRpcRows, which outgrew Next's 2MB
// entry (PERF-004). Same tag and same 300s as before; a new key part so an old raw entry is never
// read back as a packed one. The key is still the fully scope-resolved `inputs`, confidential
// exclude codes included, so two viewers share an entry only when they are entitled to the same rows.
const fetchSosDashboardRpcRowsPacked = unstable_cache(
  async (inputs: SosRpcInputs) => packSosRows(await fetchSosDashboardRpcRowsUncached(inputs)),
  ["sos-dashboard-packed"],
  { revalidate: 300, tags: ["sos-dashboard"] },
);

// EVERY viewer goes through the cache — the CEO and the Super Admin included. OWNER DECISION,
// 2026-10-04: the company-wide view (no line restriction + cross-line geography) used to skip the
// cache because its raw brick + customer rows outgrew Next's 2MB entry; packed, it fits, and the
// owner chose the same 5-minute cache for that view as for everyone else.
async function fetchSosDashboardRpcRows(inputs: SosRpcInputs): Promise<SosRpcRows> {
  const packed = await fetchSosDashboardRpcRowsPacked(inputs);
  if (packed !== null) {
    const cached = await unpackSosRows(packed);
    // packSosRows never packs a failure; this is the second lock, so a cached entry carrying one can
    // never be served for the full TTL even if the first is ever loosened.
    if (cached.failedRpcs.length === 0) return cached;
  }
  // Not cacheable (a failed aggregate, or too big even packed): read live. A failure that persists
  // comes back in failedRpcs and the caller says so instead of showing a stale zero.
  return fetchSosDashboardRpcRowsUncached(inputs);
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
  /**
   * Override the scope-derived AREA codes. When the KEY is present it replaces the base area
   * lockdown. Always paired with a region override wide enough to fetch those areas' rows — the
   * area filter is what keeps that widening from exposing a sibling manager's areas. null = no area
   * restriction; a Set = restrict to those codes. Server-resolved from the session, never user input.
   */
  allowedAreaCodes?: Set<string> | null;
};

/**
 * Scope overrides plus the additive admin/export feature flags. Both flags default to off, so
 * every existing caller (portal wrapper, portal export) gets a byte-identical payload.
 */
export type SosDashboardOptions = SosScopeOverrides & {
  /** Compute momComparison + paretoProducts (one extra pushed-down prior-period detail RPC). */
  includeMomComparison?: boolean;
  /**
   * Compute yoyComparison vs the same month last year (one extra pushed-down detail RPC).
   * Structurally identical to momComparison — same delta/movers/contribution/new-lost math,
   * just against `shiftPeriod(selectedPeriod, 12)` instead of the prior month. Only meaningful
   * for a single-month selection with that prior-year month present in availablePeriods;
   * otherwise yoyComparison is null (never a fabricated/partial comparison).
   */
  includeYoY?: boolean;
  /** Attach the keepExec-filtered leaf rows (detailRows) for the BI export's Data sheet. */
  includeDetailRows?: boolean;
  /**
   * Explicit CEO/Super-Admin opt-in to reveal the confidential products (LA003/LA004/SS001) in
   * this response. Confidential-by-default: omitting this (or a non-CEO/SA role requesting it)
   * keeps them excluded — the same fail-closed AND as every other restricted-data gate in this
   * file. Mirrors the marketing-ROI report's `includeRestricted` toggle (src/lib/marketing-requests
   * /roi-report-service.ts) — same UX, same server-side re-validation against the caller's role.
   */
  revealRestrictedProducts?: boolean;
  /**
   * Leave the data-gap banner ("<distributor> is missing from <months> …") out of `insights`.
   * The employee portal sets it: the banner is an HR/admin upload-housekeeping note, never shown
   * to the field (owner, 2026-10-26). The admin dashboard and exports keep it.
   */
  omitCoverageWarning?: boolean;
};

/**
 * The batch-coverage read behind the data-gap banner, or null — when the caller hides the banner
 * (the batch query is then never run) or when the read fails (the dashboard must not go down for it).
 */
export function loadSosCoverageFor(
  options: SosDashboardOptions | undefined,
  load: () => Promise<SosCoverageReport> = loadSosCoverageReport,
): Promise<SosCoverageReport | null> {
  if (options?.omitCoverageWarning) return Promise.resolve(null);
  return load().catch(() => null);
}

export async function getSosDashboard(
  filters: SosDashboardFilters,
  accessContext: AccessContext,
  options?: SosDashboardOptions,
): Promise<SosDashboardData> {
  // Confidential products are excluded by default even for CEO/Super Admin — revealing them
  // requires an explicit per-request opt-in (the UI toggle), re-validated here against the
  // caller's role so a tampered request can never widen visibility past what the role allows.
  const canRevealRestricted = canViewRestrictedProducts(accessContext.role);
  const canSeeRestricted = options?.revealRestrictedProducts === true && canRevealRestricted;
  // Head Office line + its products are confidential — CEO / Super Admin only. Stripped below
  // from rows, filter options and the trend for every other role (incl. company-scope SFE).
  const canSeeHeadOffice = canViewHeadOfficeLine(accessContext.role);

  const [availablePeriods, references, salesScope, coverage, operationalRegions] = await Promise.all([
    listMonthlyClosingPeriods(),
    loadSalesReferenceData({ includeCustomerBricks: false }),
    resolveSalesAccessScope(accessContext),
    // Which months and which distributors actually landed. Nothing in the pipeline noticed that
    // 2026-05 was never uploaded, and every trend line drew straight through the gap. A failure to
    // read coverage must not take the dashboard down — it degrades to "no gaps reported". The
    // employee portal never shows the banner, so it never runs the read either.
    loadSosCoverageFor(options),
    // The organogram's area -> DM-territory map, for every line and every month this page can show.
    // Fails soft to an unavailable resolver: the dashboard then groups geographically exactly as it
    // did before, which is wrong-but-unchanged rather than blank. See loadOperationalRegionResolver.
    loadOperationalRegionResolver(),
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
  // The viewer's own geography bound: a District / Regional Manager's areas come from the organogram
  // seat map (which can legitimately place an area outside their region label), everyone else keeps
  // the region-name bound. `regionCodes` is then only wide enough to FETCH those areas' rows; the
  // `areaCodes` filter in keepExec below is what stops that widening from leaking a sibling
  // manager's areas in the same region. See src/lib/sales/seat-area-scope.ts.
  const geographyBound = resolveSalesGeographyBound(salesScope, (names) =>
    new Set(
      references.regions
        .filter((r) => names.has(canonicalizeRegionName(r.regionName)))
        .map((r) => r.regionCode.toUpperCase()),
    ),
  );
  const scopeRegionCodes: Set<string> | null =
    options && "allowedRegionCodes" in options
      ? options.allowedRegionCodes
        ? new Set([...options.allowedRegionCodes].map((code) => code.trim().toUpperCase()))
        : null
      : geographyBound.regionCodes;
  const scopeAreaCodes: Set<string> | null =
    options && "allowedAreaCodes" in options
      ? options.allowedAreaCodes
        ? new Set([...options.allowedAreaCodes].map((code) => code.trim().toUpperCase()))
        : null
      : geographyBound.areaCodes;
  // Product lockdown (server-resolved): null/undefined = no restriction; empty Set = show
  // nothing; non-empty = only those codes. A Product Manager with no product list arrives as
  // null — his whole lines (owner, 2026-09-18; resolveWeeklyProductBound) — never as an empty Set.
  const scopeProductCodes: Set<string> | null =
    options?.allowedProductCodes == null
      ? null
      : new Set([...options.allowedProductCodes].map((code) => code.trim().toUpperCase()));

  // Area-merge fold decision. An area merge (Pedia's Fayoum GZ6 + Beni Suef UE9 → one row) is only
  // coherent when the ENTIRE view resolves to that one line: byArea and coverage aggregate ACROSS
  // lines, so folding one line's areas inside a mixed-line view would misgroup the others. Resolve
  // the sole line in force = the user's line filter intersected with the viewer's scope (null on a
  // side means "all" from that side, mirroring `intersect` used for the trend below). Both Pedia
  // halves share one DM seat and one operational region (verified in au_v_line_area_map), so this
  // fold is display-only — every viewer who can see GZ6 already sees UE9; it never changes scope.
  const foldSoleLine = ((): string | null => {
    const user = filters.lines?.length ? filters.lines : filters.line ? [filters.line] : null;
    const scope = scopeLineKeys ? [...(salesScope.allowedLineNames ?? [])] : null;
    let effective: string[];
    if (user && scope) {
      const scopeKeys = new Set(scope.map(normalizeLineKey));
      effective = user.filter((name) => scopeKeys.has(normalizeLineKey(name)));
    } else if (user) {
      effective = user;
    } else if (scope) {
      effective = scope;
    } else {
      return null;
    }
    return effective.length === 1 ? effective[0] : null;
  })();
  const foldLineCode = foldSoleLine && hasClosingAreaMerges(foldSoleLine) ? foldSoleLine : null;

  // Label + master maps.
  const regionLabel = new Map<string, string>();
  references.regions.forEach((r) => regionLabel.set(r.regionCode, r.regionName || r.regionCode));
  const areaLabel = new Map<string, string>();
  const areaRegion = new Map<string, string>();
  (references.areas ?? []).forEach((a) => {
    areaLabel.set(a.areaCode, a.areaName || a.areaCode);
    areaRegion.set(a.areaCode, a.regionCode);
  });
  // On a folded single-Pedia view, the surviving area (GZ6) shows its combined name; UE9's detail
  // rows re-key onto GZ6 after keepExec, so they read this same label. Only Pedia has a rule.
  if (foldLineCode) {
    for (const a of references.areas ?? []) {
      const merged = getMergedAreaName(foldLineCode, a.areaCode);
      if (merged) areaLabel.set(a.areaCode, merged);
    }
  }
  // UE-1 and UE-2 exist ONLY in the organogram — `source_of_sales_areas` has no such region codes,
  // so `regionLabel` alone would render them as bare codes on the very screen that introduces them.
  const regionDisplayLabel = (code: string): string =>
    regionLabel.get(code) ?? operationalRegions.regionName(code) ?? code;
  /** Every official line label present in the product master — the set `forLinePeriod` is asked about. */
  const officialLines = [...new Set(references.products.map((p) => norm(p.line)).filter(Boolean))];
  /** Upper-cased area -> geographic region. The organogram's own keys are upper-cased; these are not. */
  const geographicRegionByArea = new Map<string, string>();
  (references.areas ?? []).forEach((a) => {
    if (a.areaCode) geographicRegionByArea.set(a.areaCode.toUpperCase(), (a.regionCode ?? "").toUpperCase());
  });

  // Keyed on the canonical code so both Direct vintages resolve to one name. The Direct entry is
  // named here rather than read from the distributors master: the retired DIRECT row is active=false
  // so loadSalesReferenceData never returns it, which rendered every pre-2026-08 direct row as the
  // raw code "DIRECT" beside DirectReq's "Direct Order Requests" — one channel under two names.
  const distributorLabel = new Map<string, string>();
  references.distributors.forEach((d) => distributorLabel.set(canonicalDistributorKey(d.code), d.name || d.code));
  distributorLabel.set(DIRECT_CHANNEL_CODE, DIRECT_CHANNEL_LABEL);
  const labelForDistributor = (code: string): string =>
    distributorLabel.get(canonicalDistributorKey(code)) ?? norm(code);
  const brickLabel = new Map<string, string>();
  (references.bricks ?? []).forEach((b) => brickLabel.set(b.brickId, b.brickName || b.brickId));
  const productLabel = new Map<string, string>();
  const productLine = new Map<string, string>();
  references.products.forEach((p) => {
    productLabel.set(p.productCode, p.productName || p.productCode);
    productLine.set(p.productCode, p.line);
  });
  // Coverage denominator is scoped to the viewer: a region-locked caller (DSM / RM) measures
  // coverage against THEIR regions' areas, not the whole company — otherwise "3 / 120 areas"
  // reads as poor coverage when they only own a handful. Company / line-only callers keep all areas.
  const masterAreasScoped = (references.areas ?? [])
    .filter((a) => a.areaCode)
    // A seat-scoped viewer measures coverage against exactly THEIR areas; otherwise fall back to
    // every area in their regions. Using the region set alone for a seat-scoped viewer would inflate
    // the denominator with sibling managers' areas in a shared region.
    .filter((a) =>
      scopeAreaCodes
        ? scopeAreaCodes.has(a.areaCode.toUpperCase())
        : !scopeRegionCodes || scopeRegionCodes.has((a.regionCode ?? "").toUpperCase()),
    );
  // Fold the coverage denominator too, or "areas reached / total areas" would divide a folded
  // numerator (one GZ6) by an unfolded denominator (GZ6 + UE9) and UE9 would show as permanent
  // white space. foldAreaOptionsForLine drops UE9 and renames GZ6; a no-rule line is unchanged.
  const masterAreas = foldLineCode ? foldAreaOptionsForLine(foldLineCode, masterAreasScoped) : masterAreasScoped;
  const totalAreas = masterAreas.length;
  // Brick coverage needs a MASTER denominator, scoped exactly like masterAreas above. It used to be
  // `new Set(brickRows.map(r => r.brickId)).size` — the very same expression as the numerator — so
  // "bricks reached / total bricks" was mathematically always 100% and the KPI could never show a
  // gap: only bricks that HAD sales were ever counted as bricks that exist.
  const masterBricks = (references.bricks ?? []).filter((b) => {
    if (!b.brickId) return false;
    if (scopeAreaCodes) return scopeAreaCodes.has((b.areaCode ?? "").toUpperCase());
    return !scopeRegionCodes || scopeRegionCodes.has((b.regionCode ?? "").toUpperCase());
  });
  const totalBricks = masterBricks.length;

  // Multi-month selection: the dashboard sums leaf rows across every selected month. `periods`
  // (multi) takes precedence over the legacy single `period`; when neither is supplied it defaults
  // to the latest available month. Ordered newest-first and capped so a broad selection stays
  // bounded. `selectedPeriod` (the newest in scope) remains the anchor for the trend + single-month
  // month-over-month comparison.
  const availableSet = new Set(availablePeriods);
  const requestedPeriods = (filters.periods ?? []).filter((p) => availableSet.has(p));
  const legacySingle = filters.period && availableSet.has(filters.period) ? [filters.period] : [];
  const selectedPeriods = [...new Set(requestedPeriods.length > 0 ? requestedPeriods : legacySingle)]
    .sort((left, right) => right.localeCompare(left))
    .slice(0, MAX_SELECTED_PERIODS);
  // The default is the latest month that has STARTED, never the newest uploaded one: a Direct order
  // collecting next month books into a future period, and defaulting there showed a near-empty page.
  const defaultPeriod = latestNonFuturePeriod(availablePeriods) ?? availablePeriods[0];
  if (selectedPeriods.length === 0 && defaultPeriod) selectedPeriods.push(defaultPeriod);
  const selectedPeriodSet = new Set(selectedPeriods);
  const selectedPeriod = selectedPeriods[0] ?? null;
  const isSingleMonth = selectedPeriods.length === 1;

  // Filter option lists (stable, from masters — products stripped of confidential codes for non-CEO).
  const filterOptions: SosFilterOptions = {
    periods: availablePeriods,
    lines: [...new Set(references.products.map((p) => norm(p.line)).filter(Boolean))]
      .filter((line) => line.toUpperCase() !== "IGNORE")
      .filter((line) => canSeeHeadOffice || !isHeadOfficeLine(line))
      .sort(),
    // One Direct option standing for both vintages. The master carries DirectReq active and the
    // retired DIRECT inactive, so an unfolded list offered "Direct Order Requests" (2026-08 on) and
    // no way at all to pick the uploaded months; the selection is widened back to both codes by
    // expandDirectChannelFilter before it reaches the RPCs.
    distributors: [
      ...references.distributors
        .filter((d) => !isDirectChannelCode(d.code))
        .map((d) => ({ code: d.code, label: d.name || d.code })),
      { code: DIRECT_CHANNEL_CODE, label: DIRECT_CHANNEL_LABEL },
    ],
    // Regions the viewer can PICK are the ones the board can SHOW, so this list is the organogram's
    // as well as geography's. Without the union, Anti Infective's UE-1 / UE-2 subtotals would be
    // rendered on the board with no way to filter to either of them, and picking "Upper Egypt"
    // would select a region that line no longer has. Resolved at the selected month, never today —
    // a forward-dated territory move must not add its region to a month it was dated to spare.
    regions: buildRegionOptions(references.regions, operationalRegions, officialLines, selectedPeriod),
    areas: (foldLineCode ? foldAreaOptionsForLine(foldLineCode, references.areas ?? []) : references.areas ?? [])
      .map((a) => ({ code: a.areaCode, label: a.areaName || a.areaCode, region: a.regionCode })),
    products: references.products
      .filter((p) => p.productCode.toUpperCase() !== "IGNORE")
      .filter((p) => canSeeRestricted || !RESTRICTED_SET.has(p.productCode.toUpperCase()))
      .filter((p) => canSeeHeadOffice || !isHeadOfficeLine(p.line))
      .map((p) => ({ code: p.productCode, label: p.productName || p.productCode, line: p.line })),
  };

  if (!selectedPeriod) {
    return emptyDashboard(filterOptions, totalAreas, totalBricks, canSeeRestricted);
  }

  // Trend window = the most-recent N months, always including every selected period (so a selection
  // reaching outside the recent window still charts its own points).
  const trendBase = availablePeriods.filter((p) => !isFuturePeriod(p));
  const windowPeriods = [...new Set([...trendBase.slice(0, TREND_WINDOW), ...selectedPeriods])].sort();

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
  const userAreaCodes = filters.areas?.length ? filters.areas.map((c) => c.toUpperCase()) : null;

  const scopeLineNamesArr = scopeLineKeys ? (salesScope.allowedLineNames ? [...salesScope.allowedLineNames] : []) : null;
  const scopeRegionArr = scopeRegionCodes ? [...scopeRegionCodes] : null;
  const scopeProductArr = scopeProductCodes ? [...scopeProductCodes] : null;
  const scopeAreaArr = scopeAreaCodes ? [...scopeAreaCodes] : null;

  const trendLineNames = intersect(userLineNames, scopeLineNamesArr);
  // Every month whose rows this request can fetch — the trend window, plus the year-ago anchor,
  // plus the live structure. The widening below is a FETCH widener, so being generous here can only
  // over-fetch (keepExec re-applies the exact per-row, per-month operational test); being stingy
  // would silently drop rows, which is the failure that reads as "you sold nothing".
  const widenPeriods: Array<string | null> = [
    ...windowPeriods,
    selectedPeriod ? shiftPeriod(selectedPeriod, 12) : null,
    null,
  ];
  const trendRegionCodes = intersect(
    userRegionCodes
      ? widenRegionsToGeography(userRegionCodes, operationalRegions, officialLines, widenPeriods, geographicRegionByArea)
      : null,
    scopeRegionArr,
  );
  const trendProductCodes = intersect(userProductCodes, scopeProductArr);
  // The AREA push-down carries the seat bound into SQL. This matters beyond latency: the 6-month
  // trend RPC has no area dimension of its own, so without it a seat-scoped viewer whose region set
  // was widened to reach an out-of-region area would see that whole foreign region in the trend line
  // (and the trend would disagree with the area-filtered detail total below).
  const trendAreaCodes = intersect(userAreaCodes, scopeAreaArr);

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
    (trendAreaCodes !== null && trendAreaCodes.length === 0) ||
    (trendProductCodes !== null && trendProductCodes.length === 0);

  // Month-over-month / year-over-year anchor months. Only meaningful for a SINGLE selected month —
  // comparing a multi-month total against one prior month would mislead — so both are suppressed for
  // a multi-month selection (mirrors the weekly dashboard's prior-week rule). Computed here so they
  // feed both the cache key and the fetch below.
  const priorPeriod =
    options?.includeMomComparison && isSingleMonth ? resolvePriorPeriod(availablePeriods, selectedPeriod) : null;
  const yoyPeriodCandidate = options?.includeYoY && isSingleMonth ? shiftPeriod(selectedPeriod, 12) : null;
  const yoyPeriod = yoyPeriodCandidate && availableSet.has(yoyPeriodCandidate) ? yoyPeriodCandidate : null;

  // Brick + customer aggregates carry no LINE dimension, so they are only ever shown to company-scope
  // callers. Skip those two heavy RPCs entirely for every scoped (portal) caller — their results
  // would be discarded by keepExec anyway, so this is a pure latency win with no behavior change.
  const canSeeCrossLineGeography = salesScope.canViewAllSales;

  // Heavy phx_exec_* fan-out, cached (300s, tag "sos-dashboard"). The key is the fully scope-resolved
  // input set below (scope ∩ user filters, exclude sets, geo gate) — arrays are sorted so the same
  // logical query always maps to the same cache entry. Two callers share an entry ONLY when entitled
  // to identical rows; keepExec below stays the authoritative per-request authorization backstop.
  const { detailRows, trendRowsRaw, brickRaw, customerRaw, priorDetailRaw, yoyDetailRaw, failedRpcs } =
    await fetchSosDashboardRpcRows({
      windowPeriods,
      selectedPeriods: [...selectedPeriods].sort(),
      priorPeriod,
      yoyPeriod,
      trendLineNames: sortedOrNull(trendLineNames),
      trendRegionCodes: sortedOrNull(trendRegionCodes),
      trendProductCodes: sortedOrNull(trendProductCodes),
      // scope ∩ user selection (null ⇒ no restriction ⇒ [] = "all" to the RPCs).
      // Expand a folded pick (GZ6) back to its real codes ({GZ6, UE9}) so the RPC pulls Beni Suef's
      // rows too — they are re-keyed onto GZ6 for display after keepExec. Both are already in scope.
      filterAreas: [
        ...(foldLineCode && trendAreaCodes ? expandAreaCodesForLine(foldLineCode, trendAreaCodes) : trendAreaCodes ?? []),
      ].sort(),
      // Picking the Direct channel must reach both codes: the RPCs match the stored code, so an
      // unexpanded selection silently drops one side of the 2026-07/08 cutover.
      filterDistributors: expandDirectChannelFilter(filters.distributors).sort(),
      excludeCodes: [...excludeCodes].sort(),
      trendExcludeCodes: [...trendExcludeCodes].sort(),
      trendForcedEmpty,
      canSeeCrossLineGeography,
    });

  // Shared leaf-row filter (line / distributor / region / area / product + restricted stripping).
  const distSet = toFilterSet(expandDirectChannelFilter(filters.distributors));
  const regionSet = toFilterSet(filters.regions);
  // On a folded single-Pedia view the picker emits only GZ6; expand it back to {GZ6, UE9} so a
  // filter on the merged area keeps Beni Suef's rows through keepExec (they authorize on the real
  // area code, then re-key onto GZ6 for display below).
  const areaSet = toFilterSet(
    foldLineCode && filters.areas?.length ? expandAreaCodesForLine(foldLineCode, filters.areas) : filters.areas,
  );
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
    if (!rowIsInRegionScope(scopeRegionCodes, row)) return false;
    // Area lockdown — the tight half of a seat-derived geography bound. Rows with no area (the
    // "DIRECT" national placeholder) are left to the region check above, exactly as before.
    if (scopeAreaCodes && row.areaCode && !scopeAreaCodes.has(row.areaCode.toUpperCase())) return false;
    if (scopeProductCodes && !scopeProductCodes.has(row.productCode.toUpperCase())) return false;
    if (lineFilterSet) {
      if (!lineFilterSet.has(row.officialLine.toLowerCase())) return false;
    } else if (lineFilter && row.officialLine.toLowerCase() !== lineFilter) return false;
    if (distSet && !distSet.has(row.distributorCode.toUpperCase())) return false;
    // The USER's region filter matches what the board SHOWS — the organogram region. The access
    // check above deliberately stays on the geographic code: that is the dimension the RPC
    // push-down filters on, and swapping it would empty a scoped manager's board rather than
    // scope it. Two different questions, two different columns; see ExecRow.
    if (!rowMatchesRegionFilter(regionSet, row)) return false;
    if (areaSet && !areaSet.has(row.areaCode.toUpperCase())) return false;
    if (productSet && !productSet.has(row.productCode.toUpperCase())) return false;
    return true;
  };

  const mapExecRow = (row: Record<string, unknown>): ExecRow => {
    const officialLine = norm(row.official_line as string);
    const regionCode = norm(row.region_code as string);
    const areaCode = norm(row.area_code as string);
    const period = norm(row.__period as string);
    return {
      distributorCode: norm(row.distributor_code as string),
      officialLine,
      regionCode,
      // Resolved at the row's OWN month. The prior-period and year-ago fetches carry different
      // months, and a territory move between them is exactly the case that must not be flattened.
      operationalRegionCode: operationalRegionFor(operationalRegions, officialLine, areaCode, period, regionCode),
      areaCode,
      productCode: norm(row.product_code as string),
      productName: norm(row.product_name as string),
      units: Number(row.units ?? 0),
      value: Number(row.value ?? 0),
      period,
    };
  };

  // Re-key a merged area onto its surviving code (UE9 → GZ6 on Pedia), or return it unchanged for a
  // non-merge code and every non-fold view. Byte-for-byte identity for anything without a rule.
  const foldAreaForDisplay = (code: string): string => {
    if (!foldLineCode) return code;
    const folded = foldAreaCodeForLine(foldLineCode, code);
    return folded === code.toUpperCase() ? code : folded;
  };
  // Apply that AFTER keepExec, so authorization always runs on the real geography (UE9 stays UE9
  // through the scope/area checks) while every downstream breakdown groups the folded area as one
  // row. Only Pedia has a rule, and only on a single-Pedia view.
  //
  // The fold re-keys the AREA and deliberately leaves `operationalRegionCode` alone, which is only
  // coherent because the two merged areas share an organogram region on the line that merges them:
  // on pedia both GZ6 and UE9 resolve to GZ (measured on production 2026-08-31). They do NOT agree
  // on anti_infective — GZ6 is GZ while UE9 is UE-1 — but that line has no merge rule, so the fold
  // never runs there. If a merge rule is ever added for a line whose merged areas sit in different
  // organogram regions, one displayed area would split across two regions on the board, and the
  // fold would have to re-resolve the region for the surviving code as well.
  const foldExecRowArea = (row: ExecRow): ExecRow => {
    const folded = foldAreaForDisplay(row.areaCode);
    return folded === row.areaCode ? row : { ...row, areaCode: folded };
  };

  // Detail = the union of leaf rows across every selected month (each already tagged with its period).
  const detail = (detailRows as Array<Record<string, unknown>>).map(mapExecRow).filter(keepExec).map(foldExecRowArea);
  // Prior-period leaf rows for the MoM layer — same mapping, same keepExec (period-agnostic).
  const priorDetail = (priorDetailRaw as Array<Record<string, unknown>>).map(mapExecRow).filter(keepExec).map(foldExecRowArea);
  // Same-month-last-year leaf rows for the YoY layer — same mapping, same keepExec.
  const yoyDetail = (yoyDetailRaw as Array<Record<string, unknown>>).map(mapExecRow).filter(keepExec).map(foldExecRowArea);

  const totalValue = detail.reduce((sum, row) => sum + row.value, 0);
  const totalUnits = detail.reduce((sum, row) => sum + row.units, 0);

  // Trend across the window: lightweight per-period totals from phx_exec_sos_trend (filter-aware,
  // restricted-stripped in SQL). Every SELECTED month reuses its own detail total so each selected
  // point matches the KPIs exactly (their sum is the headline total). Non-selected points come from
  // the trend RPC. Non-fatal: a trend failure never blocks the dashboard.
  const detailTotalsByPeriod = new Map<string, { units: number; value: number }>();
  for (const row of detail) {
    const current = detailTotalsByPeriod.get(row.period) ?? { units: 0, value: 0 };
    current.units += row.units;
    current.value += row.value;
    detailTotalsByPeriod.set(row.period, current);
  }
  const trendByPeriod = new Map<string, { units: number; value: number }>();
  const trendRows = trendRowsRaw as Array<Record<string, unknown>>;
  for (const row of trendRows) {
    trendByPeriod.set(String(row.period ?? ""), { units: Number(row.units ?? 0), value: Number(row.value ?? 0) });
  }
  const trend: SosTrendPoint[] = windowPeriods.map((period) =>
    selectedPeriodSet.has(period)
      ? { period, units: detailTotalsByPeriod.get(period)?.units ?? 0, value: detailTotalsByPeriod.get(period)?.value ?? 0 }
      : { period, units: trendByPeriod.get(period)?.units ?? 0, value: trendByPeriod.get(period)?.value ?? 0 },
  );
  const directValue = detail.filter((row) => isDirect(row.distributorCode)).reduce((sum, row) => sum + row.value, 0);
  const distributorValue = totalValue - directValue;

  // Generic grouper. `total` is passed explicitly so the same helper can compute shares for the
  // selected period (totalValue) and the prior period (its own total) without ambiguity.
  const group = (
    rows: ExecRow[],
    keyOf: (row: ExecRow) => string,
    labelOf: (code: string, row: ExecRow) => string,
    lineOf: (code: string, row: ExecRow) => string | null,
    total: number,
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
      .map(([code, v]) => ({ code, label: v.label, line: v.line, value: v.value, units: v.units, share: share(v.value, total) }))
      .sort((a, b) => b.value - a.value);
  };

  // Regional subtotals follow the ORGANOGRAM, the same rule the Monthly Closing publishes and the
  // same rule the owner ruled on for CNS and Pedia on 2026-08-07. Until this changed, these two
  // executive surfaces split the same line and month differently and neither said which rule it
  // used — the grand totals matched, so the disagreement was invisible.
  const groupByRegion = (rows: ExecRow[], total: number) =>
    group(rows, (row) => row.operationalRegionCode, (code) => regionDisplayLabel(code), () => null, total);
  const groupByArea = (rows: ExecRow[], total: number) =>
    group(
      rows,
      (row) => row.areaCode,
      (code) => (code === "DIRECT" ? "Direct (National)" : areaLabel.get(code) ?? code),
      (code) => regionLabel.get(areaRegion.get(code) ?? "") ?? null,
      total,
    );
  const groupByProduct = (rows: ExecRow[], total: number) =>
    group(
      rows,
      (row) => row.productCode,
      (code, row) => productLabel.get(code) ?? row.productName ?? code,
      (code, row) => productLine.get(code) ?? row.officialLine ?? null,
      total,
    );

  const byRegion = groupByRegion(detail, totalValue);
  const byArea = groupByArea(detail, totalValue);
  const byProduct = groupByProduct(detail, totalValue);
  const byLine = group(
    detail,
    (row) => row.officialLine,
    (code) => code,
    (code) => code,
    totalValue,
  );

  // Distributors carry reach counts (distinct regions / real areas / products).
  // Keyed on the canonical code so the two Direct vintages are ONE row: a window covering the
  // 2026-07/08 cutover otherwise reports DIRECT and DirectReq side by side, which reads as one
  // source that died and another that appeared — and makes the same split in distributorCount and
  // in every MoM/YoY mover table below.
  const distAccum = new Map<string, { value: number; units: number; regions: Set<string>; areas: Set<string>; products: Set<string> }>();
  for (const row of detail) {
    const code = foldDirectDistributorCode(row.distributorCode);
    if (!code) continue;
    const current = distAccum.get(code) ?? { value: 0, units: 0, regions: new Set(), areas: new Set(), products: new Set() };
    current.value += row.value;
    current.units += row.units;
    // Counted on the same basis the board's regional split uses, so "covers 5 regions" and the
    // five rows above it are the same five.
    if (row.operationalRegionCode) current.regions.add(row.operationalRegionCode);
    if (row.areaCode && row.areaCode !== "DIRECT") current.areas.add(row.areaCode);
    if (row.productCode) current.products.add(row.productCode);
    distAccum.set(code, current);
  }
  const byDistributor: SosDistributorRow[] = [...distAccum.entries()]
    .map(([code, v]) => ({
      code,
      label: labelForDistributor(code),
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
      if (!areaMatchesRegionFilter(regionSet, operationalRegions, officialLines, selectedPeriod, row.regionCode, row.areaCode))
        return false;
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
  const allBrickRows: SosGroupRow[] = [...brickAccum.entries()]
    .map(([code, v]) => ({ code, label: brickLabel.get(code) ?? code, line: null, value: v.value, units: v.units, share: share(v.value, brickTotalValue) }));
  const topBricks: SosGroupRow[] = [...allBrickRows].sort((a, b) => b.value - a.value).slice(0, 12);
  const bottomBricks: SosGroupRow[] = [...allBrickRows].sort((a, b) => a.value - b.value).slice(0, 12).reverse();

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
      if (!areaMatchesRegionFilter(regionSet, operationalRegions, officialLines, selectedPeriod, row.regionCode, row.areaCode))
        return false;
      if (areaSet && !areaSet.has(row.areaCode.toUpperCase())) return false;
      return true;
    });
  const aggregatedCustomers = aggregateCustomerRows(customerRows);
  const customerTotalValue = customerRows.reduce((sum, row) => sum + row.value, 0);
  const sortedCustomers = [...aggregatedCustomers].sort((a, b) => b.value - a.value);
  const topCustomers: SosCustomerRow[] = sortedCustomers.slice(0, 15).map((row) => ({
    code: row.clientCode,
    name: row.clientName || row.clientCode,
    distributor: labelForDistributor(row.distributorCode),
    region: regionLabel.get(row.regionCode) ?? row.regionCode,
    area: row.areaCode === "DIRECT" ? "Direct" : areaLabel.get(foldAreaForDisplay(row.areaCode)) ?? row.areaCode,
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
    customerCount: aggregatedCustomers.length,
    directValue,
    distributorValue,
    directShare: share(directValue, totalValue),
    areasReached: soldAreaCodes.size,
    totalAreas,
    bricksReached: soldBrickIds.size,
    totalBricks,
  };

  const channelMix = [
    { name: "Distributors", value: distributorValue },
    { name: "Direct (Company)", value: directValue },
  ].filter((slice) => slice.value > 0);

  // ── Month-over-month layer (admin dashboard + BI export only) ────────────────────────────
  // Pure presentation math over the two keepExec-filtered leaf sets — no new value semantics.
  let momComparison: SosMomComparison | null | undefined = undefined;
  let paretoProducts: SosParetoRow[] | undefined = undefined;
  if (options?.includeMomComparison) {
    paretoProducts = computePareto(byProduct);
    if (!priorPeriod) {
      momComparison = null;
    } else {
      const priorTotalValue = priorDetail.reduce((sum, row) => sum + row.value, 0);
      const priorTotalUnits = priorDetail.reduce((sum, row) => sum + row.units, 0);
      const priorByProduct = groupByProduct(priorDetail, priorTotalValue);
      const priorByRegion = groupByRegion(priorDetail, priorTotalValue);
      const priorByArea = groupByArea(priorDetail, priorTotalValue);
      const priorByDistributor = group(
        priorDetail,
        (row) => foldDirectDistributorCode(row.distributorCode),
        (code) => labelForDistributor(code),
        () => null,
        priorTotalValue,
      );
      const priorDirectValue = priorDetail
        .filter((row) => isDirect(row.distributorCode))
        .reduce((sum, row) => sum + row.value, 0);
      const priorAreasReached = new Set(
        priorDetail.map((row) => row.areaCode).filter((code) => code && code !== "DIRECT"),
      ).size;
      const priorDistributorCount = new Set(
        priorDetail.map((row) => foldDirectDistributorCode(row.distributorCode)).filter(Boolean),
      ).size;
      const priorProductCount = new Set(priorDetail.map((row) => row.productCode).filter(Boolean)).size;
      const isRealArea = (row: { code: string }) => row.code !== "DIRECT";
      const newLostProducts = computeNewAndLost(byProduct, priorByProduct);
      const newLostAreas = computeNewAndLost(byArea.filter(isRealArea), priorByArea.filter(isRealArea));
      momComparison = {
        priorPeriod,
        summaryDeltas: {
          totalValue: computeDelta(totalValue, priorTotalValue),
          totalUnits: computeDelta(totalUnits, priorTotalUnits),
          avgPricePerUnit: computeDelta(
            summary.avgPricePerUnit,
            priorTotalUnits > 0 ? priorTotalValue / priorTotalUnits : 0,
          ),
          distributorCount: computeDelta(summary.distributorCount, priorDistributorCount),
          productCount: computeDelta(summary.productCount, priorProductCount),
          directShare: computeDelta(summary.directShare, share(priorDirectValue, priorTotalValue)),
          areasReached: computeDelta(summary.areasReached, priorAreasReached),
        },
        movers: {
          products: computeMovers(byProduct, priorByProduct),
          regions: computeMovers(byRegion, priorByRegion),
          distributors: computeMovers(byDistributor, priorByDistributor),
        },
        // Full per-code deltas (all rows, not just the top-5 movers) so the tables show every row's %.
        deltaPctByCode: {
          products: computeDeltaPctByCode(byProduct, priorByProduct),
          regions: computeDeltaPctByCode(byRegion, priorByRegion),
          distributors: computeDeltaPctByCode(byDistributor, priorByDistributor),
        },
        contribution: {
          products: computeContribution(byProduct, priorByProduct),
          regions: computeContribution(byRegion, priorByRegion),
        },
        newProducts: newLostProducts.added,
        lostProducts: newLostProducts.removed,
        newAreas: newLostAreas.added,
        lostAreas: newLostAreas.removed,
      };
    }
  }

  // ── Year-over-year layer (admin dashboard + BI export only) ──────────────────────────────
  // Structurally identical to the MoM block above — same pure presentation math, just comparing
  // against the same month last year (yoyDetail/yoyPeriod) instead of the prior month.
  let yoyComparison: SosMomComparison | null | undefined = undefined;
  if (options?.includeYoY) {
    if (!yoyPeriod) {
      yoyComparison = null;
    } else {
      const yoyTotalValue = yoyDetail.reduce((sum, row) => sum + row.value, 0);
      const yoyTotalUnits = yoyDetail.reduce((sum, row) => sum + row.units, 0);
      const yoyByProduct = groupByProduct(yoyDetail, yoyTotalValue);
      const yoyByRegion = groupByRegion(yoyDetail, yoyTotalValue);
      const yoyByArea = groupByArea(yoyDetail, yoyTotalValue);
      const yoyByDistributor = group(
        yoyDetail,
        (row) => foldDirectDistributorCode(row.distributorCode),
        (code) => labelForDistributor(code),
        () => null,
        yoyTotalValue,
      );
      const yoyDirectValue = yoyDetail
        .filter((row) => isDirect(row.distributorCode))
        .reduce((sum, row) => sum + row.value, 0);
      const yoyAreasReached = new Set(
        yoyDetail.map((row) => row.areaCode).filter((code) => code && code !== "DIRECT"),
      ).size;
      const yoyDistributorCount = new Set(
        yoyDetail.map((row) => foldDirectDistributorCode(row.distributorCode)).filter(Boolean),
      ).size;
      const yoyProductCount = new Set(yoyDetail.map((row) => row.productCode).filter(Boolean)).size;
      const isRealArea = (row: { code: string }) => row.code !== "DIRECT";
      const newLostProductsYoy = computeNewAndLost(byProduct, yoyByProduct);
      const newLostAreasYoy = computeNewAndLost(byArea.filter(isRealArea), yoyByArea.filter(isRealArea));
      yoyComparison = {
        priorPeriod: yoyPeriod,
        summaryDeltas: {
          totalValue: computeDelta(totalValue, yoyTotalValue),
          totalUnits: computeDelta(totalUnits, yoyTotalUnits),
          avgPricePerUnit: computeDelta(
            summary.avgPricePerUnit,
            yoyTotalUnits > 0 ? yoyTotalValue / yoyTotalUnits : 0,
          ),
          distributorCount: computeDelta(summary.distributorCount, yoyDistributorCount),
          productCount: computeDelta(summary.productCount, yoyProductCount),
          directShare: computeDelta(summary.directShare, share(yoyDirectValue, yoyTotalValue)),
          areasReached: computeDelta(summary.areasReached, yoyAreasReached),
        },
        movers: {
          products: computeMovers(byProduct, yoyByProduct),
          regions: computeMovers(byRegion, yoyByRegion),
          distributors: computeMovers(byDistributor, yoyByDistributor),
        },
        // Full per-code deltas (all rows, not just the top-5 movers) so the tables show every row's %.
        deltaPctByCode: {
          products: computeDeltaPctByCode(byProduct, yoyByProduct),
          regions: computeDeltaPctByCode(byRegion, yoyByRegion),
          distributors: computeDeltaPctByCode(byDistributor, yoyByDistributor),
        },
        contribution: {
          products: computeContribution(byProduct, yoyByProduct),
          regions: computeContribution(byRegion, yoyByRegion),
        },
        newProducts: newLostProductsYoy.added,
        lostProducts: newLostProductsYoy.removed,
        newAreas: newLostAreasYoy.added,
        lostAreas: newLostAreasYoy.removed,
      };
    }
  }

  // Leaf rows for the BI export's hidden Data sheet — the exact rows behind every on-screen
  // aggregate (already scoped + confidential-stripped by keepExec), labeled via the masters.
  const detailLeafRows: SosDetailLeafRow[] | undefined = options?.includeDetailRows
    ? detail.map((row) => ({
        period: row.period,
        distributorCode: row.distributorCode,
        distributorName: labelForDistributor(row.distributorCode),
        officialLine: row.officialLine,
        // The BI workbook's region tree is built off these two, so they carry the SAME organogram
        // rule the board and the Monthly Closing use. Publishing used to mail the CEO a geographic
        // split of a month he was reading the organogram split of, with matching grand totals.
        regionCode: row.operationalRegionCode,
        regionName: regionDisplayLabel(row.operationalRegionCode),
        sourceRegionCode: row.regionCode,
        sourceRegionName: regionDisplayLabel(row.regionCode),
        areaCode: row.areaCode,
        areaName: row.areaCode === "DIRECT" ? "Direct (National)" : areaLabel.get(row.areaCode) ?? row.areaCode,
        productCode: row.productCode,
        productName: productLabel.get(row.productCode) ?? row.productName ?? row.productCode,
        channel: isDirect(row.distributorCode) ? ("Direct" as const) : ("Distributor" as const),
        units: row.units,
        value: row.value,
      }))
    : undefined;

  return {
    period: selectedPeriod,
    selectedPeriods,
    availablePeriods,
    filters: filterOptions,
    incompleteReason: failedRpcs,
    summary,
    trend,
    channelMix,
    byDistributor,
    byRegion,
    byArea,
    byProduct,
    byLine,
    topBricks,
    bottomBricks,
    topCustomers,
    customerTop10Share,
    whiteSpaceAreas,
    insights: buildInsights({
      // 🔴 MASKED HERE, BEFORE THE SENTENCE IS WRITTEN. The coverage banner names the costliest gap
      // by estimated value, and `maskPortalSosDashboard` cannot reach it — it masks four structural
      // fields, while this is free text inside `insights`. El Qema is the costliest remaining gap on
      // Pedia, so without this the dashboard would name it to every role holding `sales:read`.
      coverage: coverage ? maskSosCoverageReport(coverage, accessContext) : coverage,
      // Same array that fills `incompleteReason` above. It is surfaced here because that field is
      // read by no component, so a failed aggregate had no way to reach the screen.
      incompleteReason: failedRpcs,
      byDistributor,
      byRegion,
      byArea,
      byProduct,
      summary,
      customerTop10Share,
      whiteSpaceAreas,
      // A viewer locked to exactly one region (DSM) gets a useless "top region = 100%" line, so swap
      // it for a "top area" insight. Derived from the engine's own region lockdown so it holds for
      // any caller, not just the portal wrapper.
      singleRegion: scopeRegionCodes !== null && scopeRegionCodes.size === 1,
      mom: momComparison ?? null,
    }),
    momComparison,
    yoyComparison,
    paretoProducts,
    detailRows: detailLeafRows,
    restrictedRevealed: canSeeRestricted,
  };
}

/**
 * Coverage over every validated batch. Ordered by id (uuid) so the offset walk has a total order;
 * period alone is not unique.
 */
async function loadSosCoverageReport(): Promise<SosCoverageReport> {
  const supabase = getSupabaseAdmin();
  const rows = await fetchAllRows<{
    period: string;
    distributor_code: string;
    distributor_name: string | null;
    total_value: number | null;
  }>(
    () =>
      supabase
        .from("source_of_sales_import_batches")
        // The NAME comes along because the banner must say "EPDA-BULK", not "EP-BK" (standing rule:
        // names, never raw codes). It is the name entered on the batch, so a distributor renamed
        // mid-year reads under the name of its latest file.
        .select("period,distributor_code,distributor_name,total_value")
        .eq("status", "validated"),
    "id",
  );
  return buildSosCoverageReport(
    rows.map((row) => ({
      period: String(row.period ?? ""),
      distributorCode: String(row.distributor_code ?? ""),
      distributorName: row.distributor_name,
      totalValue: row.total_value == null ? 0 : Number(row.total_value),
    })),
  );
}

/**
 * Pure: the Insights strip. Exported for tests — the incomplete-read warning must be provable
 * without a database, and it must come FIRST so a partial read is never read as a fall in sales.
 */
export function buildInsights(input: {
  byDistributor: SosDistributorRow[];
  byRegion: SosGroupRow[];
  byArea: SosGroupRow[];
  byProduct: SosGroupRow[];
  summary: SosDashboardData["summary"];
  customerTop10Share: number;
  whiteSpaceAreas: SosWhiteSpaceRow[];
  singleRegion: boolean;
  /** Month-over-month comparison — only supplied by admin/export callers; null/absent for the portal. */
  mom?: SosMomComparison | null;
  /** Batch coverage; null when the lookup failed. */
  coverage?: SosCoverageReport | null;
  /** Aggregates that failed to load. Empty on a healthy read. */
  incompleteReason: string[];
}): SosDashboardData["insights"] {
  const out: SosDashboardData["insights"] = [];
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  // FIRST OF ALL, ahead of even the coverage gap: if an aggregate did not load, the numbers below
  // are not a smaller month, they are a partial read. `incompleteReason` was computed on every load
  // and consumed by NOTHING — no component read it — so a timed-out RPC rendered as clean zeros and
  // a reader had no way to tell "no sales" from "did not load".
  if (input.incompleteReason.length > 0) {
    const failed = input.incompleteReason.join(", ");
    out.push({
      tone: "danger",
      text: `This view is INCOMPLETE — ${input.incompleteReason.length} data source(s) failed to load (${failed}). Every figure below is partial: read it as missing data, never as a fall in sales.`,
    });
  }
  // Then, before any movement commentary: if a month or a distributor never landed, every "up
  // 12% vs last month" below it is partly measuring which files were uploaded.
  const coverageWarning = input.coverage ? describeSosCoverageGaps(input.coverage) : null;
  if (coverageWarning) out.push({ tone: "danger", text: coverageWarning });
  const momValue = input.mom?.summaryDeltas.totalValue;
  if (momValue && momValue.deltaPct != null) {
    out.push({
      tone: momValue.deltaPct >= 0 ? "success" : "danger",
      text: `Total value is ${momValue.deltaPct >= 0 ? "up" : "down"} ${pct(Math.abs(momValue.deltaPct))} vs ${input.mom!.priorPeriod}.`,
    });
  }
  const lead = input.byDistributor[0];
  if (lead) out.push({ tone: "neutral", text: `${lead.label} leads distribution with ${pct(lead.share)} of value across ${lead.regions} region(s).` });
  if (input.singleRegion) {
    // One region only → "top region = 100%" is noise. Surface the strongest area instead
    // (skip the national "Direct" pseudo-area so this stays a real geographic insight).
    const topArea = input.byArea.find((row) => row.code !== "DIRECT");
    if (topArea) out.push({ tone: "neutral", text: `${topArea.label} is the top area at ${pct(topArea.share)} of value.` });
  } else {
    const topRegion = input.byRegion[0];
    if (topRegion) out.push({ tone: "neutral", text: `${topRegion.label} is the top region at ${pct(topRegion.share)} of value.` });
  }
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

function emptyDashboard(filters: SosFilterOptions, totalAreas: number, totalBricks: number, restrictedRevealed: boolean): SosDashboardData {
  return {
    period: null,
    selectedPeriods: [],
    availablePeriods: filters.periods,
    filters,
    restrictedRevealed,
    // A genuinely empty dashboard is complete — it really did load and really has no rows. Only a
    // failed aggregate populates this.
    incompleteReason: [],
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
      // Master denominator even with no sales, so the KPI reads "0 of N" rather than "0 of 0".
      totalBricks,
    },
    trend: [],
    channelMix: [],
    byDistributor: [],
    byRegion: [],
    byArea: [],
    byProduct: [],
    byLine: [],
    topBricks: [],
    bottomBricks: [],
    topCustomers: [],
    customerTop10Share: 0,
    whiteSpaceAreas: [],
    insights: [],
  };
}
