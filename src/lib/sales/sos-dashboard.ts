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
import { shiftPeriod } from "@/lib/sales/periods";
import {
  computeContribution,
  computeDelta,
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
  regionCode: string;
  regionName: string;
  areaCode: string;
  areaName: string;
  productCode: string;
  productName: string;
  channel: "Direct" | "Distributor";
  units: number;
  value: number;
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
  /** The month this leaf row belongs to — tagged at fetch time so the trend can reconcile each
   *  selected month's point to its own detail total. Empty for the prior-period MoM fetch. */
  period: string;
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
};

export async function getSosDashboard(
  filters: SosDashboardFilters,
  accessContext: AccessContext,
  options?: SosDashboardOptions,
): Promise<SosDashboardData> {
  const supabase = getSupabaseAdmin();
  // Confidential products are excluded by default even for CEO/Super Admin — revealing them
  // requires an explicit per-request opt-in (the UI toggle), re-validated here against the
  // caller's role so a tampered request can never widen visibility past what the role allows.
  const canRevealRestricted = canViewRestrictedProducts(accessContext.role);
  const canSeeRestricted = options?.revealRestrictedProducts === true && canRevealRestricted;
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
  const masterAreas = (references.areas ?? [])
    .filter((a) => a.areaCode)
    .filter((a) => !scopeRegionCodes || scopeRegionCodes.has((a.regionCode ?? "").toUpperCase()));
  const totalAreas = masterAreas.length;

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
  if (selectedPeriods.length === 0 && availablePeriods[0]) selectedPeriods.push(availablePeriods[0]);
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
    return emptyDashboard(filterOptions, totalAreas, canSeeRestricted);
  }

  // Trend window = the most-recent N months, always including every selected period (so a selection
  // reaching outside the recent window still charts its own points).
  const windowPeriods = [...new Set([...availablePeriods.slice(0, TREND_WINDOW), ...selectedPeriods])].sort();

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
  // Detail is fetched ONCE PER SELECTED MONTH and concatenated — each call is the same pushed-down,
  // scope-and-filter-narrowed aggregate the single-month path used, so multi-month is just the union
  // of those leaf rows (the downstream grouping already sums them). Each row is tagged with its own
  // period so the trend can reconcile every selected point to its month's exact total. Bounded by
  // MAX_SELECTED_PERIODS, so this is a handful of ~20k-row-rollup reads, not a full-history scan.
  const detailArgsFor = (period: string) => ({
    p_period: period,
    p_lines: trendLineNames ?? [],
    p_distributors: filters.distributors ?? [],
    p_regions: trendRegionCodes ?? [],
    p_areas: filters.areas ?? [],
    p_products: trendProductCodes ?? [],
    p_exclude_codes: excludeCodes,
  });
  const fetchDetail = (periods: string[]) =>
    Promise.all(
      periods.map((period) =>
        rpcAll(supabase, "phx_exec_distributor_product", detailArgsFor(period), [
          "distributor_code",
          "region_code",
          "area_code",
          "product_code",
        ]).then((rows) => rows.map((row) => ({ ...row, __period: period }))),
      ),
    ).then((arrays) => arrays.flat());
  const detailRowsPromise = trendForcedEmpty ? emptyRpcRows : fetchDetail(selectedPeriods);

  // Month-over-month: the next-older validated period, fetched through the SAME pushed-down detail
  // RPC + keepExec backstop as the selected month. Only meaningful when EXACTLY ONE month is in
  // scope — comparing a multi-month total against a single prior month would mislead — so it is
  // suppressed for a multi-month selection (mirrors the weekly dashboard's prior-week rule).
  const priorPeriod =
    options?.includeMomComparison && isSingleMonth ? resolvePriorPeriod(availablePeriods, selectedPeriod) : null;
  const priorDetailRowsPromise =
    !priorPeriod || trendForcedEmpty
      ? emptyRpcRows
      : safeRpcAll("phx_exec_distributor_product (prior period)", () =>
          rpcAll(supabase, "phx_exec_distributor_product", detailArgsFor(priorPeriod), [
            "distributor_code",
            "region_code",
            "area_code",
            "product_code",
          ]),
        );

  // Year-over-year: the same month last year, fetched through the SAME pushed-down detail RPC —
  // structurally identical to the MoM prior-period fetch above, just shifted 12 months instead of
  // 1. Same single-month guard (a multi-month YoY comparison would be as misleading as MoM's).
  const yoyPeriodCandidate = options?.includeYoY && isSingleMonth ? shiftPeriod(selectedPeriod, 12) : null;
  const yoyPeriod = yoyPeriodCandidate && availableSet.has(yoyPeriodCandidate) ? yoyPeriodCandidate : null;
  const yoyDetailRowsPromise =
    !yoyPeriod || trendForcedEmpty
      ? emptyRpcRows
      : safeRpcAll("phx_exec_distributor_product (YoY period)", () =>
          rpcAll(supabase, "phx_exec_distributor_product", detailArgsFor(yoyPeriod), [
            "distributor_code",
            "region_code",
            "area_code",
            "product_code",
          ]),
        );

  // Head-Office confidentiality for the geography aggregates: brick/customer rows carry no
  // product/line dimension, so the Head-Office contribution can only be stripped INSIDE the RPC
  // (LA003/LA004/SS001 are already hard-excluded in the SQL bodies since 20260702130000). Pass
  // the same dynamic exclusion set the trend uses — but ONLY when non-empty, so CEO/Super-Admin
  // calls stay single-arg (byte-identical, and still valid against a pre-migration database).
  // For a restricted viewer against a pre-migration database the RPC rejects the unknown
  // parameter and safeRpcAll fails CLOSED (empty sections) — never leaks.
  const geoArgsFor = (period: string): Record<string, unknown> =>
    trendExcludeCodes.length > 0 ? { p_period: period, p_exclude_codes: trendExcludeCodes } : { p_period: period };
  // Brick/customer aggregates are also fetched per selected month and concatenated — the downstream
  // grouping sums them by brick / customer across the months, so the geography totals span the whole
  // selection. A failure for any single month fails closed to [] for that month (safeRpcAll).
  const fetchGeo = (fn: "phx_exec_brick" | "phx_exec_customers", orderBy: string[]) =>
    canSeeCrossLineGeography
      ? Promise.all(
          selectedPeriods.map((period) => safeRpcAll(fn, () => rpcAll(supabase, fn, geoArgsFor(period), orderBy))),
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

  const mapExecRow = (row: Record<string, unknown>): ExecRow => ({
    distributorCode: norm(row.distributor_code as string),
    officialLine: norm(row.official_line as string),
    regionCode: norm(row.region_code as string),
    areaCode: norm(row.area_code as string),
    productCode: norm(row.product_code as string),
    productName: norm(row.product_name as string),
    units: Number(row.units ?? 0),
    value: Number(row.value ?? 0),
    period: norm(row.__period as string),
  });

  // Detail = the union of leaf rows across every selected month (each already tagged with its period).
  const detail = (detailRows as Array<Record<string, unknown>>).map(mapExecRow).filter(keepExec);
  // Prior-period leaf rows for the MoM layer — same mapping, same keepExec (period-agnostic).
  const priorDetail = (priorDetailRaw as Array<Record<string, unknown>>).map(mapExecRow).filter(keepExec);
  // Same-month-last-year leaf rows for the YoY layer — same mapping, same keepExec.
  const yoyDetail = (yoyDetailRaw as Array<Record<string, unknown>>).map(mapExecRow).filter(keepExec);

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

  const groupByRegion = (rows: ExecRow[], total: number) =>
    group(rows, (row) => row.regionCode, (code) => regionLabel.get(code) ?? code, () => null, total);
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
        (row) => row.distributorCode,
        (code) => distributorLabel.get(code) ?? code,
        () => null,
        priorTotalValue,
      );
      const priorDirectValue = priorDetail
        .filter((row) => isDirect(row.distributorCode))
        .reduce((sum, row) => sum + row.value, 0);
      const priorAreasReached = new Set(
        priorDetail.map((row) => row.areaCode).filter((code) => code && code !== "DIRECT"),
      ).size;
      const priorDistributorCount = new Set(priorDetail.map((row) => row.distributorCode).filter(Boolean)).size;
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
        (row) => row.distributorCode,
        (code) => distributorLabel.get(code) ?? code,
        () => null,
        yoyTotalValue,
      );
      const yoyDirectValue = yoyDetail
        .filter((row) => isDirect(row.distributorCode))
        .reduce((sum, row) => sum + row.value, 0);
      const yoyAreasReached = new Set(
        yoyDetail.map((row) => row.areaCode).filter((code) => code && code !== "DIRECT"),
      ).size;
      const yoyDistributorCount = new Set(yoyDetail.map((row) => row.distributorCode).filter(Boolean)).size;
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
        distributorName: distributorLabel.get(row.distributorCode) ?? row.distributorCode,
        officialLine: row.officialLine,
        regionCode: row.regionCode,
        regionName: regionLabel.get(row.regionCode) ?? row.regionCode,
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

function buildInsights(input: {
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
}): SosDashboardData["insights"] {
  const out: SosDashboardData["insights"] = [];
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
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

function emptyDashboard(filters: SosFilterOptions, totalAreas: number, restrictedRevealed: boolean): SosDashboardData {
  return {
    period: null,
    selectedPeriods: [],
    availablePeriods: filters.periods,
    filters,
    restrictedRevealed,
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
    bottomBricks: [],
    topCustomers: [],
    customerTop10Share: 0,
    whiteSpaceAreas: [],
    insights: [],
  };
}
