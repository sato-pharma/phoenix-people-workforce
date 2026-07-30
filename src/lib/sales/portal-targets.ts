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
import { resolveSalesAccessScope, resolveSalesGeographyBound } from "@/lib/sales/access-scope";
import type { AchievementRow } from "@/lib/sales/monthly-targets";

/**
 * Employee-portal-shell roles that get the read-only Targets view.
 *
 * Owner decision 2026-07-30: District / Regional / National Sales Manager, read-only. Medical Rep is
 * deliberately excluded (their target numbers reach them through the achievement/incentive
 * surfaces). The Head-Office "Manager" rung is excluded too: it owns no field areas, so the bound
 * below would fail it closed to an empty grid — a dead tab is worse than no tab.
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
  /** Sales line codes ("cns" | "pedia" | "anti_infective"); null = every line. */
  lineCodes: Set<string> | null;
};

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
      if (!areaCode || !bound.areaCodes.has(areaCode)) return false;
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
  const scope = await resolveSalesAccessScope(ctx);
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

  return {
    canViewAllTargets: false,
    areaCodes: bound.areaCodes && bound.areaCodes.size > 0 ? new Set(Array.from(bound.areaCodes).map(normalizeAreaCode)) : null,
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
 */
export async function assertTargetsAreaInScope(ctx: AccessContext, areaCode: string): Promise<void> {
  const bound = await resolvePortalTargetsBound(ctx);
  if (bound.canViewAllTargets) return;
  const requested = normalizeAreaCode(areaCode);
  if (!requested) throw new Error("Forbidden: an area is required.");
  if (!bound.areaCodes || !bound.areaCodes.has(requested)) {
    throw new Error("Forbidden: that area is outside your territory.");
  }
}
