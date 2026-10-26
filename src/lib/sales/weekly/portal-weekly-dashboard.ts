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
// The access scope is enforced inside loadWeeklyDashboard via applyWeeklyAccessScope — or, for a
// district or regional manager, via his own areas' share of every depot (own-area-share.ts), which
// every figure on his screen follows (owner, 2026-09-17). This wrapper computes filter visibility,
// trims option lists, and runs the comparison.

import { type AccessContext, type PhoenixRole } from "@/lib/auth/permissions";
import {
  resolveWeeklyAccessScope,
  type WeeklyAccessScope,
} from "@/lib/sales/weekly/access";
import { latestNonFuturePeriod } from "@/lib/sales/periods";
import { loadWeeklyAreaSplitIndex } from "@/lib/sales/weekly/branch-area-split";
import { resolveWeeklyOwnAreaKeys, weeklyScopeOwnAreaKeys } from "@/lib/sales/weekly/own-area-scope";
import { mayLiftWeeklyGeography, type WeeklyOwnAreaShare } from "@/lib/sales/weekly/own-area-share";
import {
  buildPortalWeeklyFieldForce,
  loadFieldForceSeatIndex,
  type FieldForceSeatIndex,
  type PortalWeeklyFieldForce,
} from "@/lib/sales/weekly/portal-weekly-field-force";
import { loadWeeklyScopeRegionNames, weeklyScopeRegionPart } from "@/lib/sales/weekly/scope-region-names";
import { loadWeeklyDashboard } from "@/lib/sales/weekly/service";
import type {
  WeeklyDashboard,
  WeeklyFilterMode,
  WeeklyRanked,
} from "@/lib/sales/weekly/types";

/**
 * Roles allowed to open the portal Weekly Sales dashboard, its API and its export. Medical Reps stay
 * excluded: the same page gives a rep his own area's screen instead (PORTAL_WEEKLY_REP_ROLES in
 * portal-weekly-rep.ts), never this territory dashboard.
 */
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

/**
 * The company-wide readers, who open this same dashboard on the admin Field Sales page rather than
 * the portal: the CEO, the Super Admin and the SFE Manager.
 *
 * The SFE Manager holds full weekly access in access.ts (company-wide oversight, minus the
 * confidential Lacto Basic), and his own overview links him to that page — yet the page and every
 * one of its five feeds admitted the CEO and the Super Admin alone and sent him back to /admin
 * (owner, 2026-10-20: every role a module applies to must find it). One list, so the next gate
 * cannot be written with the old two.
 */
export const COMPANY_WEEKLY_READER_ROLES = ["CEO", "Super Admin", "SFE Manager"] as const satisfies readonly PhoenixRole[];

const COMPANY_WEEKLY_READER_ROLE_SET = new Set<PhoenixRole>(COMPANY_WEEKLY_READER_ROLES);

export function isCompanyWeeklyReader(role: PhoenixRole): boolean {
  return COMPANY_WEEKLY_READER_ROLE_SET.has(role);
}

/**
 * Who may read the managers' Weekly Sales feeds and their downloads: the portal roles above, and the
 * company-wide readers. A Medical Rep is neither — he reads his own area's screen.
 */
export function mayReadManagersWeeklySales(role: PhoenixRole): boolean {
  return isPortalWeeklyRole(role) || isCompanyWeeklyReader(role);
}

/**
 * Who may download the NSM/DSM workbook from the PORTAL (owner, 2026-10-17): a national sales
 * manager and a regional manager, each scoped to his own numbers, choosing nothing but the month.
 *
 * A NARROWER list than PORTAL_WEEKLY_ROLES on purpose — it is the two seats he named. A district
 * manager keeps the Depot Detail and Field Force downloads he already has; a product or marketing
 * manager is scoped by PRODUCT, and this book is laid out by area, branch and manager, so it would
 * read as a territory book with most of its territory missing.
 */
export const PORTAL_NSM_DSM_EXPORT_ROLES = [
  "National Sales Manager",
  "Regional Manager",
] as const satisfies readonly PhoenixRole[];

const PORTAL_NSM_DSM_EXPORT_ROLE_SET = new Set<PhoenixRole>(PORTAL_NSM_DSM_EXPORT_ROLES);

/**
 * CEO and Super Admin are admitted alongside them: they already hold this button on the admin Field
 * Sales page, and without them the control would be invisible on the portal page to the only two
 * accounts that can check it.
 */
export function mayDownloadPortalNsmDsmExport(role: PhoenixRole): boolean {
  return PORTAL_NSM_DSM_EXPORT_ROLE_SET.has(role) || role === "CEO" || role === "Super Admin";
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
  /**
   * Whether to offer the NSM/DSM workbook download (mayDownloadPortalNsmDsmExport). Decided here, on
   * the server, so the control is not shown to someone the route would then refuse — and the route
   * re-asks the same question rather than trusting this flag.
   */
  canDownloadNsmDsmExport: boolean;
};

export function toPortalWeeklyScopeView(scope: PortalWeeklyScope): PortalWeeklyScopeView {
  return {
    role: scope.role,
    visibility: scope.visibility,
    scopeSummary: scope.scopeSummary,
    isSingleRegion: scope.isSingleRegion,
    canDownloadNsmDsmExport: mayDownloadPortalNsmDsmExport(scope.role),
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
  /**
   * The organogram's region names (scope-region-names.ts), read only when the scope line names a region. The
   * Depot Detail tab builds its own scope line from these same names, so the two never disagree.
   */
  regionNames: ReadonlyMap<string, string>;
};

/** The scope line, in names: a single bound region is named from the organogram, never printed as its code. Pure. */
export function buildWeeklyScopeSummary(
  scope: WeeklyAccessScope,
  role: PhoenixRole,
  regionNames: ReadonlyMap<string, string>,
): string {
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
      parts.push(weeklyScopeRegionPart(scope.allowedRegionCodes, regionNames));
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
  // Depot rows keep the region label they were mapped with, so the dashboard's own region options never name
  // Upper Egypt 1, Upper Egypt 2 or Delta (3). The scope line names the region from the organogram instead.
  const regionNames = await loadWeeklyScopeRegionNames(accessScope);

  let allowedRegionCodes: Set<string> | null = null;
  let allowedProductCodes: Set<string> | null = null;

  if (accessScope.tier === "territory") {
    allowedRegionCodes = accessScope.allowedRegionCodes;
  } else if (accessScope.tier === "product") {
    allowedProductCodes = accessScope.productCodes;
  }

  const isSingleRegion = allowedRegionCodes !== null && allowedRegionCodes.size === 1;
  const visibility = computePortalWeeklyVisibility(role, allowedRegionCodes, accessScope.tier === "full");
  const scopeSummary = buildWeeklyScopeSummary(accessScope, role, regionNames);

  return {
    accessScope,
    role,
    allowedRegionCodes,
    allowedProductCodes,
    isSingleRegion,
    visibility,
    scopeSummary,
    regionNames,
  };
}

/**
 * Trim option arrays to the viewer's in-scope universe. A manager whose rows follow his own areas keeps
 * every region those rows carry: his areas are filed under the organogram's regions, which his depot-label
 * region bound does not name, and the rows are already his.
 */
function trimWeeklyFilterOptions(
  data: WeeklyDashboard,
  scope: PortalWeeklyScope,
  followsOwnAreas = false,
): WeeklyDashboard {
  const { allowedRegionCodes, allowedProductCodes } = scope;

  let availableRegions = data.availableRegions;
  let availableProducts = data.availableProducts;
  let availableLines = data.availableLines;

  if (allowedRegionCodes !== null && !followsOwnAreas) {
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
  // The current month's own-area share, so last month is measured over the same areas.
  ownAreaShare: Promise<WeeklyOwnAreaShare> | null,
): Promise<PortalWeeklyComparison | null> {
  // The month the screen is ON: the one asked for, or the one the first-paint default opened on
  // (appliedFilters carries it), else the latest that has started.
  const appliedMonths = currentData.appliedFilters.cycleMonths;
  const currentCycleMonth =
    filters.cycleMonths && filters.cycleMonths.length === 1
      ? filters.cycleMonths[0]
      : filters.defaultToLatestStartedMonth && appliedMonths.length === 1
        ? appliedMonths[0]
        : // THE FUTURE-MONTH RULE: "all months" compares the latest month that has started, never an
        // uploaded month ahead of today (a Direct order collecting next month books one).
        (latestNonFuturePeriod(currentData.availableMonths.map((month) => month.code)) ?? null);

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
      ownAreaShare,
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
  /** First paint only: open on the newest month that has started when none was named (see loadWeeklyDashboard). */
  defaultToLatestStartedMonth?: boolean;
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
  /** The "Units for" pick — see loadWeeklyDashboard unitProductCode. Moves units only, never a value. */
  unitProductCode?: string | null;
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
  // A district or regional manager's EVERY figure follows his own areas (owner, 2026-09-17): the KPIs,
  // movers, trend, week comparison, rankings, breakdowns, the export and the Field Force tab all read his
  // areas' share of each depot, and money placed in another manager's area leaves. Depot rows keep the
  // region label they were mapped with, so a region-bound load both missed the "UE" rows the split
  // shares with an Upper Egypt 2 manager and counted Qalubeya whole for Delta (1) after it became
  // Delta (3)'s. Everyone else (an NSM, a product manager, a company viewer) loads as before.
  const ownAreaKeys = weeklyScopeOwnAreaKeys(scope.accessScope);
  const followsOwnAreas = mayLiftWeeklyGeography(scope.accessScope, ownAreaKeys);
  const needsIndexes = includeFieldForce || followsOwnAreas;

  // The two supporting indexes are independent of the rows, so they are fetched ALONGSIDE the load
  // rather than after it. Both fail soft on their own, which is why neither can take the page down.
  const areaSplitLoad = needsIndexes ? loadWeeklyAreaSplitIndex().catch(() => null) : Promise.resolve(null);
  const seatIndexLoad: Promise<FieldForceSeatIndex | null> = needsIndexes
    ? loadFieldForceSeatIndex()
    : Promise.resolve(null);
  const ownAreaShare = followsOwnAreas
    ? Promise.all([areaSplitLoad, seatIndexLoad]).then(([areaSplit, seatIndex]) => ({ ownAreaKeys, areaSplit, seatIndex }))
    : null;

  const [data, areaSplit, seatIndex] = await Promise.all([
    loadWeeklyDashboard({
      cycleMonths: filters.cycleMonths,
      cycleMonthMode: filters.cycleMonthMode,
      defaultToLatestStartedMonth: filters.defaultToLatestStartedMonth,
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
      unitProductCode: filters.unitProductCode,
      accessScope: scope.accessScope,
      allWeeks: true,
      // The row grain the Field Force tab is built from. Deliberately NOT paired with
      // excludeUnmapped: the two tabs sit on one screen under one filter bar, so the rep rows must
      // add to the KPI strip above them. Dropping unmapped SKUs here would make the field force
      // read SHORT against the same page's own total, which is the one discrepancy a reader cannot
      // explain. Unmapped products surface on the Completeness tracker instead, where they belong.
      includeFactRows: includeFieldForce,
      // Unrounded, as Depot Detail reads them: the tab totals these rows under the Sales Value tile, and a
      // manager's rows are many small split shares, so cents rounded row by row add up to a visible pound
      // (Sally Saied, September: 285,878 against 285,879). The rows never leave the server.
      factRowsFullPrecision: includeFieldForce,
      ownAreaShare,
    }),
    areaSplitLoad,
    includeFieldForce ? seatIndexLoad : Promise.resolve(null),
  ]);

  const trimmed = trimWeeklyFilterOptions(data, scope, followsOwnAreas);
  const comparison = await computeWeeklyComparison(filters, scope, trimmed, ownAreaShare);

  const fieldForce = seatIndex
    ? buildPortalWeeklyFieldForce({
        rows: data.factRows ?? [],
        areaSplit,
        seatIndex,
        // The dashboard's stable product universe, so column N is the same product on every rep's
        // row and in every scope — the same reason the NSM/DSM workbook takes a productAxis.
        productAxis: trimmed.availableProducts.map((option) => ({ code: option.code, name: option.name })),
        // Flagged per depot, over the rows that count on this grid (owner, 2026-09-17): a pooled flag lets
        // one depot's sheet hide another depot's missing week.
        depotWeekGaps: data.factRowDepotWeekGaps ?? [],
        seatIndexUnavailable: seatIndex.seats.length === 0,
      })
    : null;

  // Never ship the row grain to the browser. It is thousands of rows per month and the client has no
  // use for it — everything the screen renders is already aggregated into `fieldForce`. The depot gap
  // list goes with it: it is read over every loaded row, so it names depots and weeks beyond his scope.
  const { factRows: _factRows, factRowDepotWeekGaps: _factRowDepotWeekGaps, ...clientSafe } = trimmed;

  return { data: clientSafe, scope, comparison, fieldForce };
}

/**
 * One month's Field Force grid and nothing else, for the month-pace strip on the portal Source of Sales
 * page. Lighter than getPortalWeeklyDashboard — the strip reads only the grid, so there is no
 * comparison month and no option trimming — and, like every weekly report, it leaves unmapped products
 * out (excludeUnmapped), which is also how the medical rep's own Weekly Sales page reads a month.
 *
 * The load follows the viewer's own areas (own-area-share.ts), exactly as his Weekly Sales screen does.
 * A medical rep needs that as much as a manager: an Upper Egypt 2 rep's region-bound load never fetched
 * the "UE" depot rows at all, so his strip read about zero. His own areas are his filled rep seats, from
 * the same seat index the grid is keyed by. null when the viewer has no weekly access.
 */
export async function getPortalWeeklyMonthFieldForce(
  ctx: AccessContext,
  cycleMonth: string,
): Promise<PortalWeeklyFieldForce | null> {
  const [accessScope, seatIndex] = await Promise.all([resolveWeeklyAccessScope(ctx), loadFieldForceSeatIndex()]);
  if (accessScope.tier === "none") return null;

  const areaSplitLoad = loadWeeklyAreaSplitIndex().catch(() => null);
  const ownAreaKeys = await resolveWeeklyOwnAreaKeys(ctx, accessScope, seatIndex.seats);
  const ownAreaShare = mayLiftWeeklyGeography(accessScope, ownAreaKeys)
    ? areaSplitLoad.then((areaSplit) => ({ ownAreaKeys, areaSplit, seatIndex }))
    : null;

  const [data, areaSplit] = await Promise.all([
    loadWeeklyDashboard({
      cycleMonths: [cycleMonth],
      cycleMonthMode: "include",
      // Only the grid is read, never the option lists, which is the precondition for narrowing the fetch.
      narrowRowsToCycleMonths: [cycleMonth],
      accessScope,
      allWeeks: true,
      excludeUnmapped: true,
      includeFactRows: true,
      ownAreaShare,
    }),
    areaSplitLoad,
  ]);

  return buildPortalWeeklyFieldForce({
    rows: data.factRows ?? [],
    areaSplit,
    seatIndex,
    depotWeekGaps: data.factRowDepotWeekGaps ?? [],
    seatIndexUnavailable: seatIndex.seats.length === 0,
  });
}
