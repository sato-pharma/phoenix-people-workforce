// Employee-portal Weekly Sales wrapper. Reuses the admin weekly engine (loadWeeklyDashboard)
// but resolves and enforces each viewer's scope SERVER-SIDE, and computes which filters are
// applicable to that scope so the client only renders the filters a role can act on.
//
// Scope per role (mirrors the portal SoS pattern but wired to WeeklyAccessScope):
//   DSM  — territory tier, single region fixed         → Region filter HIDDEN
//   RM   — territory tier, multi-region (Pedia subtree) → Region filter SHOWN
//   NSM  — territory tier, all regions in line          → Region filter SHOWN
//   PM/GPM — product tier or territory (no explicit assignment) → Line HIDDEN, Region SHOWN
//   MM   — product tier or territory (3 lines)           → Line filter SHOWN, Region SHOWN
//
// The access scope is enforced inside loadWeeklyDashboard via applyWeeklyAccessScope.
// This wrapper only computes filter visibility, trims option lists, and runs the comparison.

import { type AccessContext, type PhoenixRole } from "@/lib/auth/permissions";
import {
  resolveWeeklyAccessScope,
  type WeeklyAccessScope,
} from "@/lib/sales/weekly/access";
import { loadWeeklyAreaSplitIndex } from "@/lib/sales/weekly/branch-area-split";
import {
  buildPortalWeeklyFieldForce,
  loadFieldForceSeatIndex,
  type PortalWeeklyFieldForce,
} from "@/lib/sales/weekly/portal-weekly-field-force";
import { loadWeeklyDashboard } from "@/lib/sales/weekly/service";
import type {
  WeeklyDashboard,
  WeeklyFilterMode,
  WeeklyRanked,
} from "@/lib/sales/weekly/types";

/** Roles allowed to open the portal Weekly Sales dashboard. Medical Reps intentionally excluded. */
export const PORTAL_WEEKLY_ROLES = [
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
  "Marketing Manager",
] as const satisfies readonly PhoenixRole[];

const PORTAL_WEEKLY_ROLE_SET = new Set<PhoenixRole>(PORTAL_WEEKLY_ROLES);

export function isPortalWeeklyRole(role: PhoenixRole): boolean {
  return PORTAL_WEEKLY_ROLE_SET.has(role);
}

/** Which filters the client should render for this viewer. */
export type PortalWeeklyFilterVisibility = {
  /** Always true. */
  month: boolean;
  /** Always true. */
  weekNumber: boolean;
  /** True for Marketing Manager (multi-line role) and full-tier company viewers (CEO / Super Admin). */
  line: boolean;
  /** False when locked to exactly one region (DSM). */
  region: boolean;
  /** Always true (trimmed to scope for PM/GPM). */
  product: boolean;
  /** Always true. */
  distributor: boolean;
};

/**
 * Pure visibility rule — exported for unit testing.
 * Region hidden ONLY when locked to exactly one region (DSM territory tier).
 * Line shown for Marketing Manager (multi-line role) and for full-tier company
 * viewers (CEO / Super Admin on the admin Field Sales pages).
 */
export function computePortalWeeklyVisibility(
  role: PhoenixRole,
  allowedRegionCodes: Set<string> | null,
  companyWide = false,
): PortalWeeklyFilterVisibility {
  return {
    month: true,
    weekNumber: true,
    line: role === "Marketing Manager" || companyWide,
    region: !(allowedRegionCodes !== null && allowedRegionCodes.size === 1),
    product: true,
    distributor: true,
  };
}

/**
 * Serializable subset of PortalWeeklyScope safe to pass to a client component / JSON response.
 * (PortalWeeklyScope holds Sets that cannot cross the server→client boundary.)
 */
export type PortalWeeklyScopeView = {
  role: PhoenixRole;
  visibility: PortalWeeklyFilterVisibility;
  scopeSummary: string;
  /**
   * Viewer is locked to exactly one region (DSM). Client hides the region filter and
   * the "By Region" chart, and defaults the breakdown view to "product".
   */
  isSingleRegion: boolean;
};

export function toPortalWeeklyScopeView(scope: PortalWeeklyScope): PortalWeeklyScopeView {
  return {
    role: scope.role,
    visibility: scope.visibility,
    scopeSummary: scope.scopeSummary,
    isSingleRegion: scope.isSingleRegion,
  };
}

type PortalWeeklyScope = {
  accessScope: WeeklyAccessScope;
  role: PhoenixRole;
  allowedRegionCodes: Set<string> | null;
  allowedProductCodes: Set<string> | null;
  isSingleRegion: boolean;
  visibility: PortalWeeklyFilterVisibility;
  scopeSummary: string;
};

function buildWeeklyScopeSummary(scope: WeeklyAccessScope, role: PhoenixRole): string {
  const parts: string[] = [];

  switch (scope.tier) {
    case "full":
      parts.push("All lines");
      parts.push("all regions");
      break;
    case "product": {
      const count = scope.productCodes.size;
      parts.push(`${count} product${count === 1 ? "" : "s"}`);
      break;
    }
    case "territory": {
      if (scope.allowedLineNames && scope.allowedLineNames.size > 0) {
        parts.push([...scope.allowedLineNames].join(" · "));
      } else {
        parts.push("All lines");
      }
      if (scope.allowedRegionCodes) {
        if (scope.allowedRegionCodes.size === 1) {
          parts.push(`${[...scope.allowedRegionCodes][0]} region`);
        } else {
          parts.push(`${scope.allowedRegionCodes.size} regions`);
        }
      } else {
        parts.push("all regions");
      }
      break;
    }
    case "none":
      parts.push("No access");
      break;
  }

  // Append role for clarity
  parts.push(role);

  return parts.join(" · ");
}

export async function resolvePortalWeeklyScope(ctx: AccessContext): Promise<PortalWeeklyScope> {
  const role = ctx.role;
  const accessScope = await resolveWeeklyAccessScope(ctx);

  let allowedRegionCodes: Set<string> | null = null;
  let allowedProductCodes: Set<string> | null = null;

  if (accessScope.tier === "territory") {
    allowedRegionCodes = accessScope.allowedRegionCodes;
  } else if (accessScope.tier === "product") {
    allowedProductCodes = accessScope.productCodes;
  }

  const isSingleRegion = allowedRegionCodes !== null && allowedRegionCodes.size === 1;
  const visibility = computePortalWeeklyVisibility(role, allowedRegionCodes, accessScope.tier === "full");
  const scopeSummary = buildWeeklyScopeSummary(accessScope, role);

  return {
    accessScope,
    role,
    allowedRegionCodes,
    allowedProductCodes,
    isSingleRegion,
    visibility,
    scopeSummary,
  };
}

/** Trim option arrays to the viewer's in-scope universe. */
function trimWeeklyFilterOptions(
  data: WeeklyDashboard,
  scope: PortalWeeklyScope,
): WeeklyDashboard {
  const { allowedRegionCodes, allowedProductCodes } = scope;

  let availableRegions = data.availableRegions;
  let availableProducts = data.availableProducts;
  let availableLines = data.availableLines;

  if (allowedRegionCodes !== null) {
    availableRegions = data.availableRegions.filter((r) =>
      allowedRegionCodes.has(r.code.toUpperCase()),
    );
  }

  if (allowedProductCodes !== null) {
    availableProducts = data.availableProducts.filter((p) =>
      allowedProductCodes.has(p.code.toUpperCase()),
    );
  }

  if (scope.role !== "Marketing Manager" && scope.accessScope.tier !== "full") {
    // Line-bounded roles get the line filter hidden entirely; Marketing Manager and
    // full-tier company viewers (CEO / Super Admin) keep the line list for slicing.
    availableLines = [];
  }

  return { ...data, availableRegions, availableProducts, availableLines };
}

/** "2026-06-01" → "2026-05-01"; "2026-01-01" → "2025-12-01"; invalid input → null. */
function shiftCycleMonthBack(cycleMonth: string): string | null {
  if (!/^\d{4}-\d{2}-01$/.test(cycleMonth)) return null;
  const year = Number(cycleMonth.slice(0, 4));
  const month = Number(cycleMonth.slice(5, 7));
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  return `${prevYear}-${String(prevMonth).padStart(2, "0")}-01`;
}

export type PortalWeeklyMover = {
  code: string;
  label: string;
  value: number;
  prevValue: number;
  deltaPct: number;
};

export type PortalWeeklyComparison = {
  previousCycleMonth: string | null;
  prevValueByCode: {
    region: Record<string, number>;
    product: Record<string, number>;
    distributor: Record<string, number>;
  };
  gainers: PortalWeeklyMover[];
  decliners: PortalWeeklyMover[];
};

function valueByCode(rows: WeeklyRanked[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) out[row.code] = row.salesValue;
  return out;
}

async function computeWeeklyComparison(
  filters: PortalWeeklyFilters,
  scope: PortalWeeklyScope,
  currentData: WeeklyDashboard,
): Promise<PortalWeeklyComparison | null> {
  const currentCycleMonth =
    filters.cycleMonths && filters.cycleMonths.length === 1
      ? filters.cycleMonths[0]
      : (currentData.availableMonths[0]?.code ?? null);

  if (!currentCycleMonth) return null;
  const previousCycleMonth = shiftCycleMonthBack(currentCycleMonth);
  if (!previousCycleMonth) return null;

  let prevData: WeeklyDashboard;
  try {
    prevData = await loadWeeklyDashboard({
      cycleMonths: [previousCycleMonth],
      cycleMonthMode: "include",
      // This call exists only to read three aggregate maps for ONE month (prevValueByCode below), but
      // `cycleMonths` alone filters in memory — so it was fetching EVERY validated row of every month,
      // a second full-history scan running right behind the current-period one. We discard prevData's
      // option universes entirely, which is exactly the precondition narrowRowsToCycleMonths requires.
      narrowRowsToCycleMonths: [previousCycleMonth],
      weekNumbers: filters.weekNumbers,
      weekNumberMode: filters.weekNumberMode,
      distributorCodes: filters.distributorCodes,
      distributorFilterMode: filters.distributorFilterMode,
      regionCodes: filters.regionCodes,
      regionFilterMode: filters.regionFilterMode,
      productCodes: filters.productCodes,
      productFilterMode: filters.productFilterMode,
      lineCodes: filters.lineCodes,
      lineFilterMode: filters.lineFilterMode,
      accessScope: scope.accessScope,
      allWeeks: true,
    });
  } catch {
    return null;
  }

  // If the previous month returned nothing (empty month), skip the comparison.
  const hasData =
    prevData.regions.length > 0 ||
    prevData.products.length > 0 ||
    prevData.distributorBreakdown.length > 0;
  if (!hasData) return null;

  const prevValueByCode = {
    region: valueByCode(prevData.regions),
    product: valueByCode(prevData.products),
    distributor: valueByCode(prevData.distributorBreakdown),
  };

  const moves: PortalWeeklyMover[] = currentData.products.map((row) => {
    const prevValue = prevValueByCode.product[row.code] ?? 0;
    const deltaPct = prevValue > 0 ? (row.salesValue - prevValue) / prevValue : 0;
    return { code: row.code, label: row.name, value: row.salesValue, prevValue, deltaPct };
  }).filter((m) => m.prevValue > 0);

  const gainers = [...moves].filter((m) => m.deltaPct > 0).sort((a, b) => b.deltaPct - a.deltaPct).slice(0, 3);
  const decliners = [...moves].filter((m) => m.deltaPct < 0).sort((a, b) => a.deltaPct - b.deltaPct).slice(0, 3);

  return { previousCycleMonth, prevValueByCode, gainers, decliners };
}

export type PortalWeeklyFilters = {
  cycleMonths?: string[];
  cycleMonthMode?: WeeklyFilterMode;
  weekNumbers?: number[];
  weekNumberMode?: WeeklyFilterMode;
  distributorCodes?: string[];
  distributorFilterMode?: WeeklyFilterMode;
  regionCodes?: string[];
  regionFilterMode?: WeeklyFilterMode;
  productCodes?: string[];
  productFilterMode?: WeeklyFilterMode;
  lineCodes?: string[];
  lineFilterMode?: WeeklyFilterMode;
};

export async function getPortalWeeklyDashboard(
  filters: PortalWeeklyFilters,
  ctx: AccessContext,
  // OPT-IN, deliberately. Building the field force costs the row grain plus two supporting index
  // reads, and two of this function's four callers never show it: the export route builds its own
  // workbook, and the CEO command centre reads only a trend line. Defaulting it ON would have made
  // both slower for nothing.
  options?: { includeFieldForce?: boolean },
): Promise<{
  data: WeeklyDashboard;
  scope: PortalWeeklyScope;
  comparison: PortalWeeklyComparison | null;
  fieldForce: PortalWeeklyFieldForce | null;
}> {
  const scope = await resolvePortalWeeklyScope(ctx);
  const includeFieldForce = options?.includeFieldForce === true;

  // The two supporting indexes the Field Force tab needs are independent of the dashboard load, so
  // they are fetched ALONGSIDE it rather than after it — the tab costs one round trip of latency,
  // not three. Both fail soft on their own, which is why neither can take the page down.
  const [data, areaSplit, seatIndex] = await Promise.all([
    loadWeeklyDashboard({
      cycleMonths: filters.cycleMonths,
      cycleMonthMode: filters.cycleMonthMode,
      weekNumbers: filters.weekNumbers,
      weekNumberMode: filters.weekNumberMode,
      distributorCodes: filters.distributorCodes,
      distributorFilterMode: filters.distributorFilterMode,
      regionCodes: filters.regionCodes,
      regionFilterMode: filters.regionFilterMode,
      productCodes: filters.productCodes,
      productFilterMode: filters.productFilterMode,
      lineCodes: filters.lineCodes,
      lineFilterMode: filters.lineFilterMode,
      accessScope: scope.accessScope,
      allWeeks: true,
      // The row grain the Field Force tab is built from. Deliberately NOT paired with
      // excludeUnmapped: the two tabs sit on one screen under one filter bar, so the rep rows must
      // add to the KPI strip above them. Dropping unmapped SKUs here would make the field force
      // read SHORT against the same page's own total, which is the one discrepancy a reader cannot
      // explain. Unmapped products surface on the Completeness tracker instead, where they belong.
      includeFactRows: includeFieldForce,
    }),
    // The owner's depot-split rule. Fails soft to an empty index, which simply means no branch is
    // split and only hand-mapped branches reach a rep.
    includeFieldForce ? loadWeeklyAreaSplitIndex().catch(() => null) : Promise.resolve(null),
    includeFieldForce ? loadFieldForceSeatIndex() : Promise.resolve(null),
  ]);

  const trimmed = trimWeeklyFilterOptions(data, scope);
  const comparison = await computeWeeklyComparison(filters, scope, trimmed);

  const fieldForce = seatIndex
    ? buildPortalWeeklyFieldForce({
        rows: data.factRows ?? [],
        areaSplit,
        seatIndex,
        // The dashboard's stable product universe, so column N is the same product on every rep's
        // row and in every scope — the same reason the NSM/DSM workbook takes a productAxis.
        productAxis: trimmed.availableProducts.map((option) => ({ code: option.code, name: option.name })),
        weekComparison: trimmed.weekComparison,
        seatIndexUnavailable: seatIndex.seats.length === 0,
      })
    : null;

  // Never ship the row grain to the browser. It is thousands of rows per month and the client has no
  // use for it — everything the screen renders is already aggregated into `fieldForce`.
  const { factRows: _factRows, ...clientSafe } = trimmed;

  return { data: clientSafe, scope, comparison, fieldForce };
}
