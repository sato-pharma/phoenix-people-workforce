// Weekly Sales — lifting a territory viewer's REGION bound for a load, and narrowing straight back to
// his own areas.
//
// WHY THIS EXISTS
// ───────────────
// A weekly row is a depot shipment, and its region label is the depot's, set when the sheet was
// mapped. The organogram moved on without it: Anti Infective's Upper Egypt is now Upper Egypt 1 and
// Upper Egypt 2, and Delta (3) was carved out on 2026-09-01, but the depot rows still say "UE" and not
// one says Delta (3). A territory viewer is bounded by his OWN region code, so an Upper Egypt 2
// district manager never even fetched the "UE" rows, although the owner's depot-split rule gives part
// of every one of them to his areas. His reps read low on his Field Force tab, their month-pace strip
// read about zero, and their Weekly Stock screen was nearly empty.
//
// Every sales figure — the Weekly Sales screen, its Field Force tab, the month-pace strip and a
// manager's Depot Detail — now reads the viewer's own areas' share through own-area-share.ts, where
// money placed in another manager's area leaves (owner, 2026-09-17). What stays here is who the viewer's
// own areas are, and Weekly Stock's narrowing, which keeps a depot's shelf WHOLE (admitWeeklyStockRows).
// A load lifts only when there IS a region bound to lift and the viewer's own areas are known — a
// manager's seat areas, or a medical rep's own filled seats, picked by his own Weekly Sales screen's
// selectOwnRepSeats. Everyone else loads exactly as before.

import { resolveEmployeeIdentityId, type AccessContext } from "@/lib/auth/permissions";
import { sharedIdentityKeys } from "@/lib/auth/identity-aliases";
import { applyWeeklyTerritoryScope, type WeeklyAccessScope } from "@/lib/sales/weekly/access";
import type { WeeklyAreaSplitIndex } from "@/lib/sales/weekly/branch-area-split";
import { splitWeeklyRowsByBranch } from "@/lib/sales/weekly/branch-attribution";
import { fieldForceKey, loadFieldForceSeatIndex, type FieldForceSeat } from "@/lib/sales/weekly/portal-weekly-field-force";
import { repWeeklySeatKey, selectOwnRepSeats } from "@/lib/sales/weekly/portal-weekly-rep";
import type { WeeklyStockSourceRow } from "@/lib/sales/weekly/stock-dashboard";
import type { WeeklyDistributorOption, WeeklyFilterMode } from "@/lib/sales/weekly/types";

export { mayLiftWeeklyGeography } from "@/lib/sales/weekly/own-area-share";

/** The part of a territory scope a lifted load drops, kept so the narrowing can re-apply it. */
export type WeeklyGeographyBound = {
  allowedRegionCodes: Set<string> | null;
  allowedAreaCodes: Set<string> | null;
};

/**
 * A manager's own area keys, straight from his scope: every line he may read × every area his seat
 * covers, keyed `${lineKey}|${AREA}` as the Field Force grid keys a seat. Empty when the scope carries
 * no area bound, or no line bound to key it by. Pure.
 */
export function weeklyScopeOwnAreaKeys(scope: WeeklyAccessScope): Set<string> {
  const keys = new Set<string>();
  if (scope.tier !== "territory" || !scope.allowedAreaCodes || !scope.allowedLineNames) return keys;
  for (const line of scope.allowedLineNames) {
    for (const area of scope.allowedAreaCodes) {
      const key = fieldForceKey(line, area);
      if (key) keys.add(key);
    }
  }
  return keys;
}

/**
 * The viewer's own area keys, or an empty set when his load must not lift. A district or regional
 * manager's come from his seat's area bound. A medical rep's scope has no area bound, so his come from
 * his own filled rep seats in the organogram — `seats` when the caller already loaded them, otherwise
 * read here — picked by selectOwnRepSeats, the selector his own Weekly Sales screen uses, so the two
 * screens can never disagree about which areas are his. Every other viewer gets an empty set.
 */
export async function resolveWeeklyOwnAreaKeys(
  ctx: AccessContext,
  scope: WeeklyAccessScope,
  seats?: readonly FieldForceSeat[] | null,
): Promise<Set<string>> {
  if (scope.tier !== "territory" || scope.allowedRegionCodes === null) return new Set();
  if (scope.allowedAreaCodes && scope.allowedAreaCodes.size > 0) return weeklyScopeOwnAreaKeys(scope);
  if (ctx.role !== "Medical Rep") return new Set();
  const repSeats = seats ?? (await loadFieldForceSeatIndex()).seats;
  const ownSeats = selectOwnRepSeats(repSeats, sharedIdentityKeys(resolveEmployeeIdentityId(ctx)), scope.allowedLineNames);
  return new Set(ownSeats.map(repWeeklySeatKey));
}

/**
 * Narrow a lifted Weekly Stock load back to the viewer. A depot row stays when his own scope admits it
 * (what he saw before), or when the depot serves one of his own areas: a branch mapped by hand to one
 * of them, or a branch the owner's split rule spreads over at least one of them.
 *
 * The row stays WHOLE. Stock on a depot shelf is one stock whichever rep's area it will reach, which is
 * how every region-bound rep has always seen his depots; splitting a shelf's units by area would print
 * a quantity no shelf holds. A warehouse or a tender is never spread (branch-attribution.ts), so it
 * reaches him only when his own scope admits it. Pure; returns the input rows themselves, in order.
 */
export function admitWeeklyStockRows<T extends WeeklyStockSourceRow>(
  rows: readonly T[],
  input: { bound: WeeklyGeographyBound; ownAreaKeys: ReadonlySet<string>; areaSplit: WeeklyAreaSplitIndex | null },
): T[] {
  const admitted = new Set<T>(
    applyWeeklyTerritoryScope([...rows], {
      allowedLineNames: null,
      allowedRegionCodes: input.bound.allowedRegionCodes,
      allowedAreaCodes: input.bound.allowedAreaCodes,
    }),
  );

  const reached = new Set<T>();
  const candidates = rows.filter((row) => !admitted.has(row));
  // Only the depot's placement is read, so the money fields are zeros; the source row rides along so a
  // share landing in one of his areas can admit the row it was cut from.
  const { rows: parts } = splitWeeklyRowsByBranch(
    candidates.map((row) => ({
      line: row.line,
      regionCode: row.regionCode,
      areaCode: row.areaCode,
      branchName: row.branchName,
      branchCode: row.branchCode,
      salesValue: 0,
      salesUnits: 0,
      stockUnits: 0,
      source: row,
    })),
    input.areaSplit,
  );
  for (const part of parts) {
    if (input.ownAreaKeys.has(fieldForceKey(part.line, part.areaCode))) reached.add(part.source);
  }

  return rows.filter((row) => admitted.has(row) || reached.has(row));
}

/**
 * A lifted Weekly Stock load's product filter, read in memory after the narrowing instead of inside the
 * load — so the product list can still offer every product his depots carry while one is chosen. The
 * load's own rule: codes compared trimmed and upper-cased, "exclude" drops the listed products, any
 * other mode keeps only them, and no codes keeps everything. Pure.
 */
export function weeklyStockProductPredicate(filters: {
  productCodes?: readonly string[] | null;
  productFilterMode?: WeeklyFilterMode | null;
}): (row: { productCode: string }) => boolean {
  const codes = new Set((filters.productCodes ?? []).map((code) => code.trim().toUpperCase()).filter(Boolean));
  if (codes.size === 0) return () => true;
  const include = filters.productFilterMode !== "exclude";
  return (row) => codes.has(row.productCode.trim().toUpperCase()) === include;
}

/**
 * A lifted viewer's option list: the load's own options (region-bound), plus every code his narrowed
 * rows carry that the list lacks, upper-cased and named from the row. Returns `options` itself when
 * nothing is added; otherwise the whole list sorted by name, as the load sorts it. Pure.
 */
export function withExtraWeeklyOptions(
  options: WeeklyDistributorOption[],
  extras: readonly WeeklyDistributorOption[],
): WeeklyDistributorOption[] {
  const known = new Set(options.map((option) => option.code.trim().toUpperCase()));
  const added = new Map<string, WeeklyDistributorOption>();
  for (const extra of extras) {
    const code = extra.code.trim().toUpperCase();
    if (!code || known.has(code) || added.has(code)) continue;
    added.set(code, { code, name: extra.name.trim() || code });
  }
  if (added.size === 0) return options;
  return [...options, ...added.values()].sort((left, right) => left.name.localeCompare(right.name));
}
