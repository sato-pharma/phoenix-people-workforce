// Weekly Sales — the FIELD FORCE view: every medical rep, week by week, per product.
//
// WHAT THIS ANSWERS
// ─────────────────
// The owner's standing question about Weekly Sales is not "what did the region do" — it is "what
// did each of my medical reps do, week by week, on each product". The dashboard answered the first
// and never the second, so the screen was read once and abandoned. This module builds the second.
//
// THE CHAIN, AND WHY EACH LINK IS THE ONE IT IS
// ────────────────────────────────────────────
//   weekly row (a DEPOT shipment: distributor · branch · product · line · qty · value)
//     -> branch  -> area shares     splitWeeklyRowsByBranch + branch-area-split (the owner's rule)
//     -> (line, area) -> REP seat   au_v_org_tree, the same tree the organogram reads
//     -> the rep who covers it
//
// The last link is exact and needs no guessing: on every tracked line an area is covered by exactly
// ONE rep seat, so (line, area) -> rep is a lookup, not an inference. Measured on production
// 2026-09-01: 38 rep seats on Anti Infective, 35 on CNS, 36 on Pedia — one per area, every time.
// The area is keyed WITH the line and never alone, because the same area is a different rep's on
// CNS than on Pedia.
//
// THE HONESTY RULE THIS FILE EXISTS TO KEEP
// ─────────────────────────────────────────
// A weekly row is a shipment INTO a depot, not a sale observed in a territory. Where the owner has
// mapped a branch to an area by hand, the credit is EXACT. Everywhere else the branch NAME is read
// and its money is spread across the areas it serves — an ALLOCATION, and the standing rule
// (docs: weekly-sales-cannot-follow-the-organogram-it-is-depot-data) is that such a cut must never
// be presented as observed. Measured on production for August 2026 across the three tracked lines,
// only 20.9% of value sits on a hand-mapped branch; 63.5% carries a region and is placed by name.
//
// So every rep here carries `exactValue` and `allocatedValue` alongside the total, the screen shows
// the mix, and `coverage` states it for the whole view. That is not decoration: a rep whose entire
// number is allocated is a rep the owner must not performance-manage on this screen, and nothing
// else on it would tell him so.
//
// UNITS ARE NEVER ADDED ACROSS PRODUCTS (owner rule, 2026-08-27)
// ─────────────────────────────────────────────────────────────
// A unit total is meaningful for ONE product code and meaningless above it — Tebofortin alone has
// seven concentrations. So a rep's own total is EGP and only EGP, units appear only inside a single
// product's row, and there is deliberately no "total units" field on a rep anywhere in this file.
// The same rule is why the NSM/DSM workbook has no such column either.

import { splitWeeklyRowsByBranch } from "@/lib/sales/weekly/branch-attribution";
import { type WeeklyAreaSplitIndex } from "@/lib/sales/weekly/branch-area-split";
import { depotWeekGapKeys, moneySpansDepotGap, type DepotWeekGap } from "@/lib/sales/weekly/decumulate";
import { normalizeHrId } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { WeeklyFactExportRow } from "@/lib/sales/weekly/types";

// ── seat index ───────────────────────────────────────────────────────────────

/** One REP seat, already resolved to the people and places a screen has to name. */
export type FieldForceSeat = {
  seatId: string;
  lineCode: string;
  /** The line's NAME as the org tree spells it, for a screen that must name a seat with no sales row. */
  lineName: string;
  areaCode: string;
  areaName: string;
  regionCode: string;
  regionName: string;
  repHrId: string | null;
  /** Null when the seat is vacant. Owner rule: a name, never an HR id. */
  repName: string | null;
  isVacant: boolean;
  /** The DM above this rep, so an NSM's screen can group reps by their district manager. */
  managerName: string | null;
};

export type FieldForceSeatIndex = {
  /** `${normalizedLine}|${AREA}` -> seat. Keyed with the line: the same area is a different rep per line. */
  byLineArea: Map<string, FieldForceSeat>;
  /** Every rep seat, so a rep who sold nothing this month is still listed rather than vanishing. */
  seats: FieldForceSeat[];
  /**
   * Every `${normalizedLine}|${AREA}` a real district manager's seat owns on the current line-to-area map,
   * vacant seats included. An area has no rep seat more often than it has no manager: a manager can own
   * one (Delta (3)'s Anti Infective OT9, Upper Egypt 2's Pedia OT6), so rep seats cannot answer this. An
   * area missing from the set, such as a line's "Others" areas under its pseudo-DM, belongs to no district
   * manager. Absent when the map was not read, and then no area may be treated as ownerless.
   */
  managedAreaKeys?: Set<string>;
  /**
   * `${normalizedLine}|${AREA}` -> the district manager who owns an area that has NO rep seat. Such an
   * area's sales are shown under his name instead of "Not attributed to a rep" (owner, 2026-10-20,
   * asked and answering "Show under his name"). Only a named manager on a real, occupied district seat
   * is listed: a vacant district seat has no name to show, so its area stays in the residue.
   */
  managerOnlyAreas?: Map<string, FieldForceManagerArea>;
};

/** An area a district manager owns with no rep seat under it. */
export type FieldForceManagerArea = {
  managerName: string;
  lineCode: string;
  lineName: string;
  areaCode: string;
  areaName: string;
};

/** One current `au_v_line_area_map` row, narrowed to what the index reads. */
export type FieldForceLineAreaRow = {
  line_code?: string | null;
  area_code?: string | null;
  dm_seat_id?: string | null;
};

const norm = (value: unknown) => String(value ?? "").trim();
const upper = (value: unknown) => norm(value).toUpperCase();

/**
 * Collapse every spelling of a line to one key.
 *
 * Copied in spirit from area-rep-resolver.normalizeLineKey and required for the same reason: `au.lines`
 * seeds Anti Infective as 'Anti infective' while the weekly row says "Anti Infective", and a
 * case-sensitive compare silently drops that entire line's reps.
 */
export function fieldForceLineKey(value: string | null | undefined): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function fieldForceKey(line: string | null | undefined, areaCode: string | null | undefined): string {
  const lineKey = fieldForceLineKey(line);
  const area = upper(areaCode);
  if (!lineKey || !area) return "";
  return `${lineKey}|${area}`;
}

/** One `au_v_org_tree` row, narrowed to what the index reads. */
export type FieldForceSeatRow = {
  seat_id?: string | null;
  seat_tier?: string | null;
  line_code?: string | null;
  line_name?: string | null;
  region_code?: string | null;
  region_name?: string | null;
  area_code?: string | null;
  area_name?: string | null;
  occupant_hr_id?: string | null;
  is_vacant?: boolean | null;
  is_other_pseudo_dm?: boolean | null;
  parent_seat_id?: string | null;
};

/**
 * Pure: index REP seats by (line, area). Exported so the selection rule is testable without Supabase.
 *
 * Each seat is registered under BOTH its line_name and its line_code key, so either spelling on a
 * weekly row finds the rep. The per-line "Others" pseudo-DM is excluded — it holds no real people.
 *
 * Given the current line-to-area map, it also records which areas a real district manager owns
 * (managedAreaKeys); without it that set is absent.
 */
export function selectFieldForceSeats(
  rows: FieldForceSeatRow[],
  nameOf: (hrId: string | null) => string | null,
  lineAreas?: FieldForceLineAreaRow[],
): FieldForceSeatIndex {
  const managerNameBySeatId = new Map<string, string | null>();
  for (const row of rows) {
    const tier = upper(row.seat_tier);
    if (tier !== "DM" && tier !== "ACTING_DM") continue;
    const seatId = norm(row.seat_id);
    if (!seatId) continue;
    const hrId = row.is_vacant ? null : normalizeHrId(row.occupant_hr_id) || null;
    managerNameBySeatId.set(seatId, hrId ? nameOf(hrId) : null);
  }

  const byLineArea = new Map<string, FieldForceSeat>();
  const seats: FieldForceSeat[] = [];

  const repRows = rows
    .filter((row) => upper(row.seat_tier) === "REP")
    .filter((row) => row.is_other_pseudo_dm !== true)
    .filter((row) => norm(row.area_code))
    // Stable order, so a multi-seat area always resolves to the same primary.
    .sort((a, b) => norm(a.seat_id).localeCompare(norm(b.seat_id)));

  for (const row of repRows) {
    const areaCode = upper(row.area_code);
    const hrId = row.is_vacant ? null : normalizeHrId(row.occupant_hr_id) || null;
    const seat: FieldForceSeat = {
      seatId: norm(row.seat_id),
      lineCode: norm(row.line_code),
      lineName: norm(row.line_name) || norm(row.line_code),
      areaCode,
      areaName: norm(row.area_name) || areaCode,
      regionCode: upper(row.region_code),
      regionName: norm(row.region_name) || upper(row.region_code),
      repHrId: hrId,
      repName: hrId ? (nameOf(hrId) ?? null) : null,
      isVacant: row.is_vacant === true || !hrId,
      managerName: managerNameBySeatId.get(norm(row.parent_seat_id)) ?? null,
    };
    seats.push(seat);

    const lineKeys = new Set(
      [fieldForceLineKey(row.line_name), fieldForceLineKey(row.line_code)].filter(Boolean),
    );
    for (const lineKey of lineKeys) {
      const key = `${lineKey}|${areaCode}`;
      if (!byLineArea.has(key)) byLineArea.set(key, seat);
    }
  }

  if (!lineAreas) return { byLineArea, seats };
  return {
    byLineArea,
    seats,
    managedAreaKeys: selectManagedAreaKeys(rows, lineAreas),
    managerOnlyAreas: selectManagerOnlyAreas(rows, lineAreas, nameOf, byLineArea),
  };
}

/**
 * Pure: every (line, area) a NAMED district manager owns where no rep seat sits — keyed exactly like
 * `byLineArea`, so the grid can look it up the same way it looks up a rep.
 */
function selectManagerOnlyAreas(
  rows: FieldForceSeatRow[],
  lineAreas: FieldForceLineAreaRow[],
  nameOf: (hrId: string | null) => string | null,
  byLineArea: Map<string, FieldForceSeat>,
): Map<string, FieldForceManagerArea> {
  const managerSeats = new Map<string, FieldForceSeatRow>();
  const areaNameByCode = new Map<string, string>();
  for (const row of rows) {
    const areaCode = upper(row.area_code);
    if (areaCode && norm(row.area_name) && !areaNameByCode.has(areaCode)) areaNameByCode.set(areaCode, norm(row.area_name));
    const tier = upper(row.seat_tier);
    if (tier !== "DM" && tier !== "ACTING_DM") continue;
    if (row.is_other_pseudo_dm === true || !norm(row.seat_id)) continue;
    managerSeats.set(norm(row.seat_id), row);
  }

  const result = new Map<string, FieldForceManagerArea>();
  for (const area of lineAreas) {
    const seat = managerSeats.get(norm(area.dm_seat_id));
    if (!seat || seat.is_vacant === true) continue;
    const hrId = normalizeHrId(seat.occupant_hr_id) || null;
    const managerName = hrId ? nameOf(hrId) : null;
    const areaCode = upper(area.area_code);
    if (!managerName || !areaCode) continue;
    const lineKeys = [area.line_code];
    if (fieldForceLineKey(seat.line_code) === fieldForceLineKey(area.line_code)) lineKeys.push(seat.line_name);
    for (const line of lineKeys) {
      const key = fieldForceKey(line, areaCode);
      if (!key || byLineArea.has(key) || result.has(key)) continue;
      result.set(key, {
        managerName,
        lineCode: norm(area.line_code),
        lineName: norm(seat.line_name) || norm(area.line_code),
        areaCode,
        areaName: areaNameByCode.get(areaCode) ?? areaCode,
      });
    }
  }
  return result;
}

/**
 * Pure: every (line, area) a real district manager's seat owns. The line's "Others" pseudo-DM owns
 * nobody's areas, and a map row naming a seat the org tree does not hold is no manager's either. Each
 * area is registered under its line code and, when the seat is on the same line, the seat's line name.
 */
function selectManagedAreaKeys(rows: FieldForceSeatRow[], lineAreas: FieldForceLineAreaRow[]): Set<string> {
  const managerSeats = new Map<string, FieldForceSeatRow>();
  for (const row of rows) {
    const tier = upper(row.seat_tier);
    if (tier !== "DM" && tier !== "ACTING_DM") continue;
    if (row.is_other_pseudo_dm === true || !norm(row.seat_id)) continue;
    managerSeats.set(norm(row.seat_id), row);
  }

  const keys = new Set<string>();
  for (const area of lineAreas) {
    const seat = managerSeats.get(norm(area.dm_seat_id));
    if (!seat) continue;
    const lineKeys = [area.line_code];
    if (fieldForceLineKey(seat.line_code) === fieldForceLineKey(area.line_code)) lineKeys.push(seat.line_name);
    for (const line of lineKeys) {
      const key = fieldForceKey(line, area.area_code);
      if (key) keys.add(key);
    }
  }
  return keys;
}

/**
 * Load the rep seat index.
 *
 * Fails SOFT to an empty index, exactly as loadWeeklyAreaSplitIndex does: an unreadable org tree
 * must degrade this tab to "we cannot say who", never 500 the whole Weekly Sales page for a viewer
 * whose other tab is fine.
 */
export async function loadFieldForceSeatIndex(): Promise<FieldForceSeatIndex> {
  const supabase = getSupabaseAdmin();
  try {
    const [treeResult, employeesResult, lineAreaResult] = await Promise.all([
      supabase
        .from("au_v_org_tree")
        .select(
          "seat_id,seat_tier,line_code,line_name,region_code,region_name,area_code,area_name,occupant_hr_id,is_vacant,is_other_pseudo_dm,parent_seat_id",
        ),
      supabase.from("employees").select("hr_id, full_name, nickname"),
      // Current rows only, as the seat area scope reads them: which manager owns an area today.
      supabase.from("au_v_line_area_map").select("line_code,area_code,dm_seat_id").is("effective_to", null),
    ]);
    if (treeResult.error) throw treeResult.error;
    if (employeesResult.error) throw employeesResult.error;

    const nameByHrId = new Map<string, string>();
    for (const row of employeesResult.data ?? []) {
      const record = row as Record<string, unknown>;
      // HR ids are MIXED CASE in this database and a plain equality lookup silently under-returns,
      // so both sides are normalized through the same helper the seat rows use.
      const hrId = normalizeHrId(record.hr_id as string | null);
      if (!hrId) continue;
      const name = norm(record.full_name) || norm(record.nickname);
      if (name) nameByHrId.set(hrId, name);
    }

    return selectFieldForceSeats(
      (treeResult.data ?? []) as FieldForceSeatRow[],
      (hrId) => (hrId ? (nameByHrId.get(hrId) ?? null) : null),
      // An unreadable map leaves the ownership unknown rather than blanking the reps.
      lineAreaResult.error ? undefined : ((lineAreaResult.data ?? []) as FieldForceLineAreaRow[]),
    );
  } catch {
    return { byLineArea: new Map(), seats: [] };
  }
}

// ── the grid ─────────────────────────────────────────────────────────────────

/** One product's row inside a rep. UNITS live here and nowhere above, per the owner's rule. */
export type FieldForceProduct = {
  productCode: string;
  productName: string;
  /** Product family NAME (never family_code — "DO" belongs to two families). */
  family: string;
  /** week-of-month -> units of THIS product. Valid to add down a column, never across products. */
  unitsByWeek: Record<number, number>;
  /** Units of this product across the whole period. One product, so this is legitimate. */
  units: number;
  /** EGP, so a product can be ranked against another. */
  value: number;
};

export type FieldForceRep = {
  /** Stable row key: `${lineKey}|${AREA}`, or `unattributed:<line>` for the residue bucket. */
  key: string;
  kind: "rep" | "vacant" | "manager" | "unattributed";
  /** The rep's name, "Vacant", or the residue bucket's label. Never an HR id, never a seat id. */
  label: string;
  repName: string | null;
  repHrId: string | null;
  areaCode: string | null;
  areaName: string | null;
  lineCode: string;
  lineName: string;
  regionCode: string | null;
  regionName: string | null;
  /** The district manager above this rep, for grouping on an NSM's screen. */
  managerName: string | null;
  /** EGP for the whole period. The ONLY legitimate total for a rep — never units. */
  value: number;
  /** week-of-month -> EGP. Money is addable across products, so a week column is safe here. */
  valueByWeek: Record<number, number>;
  /**
   * This row's weeks whose figure reads high: money on THIS row came from a depot that sent no sheet for
   * the week before. The rep's own screen reads it, so his flags are his depots' and no one else's.
   */
  gapWeekNumbers: number[];
  /** Value credited from a branch the owner mapped BY HAND. Exact, not allocated. */
  exactValue: number;
  /** Value placed by reading the branch name and spreading it. An allocation — label it. */
  allocatedValue: number;
  /** Products this rep sold, ranked by value, each with its own week columns in units. */
  products: FieldForceProduct[];
};

export type PortalWeeklyFieldForce = {
  /** Week-of-month numbers carried by a row that counts on this grid, ascending — the column axis. */
  weekNumbers: number[];
  /**
   * Weeks where money that counts on this grid came from a depot that sent no sheet for the week before,
   * so the de-cumulated figure silently holds the week it skipped; the screen must flag these.
   */
  gapWeekNumbers: number[];
  /** Rows: real reps first (by value), then vacant areas, then the residue bucket. */
  reps: FieldForceRep[];
  /** Product axis shared by every rep, so column N means the same product on every row. */
  productAxis: { code: string; name: string }[];
  totals: {
    value: number;
    exactValue: number;
    allocatedValue: number;
    /** Value that reached no area at all, and therefore no rep. Shown, never dropped. */
    unattributedValue: number;
    repsWithSales: number;
    vacantAreasWithSales: number;
  };
  /** True when the seat index could not be read — the screen must say so rather than show "no reps". */
  seatIndexUnavailable: boolean;
};

type TaggedRow = WeeklyFactExportRow & { exactArea: boolean };

const lineNameOf = (row: WeeklyFactExportRow) => norm(row.line) || "—";

/**
 * Build the field-force grid from a dashboard's fact rows.
 *
 * Pure and synchronous: the caller supplies the two indexes, which is what lets a test drive the
 * whole grid from fixtures and what keeps the loading order visible at the call site.
 */
export function buildPortalWeeklyFieldForce(input: {
  rows: WeeklyFactExportRow[];
  areaSplit: WeeklyAreaSplitIndex | null;
  seatIndex: FieldForceSeatIndex;
  /** The dashboard's stable product universe, so the axis does not change with the view. */
  productAxis?: { code: string; name: string }[];
  /**
   * Every depot week that spans an upload gap (the dashboard's factRowDepotWeekGaps). A week is flagged
   * where money that counts on this grid came from one of them, so a depot that skipped a week is caught
   * even when another depot sent that week (owner, 2026-09-17: one rule on every Field Force tab). Absent
   * = nothing is flagged, so every screen passes it.
   */
  depotWeekGaps?: readonly DepotWeekGap[];
  seatIndexUnavailable?: boolean;
}): PortalWeeklyFieldForce {
  const { rows, areaSplit, seatIndex } = input;

  // Tag BEFORE the split: a row carrying an area came from a branch the owner mapped by hand, and
  // splitWeeklyRowsByBranch leaves exactly those rows alone. After the split the two are
  // indistinguishable, and the exact/allocated mix is the whole honesty story of this screen. A load
  // that followed the viewer's own areas (own-area-share.ts) has already split its depots, and says so
  // on each row: its placed parts carry an area and are still allocations.
  const tagged: TaggedRow[] = rows.map((row) => ({
    ...row,
    exactArea: row.areaBasis ? row.areaBasis === "mapped" : Boolean(norm(row.areaCode)),
  }));
  const { rows: split } = splitWeeklyRowsByBranch(tagged, areaSplit);

  const weekNumbers = new Set<number>();
  const byKey = new Map<string, FieldForceRep>();
  const productsByKey = new Map<string, Map<string, FieldForceProduct>>();
  const depotGapKeys = depotWeekGapKeys(input.depotWeekGaps ?? []);
  const depotGapWeeksByKey = new Map<string, Set<number>>();

  let unattributedValue = 0;

  const ensureRep = (key: string, seed: () => FieldForceRep): FieldForceRep => {
    const existing = byKey.get(key);
    if (existing) return existing;
    const created = seed();
    byKey.set(key, created);
    productsByKey.set(key, new Map());
    return created;
  };

  for (const row of split) {
    const value = Number(row.salesValue) || 0;
    const units = Number(row.salesUnits) || 0;
    const week = row.weekNumber;

    // Every row here already counts for the viewer: a load that follows his own areas narrowed it first
    // (own-area-share.ts). So a week is a column exactly where one of his rows carries it.
    if (week !== null && week !== undefined) weekNumbers.add(week);

    // Money from a depot week that spans an upload gap reads high. A row that moves no money cannot.
    const spansDepotGap = moneySpansDepotGap(row, { value, units }, depotGapKeys);

    const areaCode = upper(row.areaCode);
    const seat = areaCode ? seatIndex.byLineArea.get(fieldForceKey(row.line, areaCode)) : undefined;

    // The residue. A depot whose name states no place, or an area no line seats, reaches no rep —
    // and it must still be reported under a named bucket. Dropping it would make the reps on screen
    // add to less than the KPI strip above them, which is the one discrepancy a reader cannot
    // explain and will not forgive.
    // An area its district manager covers with no rep seat: his row, under his name (owner, 2026-10-20).
    const managerArea = !seat && areaCode ? seatIndex.managerOnlyAreas?.get(fieldForceKey(row.line, areaCode)) : undefined;
    if (managerArea) {
      const key = `manager:${fieldForceLineKey(managerArea.lineCode)}|${managerArea.areaCode}`;
      const rep = ensureRep(key, () => ({
        key,
        kind: "manager",
        label: `${managerArea.managerName} — ${managerArea.areaName}, no rep seat`,
        repName: null,
        repHrId: null,
        areaCode: managerArea.areaCode,
        areaName: managerArea.areaName,
        lineCode: managerArea.lineCode,
        lineName: lineNameOf(row),
        regionCode: null,
        regionName: null,
        managerName: managerArea.managerName,
        value: 0,
        valueByWeek: {},
        gapWeekNumbers: [],
        exactValue: 0,
        allocatedValue: 0,
        products: [],
      }));
      accumulate(rep, productsByKey.get(key)!, row, value, units, week);
      if (spansDepotGap) addGapWeek(depotGapWeeksByKey, key, week);
      continue;
    }

    if (!seat) {
      unattributedValue += value;
      const line = lineNameOf(row);
      const key = `unattributed:${fieldForceLineKey(line)}`;
      const rep = ensureRep(key, () => ({
        key,
        kind: "unattributed",
        label: "Not attributed to a rep",
        repName: null,
        repHrId: null,
        areaCode: null,
        areaName: null,
        lineCode: line,
        lineName: line,
        regionCode: null,
        regionName: null,
        managerName: null,
        value: 0,
        valueByWeek: {},
        gapWeekNumbers: [],
        exactValue: 0,
        allocatedValue: 0,
        products: [],
      }));
      accumulate(rep, productsByKey.get(key)!, row, value, units, week);
      if (spansDepotGap) addGapWeek(depotGapWeeksByKey, key, week);
      continue;
    }

    const key = `${fieldForceLineKey(seat.lineCode)}|${seat.areaCode}`;
    const rep = ensureRep(key, () => ({
      key,
      kind: seat.isVacant ? "vacant" : "rep",
      label: seat.isVacant ? `Vacant — ${seat.areaName}` : (seat.repName ?? seat.areaName),
      repName: seat.repName,
      repHrId: seat.repHrId,
      areaCode: seat.areaCode,
      areaName: seat.areaName,
      lineCode: seat.lineCode,
      lineName: lineNameOf(row),
      regionCode: seat.regionCode,
      regionName: seat.regionName,
      managerName: seat.managerName,
      value: 0,
      valueByWeek: {},
      gapWeekNumbers: [],
      exactValue: 0,
      allocatedValue: 0,
      products: [],
    }));
    accumulate(rep, productsByKey.get(key)!, row, value, units, week);
    if (spansDepotGap) addGapWeek(depotGapWeeksByKey, key, week);
  }

  // Rank each rep's products by value, then attach.
  for (const [key, rep] of byKey) {
    const products = [...(productsByKey.get(key)?.values() ?? [])];
    products.sort((a, b) => b.value - a.value || a.productName.localeCompare(b.productName));
    rep.products = products;
  }

  const reps = [...byKey.values()].sort((a, b) => {
    // Real reps first, then vacant seats, then the residue — the residue is never the headline.
    const rank = (row: FieldForceRep) => (row.kind === "rep" ? 0 : row.kind === "vacant" || row.kind === "manager" ? 1 : 2);
    return rank(a) - rank(b) || b.value - a.value || a.label.localeCompare(b.label);
  });

  const totals = reps.reduce(
    (acc, rep) => {
      acc.value += rep.value;
      // The three attribution buckets must PARTITION `value`. The residue is reported on its own as
      // `unattributedValue`; counting its money a SECOND time inside exact/allocated made the strip's
      // stacked bar 108% wide and printed two different "exact" figures on one screen (30.3% beside
      // 27.8%). Two numbers for one quantity does not cost half the trust — it costs all of it, in
      // both numbers, because the reader cannot tell which one is the lie.
      if (rep.kind !== "unattributed") {
        acc.exactValue += rep.exactValue;
        acc.allocatedValue += rep.allocatedValue;
      }
      if (rep.kind === "rep" && rep.value > 0) acc.repsWithSales += 1;
      if (rep.kind === "vacant" && rep.value > 0) acc.vacantAreasWithSales += 1;
      return acc;
    },
    { value: 0, exactValue: 0, allocatedValue: 0, unattributedValue, repsWithSales: 0, vacantAreasWithSales: 0 },
  );

  const orderedWeeks = [...weekNumbers].sort((a, b) => a - b);

  // A depot week whose previous week that depot never uploaded carries a de-cumulated figure that
  // silently spans the gap. A per-rep cell cannot be suppressed without breaking the row's own
  // arithmetic, so the week is FLAGGED instead and the screen marks the column. Per depot, so one depot's
  // missing week is not hidden by another depot's sheet, and per row, so a rep carries only his own.
  const byWeek = (a: number, b: number) => a - b;
  const gapWeekNumbers = [...new Set([...depotGapWeeksByKey.values()].flatMap((weeks) => [...weeks]))].sort(byWeek);
  for (const rep of reps) rep.gapWeekNumbers = [...(depotGapWeeksByKey.get(rep.key) ?? [])].sort(byWeek);

  // The axis is the dashboard's stable universe where one was supplied, narrowed to products that
  // actually appear — so column N is the same product on every rep's row, in every scope.
  const present = new Map<string, string>();
  for (const map of productsByKey.values()) {
    for (const product of map.values()) present.set(product.productCode, product.productName);
  }
  const axisSource = input.productAxis ?? [];
  const productAxis = axisSource.length > 0
    ? axisSource.filter((option) => present.has(option.code)).map((option) => ({
        code: option.code,
        name: present.get(option.code) ?? option.name,
      }))
    : [...present.entries()]
        .map(([code, name]) => ({ code, name }))
        .sort((a, b) => a.name.localeCompare(b.name));

  return {
    weekNumbers: orderedWeeks,
    gapWeekNumbers,
    reps,
    productAxis,
    totals,
    seatIndexUnavailable: input.seatIndexUnavailable ?? seatIndex.seats.length === 0,
  };
}

function addGapWeek(weeksByKey: Map<string, Set<number>>, key: string, week: number | null | undefined): void {
  if (week === null || week === undefined) return;
  const weeks = weeksByKey.get(key) ?? new Set<number>();
  weeks.add(week);
  weeksByKey.set(key, weeks);
}

function accumulate(
  rep: FieldForceRep,
  products: Map<string, FieldForceProduct>,
  row: TaggedRow,
  value: number,
  units: number,
  week: number | null | undefined,
): void {
  rep.value += value;
  if (row.exactArea) rep.exactValue += value;
  else rep.allocatedValue += value;
  if (week !== null && week !== undefined) {
    rep.valueByWeek[week] = (rep.valueByWeek[week] ?? 0) + value;
  }

  const code = norm(row.productCode);
  if (!code) return;
  const product = products.get(code) ?? {
    productCode: code,
    productName: norm(row.productName) || code,
    family: norm(row.family),
    unitsByWeek: {},
    units: 0,
    value: 0,
  };
  product.units += units;
  product.value += value;
  if (week !== null && week !== undefined) {
    product.unitsByWeek[week] = (product.unitsByWeek[week] ?? 0) + units;
  }
  products.set(code, product);
}
