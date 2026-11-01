// ─────────────────────────────────────────────────────────────────────────────
// Sales vs Target — who sees which rows.
//
// This dashboard is the first sales surface a MEDICAL REP can open (owner decision,
// 2026-08-04, reversing the 2026-07-30 call that kept reps out of portal Targets), and
// that is exactly why it needs its own bound instead of reusing resolvePortalTargetsBound.
//
// A rep's sales business scope is SELF. computeSalesAccessScope handles COMPANY and NONE
// explicitly but lets SELF fall through to the line/region path, and seat-derived
// `allowedAreaCodes` is non-null only for District / Regional Managers. So a rep resolves
// to { areaCodes: null, lineCodes: {their line} } — and filterAchievementForScope reads a
// null area bound as "no area restriction", which would show one medical rep the numbers
// of all 35 reps on their line. Verified against the resolver on 2026-08-04.
//
// The fix is a bound that names the SELF case rather than letting it fall through:
// a rep is bounded to rows the attribution engine already resolved to THEM
// (rep_hr_id = their HR id, computed from seat occupancy as of the period end), which is
// self-maintaining across transfers and needs no second territory lookup.
//
// DM / RM / NSM / company behaviour is deliberately IDENTICAL to portal Targets. This
// module adds a role; it does not relitigate what the existing roles already see on a
// sibling page.
// ─────────────────────────────────────────────────────────────────────────────

import type { AccessContext } from "@/lib/auth/permissions";
import { getSalesScope } from "@/lib/auth/permissions";
import { areaInBoundForMonth } from "@/lib/org/sales-only-seats";
import { resolveSalesAccessScope, resolveSalesGeographyBound, type SalesAccessScope } from "@/lib/sales/access-scope";
import { isAreaBoundSalesScope, salesLineCodeForOfficialLine } from "@/lib/sales/portal-targets";
import type { AchievementRow } from "@/lib/sales/monthly-targets";
import type { BrickSalesRow } from "@/lib/sales/vs-target";

/**
 * The resolved row bound for one viewer.
 *
 * A discriminated union rather than a bag of nullable sets, because the dangerous bug in
 * this area is a null field being read as "unbounded". Here every variant states what it
 * allows, and the default is `none`.
 */
export type VsTargetBound =
  | { kind: "company" }
  | { kind: "line"; lineCodes: Set<string> }
  | { kind: "areas"; areaCodes: Set<string>; lineCodes: Set<string> | null; earlierMonthAreas?: Map<string, string> }
  | { kind: "self"; hrId: string }
  | { kind: "none" };

/** How the viewer's reach is described in the UI. Never a code. */
export function boundLabel(bound: VsTargetBound): string {
  switch (bound.kind) {
    case "company":
      return "Company-wide";
    case "line":
      return "Your line";
    case "areas":
      return "Your territory";
    case "self":
      return "Your areas";
    case "none":
      return "No sales territory";
  }
}

function normalizeAreaCode(value: string | null | undefined): string {
  return String(value ?? "").trim().toUpperCase();
}

function normalizeIdentity(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * Resolve one viewer's bound.
 *
 * Order matters: SELF is tested BEFORE the geography fallbacks, because a rep does have a
 * line and a region and would otherwise be silently widened to both.
 */
export async function resolveVsTargetBound(ctx: AccessContext): Promise<VsTargetBound> {
  return vsTargetBoundFromSalesScope(await resolveSalesAccessScope(ctx), ctx);
}

/** The pure half of resolveVsTargetBound — no DB, directly unit-tested. */
export function vsTargetBoundFromSalesScope(
  scope: SalesAccessScope,
  ctx: Pick<AccessContext, "role" | "scope" | "hrId">,
): VsTargetBound {
  if (scope.canViewAllSales) return { kind: "company" };

  const businessScope = ctx.scope === "system" ? "COMPANY" : getSalesScope({ role: ctx.role });

  if (businessScope === "NONE") return { kind: "none" };

  if (businessScope === "SELF") {
    // The attribution engine keys reps by HR id. No HR id => we cannot identify whose rows
    // these are, so show nothing rather than fall back to a wider bound.
    const hrId = normalizeIdentity(ctx.hrId);
    return hrId ? { kind: "self", hrId } : { kind: "none" };
  }

  const lineCodes = scope.allowedLineNames
    ? new Set(
        Array.from(scope.allowedLineNames)
          .map((name) => salesLineCodeForOfficialLine(name))
          .filter((code): code is string => Boolean(code)),
      )
    : null;

  // Region NAMES are not a usable bound for these rows (they key off region CODE), so the
  // name->code mapper is a deliberate no-op: seat-derived area codes when they resolved,
  // the line bound otherwise. Same precedence portal Targets uses.
  const geography = resolveSalesGeographyBound(scope, () => new Set<string>());
  if (geography.areaCodes && geography.areaCodes.size > 0) {
    return {
      kind: "areas",
      areaCodes: new Set(Array.from(geography.areaCodes).map(normalizeAreaCode)),
      lineCodes: lineCodes && lineCodes.size > 0 ? lineCodes : null,
      ...(scope.allowedEarlierMonthAreas ? { earlierMonthAreas: scope.allowedEarlierMonthAreas } : {}),
    };
  }

  // A District / Regional Manager whose seat gave no areas (unseated, a seat with no mapped areas, or
  // an organogram read that failed) is NOT a line viewer. Handing him the line bound showed him every
  // sibling district's sales (2026-10-26). Only a genuinely line-scoped role — National Sales
  // Manager, Product Manager, Group Product Manager, Marketing Manager — takes the line below.
  if (isAreaBoundSalesScope(scope.businessScope)) return { kind: "none" };

  if (lineCodes && lineCodes.size > 0) return { kind: "line", lineCodes };

  // A non-company viewer we could not place anywhere. Fail closed — an unresolved bound
  // must never mean "everything".
  return { kind: "none" };
}

/**
 * Apply a bound to achievement rows. PURE — no DB, no AccessContext, directly unit-tested.
 *
 * MUST run before any roll-up. Rolling up first and filtering after produces a table that
 * looks correctly scoped sitting under summary cards that total the whole company.
 */
export function filterRowsForBound(rows: AchievementRow[], bound: VsTargetBound): AchievementRow[] {
  switch (bound.kind) {
    case "company":
      return rows;
    case "none":
      return [];
    case "self":
      return rows.filter((row) => normalizeIdentity(row.repHrId) === bound.hrId);
    case "line":
      return rows.filter((row) => row.lineCode != null && bound.lineCodes.has(row.lineCode));
    case "areas":
      return rows.filter((row) => {
        if (bound.lineCodes && (row.lineCode == null || !bound.lineCodes.has(row.lineCode))) return false;
        // A row with no area (the direct-at-region and "Other" buckets) cannot be
        // attributed to this viewer's areas, so it is not theirs to see.
        const areaCode = normalizeAreaCode(row.areaCode);
        return Boolean(areaCode) && areaInBoundForMonth(areaCode, row.period, bound.areaCodes, bound.earlierMonthAreas);
      });
  }
}

/** The same bound applied to brick rows, so a drill-down can never out-reach the page. */
export function filterBricksForBound(rows: BrickSalesRow[], bound: VsTargetBound): BrickSalesRow[] {
  switch (bound.kind) {
    case "company":
      return rows;
    case "none":
      return [];
    case "self":
      return rows.filter((row) => normalizeIdentity(row.repHrId) === bound.hrId);
    case "line":
      return rows.filter((row) => row.lineCode != null && bound.lineCodes.has(row.lineCode));
    case "areas":
      return rows.filter((row) => {
        if (bound.lineCodes && (row.lineCode == null || !bound.lineCodes.has(row.lineCode))) return false;
        const areaCode = normalizeAreaCode(row.areaCode);
        return Boolean(areaCode) && areaInBoundForMonth(areaCode, row.period, bound.areaCodes, bound.earlierMonthAreas);
      });
  }
}

/**
 * Which roll-up levels are worth rendering for this viewer.
 *
 * A medical rep has exactly one team, one region and (usually) one area, so showing them
 * a "by team" bar chart of a single bar is noise. They get areas + bricks. Managers get
 * the levels above them too.
 */
export function visibleLevelsForBound(bound: VsTargetBound): {
  team: boolean;
  region: boolean;
  area: boolean;
  rep: boolean;
  brick: boolean;
} {
  switch (bound.kind) {
    case "company":
      return { team: true, region: true, area: true, rep: true, brick: true };
    case "line":
      return { team: false, region: true, area: true, rep: true, brick: true };
    case "areas":
      return { team: false, region: false, area: true, rep: true, brick: true };
    case "self":
      return { team: false, region: false, area: true, rep: false, brick: true };
    case "none":
      return { team: false, region: false, area: false, rep: false, brick: false };
  }
}
