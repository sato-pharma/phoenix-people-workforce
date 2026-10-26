import type { AccessContext, PhoenixRole } from "@/lib/auth/permissions";
import { listPublishedPeriodsForLine } from "@/lib/sales/monthly-closing-publication";
import { loadAchievementRange } from "@/lib/sales/vs-target";

import { fetchTerritoryAreaPharmacies } from "./pharmacies";
import { resolveTerritoryRootScope } from "./root-scope";
import {
  buildTerritorySkeleton,
  deniedSkeleton,
  loadLineAreas,
  resolveAuLineCode,
  territoryAsOfDate,
} from "./skeleton";
import { sumTerritoryClosingTotals } from "./totals";
import type {
  TerritoryAreaPayload,
  TerritoryClosingTotals,
  TerritoryRootScope,
  TerritorySkeleton,
} from "./types";
import { TERRITORY_DEFAULT_WINDOW_MONTHS, territoryWindow, type TerritoryWindow } from "./window";

export { isTerritoryLinePickerRole, TERRITORY_LINE_PICKER_ROLES } from "./root-scope";
export { TERRITORY_PICKER_LINES } from "./skeleton";

/** Thrown when a request's resolved territory scope denies it — the API layer maps this to 403. */
export class TerritoryAccessError extends Error {}

// Every role the Territory Drilldown module serves. Medical Rep / District Manager / Regional
// Manager / National Sales Manager each drill their OWN single line's seat tree; Super Admin and
// CEO see every line, so they pick one and drill it nationwide (see TERRITORY_LINE_PICKER_ROLES in
// root-scope.ts). Mirrors the PORTAL_SOS_ROLES / isPortalSosRole precedent in
// portal-sos-dashboard.ts: the role gate lives with the domain service, not the API route, so the
// page and every route agree.
export const TERRITORY_DRILLDOWN_ROLES = [
  "Medical Rep",
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
  "Super Admin",
  "CEO",
] as const satisfies readonly PhoenixRole[];

const TERRITORY_DRILLDOWN_ROLE_SET = new Set<PhoenixRole>(TERRITORY_DRILLDOWN_ROLES);

export function isTerritoryDrilldownRole(role: PhoenixRole): boolean {
  return TERRITORY_DRILLDOWN_ROLE_SET.has(role);
}

/** The drilled line's window — ending at its newest published closing, never the open month or a
 *  month a forward-dated order created (see territory/window.ts). */
async function resolveTerritoryWindow(officialLine: string, months: number): Promise<TerritoryWindow> {
  return territoryWindow(await listPublishedPeriodsForLine(officialLine), months);
}

/** Server-side stage timing for the drilldown's first paint, one line per render, so production
 *  logs name the slow stage (root scope, published window, skeleton) instead of a guess. */
function logTerritoryTiming(stage: string, startedAt: number, stages: Record<string, number>) {
  console.info(
    `[territory-drilldown] ${stage} ${JSON.stringify({ totalMs: Math.round(performance.now() - startedAt), ...stages })}`,
  );
}

export async function getTerritorySkeleton(
  ctx: AccessContext,
  selectedLine?: string | null,
): Promise<TerritorySkeleton> {
  const startedAt = performance.now();
  const rootScope = await resolveTerritoryRootScope(ctx, selectedLine);
  const rootScopeMs = Math.round(performance.now() - startedAt);
  if (rootScope.level === "denied") {
    return deniedSkeleton(ctx.role, rootScope.diagnostic);
  }
  const windowStartedAt = performance.now();
  const drillWindow = await resolveTerritoryWindow(rootScope.officialLine, TERRITORY_DEFAULT_WINDOW_MONTHS);
  const windowMs = Math.round(performance.now() - windowStartedAt);
  const skeletonStartedAt = performance.now();
  const windowEnd = drillWindow.periods[drillWindow.periods.length - 1];
  const skeleton = await buildTerritorySkeleton(ctx.role, rootScope, territoryAsOfDate(windowEnd));
  logTerritoryTiming("skeleton", startedAt, {
    rootScopeMs,
    windowMs,
    skeletonMs: Math.round(performance.now() - skeletonStartedAt),
    areas: skeleton.areas.length,
    bricks: skeleton.bricks.length,
  });
  return { ...skeleton, window: drillWindow };
}

/**
 * Whether `areaCode` is actually inside the caller's resolved scope. For "region" (District
 * Manager today) and "nationwide" (future National Sales Manager) this MUST check the same
 * line-scoped organogram seat structure buildTerritorySkeleton uses to list areas — not just
 * region membership — or a viewer could fetch a sibling line's area (e.g. a region's Anti
 * Infective DM requesting a CNS-only area) even though it never appears in their own tree. A
 * region routinely hosts a separate DM seat per line, each covering a different subset of
 * that region's areas (see loadLineAreas), so "same region" alone is not "in my territory".
 */
async function isAreaInRootScope(
  areaCode: string,
  rootScope: Exclude<TerritoryRootScope, { level: "denied" }>,
  asOf: string,
): Promise<boolean> {
  if (rootScope.level === "area") {
    return rootScope.sosAreaCodes.includes(areaCode);
  }
  const auLineCode = resolveAuLineCode(rootScope.officialLine);
  if (!auLineCode) return false;
  const regionCodes =
    rootScope.level === "region" ? new Set(rootScope.regionCodes.map((code) => code.toUpperCase())) : null;
  // As of the SAME window end the fetch is for, so an area's membership matches the list the
  // skeleton showed — validating against today's geography would 403 an area a forward-dated move
  // has not yet reached, or admit one it already left.
  const lineAreas = await loadLineAreas(auLineCode, regionCodes, asOf);
  return lineAreas.some((area) => area.areaCode.toUpperCase() === areaCode);
}

/**
 * The lazy per-area pharmacy fetch. Re-derives resolveTerritoryRootScope on EVERY call and
 * checks the requested area against it — the server boundary is authoritative on every
 * request, not just at page load, so a client asking for an out-of-scope area gets denied
 * here regardless of what the (already-scoped) skeleton it was given shows.
 */
export async function getTerritoryAreaPharmacies(
  ctx: AccessContext,
  areaCode: string,
  months: number,
  selectedLine?: string | null,
): Promise<TerritoryAreaPayload & { periods: string[] }> {
  const rootScope = await resolveTerritoryRootScope(ctx, selectedLine);
  if (rootScope.level === "denied") {
    throw new TerritoryAccessError(rootScope.diagnostic.message);
  }

  // The SAME window the page labelled: resolved from the drilled line's published closings here,
  // never from the request, so a client cannot widen it into the open month.
  const { periods } = await resolveTerritoryWindow(rootScope.officialLine, months);
  const asOf = territoryAsOfDate(periods[periods.length - 1]);
  const normalizedAreaCode = areaCode.trim().toUpperCase();
  if (!normalizedAreaCode || !(await isAreaInRootScope(normalizedAreaCode, rootScope, asOf))) {
    throw new TerritoryAccessError(`Area "${areaCode}" is outside your territory.`);
  }

  return { periods, ...(await fetchTerritoryAreaPharmacies(normalizedAreaCode, periods, rootScope.officialLine)) };
}

/**
 * Region and area totals at a glance, from the closing engine over the window's published months
 * (see territory/totals.ts). Re-derives the caller's scope and skeleton on this request, so the
 * totals cover exactly the areas the caller's own tree shows — never a sibling line's or region's.
 */
export async function getTerritoryClosingTotals(
  ctx: AccessContext,
  selectedLine?: string | null,
): Promise<TerritoryClosingTotals> {
  const startedAt = performance.now();
  const rootScope = await resolveTerritoryRootScope(ctx, selectedLine);
  if (rootScope.level === "denied") {
    throw new TerritoryAccessError(rootScope.diagnostic.message);
  }
  const auLineCode = resolveAuLineCode(rootScope.officialLine);
  const drillWindow = await resolveTerritoryWindow(rootScope.officialLine, TERRITORY_DEFAULT_WINDOW_MONTHS);
  const periods = drillWindow.publishedPeriods;
  if (!auLineCode || periods.length === 0) {
    return { periods, areaValues: {}, regionValues: {}, regionOtherValues: {}, outsideRegionsValue: null };
  }
  const [skeleton, rows] = await Promise.all([
    buildTerritorySkeleton(ctx.role, rootScope, territoryAsOfDate(drillWindow.periods[drillWindow.periods.length - 1])),
    loadAchievementRange(periods[0], periods[periods.length - 1]),
  ]);
  const totals = sumTerritoryClosingTotals({
    rows,
    auLineCode,
    areas: skeleton.areas,
    periods,
    includeOtherAreas: rootScope.level !== "area",
    nationwide: rootScope.level === "nationwide",
  });
  logTerritoryTiming("closing-totals", startedAt, { months: periods.length, areas: skeleton.areas.length });
  return totals;
}
