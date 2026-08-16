import type { PhoenixRole } from "@/lib/auth/permissions";
import { lineName, resolveTargetLineCode, type MonthlyTargetRow } from "@/lib/sales/monthly-targets";
import { applyWeeklyAccessScope, type WeeklyAccessScope } from "@/lib/sales/weekly/access";
import type { MonthTargetInput } from "@/lib/sales/weekly/summary-workbook";

// ─────────────────────────────────────────────────────────────────────────────
// Weekly Sales — Month vs Target: who may see the tab, and which targets are his.
//
// This module exists because the tab's scoping rules were written inline in the export route, where
// nothing could test them and the one that mattered most was missing. `loadWeeklyDashboard` redacts
// the SALES per viewer (applyWeeklyAccessScope, service.ts); `phx_monthly_targets` is a SECURITY
// DEFINER RPC that carries no viewer bound at all and returns every line × every area for the
// period. Narrowing only by the URL query params therefore divided a Regional Manager's three
// regions of sales by the NATIONAL target, and printed every out-of-territory area as a named row
// carrying its real number.
//
// The fix is reuse, not a second security system: the targets go through the SAME
// applyWeeklyAccessScope the sales side already uses, so the numerator and the denominator are
// bounded identically by construction. There is no way for one to drift from the other without the
// other moving too.
//
// Everything here is PURE — no database client, no AccessContext, no request. That is what makes it
// unit-testable, and this file's whole reason for existing is that its predecessor was not.
// ─────────────────────────────────────────────────────────────────────────────

/** One URL filter: the values he picked, and whether they are the keep-set or the drop-set. */
export type WeeklyTargetFilter = { values: string[]; mode: "include" | "exclude" };

const upper = (value: string | null | undefined): string => (value ?? "").trim().toUpperCase();

/**
 * Prepared once per filter, never per row.
 *
 * The route used to call `mode("lineMode")` inside the per-row predicate, so each of ~2,000 target
 * rows paid three `URLSearchParams.get` lookups and three `toLowerCase` calls to re-derive three
 * values that cannot change during the loop.
 */
type PreparedFilter = { keys: Set<string>; keep: boolean; requested: boolean };

const prepare = (filter: WeeklyTargetFilter, key: (value: string) => string): PreparedFilter => ({
  keys: new Set(filter.values.map(key).filter(Boolean)),
  keep: filter.mode === "include",
  // Whether he asked for ANYTHING, recorded before the values are resolved to keys.
  requested: filter.values.length > 0,
});

/**
 * "He asked for nothing" and "he asked for something that resolves to nothing" are DIFFERENT.
 *
 * Collapsing them is the same absent-means-unbounded trap this module's header warns about, one
 * level down: a `?line=Head Office` filter resolves to no line code (Head Office carries no field
 * target), and treating that empty key set as "no filter" would widen the tab from the one line he
 * asked for to EVERY line. An unresolvable include therefore matches nothing, and an unresolvable
 * exclude removes nothing — each fails in the direction that cannot invent data.
 */
const passes = (filter: PreparedFilter, value: string): boolean => {
  if (!filter.requested) return true;
  if (filter.keys.size === 0) return !filter.keep;
  return filter.keys.has(value) === filter.keep;
};

// ── Who may see the tab ───────────────────────────────────────────────────────

/**
 * Managers only — owner's decision, 2026-08-16.
 *
 * A Medical Rep is measured on his own visits and his own line, not on an area's whole monthly
 * number, and the tab's grain (region → area) is a management view he has no use for. He keeps the
 * other five tabs exactly as before.
 *
 * An explicit ALLOW-list, not a deny-list: a role added to this system later gets no tab until
 * someone decides it should have one. Fail closed.
 */
const VS_TARGET_ROLES: ReadonlySet<PhoenixRole> = new Set<PhoenixRole>([
  "Super Admin",
  "CEO",
  "National Sales Manager",
  "Regional Manager",
  "District Manager",
  "SFE Manager",
  "Product Manager",
  "Group Product Manager",
  "Marketing Manager",
]);

/**
 * Owner's wording, 2026-08-16. A target belongs to an AREA; it cannot be narrowed to whoever
 * delivered the units. Showing the tab anyway would divide one distributor's sales by the area's
 * whole month and report a miss the field never made — so the tab is withheld and says why, rather
 * than printing knowingly-wrong percentages under a caution nobody reads.
 */
export const VS_TARGET_DISTRIBUTOR_REASON =
  "Month vs Target is not shown when a distributor filter is active. A target belongs to an AREA, " +
  "not to the distributor that delivered it, so every percentage would be understated. Clear the " +
  "distributor filter and export again to read achievement.";

export type VsTargetVisibility =
  /** Build the tab. */
  | { kind: "shown" }
  /** No sheet at all — the viewer's role does not get this tab. */
  | { kind: "hidden" }
  /** One sheet carrying the reason, so the tab's absence is never mistaken for an empty month. */
  | { kind: "blocked"; reason: string };

/**
 * Decide whether this viewer, with these filters, gets the Month vs Target tab.
 *
 * Role is checked FIRST: a rep with a distributor filter gets no sheet rather than a sheet
 * explaining a tab he was never going to see.
 */
export function vsTargetVisibility(role: PhoenixRole, distributorFilterActive: boolean): VsTargetVisibility {
  if (!VS_TARGET_ROLES.has(role)) return { kind: "hidden" };
  if (distributorFilterActive) return { kind: "blocked", reason: VS_TARGET_DISTRIBUTOR_REASON };
  return { kind: "shown" };
}

// ── Scoping the month's targets ───────────────────────────────────────────────

export type MonthTargetScopeInput = {
  /** Straight from loadMonthlyTargets — every line × area × product for the period, unbounded. */
  targets: MonthlyTargetRow[];
  /** The SAME bound loadWeeklyDashboard applied to the sales these targets are divided into. */
  accessScope: WeeklyAccessScope;
  /** area_code (upper) -> its name and the region that carries its target. */
  areaIndex: Map<string, { areaName: string; regionCode: string }>;
  line: WeeklyTargetFilter;
  region: WeeklyTargetFilter;
  product: WeeklyTargetFilter;
};

export type ScopedMonthTargets = {
  targets: MonthTargetInput[];
  /** Official line names carrying a real target — tells "no target" apart from "a target of 0". */
  targetedLines: string[];
  /**
   * How many rows the viewer's access bound removed.
   *
   * Deliberately NOT printed on the sheet. The owner's "never silent-drop" rule is about rows lost
   * to a mapping gap — a data-quality fault he needs to rule on. Access redaction is the intended
   * behaviour, and telling a Regional Manager how many areas were withheld would leak the size of
   * what he is not allowed to see. It is returned because it is exactly what the tests assert on.
   */
  droppedByAccessScope: number;
  /**
   * Areas carrying a target that the master could not place in a region. THIS one is a real fault
   * and does reach the sheet: such a row cannot be scoped by region, so it fails closed and simply
   * vanishes for a territory viewer — which reads as "no target uploaded" rather than as a bug.
   */
  unresolvedAreas: string[];
  /** Line codes that are not field lines at all — dropped before scoping. See the guard below. */
  unrecognisedLines: string[];
};

/**
 * Bound one month's targets to one viewer, then to his URL filters. Pure.
 *
 * Order matters and is not interchangeable: the access bound runs FIRST, before the filters and
 * before any roll-up. src/lib/sales/vs-target-scope.ts states the reason in its own header —
 * "Rolling up first and filtering after produces a table that looks correctly scoped sitting under
 * summary cards that total the whole company."
 */
export function scopeMonthTargets(input: MonthTargetScopeInput): ScopedMonthTargets {
  const { targets, accessScope, areaIndex } = input;

  // Widen each target into the shape applyWeeklyAccessScope reads. `regionCode` is the one field
  // that MUST be populated: applyWeeklyTerritoryScope compares `(row.regionCode ?? "")` against the
  // viewer's region set, and "" matches nothing — so an unresolved area fails CLOSED. That is the
  // safe direction, but it is silent, which is why the misses are counted and surfaced below.
  // A target whose line is not a FIELD line is dropped before anything else looks at it.
  //
  // resolveTargetLineCode round-trips the three canonical codes through the same alias table the
  // upload validator uses, and returns null for everything else — "Head Office" above all, which is
  // a confidential line that carries no field target. The guard matters because the two obvious
  // defences both miss it: lineName() falls through to the raw code for an unknown line, and
  // isHeadOfficeLine() only lowercases, so it recognises "Head Office" but NOT "head_office". Today
  // au.monthly_targets holds only cns / pedia / anti_infective, so this drops nothing — it is here so
  // that stays true if a fourth code ever lands.
  const unrecognisedLines = new Set<string>();
  const fieldTargets = targets.filter((row) => {
    if (resolveTargetLineCode(row.lineCode)) return true;
    unrecognisedLines.add(row.lineCode.trim() || "(blank)");
    return false;
  });

  const unresolvedAreas = new Set<string>();
  const widened = fieldTargets.map((row) => {
    const areaCode = upper(row.areaCode);
    const mapped = areaIndex.get(areaCode);
    if (areaCode && !mapped?.regionCode) unresolvedAreas.add(areaCode);
    return {
      ...row,
      // The engine speaks line CODES and the access bound speaks official line NAMES.
      officialLine: lineName(row.lineCode),
      areaCode,
      regionCode: mapped?.regionCode ?? "",
    };
  });

  // THE bound. Same function, same scope object, same rules as the sales side — which is the whole
  // point: a viewer cannot be given a target for territory whose sales he is not shown.
  const scoped = applyWeeklyAccessScope(widened, accessScope);
  const droppedByAccessScope = widened.length - scoped.length;

  // Compare lines in CODE space on both sides. The URL carries a line NAME, and matching it against
  // lineName(row.lineCode) meant the filter worked only while the two spellings happened to agree.
  // resolveTargetLineCode owns the alias table ("anti infective" / "anti-infective" / "anti inf"),
  // so "Head Office" — which carries no field target — resolves to null and matches nothing, in
  // either polarity.
  const lineFilter = prepare(input.line, (value) => resolveTargetLineCode(value) ?? "");
  const regionFilter = prepare(input.region, upper);
  const productFilter = prepare(input.product, upper);

  const filtered = scoped.filter(
    (row) =>
      passes(lineFilter, row.lineCode.trim()) &&
      passes(regionFilter, row.regionCode) &&
      passes(productFilter, upper(row.productCode)),
  );

  const monthTargets: MonthTargetInput[] = filtered.map((row) => ({
    lineLabel: lineName(row.lineCode),
    areaCode: row.areaCode,
    targetUnits: row.targetUnits ?? 0,
  }));

  // "Has a target" means a real number was uploaded for that line. A line present only with null or
  // zero units is not being measured in units, and saying it achieved 0% would be a fabrication.
  const targetedLines = [
    ...new Set(monthTargets.filter((target) => target.targetUnits > 0).map((target) => target.lineLabel).filter(Boolean)),
  ];

  return {
    targets: monthTargets,
    targetedLines,
    droppedByAccessScope,
    unresolvedAreas: [...unresolvedAreas].sort(),
    unrecognisedLines: [...unrecognisedLines].sort(),
  };
}

// ── Region symmetry on the sales side ─────────────────────────────────────────

export type ScopedMonthSales<T> = {
  rows: T[];
  /** Rows whose branch region admitted them but whose AREA belongs to a region he did not ask for. */
  droppedByRegionDrift: number;
  /** The area names behind those drops, so the owner can see WHICH mapping disagrees. */
  driftAreas: string[];
};

/**
 * Re-apply the region filter to the sales rows using each area's OWN region.
 *
 * The tab's stated promise is that an area row sits under the region that carries its target, so
 * region subtotals reconcile with the area rows beneath them. But the dashboard admitted these rows
 * on the DISTRIBUTOR BRANCH's region (service.ts, `passesMultiFilter(region, row.regionCode)`),
 * while the targets are admitted on the area's region. Today the two always agree, because
 * resolveBranchArea refuses to store a mapping whose area sits outside the branch's region — so
 * this is a no-op on current data (0 disagreements across 546 area-mapped branches). It stops being
 * a no-op the moment an area is moved to another region without the branch map being revalidated,
 * and that is exactly when a silently non-reconciling sheet would be hardest to spot.
 *
 * This can only ever REMOVE rows the dashboard already admitted — never re-admit one it withheld —
 * so it cannot widen what the viewer sees. Rows with no area, or an area the master cannot place,
 * are left alone: their branch region is the only region they have.
 */
export function scopeMonthSalesRows<T extends { areaCode?: string | null; regionCode?: string | null }>(
  rows: T[],
  areaIndex: Map<string, { areaName: string; regionCode: string }>,
  region: WeeklyTargetFilter,
): ScopedMonthSales<T> {
  const filter = prepare(region, upper);
  if (filter.keys.size === 0) return { rows, droppedByRegionDrift: 0, driftAreas: [] };

  const driftAreas = new Set<string>();
  const kept = rows.filter((row) => {
    const areaCode = upper(row.areaCode);
    const mapped = areaCode ? areaIndex.get(areaCode) : undefined;
    if (!mapped?.regionCode) return true;
    if (passes(filter, mapped.regionCode)) return true;
    driftAreas.add(mapped.areaName || areaCode);
    return false;
  });

  return {
    rows: kept,
    droppedByRegionDrift: rows.length - kept.length,
    driftAreas: [...driftAreas].sort(),
  };
}
