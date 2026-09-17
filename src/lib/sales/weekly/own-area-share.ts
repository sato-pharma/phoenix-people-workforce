// Weekly Sales — a manager's own areas' share of the depot rows, for every figure on his screens.
//
// WHY THIS EXISTS
// ───────────────
// A weekly row is a depot shipment, and its region label is the depot's, set when the sheet was mapped.
// The organogram moved on without it: Upper Egypt split in two and Delta (3) was carved out on
// 2026-09-01, but the depot rows still say "UE" and "D1". Bounded by that label, a manager's screens
// disagreed with each other. Measured on production on 17 Sept 2026 for September: the Upper Egypt 2
// district manager's Sales Value read EGP 5,135 against 25,694 on his own Field Force tab, and the
// Delta (1) manager's tab carried EGP 34,760 of Qalubeya, which has been Delta (3)'s since 1 Sept.
//
// THE OWNER'S RULE, 2026-09-17
// ────────────────────────────
//   1. Every figure on a manager's Weekly Sales screen and his Depot Detail follows his own areas.
//   2. Money the depot split places in ANOTHER manager's area is not his, whatever region label its
//      depot carries.
//   3. A depot serving several areas reaches him as his areas' share only, never whole.
// Money that reaches no area at all (a warehouse, a tender) stays with the manager whose scope admits it.
// So does money in an area NO district manager owns (owner, 2026-09-17): a line's "Others" areas, such as
// CNS Imbaba, Fayoum, Qena 2 and Aswan, carry no rep and no target, and before this rule the manager of
// the depot's region saw that money under "Not attributed to a rep". Measured for September, dropping it
// would have taken EGP 50,454 off the CNS Giza manager's screens and 23,735 off CNS Upper Egypt's.
//
// THE NARROWING
// ─────────────
// Read the rows with his REGION and AREA bounds lifted (his line bound, the confidential products and
// the Head Office strip all stay), then keep, row by row:
//   • a row carrying an area (mapped by hand): kept whole when the area is one of his, otherwise dropped;
//   • a row the split rule places: only the parts in his own areas, marked allocated;
//   • a row no rule places: kept whole when his own region-bound scope admits it, otherwise dropped.
// Kept parts in his areas are filed under the organogram's region for that area, not the depot's label.
// A row, or a split part, in an area no district manager owns is kept as it is, without that relabel,
// when his own region-bound scope admits the row. Which areas a manager owns is the seat index's
// managedAreaKeys; when that is unknown, no area counts as ownerless.
//
// Nothing another manager owns reaches him. Scope runs downward only: the lift is for the load, and
// nothing leaves this file that is not his own areas' money or money his own scope already admitted
// that no other district manager owns.

import { applyWeeklyAccessScope, liftWeeklyGeography, type WeeklyAccessScope } from "@/lib/sales/weekly/access";
import type { WeeklyAreaSplitIndex } from "@/lib/sales/weekly/branch-area-split";
import { splitWeeklyRowsByBranch } from "@/lib/sales/weekly/branch-attribution";
import { fieldForceKey, type FieldForceSeatIndex } from "@/lib/sales/weekly/portal-weekly-field-force";
import type { WeeklyAreaBasis } from "@/lib/sales/weekly/types";

/** What a load needs to follow a viewer's own areas. */
export type WeeklyOwnAreaShare = {
  /** His own `${lineKey}|${AREA}` keys (weeklyScopeOwnAreaKeys / resolveWeeklyOwnAreaKeys). */
  ownAreaKeys: ReadonlySet<string>;
  /** The owner's depot-split rule; null when it failed to load, and then no depot is spread. */
  areaSplit: WeeklyAreaSplitIndex | null;
  /** Names the region an area sits in; an empty index leaves the depot's own region label. */
  seatIndex: FieldForceSeatIndex | null;
};

/** The row fields the narrowing reads and writes: the loader's own fact row, structurally. */
export type WeeklyOwnAreaShareRow = {
  productCode: string;
  officialLine: string;
  regionCode: string;
  regionName: string;
  areaCode: string | null;
  branchCode: string;
  branchName: string;
  salesValue: number;
  /** gross units */
  salesQty: number;
  /** net units */
  netQty: number;
  stockQty: number;
  areaBasis?: WeeklyAreaBasis;
};

/**
 * Whether a load may lift this viewer's geography: a territory viewer who HAS a region bound, and whose
 * own areas are known, so there is something to narrow back to. Anything else never lifts. Pure.
 */
export function mayLiftWeeklyGeography(scope: WeeklyAccessScope, ownAreaKeys: ReadonlySet<string>): boolean {
  return scope.tier === "territory" && scope.allowedRegionCodes !== null && ownAreaKeys.size > 0;
}

const upper = (value: string | null | undefined) => String(value ?? "").trim().toUpperCase();

/**
 * The viewer's rows: his own areas' share of every depot, plus the unplaced residue his own scope admits.
 * A viewer who may not lift (mayLiftWeeklyGeography) gets exactly applyWeeklyAccessScope. Pure; never
 * mutates a row, and returns new objects for every row it keeps from a lifted read.
 */
export function narrowWeeklyRowsToOwnAreaShare<T extends WeeklyOwnAreaShareRow>(
  rows: T[],
  scope: WeeklyAccessScope,
  share: WeeklyOwnAreaShare,
): T[] {
  if (!mayLiftWeeklyGeography(scope, share.ownAreaKeys)) return applyWeeklyAccessScope(rows, scope);

  const admitted = new Set<T>(applyWeeklyAccessScope(rows, scope));
  const lifted = applyWeeklyAccessScope(rows, liftWeeklyGeography(scope));

  const isOwn = (line: string, areaCode: string) => share.ownAreaKeys.has(fieldForceKey(line, areaCode));
  // An area no district manager owns. An unread or empty map says nothing about ownership, so then no
  // area is ownerless: read as "no one owns anything", it would hand him every other manager's areas.
  const managed = share.seatIndex?.managedAreaKeys;
  const ownerless = (line: string, areaCode: string) =>
    managed !== undefined && managed.size > 0 && !managed.has(fieldForceKey(line, areaCode));
  // Money in an area he may count: his own, or one no manager owns on a row his own scope admits.
  const counts = (row: T, line: string, areaCode: string) =>
    isOwn(line, areaCode) || (admitted.has(row) && ownerless(line, areaCode));
  // The organogram names the region of one of his areas; a depot's label is older than the organogram.
  const inOwnArea = (row: T, areaCode: string, areaBasis: WeeklyAreaBasis): T => {
    const seat = share.seatIndex?.byLineArea.get(fieldForceKey(row.officialLine, areaCode));
    return {
      ...row,
      areaCode,
      regionCode: seat?.regionCode || row.regionCode,
      regionName: seat?.regionName || row.regionName,
      areaBasis,
    };
  };

  // Which areas the split rule places a depot in, read once per depot: a depot repeats across every
  // product and week, and its placement depends only on its line, name, code and region label.
  const placements = new Map<string, string[]>();
  const placedAreas = (row: T): string[] => {
    const key = `${row.officialLine}||${row.branchName}||${row.branchCode}||${row.regionCode}`;
    const cached = placements.get(key);
    if (cached) return cached;
    const { rows: parts } = splitWeeklyRowsByBranch(
      [
        {
          line: row.officialLine,
          regionCode: row.regionCode,
          areaCode: null,
          branchName: row.branchName,
          branchCode: row.branchCode,
          salesValue: 0,
          salesUnits: 0,
          stockUnits: 0,
        },
      ],
      share.areaSplit,
    );
    const areas = parts.map((part) => upper(part.areaCode)).filter(Boolean);
    placements.set(key, areas);
    return areas;
  };

  // In load order, so every list built from these rows reads as it did: a slot is a kept row, or the
  // depot row whose own-area parts replace it.
  const slots: { row: T; split: boolean }[] = [];
  const toSplit: T[] = [];
  for (const row of lifted) {
    const areaCode = upper(row.areaCode);
    if (areaCode) {
      if (isOwn(row.officialLine, areaCode)) slots.push({ row: inOwnArea(row, areaCode, "mapped"), split: false });
      else if (counts(row, row.officialLine, areaCode)) slots.push({ row: { ...row, areaCode, areaBasis: "mapped" }, split: false });
      continue;
    }
    const areas = placedAreas(row);
    if (areas.length === 0) {
      if (admitted.has(row)) slots.push({ row: { ...row, areaBasis: "whole" }, split: false });
      continue;
    }
    if (!areas.some((area) => counts(row, row.officialLine, area))) continue;
    slots.push({ row, split: true });
    toSplit.push(row);
  }

  const partsBySource = new Map<T, T[]>();
  if (toSplit.length > 0) {
    const { rows: parts } = splitWeeklyRowsByBranch(
      toSplit.map((row) => ({
        line: row.officialLine,
        regionCode: row.regionCode,
        areaCode: null as string | null,
        branchName: row.branchName,
        branchCode: row.branchCode,
        salesValue: row.salesValue,
        salesUnits: row.netQty,
        stockUnits: row.stockQty,
        grossUnits: row.salesQty,
        source: row,
      })),
      share.areaSplit,
    );
    for (const part of parts) {
      const areaCode = upper(part.areaCode);
      if (!areaCode || !counts(part.source, part.line, areaCode)) continue;
      const own = partsBySource.get(part.source) ?? [];
      own.push({
        ...(isOwn(part.line, areaCode)
          ? inOwnArea(part.source, areaCode, "allocated")
          : { ...part.source, areaCode, areaBasis: "allocated" as const }),
        salesValue: part.salesValue,
        netQty: part.salesUnits,
        stockQty: part.stockUnits,
        salesQty: part.grossUnits ?? 0,
      });
      partsBySource.set(part.source, own);
    }
  }

  const kept: T[] = [];
  for (const slot of slots) {
    if (slot.split) kept.push(...(partsBySource.get(slot.row) ?? []));
    else kept.push(slot.row);
  }
  return kept;
}
