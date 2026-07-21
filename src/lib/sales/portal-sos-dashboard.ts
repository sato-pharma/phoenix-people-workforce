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
  type SosScopeOverrides,
} from "@/lib/sales/sos-dashboard";
import { getWeeklyProductScopeCodes } from "@/lib/sales/weekly/access";
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
 * Pure filter-visibility rule (no DB) — exported for unit testing.
 *   line:   hidden when bound to a single line; shown for multi-line (MM) or company.
 *   region: hidden ONLY when locked to exactly one region (DSM); shown otherwise.
 * Every other dimension is always available.
 */
export function computePortalSosVisibility(
  lineKeys: Set<string> | null,
  regionCodes: Set<string> | null,
): PortalSosFilterVisibility {
  return {
    period: true,
    line: lineKeys === null || lineKeys.size > 1,
    region: !(regionCodes !== null && regionCodes.size === 1),
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
}): string {
  const parts: string[] = [];
  const { salesScope, regionCodes, allowedProductCodes, references } = input;

  if (salesScope.allowedLineNames && salesScope.allowedLineNames.size > 0) {
    parts.push([...salesScope.allowedLineNames].join(" · "));
  } else {
    parts.push("All lines");
  }

  if (regionCodes) {
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

  // Product scope — PM/GPM strictly bounded to their assigned codes (empty ⇒ show nothing).
  let allowedProductCodes: Set<string> | null = null;
  if (isProductManager) {
    const hrKey = canonicalHrIdKey(resolveEmployeeIdentityId(ctx) ?? "");
    allowedProductCodes = await getWeeklyProductScopeCodes(hrKey);
  }

  // Region scope.
  let regionOverride: Set<string> | undefined;
  let regionCodes: Set<string> | null;
  if (isRegionalManager) {
    regionOverride = await resolveRegionalManagerRegionCodes(ctx, salesScope, references);
    regionCodes = regionOverride;
  } else if (isDistrictManager) {
    // DSM is already region-locked to his single own region by the base engine scope; surface
    // that region set for visibility + option trimming, but no override is needed.
    regionCodes = regionCodesForNames(salesScope.allowedRegionNames, references);
  } else {
    regionCodes = null; // NSM / PM / GPM / MM — all regions within their line scope.
  }

  const lineKeys = salesScope.allowedLineNames
    ? new Set([...salesScope.allowedLineNames].map(normalizeLineKey))
    : null;

  const allowedDistributorCodes = await resolveAllowedDistributorCodes(lineKeys, regionCodes, salesScope);

  const visibility = computePortalSosVisibility(lineKeys, regionCodes);
  const isSingleRegion = regionCodes !== null && regionCodes.size === 1;

  return {
    role,
    allowedProductCodes,
    regionOverride,
    regionCodes,
    lineKeys,
    allowedDistributorCodes,
    visibility,
    isSingleRegion,
    scopeSummary: buildScopeSummary({ salesScope, regionCodes, allowedProductCodes, references }),
  };
}

/** Trim the engine's master-derived filter option lists to the viewer's in-scope universe. */
function trimFilterOptions(filters: SosFilterOptions, scope: PortalSosScope): SosFilterOptions {
  const { lineKeys, regionCodes, allowedProductCodes, allowedDistributorCodes } = scope;

  const lines = lineKeys ? filters.lines.filter((line) => lineKeys.has(normalizeLineKey(line))) : filters.lines;
  const regions = regionCodes
    ? filters.regions.filter((region) => regionCodes.has(region.code.toUpperCase()))
    : filters.regions;
  const areas = regionCodes
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
};

function valueByCode(rows: { code: string; value: number }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) out[row.code] = row.value;
  return out;
}

async function computeComparison(
  filters: SosDashboardFilters,
  ctx: AccessContext,
  options: SosScopeOverrides,
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

  return { previousPeriod, prevValueByCode, gainers, decliners };
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

  const options: SosScopeOverrides = { allowedProductCodes: scope.allowedProductCodes };
  // Only forward a region override when one was resolved (RM). Omitting the key lets the engine
  // keep the role's base region scope (e.g. DSM's single-region lock).
  if (scope.regionOverride !== undefined) options.allowedRegionCodes = scope.regionOverride;

  const data = await getSosDashboard(filters, ctx, options);
  const [comparison, uploadStatus] = await Promise.all([
    computeComparison(filters, ctx, options, data),
    data.period ? getDistributorUploadStatus(data.period).catch(() => null) : Promise.resolve(null),
  ]);

  return { data: { ...data, filters: trimFilterOptions(data.filters, scope) }, scope, comparison, uploadStatus };
}
