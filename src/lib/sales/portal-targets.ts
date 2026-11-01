// ─────────────────────────────────────────────────────────────────────────────
// Targets — READ-ONLY scoped view for the field sales management roles.
//
// Until now /sales/targets was gated end-to-end on `sales:import`, which only Super Admin and
// SFE Manager hold. That made Targets a two-role module with NO view/edit split at all — not even
// the CEO could open it, and District / Regional / National Sales Managers had no targets surface
// anywhere. This module adds the READ side only:
//
//   * every WRITE route (save / upload / template / breakdown-export) stays on `sales:import`
//   * the read path is `sales:read` PLUS the area bound below
//
// SCOPE IS BY AREA CODE, NEVER BY REGION NAME. A District Manager's territory comes from the
// organogram seat -> `au_v_line_area_map` area codes (see ./seat-area-scope.ts). Six areas exist
// where the operational owner differs from the geographic region label, so filtering a DM by their
// region label both hides areas they own and shows areas they do not. That exact substitution was a
// real production bug (PR #1479). `resolveSalesGeographyBound` already encodes the right precedence:
// area codes when the seat resolved, region codes only as the fallback.
//
// FAILS CLOSED. A non-company role whose scope resolves to "no bound at all" sees NOTHING, not
// everything. This is deliberately the opposite of resolveSeatAreaScope's fail-soft-to-null: there,
// null means "keep the caller's existing narrower region bound"; here there is no pre-existing
// bound, so treating null as "all" would be a company-wide leak.
// ─────────────────────────────────────────────────────────────────────────────

import type { AccessContext, PhoenixRole } from "@/lib/auth/permissions";
import { areaInBoundForMonth } from "@/lib/org/sales-only-seats";
import { resolveSalesAccessScope, resolveSalesGeographyBound, type SalesAccessScope } from "@/lib/sales/access-scope";
import type { AchievementRow } from "@/lib/sales/monthly-targets";

/**
 * Employee-portal-shell roles that get the read-only Targets view.
 *
 * Owner decision 2026-07-30: District / Regional / National Sales Manager, read-only. The Head-Office
 * "Manager" rung is excluded: it owns no field areas, so the bound below would fail it closed to an
 * empty grid — a dead tab is worse than no tab.
 *
 * Medical Rep is NOT in this list, and must never be added to it. Reps reach the same tab since
 * 2026-09-16 (owner), but through PORTAL_REP_TARGETS_ROLES below and their own view: the bound in
 * this module resolves a rep to their whole LINE (no seat areas, so `areaCodes` is null), and this
 * workspace would show one rep the targets and sales of every rep on it.
 */
export const PORTAL_TARGETS_ROLES = [
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
] as const satisfies readonly PhoenixRole[];

const portalTargetsRoleSet = new Set<PhoenixRole>(PORTAL_TARGETS_ROLES);

export function isPortalTargetsRole(role: PhoenixRole | string | null | undefined): boolean {
  return portalTargetsRoleSet.has(String(role ?? "").trim() as PhoenixRole);
}

/**
 * Portal roles that get the Targets tab as their OWN numbers only (owner, 2026-09-16).
 *
 * Bounded to the rows the attribution engine resolved to the viewer's HR id, never to a line or an
 * area list — see src/lib/sales/rep-targets.ts. Deliberately disjoint from PORTAL_TARGETS_ROLES, so
 * no role can ever resolve to both views.
 */
export const PORTAL_REP_TARGETS_ROLES = ["Medical Rep"] as const satisfies readonly PhoenixRole[];

const portalRepTargetsRoleSet = new Set<PhoenixRole>(PORTAL_REP_TARGETS_ROLES);

export function isPortalRepTargetsRole(role: PhoenixRole | string | null | undefined): boolean {
  return portalRepTargetsRoleSet.has(String(role ?? "").trim() as PhoenixRole);
}

/**
 * Admin-shell roles allowed to VIEW /sales/targets.
 *
 * Named explicitly rather than relying on `sales:read` alone: `sales:read` would also admit Finance
 * Manager and Financial Advisor, which nobody asked for. Fail closed with a list.
 */
export const TARGETS_ADMIN_VIEW_ROLES = [
  "Super Admin",
  "SFE Manager",
  "CEO",
] as const satisfies readonly PhoenixRole[];

const targetsAdminViewRoleSet = new Set<PhoenixRole>(TARGETS_ADMIN_VIEW_ROLES);

export function canViewTargetsAdminPage(access: Pick<AccessContext, "role" | "scope">): boolean {
  return access.scope === "system" || targetsAdminViewRoleSet.has(access.role);
}

/** The resolved row bound for one viewer. */
export type TargetsScopeBound = {
  /** COMPANY scope — every line, region and area. */
  canViewAllTargets: boolean;
  /** Area codes the viewer owns; null = no area-level bound (fall back to line). */
  areaCodes: Set<string> | null;
  /** Areas the viewer's seat answers for only in months before the one named (sales-only-seats.ts). */
  earlierMonthAreas?: Map<string, string>;
  /** Sales line codes ("cns" | "pedia" | "anti_infective"); null = every line. */
  lineCodes: Set<string> | null;
  /**
   * True for a District-Manager-class viewer (TEAM / HIERARCHY sales scope) whose organogram seat gave
   * no areas — unseated, a seat with no mapped areas, or a seat map that could not be read. The bound
   * is then an EMPTY area set (no rows) and the page says so in words; it is never his whole line.
   */
  territoryUnresolved?: boolean;
};

/** What the Targets page says when a District-Manager-class viewer has no areas to bound him to. */
export const TARGETS_TERRITORY_UNRESOLVED_MESSAGE =
  "Your areas could not be found on the organogram right now, so there are no targets to show. Refresh in a minute; if it stays empty, ask HR to check your seat on the People Organogram.";

/**
 * District-Manager-class sales scopes — TEAM (District Manager) and HIERARCHY (Regional Manager). Their
 * reach is their organogram seat's AREAS; with no areas they get nothing, never the line bound a
 * National Sales Manager or Product Manager legitimately holds (owner, 2026-10-26).
 */
export function isAreaBoundSalesScope(businessScope: string | null | undefined): boolean {
  return businessScope === "TEAM" || businessScope === "HIERARCHY";
}

/**
 * Official Source-of-Sales line name -> the `lineCode` used by phx_monthly_achievement / SALES_LINES.
 *
 * `SalesAccessScope.allowedLineNames` carries official names ("Anti Infective"), while an
 * AchievementRow carries a code ("anti_infective"). Pure and unit-tested: a silent mismatch here
 * blanks a manager's whole grid (fail-closed, but broken).
 */
export function salesLineCodeForOfficialLine(line: string | null | undefined): string | null {
  const normalized = String(line ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  if (!normalized) return null;
  if (normalized === "cns") return "cns";
  if (normalized === "pedia" || normalized === "pediatrics") return "pedia";
  if (normalized === "antiinfective" || normalized === "antiinfectives" || normalized === "anti") return "anti_infective";
  // Head Office and anything else is not a field sales line and carries no targets.
  return null;
}

function normalizeAreaCode(value: string | null | undefined): string {
  return String(value ?? "").trim().toUpperCase();
}

/**
 * Apply a viewer's bound to raw achievement rows. PURE — no DB, no AccessContext.
 *
 * Order matters at the call site: filter FIRST, then roll up. The admin page computes its line
 * total / by-region / by-DM cards from the same row array it renders, so rolling up before filtering
 * would show a District Manager their own rows in the grid but the WHOLE LINE's numbers in the
 * summary cards — an aggregate leak that is easy to miss because the table looks correct.
 */
export function filterAchievementForScope(rows: AchievementRow[], bound: TargetsScopeBound): AchievementRow[] {
  if (bound.canViewAllTargets) return rows;
  // No bound of any kind for a non-company viewer => the resolver could not place them. Show nothing.
  if (!bound.areaCodes && !bound.lineCodes) return [];

  return rows.filter((row) => {
    if (bound.lineCodes && !bound.lineCodes.has(String(row.lineCode ?? ""))) return false;
    if (bound.areaCodes) {
      // A row with no area code (the `isOther` bucket) cannot be attributed to this viewer's areas.
      const areaCode = normalizeAreaCode(row.areaCode);
      if (!areaCode || !areaInBoundForMonth(areaCode, row.period, bound.areaCodes, bound.earlierMonthAreas)) return false;
    }
    return true;
  });
}

/**
 * Resolve one viewer's bound, reusing the sales scope machinery rather than adding a second,
 * parallel notion of "scope" (resolveSalesAccessScope already composes the seat-area layer, the line
 * bound and the region fallback internally).
 */
export async function resolvePortalTargetsBound(ctx: AccessContext): Promise<TargetsScopeBound> {
  return targetsBoundFromSalesScope(await resolveSalesAccessScope(ctx));
}

/** The pure half of resolvePortalTargetsBound — no DB, directly unit-tested. */
export function targetsBoundFromSalesScope(scope: SalesAccessScope): TargetsScopeBound {
  if (scope.canViewAllSales) return { canViewAllTargets: true, areaCodes: null, lineCodes: null };

  // Region NAMES are not a usable bound for target rows (they key off region CODE + area code), so
  // the name->code mapper is intentionally a no-op here: when the seat gave us area codes we use
  // them, and otherwise we fall back to the line bound alone rather than guessing region codes.
  const bound = resolveSalesGeographyBound(scope, () => new Set<string>());

  // An empty result stays an EMPTY SET, never null: a set that matches nothing is fail-closed,
  // whereas null would mean "every line".
  const lineCodes = scope.allowedLineNames
    ? new Set(
        Array.from(scope.allowedLineNames)
          .map((name) => salesLineCodeForOfficialLine(name))
          .filter((code): code is string => Boolean(code)),
      )
    : null;

  const areaCodes =
    bound.areaCodes && bound.areaCodes.size > 0 ? new Set(Array.from(bound.areaCodes).map(normalizeAreaCode)) : null;

  // A District / Regional Manager with no seat areas used to come back { areaCodes: null, lineCodes:
  // {his line} }, and filterAchievementForScope reads a null area bound as "the whole line" — every
  // sibling district's targets. Fail closed instead: an EMPTY area set matches no row.
  if (!areaCodes && isAreaBoundSalesScope(scope.businessScope)) {
    return { canViewAllTargets: false, areaCodes: new Set(), lineCodes, territoryUnresolved: true };
  }

  return {
    canViewAllTargets: false,
    areaCodes,
    ...(scope.allowedEarlierMonthAreas ? { earlierMonthAreas: scope.allowedEarlierMonthAreas } : {}),
    // An empty line set means "no line resolved" -> keep it as an empty Set (matches nothing) rather
    // than null (matches everything). filterAchievementForScope then returns [] unless areas bound.
    lineCodes,
  };
}

/**
 * Guard for the per-area drill-down read (`/api/sales/targets/breakdown?area=...`).
 *
 * The route takes an ARBITRARY area code from the query string. Relaxing it from `sales:import` to
 * `sales:read` WITHOUT this check would let any District Manager enumerate every other area's
 * distributor / brick / customer detail just by editing the URL — the single biggest risk in opening
 * targets up for reading.
 *
 * The LINE is checked too (2026-10-26). An area code is not unique across lines — CA1 is a CNS area
 * AND a Pedia area, each with its own manager — and the route hands the caller's `line` straight to
 * the breakdown and trend reads. Checking the area alone let a CNS District Manager read the Pedia
 * detail of his own area code by editing `?line=`.
 */
export async function assertTargetsAreaInScope(
  ctx: AccessContext,
  areaCode: string,
  line: string | null | undefined,
  period?: string | null,
): Promise<void> {
  assertTargetsAreaInBound(await resolvePortalTargetsBound(ctx), areaCode, line, period);
}

/** The pure half of assertTargetsAreaInScope — no DB, directly unit-tested. */
export function assertTargetsAreaInBound(
  bound: TargetsScopeBound,
  areaCode: string,
  line: string | null | undefined,
  period?: string | null,
): void {
  if (bound.canViewAllTargets) return;
  const requested = normalizeAreaCode(areaCode);
  if (!requested) throw new Error("Forbidden: an area is required.");
  if (!bound.areaCodes || !areaInBoundForMonth(requested, period, bound.areaCodes, bound.earlierMonthAreas)) {
    throw new Error("Forbidden: that area is outside your territory.");
  }
  if (bound.lineCodes) {
    const lineCode = salesLineCodeForOfficialLine(line);
    if (!lineCode || !bound.lineCodes.has(lineCode)) {
      throw new Error("Forbidden: that line is outside your territory.");
    }
  }
}
