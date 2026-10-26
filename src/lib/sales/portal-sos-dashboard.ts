// Employee-portal Source-of-Sales wrapper. Reuses the admin SoS engine (getSosDashboard)
// but resolves and enforces each viewer's scope SERVER-SIDE, and computes which filters are
// applicable to that scope so the client only ever renders the filters a role can act on.
//
// Scope per role (see plan / access-scope.ts):
//   DSM  — line fixed, region fixed (single)            → Region filter HIDDEN, Area drill-down
//   RM   — line fixed, regions = his reporting subtree   → Region filter SHOWN (his regions)
//   NSM  — line fixed, all regions in line               → Region filter SHOWN, Line HIDDEN
//   PM/GPM — only their assigned products (strict)        → Product-scoped, Line HIDDEN
//   MM   — the 3 product lines of his reports             → Line filter SHOWN (3), Region SHOWN
//
// Confidential products + line/region lockdown are already enforced inside getSosDashboard;
// this layer adds product-code lockdown (PM/GPM) and the RM multi-region override, then trims
// the filter dropdown universes to the in-scope sets.

import {
  resolveEmployeeIdentityId,
  type AccessContext,
  type PhoenixRole,
} from "@/lib/auth/permissions";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { canonicalHrIdKey } from "@/lib/hr-id";
import {
  bridgeEmployeeLineToOfficial,
  canonicalizeRegionName,
  normalizeLineKey,
  resolveSalesAccessScope,
  type SalesAccessScope,
} from "@/lib/sales/access-scope";
import {
  getDistributorUploadStatus,
  loadSalesReferenceData,
  type DistributorUploadStatus,
} from "@/lib/sales/monthly-distributor-import";
import { shiftPeriod } from "@/lib/sales/periods";
import {
  getSosDashboard,
  type SosDashboardData,
  type SosDashboardFilters,
  type SosFilterOptions,
  type SosDashboardOptions,
} from "@/lib/sales/sos-dashboard";
import { maskCodeKeyedDistributorMap, maskPortalSosDashboard } from "@/lib/sales/closing-source-mask";
import { resolveWeeklyProductBound } from "@/lib/sales/weekly/access";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  isWithinManagerHierarchy,
  type SeatContinuitySubject,
} from "@/lib/workforce/hierarchy-resolver";

/** Roles allowed to open the portal Source-of-Sales dashboard. */
export const PORTAL_SOS_ROLES = [
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
  "Marketing Manager",
] as const satisfies readonly PhoenixRole[];

const PORTAL_SOS_ROLE_SET = new Set<PhoenixRole>(PORTAL_SOS_ROLES);

export function isPortalSosRole(role: PhoenixRole): boolean {
  return PORTAL_SOS_ROLE_SET.has(role);
}

/**
 * Roles that see the PHARMACY ACTION LISTS at the top of the page (sos-pharmacy-actions.ts): every
 * portal SoS role plus the Medical Rep — owner, 2026-09-14, "Add Medical Reps".
 *
 * 🔴 A REP IS DELIBERATELY NOT A PORTAL SOS ROLE. The distributor dashboard underneath resolves a rep
 * at REGION level (his sales scope is SELF, which the engine reads as his region), so admitting him
 * to PORTAL_SOS_ROLES would show him every sibling rep's area. The action lists narrow him to his own
 * area, which is why he gets them and only them.
 */
export const PORTAL_SOS_ACTION_ROLES = [
  ...PORTAL_SOS_ROLES,
  "Medical Rep",
] as const satisfies readonly PhoenixRole[];

const PORTAL_SOS_ACTION_ROLE_SET = new Set<PhoenixRole>(PORTAL_SOS_ACTION_ROLES);

export function isPortalSosActionsRole(role: PhoenixRole): boolean {
  return PORTAL_SOS_ACTION_ROLE_SET.has(role);
}

/**
 * Pure filter-visibility rule (no DB) — exported for unit testing.
 *   line:   hidden when bound to a single line; shown for multi-line (MM) or company.
 *   region: hidden ONLY when locked to exactly one region (DSM); shown otherwise.
 * Every other dimension is always available.
 */
export function computePortalSosVisibility(
  lineKeys: Set<string> | null,
  regionCodes: Set<string> | null,
  /**
   * The viewer owns exactly ONE district, even though `regionCodes` may list more than one region
   * because one of that district's areas sits in a foreign region (see src/lib/sales/seat-area-scope.ts).
   * Such a viewer still has nothing to choose between, so the region picker stays hidden — offering it
   * would invite filtering to a "region" they only hold a single area in.
   */
  lockedToSingleDistrict = false,
): PortalSosFilterVisibility {
  return {
    period: true,
    line: lineKeys === null || lineKeys.size > 1,
    region: !lockedToSingleDistrict && !(regionCodes !== null && regionCodes.size === 1),
    area: true,
    product: true,
    distributor: true,
  };
}

/** Which filters the client should render for this viewer. */
export type PortalSosFilterVisibility = {
  period: boolean;
  line: boolean;
  region: boolean;
  area: boolean;
  product: boolean;
  distributor: boolean;
};

/**
 * Serializable subset of PortalSosScope safe to pass to a client component / JSON response.
 * (PortalSosScope itself holds Sets, which cannot cross the server→client boundary.)
 */
export type PortalSosScopeView = {
  role: PhoenixRole;
  visibility: PortalSosFilterVisibility;
  scopeSummary: string;
  /**
   * Viewer is locked to exactly one region (DSM). Drives the chart layout: comparing a single
   * region against itself is meaningless, so the client swaps "By region" for a vertical "By area"
   * chart and drops the Region breakdown tab. Kept distinct from `visibility.region` on purpose —
   * filter visibility and chart layout are separate concerns even if they coincide today.
   */
  isSingleRegion: boolean;
};

export function toPortalSosScopeView(scope: PortalSosScope): PortalSosScopeView {
  return {
    role: scope.role,
    visibility: scope.visibility,
    scopeSummary: scope.scopeSummary,
    isSingleRegion: scope.isSingleRegion,
  };
}

export type PortalSosScope = {
  role: PhoenixRole;
  /** Product-code lockdown (PM/GPM). null = no restriction; empty Set = show nothing. */
  allowedProductCodes: Set<string> | null;
  /** Region-code override forwarded to the engine. undefined = use the role's base scope. */
  regionOverride?: Set<string>;
  /** Region codes in scope (DSM single / RM subtree / null = unrestricted) — trims options. */
  regionCodes: Set<string> | null;
  /**
   * Area codes in scope, from the viewer's organogram seat (see src/lib/sales/seat-area-scope.ts).
   * Non-null for a District / Regional Manager whose seat resolved; it is the AUTHORITATIVE bound
   * and is what makes an area whose operational owner differs from its geography (e.g. CNS Kafr
   * El-Sheikh 1, owned by the Alex-BHR DM but carrying region Delta (1)) visible to its real owner
   * without also exposing that foreign region's other areas. null = no area restriction.
   */
  areaCodes: Set<string> | null;
  /** Normalized line keys in scope (null = all) — trims options. */
  lineKeys: Set<string> | null;
  /**
   * Distributor codes that have any sales within this viewer's line/region scope, all-time
   * (independent of the selected period) — trims the distributor dropdown. null = unrestricted
   * (no line/region scope at all); empty Set = the scope lookup found nothing (fail closed).
   */
  allowedDistributorCodes: Set<string> | null;
  visibility: PortalSosFilterVisibility;
  /** Locked to exactly one region (DSM) — see PortalSosScopeView.isSingleRegion. */
  isSingleRegion: boolean;
  /** Human banner, e.g. "Pedia · 3 regions · 8 products". */
  scopeSummary: string;
};

type ReferenceData = Awaited<ReturnType<typeof loadSalesReferenceData>>;

/** Map canonicalized employee region NAMES onto Source-of-Sales region CODES. */
function regionCodesForNames(
  names: Set<string> | null,
  references: ReferenceData,
): Set<string> {
  const out = new Set<string>();
  if (!names || names.size === 0) return out;
  for (const region of references.regions) {
    if (names.has(canonicalizeRegionName(region.regionName))) {
      out.add(region.regionCode.toUpperCase());
    }
  }
  return out;
}

/**
 * Resolve a Regional Manager's full managed region set from his reporting subtree
 * (seat-continuity aware), bounded to his own line. Fail-closed (empty ⇒ empty data).
 *
 * Exported for reuse by the Territory Drilldown module (src/lib/sales/territory/root-scope.ts),
 * which needs the exact same "his regions, plural" resolution for its Regional Manager root —
 * do not reimplement subtree walking elsewhere.
 */
export async function resolveRegionalManagerRegionCodes(
  ctx: AccessContext,
  salesScope: SalesAccessScope,
  references: ReferenceData,
): Promise<Set<string>> {
  const viewerKey = canonicalHrIdKey(resolveEmployeeIdentityId(ctx) ?? "");
  if (!viewerKey) return new Set();

  const directory = await getEmployeeDirectory();
  const byCanonicalHrId = new Map<string, SeatContinuitySubject>();
  for (const employee of directory.employees) {
    const key = canonicalHrIdKey(employee.hrId);
    if (!key) continue;
    byCanonicalHrId.set(key, {
      managerHrId: employee.managerHrId,
      pendingManagerReplacementForHrId: employee.pendingManagerReplacementForHrId,
    });
  }

  const allowedLineKeys = salesScope.allowedLineNames
    ? new Set([...salesScope.allowedLineNames].map(normalizeLineKey))
    : null;

  const regionNames = new Set<string>();
  // Include the RM's own region.
  const self = directory.employees.find((employee) => canonicalHrIdKey(employee.hrId) === viewerKey);
  if (self?.regionName) regionNames.add(canonicalizeRegionName(self.regionName));

  for (const employee of directory.employees) {
    const inHierarchy = isWithinManagerHierarchy({
      employee: {
        managerHrId: employee.managerHrId,
        pendingManagerReplacementForHrId: employee.pendingManagerReplacementForHrId,
      },
      byCanonicalHrId,
      viewerCanonicalHrId: viewerKey,
      canonicalize: (value) => canonicalHrIdKey(value) || null,
    });
    if (!inHierarchy) continue;
    if (allowedLineKeys) {
      const officialKey = normalizeLineKey(bridgeEmployeeLineToOfficial(employee.lineName) ?? employee.lineName ?? "");
      if (!allowedLineKeys.has(officialKey)) continue;
    }
    if (employee.regionName) regionNames.add(canonicalizeRegionName(employee.regionName));
  }

  return regionCodesForNames(regionNames, references);
}

/**
 * Line-aware fallback bound for a Regional Manager whose organogram seat did NOT resolve: the
 * areas their subtree actually works, derived per subordinate from their assigned area — never
 * from region labels. Labels flatten the per-line map (the same area answers to different
 * managers per line), so a label either hands a whole shared region's areas to the wrong
 * manager or silently drops an out-of-label area. Returns empty sets when nothing resolves;
 * the caller then keeps the legacy region-code fallback.
 */
export async function resolveRegionalManagerSubtreeAreaScope(
  ctx: AccessContext,
  salesScope: SalesAccessScope,
  references: ReferenceData,
): Promise<{ areaCodes: Set<string>; factRegionCodes: Set<string> }> {
  const empty = { areaCodes: new Set<string>(), factRegionCodes: new Set<string>() };
  const viewerKey = canonicalHrIdKey(resolveEmployeeIdentityId(ctx) ?? "");
  if (!viewerKey) return empty;

  const directory = await getEmployeeDirectory();
  const byCanonicalHrId = new Map<string, SeatContinuitySubject>();
  for (const employee of directory.employees) {
    const key = canonicalHrIdKey(employee.hrId);
    if (!key) continue;
    byCanonicalHrId.set(key, {
      managerHrId: employee.managerHrId,
      pendingManagerReplacementForHrId: employee.pendingManagerReplacementForHrId,
    });
  }

  const allowedLineKeys = salesScope.allowedLineNames
    ? new Set([...salesScope.allowedLineNames].map(normalizeLineKey))
    : null;

  const areaIds = new Set<number>();
  // The manager's OWN area first: isWithinManagerHierarchy walks subordinates and excludes the
  // viewer, so a manager who personally holds an area (PD-0001 holds Alex East / AB1, which none
  // of his reports cover) would otherwise lose his own territory. Mirrors the region resolver's
  // "include the RM's own region" step.
  const self = directory.employees.find((employee) => canonicalHrIdKey(employee.hrId) === viewerKey);
  if (self?.areaId != null) areaIds.add(self.areaId);
  // The manager's OWN area first: isWithinManagerHierarchy walks subordinates and excludes the
  // viewer, so a manager who personally holds an area (PD-0001 holds Alex East / AB1, which none
  // of his reports cover) would otherwise lose his own territory. Mirrors the region resolver's
  // "include the RM's own region" step.

  for (const employee of directory.employees) {
    if (employee.areaId == null) continue;
    const inHierarchy = isWithinManagerHierarchy({
      employee: {
        managerHrId: employee.managerHrId,
        pendingManagerReplacementForHrId: employee.pendingManagerReplacementForHrId,
      },
      byCanonicalHrId,
      viewerCanonicalHrId: viewerKey,
      canonicalize: (value) => canonicalHrIdKey(value) || null,
    });
    if (!inHierarchy) continue;
    if (allowedLineKeys) {
      const officialKey = normalizeLineKey(bridgeEmployeeLineToOfficial(employee.lineName) ?? employee.lineName ?? "");
      if (!allowedLineKeys.has(officialKey)) continue;
    }
    areaIds.add(employee.areaId);
  }
  if (areaIds.size === 0) return empty;

  // areaId → SoS area code via the areas master (the unified rows carry the SoS code directly).
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("areas").select("id, code").in("id", [...areaIds]);
  if (error) return empty;
  const candidateCodes = new Set<string>();
  for (const row of (data ?? []) as Array<{ id: number | null; code: string | null }>) {
    const code = String(row.code ?? "").trim().toUpperCase();
    if (code) candidateCodes.add(code);
  }

  // Keep only codes the sales master knows (mirrors the Drilldown's confirmation step), and pair
  // each with its fact region so the engine's fetch reaches out-of-label areas' rows.
  const factRegionByArea = new Map(
    (references.areas ?? []).map((area) => [area.areaCode.toUpperCase(), area.regionCode.toUpperCase()]),
  );
  const areaCodes = new Set<string>();
  const factRegionCodes = new Set<string>();
  for (const code of candidateCodes) {
    const region = factRegionByArea.get(code);
    if (!region) continue;
    areaCodes.add(code);
    factRegionCodes.add(region);
  }
  return { areaCodes, factRegionCodes };
}

/**
 * Distributor codes with any sales within the given line/region scope, all-time — used to trim
 * the distributor dropdown to the viewer's authorized universe without it shrinking/shifting as
 * the viewer changes the period filter (unlike a period-scoped byDistributor breakdown would).
 * null = no line/region restriction at all (unrestricted). Fails CLOSED on an RPC error (empty
 * Set, not null) so a lookup failure never falls back to showing the full company list.
 */
async function resolveAllowedDistributorCodes(
  lineKeys: Set<string> | null,
  regionCodes: Set<string> | null,
  salesScope: SalesAccessScope,
): Promise<Set<string> | null> {
  if (lineKeys === null && regionCodes === null) return null;
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("phx_sos_distinct_distributors", {
    p_lines: salesScope.allowedLineNames ? [...salesScope.allowedLineNames] : [],
    p_regions: regionCodes ? [...regionCodes] : [],
  });
  if (error) return new Set();
  return new Set((data ?? []).map((row: { distributor_code: string }) => String(row.distributor_code ?? "").toUpperCase()));
}

function buildScopeSummary(input: {
  salesScope: SalesAccessScope;
  regionCodes: Set<string> | null;
  allowedProductCodes: Set<string> | null;
  references: ReferenceData;
  /** Seat-scoped to one district — summarise by area count, not by the (possibly 2) region codes. */
  districtAreaCount?: number | null;
}): string {
  const parts: string[] = [];
  const { salesScope, regionCodes, allowedProductCodes, references } = input;

  if (salesScope.allowedLineNames && salesScope.allowedLineNames.size > 0) {
    parts.push([...salesScope.allowedLineNames].join(" · "));
  } else {
    parts.push("All lines");
  }

  // A one-district viewer reads "6 areas", not "2 regions" — his second region code is only there
  // because one of his own areas happens to sit in it.
  if (input.districtAreaCount != null) {
    parts.push(`${input.districtAreaCount} area${input.districtAreaCount === 1 ? "" : "s"}`);
  } else if (regionCodes) {
    if (regionCodes.size === 1) {
      const code = [...regionCodes][0];
      const region = references.regions.find((r) => r.regionCode.toUpperCase() === code);
      parts.push(`${region?.regionName ?? code} region`);
    } else {
      parts.push(`${regionCodes.size} region${regionCodes.size === 1 ? "" : "s"}`);
    }
  } else {
    parts.push("all regions");
  }

  if (allowedProductCodes) {
    parts.push(`${allowedProductCodes.size} product${allowedProductCodes.size === 1 ? "" : "s"}`);
  }

  return parts.join(" · ");
}

export async function resolvePortalSosScope(ctx: AccessContext): Promise<PortalSosScope> {
  const role = ctx.role;
  const isProductManager = role === "Product Manager" || role === "Group Product Manager";
  const isDistrictManager = role === "District Manager" || role === "Manager";
  const isRegionalManager = role === "Regional Manager";

  const [salesScope, references] = await Promise.all([
    resolveSalesAccessScope(ctx),
    loadSalesReferenceData({ includeCustomerBricks: false }),
  ]);

  // Product scope — PM/GPM are bounded to their product list. No list means their whole lines, as on
  // every other screen (owner, 2026-09-18). It used to be an empty set here, which the engine reads as
  // "show nothing", so a Product Manager with no list saw a blank Source of Sales.
  let allowedProductCodes: Set<string> | null = null;
  if (isProductManager) {
    const hrKey = canonicalHrIdKey(resolveEmployeeIdentityId(ctx) ?? "");
    allowedProductCodes = await resolveWeeklyProductBound(hrKey);
  }

  // Geography scope. A District / Regional Manager whose organogram seat resolved is bounded by that
  // seat's AREAS; the region set then only exists to reach those areas' rows (an area can sit in a
  // foreign region) and to label/trim options — the area filter is what keeps it honest.
  let regionOverride: Set<string> | undefined;
  let regionCodes: Set<string> | null;
  let areaCodes: Set<string> | null = salesScope.allowedAreaCodes ?? null;
  if (areaCodes) {
    // Seat-derived: forward BOTH bounds to the engine. The region override must be wide enough to
    // fetch every one of the seat's areas, including any that sit outside the viewer's own region.
    regionOverride = new Set(salesScope.allowedAreaFactRegionCodes ?? []);
    regionCodes = regionOverride;
  } else if (isRegionalManager) {
    // Prefer the line-aware subtree AREA bound; region labels flatten the per-line area→manager
    // map, so they stay a last resort only.
    const subtree = await resolveRegionalManagerSubtreeAreaScope(ctx, salesScope, references);
    if (subtree.areaCodes.size > 0) {
      areaCodes = subtree.areaCodes;
      regionOverride = subtree.factRegionCodes;
      regionCodes = regionOverride;
    } else {
      regionOverride = await resolveRegionalManagerRegionCodes(ctx, salesScope, references);
      regionCodes = regionOverride;
    }
  } else if (isDistrictManager) {
    // Seat map couldn't answer — fall back to the legacy single-own-region lock (unchanged
    // behaviour). No override is needed; the base engine scope already applies it.
    regionCodes = regionCodesForNames(salesScope.allowedRegionNames, references);
  } else {
    regionCodes = null; // NSM / PM / GPM / MM — all regions within their line scope.
    areaCodes = null;
  }

  const lineKeys = salesScope.allowedLineNames
    ? new Set([...salesScope.allowedLineNames].map(normalizeLineKey))
    : null;

  // NOTE: phx_sos_distinct_distributors filters by line/region only (it has no area argument), so a
  // seat-scoped viewer whose region set was widened to reach an out-of-region area can see a few extra
  // DISTRIBUTOR NAMES in the dropdown — ones active in that region but not in his own areas. Accepted
  // deliberately: it is master-data naming, every row remains area-filtered, and the alternative
  // (passing his narrow own-region set) would drop a distributor that only sells in his out-of-region
  // area — reintroducing the bug this change fixes. Give the RPC an area argument to close it properly.
  const allowedDistributorCodes = await resolveAllowedDistributorCodes(lineKeys, regionCodes, salesScope);

  // A seat-scoped District Manager owns one district by definition, so keep treating him as
  // "single region" for both the filter rule and the chart layout even when his area set reaches
  // into a second region — otherwise the fix would silently un-hide a region picker and swap his
  // "By area" chart for a two-bar "By region" chart where one bar is a single area.
  const lockedToSingleDistrict = areaCodes !== null && isDistrictManager;
  const visibility = computePortalSosVisibility(lineKeys, regionCodes, lockedToSingleDistrict);
  const isSingleRegion = lockedToSingleDistrict || (regionCodes !== null && regionCodes.size === 1);

  return {
    role,
    allowedProductCodes,
    regionOverride,
    regionCodes,
    areaCodes,
    lineKeys,
    allowedDistributorCodes,
    visibility,
    isSingleRegion,
    scopeSummary: buildScopeSummary({
      salesScope,
      regionCodes,
      allowedProductCodes,
      references,
      districtAreaCount: lockedToSingleDistrict && areaCodes ? areaCodes.size : null,
    }),
  };
}

/** Trim the engine's master-derived filter option lists to the viewer's in-scope universe. */
function trimFilterOptions(filters: SosFilterOptions, scope: PortalSosScope): SosFilterOptions {
  const { lineKeys, regionCodes, areaCodes, allowedProductCodes, allowedDistributorCodes } = scope;

  const lines = lineKeys ? filters.lines.filter((line) => lineKeys.has(normalizeLineKey(line))) : filters.lines;
  const regions = regionCodes
    ? filters.regions.filter((region) => regionCodes.has(region.code.toUpperCase()))
    : filters.regions;
  // Areas are trimmed by the seat's AREA set when there is one. Trimming by region instead would both
  // drop an owned out-of-region area and offer sibling managers' areas from a shared region.
  const areas = areaCodes
    ? filters.areas.filter((area) => areaCodes.has(area.code.toUpperCase()))
    : regionCodes
      ? filters.areas.filter((area) => area.region != null && regionCodes.has(String(area.region).toUpperCase()))
      : filters.areas;
  const products = filters.products.filter((product) => {
    if (lineKeys && !(product.line != null && lineKeys.has(normalizeLineKey(product.line)))) return false;
    if (allowedProductCodes && !allowedProductCodes.has(product.code.toUpperCase())) return false;
    return true;
  });
  const distributors = allowedDistributorCodes
    ? filters.distributors.filter((distributor) => allowedDistributorCodes.has(distributor.code.toUpperCase()))
    : filters.distributors;

  return { ...filters, lines, regions, areas, products, distributors };
}

type DetailDim = "product" | "region" | "area" | "distributor";

export type PortalSosMover = { code: string; label: string; value: number; prevValue: number; deltaPct: number };

/** Period-over-period comparison for the dashboard (vs the previous month, same scope+filters). */
export type PortalSosComparison = {
  previousPeriod: string | null;
  /** prevValue keyed by dimension + row code — drives the "Δ vs last month" column. */
  prevValueByCode: Record<DetailDim, Record<string, number>>;
  /** Biggest product gainers / decliners by % change (prev must be > 0). */
  gainers: PortalSosMover[];
  decliners: PortalSosMover[];
  /** The previous month's Total Value, same scope and filters. */
  previousTotalValue: number;
  /** The Total Value arrow: the selected month against the calendar month before it. */
  totalValueDelta: number | null;
};

/**
 * The Total Value arrow. It compares the SELECTED month with the calendar month before it, and
 * nothing else: it used to read the last two points of the trend, which are always the newest
 * month and the one before, so a manager looking at March was shown July against June.
 * Null when the prior month is not the one before `currentPeriod`, or has no value to divide by.
 */
export function totalValueDelta(
  currentPeriod: string | null,
  currentTotal: number,
  previousPeriod: string | null,
  previousTotal: number,
): number | null {
  if (!currentPeriod || !previousPeriod) return null;
  if (shiftPeriod(currentPeriod, 1) !== previousPeriod) return null;
  if (!Number.isFinite(currentTotal) || !Number.isFinite(previousTotal) || previousTotal <= 0) return null;
  return (currentTotal - previousTotal) / previousTotal;
}

function valueByCode(rows: { code: string; value: number }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) out[row.code] = row.value;
  return out;
}

async function computeComparison(
  filters: SosDashboardFilters,
  ctx: AccessContext,
  options: SosDashboardOptions,
  current: SosDashboardData,
): Promise<PortalSosComparison | null> {
  if (!current.period) return null;
  const previousPeriod = shiftPeriod(current.period, 1);
  if (!previousPeriod) return null;

  let prev: SosDashboardData;
  try {
    prev = await getSosDashboard({ ...filters, period: previousPeriod }, ctx, options);
  } catch {
    return null;
  }
  // The engine falls back to the newest period when the requested one has no validated data. If the
  // previous month is missing, `prev` would equal `current` — so skip the comparison entirely rather
  // than reporting bogus 0% deltas against itself.
  if (prev.period !== previousPeriod) return null;

  const prevValueByCode: Record<DetailDim, Record<string, number>> = {
    product: valueByCode(prev.byProduct),
    region: valueByCode(prev.byRegion),
    area: valueByCode(prev.byArea),
    distributor: valueByCode(prev.byDistributor),
  };

  // Movers from the product breakdown (most actionable). Only products with a real prior value.
  const moves: PortalSosMover[] = current.byProduct
    .map((row) => {
      const prevValue = prevValueByCode.product[row.code] ?? 0;
      return { code: row.code, label: row.label, value: row.value, prevValue, deltaPct: prevValue > 0 ? (row.value - prevValue) / prevValue : 0 };
    })
    .filter((mover) => mover.prevValue > 0);
  const gainers = [...moves].filter((m) => m.deltaPct > 0).sort((a, b) => b.deltaPct - a.deltaPct).slice(0, 3);
  const decliners = [...moves].filter((m) => m.deltaPct < 0).sort((a, b) => a.deltaPct - b.deltaPct).slice(0, 3);

  const previousTotalValue = prev.summary.totalValue;
  return {
    previousPeriod,
    prevValueByCode,
    gainers,
    decliners,
    previousTotalValue,
    totalValueDelta: totalValueDelta(current.period, current.summary.totalValue, prev.period, previousTotalValue),
  };
}

/**
 * The engine options every portal read passes. 🔴 `omitCoverageWarning` is ALWAYS on: the
 * data-gap banner ("overseas is missing from 2026-10, 2026-11 … not like-for-like") is never
 * shown on the employee portal's Source of Sales dashboard (owner, 2026-10-26).
 */
export function buildPortalSosOptions(
  scope: Pick<PortalSosScope, "allowedProductCodes" | "areaCodes" | "regionOverride">,
): SosDashboardOptions {
  const options: SosDashboardOptions = {
    allowedProductCodes: scope.allowedProductCodes,
    omitCoverageWarning: true,
  };
  // Only forward a region override when one was resolved (RM, or a seat-derived area bound whose
  // regions must be reachable). Omitting the key lets the engine keep the role's base region scope
  // (e.g. a DSM's single-region lock when the seat map couldn't answer).
  if (scope.regionOverride !== undefined) options.allowedRegionCodes = scope.regionOverride;
  // The area bound must travel with any widened region set — never one without the other.
  if (scope.areaCodes !== null) options.allowedAreaCodes = scope.areaCodes;
  return options;
}

export async function getPortalSosDashboard(
  filters: SosDashboardFilters,
  ctx: AccessContext,
): Promise<{
  data: SosDashboardData;
  scope: PortalSosScope;
  comparison: PortalSosComparison | null;
  uploadStatus: DistributorUploadStatus | null;
}> {
  const scope = await resolvePortalSosScope(ctx);

  const options = buildPortalSosOptions(scope);
  const data = await getSosDashboard(filters, ctx, options);
  const [comparison, uploadStatus] = await Promise.all([
    computeComparison(filters, ctx, options, data),
    data.period ? getDistributorUploadStatus(data.period).catch(() => null) : Promise.resolve(null),
  ]);

  // 🔒 THE SOURCE MASK, APPLIED HERE AND NOWHERE EARLIER. Everything above this line — the scope
  // resolution, the split, the comparison — must see the real distributor or El Qema's own rules
  // stop applying and the numbers move silently. This is the last thing that happens before the
  // payload leaves for a screen, which is the only safe place for it. See closing-source-mask.ts.
  //
  // The comparison is masked separately because it keys prior values BY distributor code: masking
  // it before it was computed would leave every masked row reading "no comparable prior value"
  // instead of its real movement.
  const masked = maskPortalSosDashboard(
    { ...data, filters: trimFilterOptions(data.filters, scope) },
    ctx,
  );
  // NESTED, not top level: the map lives at `prevValueByCode.distributor`, one of four dimensions
  // keyed side by side. `gainers`/`decliners` are built from byProduct and carry no distributor.
  const maskedComparison = comparison
    ? {
      ...comparison,
      prevValueByCode: {
        ...comparison.prevValueByCode,
        distributor: maskCodeKeyedDistributorMap(comparison.prevValueByCode.distributor, ctx) ?? {},
      },
    }
    : comparison;

  return { data: masked, scope, comparison: maskedComparison, uploadStatus };
}
