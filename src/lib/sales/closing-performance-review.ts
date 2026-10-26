import { getEmployeeDirectory, getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  filterMonthlyClosingMatrix,
  listMonthlyClosingLines,
  listMonthlyClosingPeriods,
  type MonthlyClosingCell,
  type MonthlyClosingMatrix,
} from "@/lib/sales/monthly-distributor-import";
import { loadMonthlyClosingPartsWithStoreSplit } from "@/lib/sales/monthly-closing-with-store-split";
import { loadMergedMonthlyClosingParts } from "@/lib/sales/monthly-closing-period-load";
import {
  monthlyClosingFilterOptions,
  type MonthlyClosingFilterOptions,
} from "@/lib/sales/monthly-closing-filter-options";
import {
  GROWTH_NO_BASE,
  performanceReviewRegionStyle,
  PERFORMANCE_REVIEW_FIRST_PERIOD,
  PERFORMANCE_REVIEW_REGIONS,
  regionOrder,
  reviewGrowthOf,
  type PerformanceReviewGrowth,
} from "@/lib/sales/closing-performance-review-regions";
import {
  narrowMatrixToViewerScope,
  reviewScopeIsBounded,
  type PerformanceReviewViewerScope,
} from "@/lib/sales/closing-performance-review-scope";

// The region palette and its first-period floor live in ./closing-performance-review-regions.ts (a
// dependency-free module) for the same reason official-lines.ts does: the Performance Review
// workspace is a CLIENT component that needs performanceReviewRegionStyle /
// PERFORMANCE_REVIEW_FIRST_PERIOD but not this file's server-only matrix builder (getEmployeeDirectory
// above pulls employee-photo's `node:crypto`, which webpack refuses in a browser bundle).
// Re-exported here so every existing server caller keeps importing from where it already does.
export { GROWTH_NO_BASE, performanceReviewRegionStyle, PERFORMANCE_REVIEW_FIRST_PERIOD, PERFORMANCE_REVIEW_REGIONS };
export type { PerformanceReviewGrowth };

/** The same four narrowings Monthly Closing offers. Empty everywhere means "the whole line". */
export type ClosingPerformanceReviewFilter = {
  areaCodes?: string[];
  productCodes?: string[];
  regionCodes?: string[];
  search?: string;
};

/** True when a filter would actually narrow anything — an all-empty filter must not cost a rebuild. */
export function reviewFilterIsActive(filter: ClosingPerformanceReviewFilter | null | undefined): boolean {
  if (!filter) return false;
  return (
    (filter.regionCodes?.length ?? 0) > 0 ||
    (filter.areaCodes?.length ?? 0) > 0 ||
    (filter.productCodes?.length ?? 0) > 0 ||
    String(filter.search ?? "").trim() !== ""
  );
}

/**
 * Narrow a closing matrix for the review.
 *
 * Delegates to filterMonthlyClosingMatrix — the SAME function the Monthly Closing screen and its
 * export already use — so "filtered like Monthly Closing" is literally true rather than a second
 * implementation that agrees with it today. It re-derives region subtotals and the national total
 * from the surviving area rows, so a narrowed review's totals stay exact.
 */
function applyReviewFilter(
  matrix: MonthlyClosingMatrix,
  filter: ClosingPerformanceReviewFilter | null,
): MonthlyClosingMatrix {
  if (!reviewFilterIsActive(filter)) return matrix;
  return filterMonthlyClosingMatrix(matrix, {
    areaCodes: filter?.areaCodes ?? [],
    productCodes: filter?.productCodes ?? [],
    regionCodes: filter?.regionCodes ?? [],
    search: filter?.search ?? "",
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Performance Review — the reading layer behind /sales/monthly-closing/performance-review.
//
// It re-shapes ONE source, the Monthly Closing matrix, into the six views the review sheet needs.
// It never re-derives sales from its own query: Monthly Closing is the only sales truth, so a
// number here that disagreed with the closing screen would be a defect, not a variant.
//
// TWO RULES GOVERN EVERY AGGREGATE BELOW, and both are the owner's:
//
//  1. **Units of different products are NEVER added.** A rep sells seventeen products at several
//     concentrations; "units" across them is not a quantity, it is a category error. So every
//     aggregate that spans more than one product code is expressed in VALUE, and units appear only
//     where the row IS a single product code. `unitsAreAddable` carries that decision to the
//     renderer so a display cannot quietly reintroduce the sum.
//  2. **A row's name is never a system state.** An area outside the organogram keeps its own name;
//     an empty rep seat reads "Vacant seat", which is a real fact about a real seat. Nothing here
//     may render as "Not mapped to an area" or "No district manager" — those describe our records,
//     not the business, and the owner has rejected them outright.
// ─────────────────────────────────────────────────────────────────────────────

/** How many months the by-month series carries, newest last. */
export const PERFORMANCE_REVIEW_MONTHS = 6;

export type PerformanceReviewAreaRow = {
  achievement: number | null;
  areaCode: string;
  areaName: string;
  /** Empty when the seat model knows no district manager for this (line, area). Never a label. */
  managerName: string | null;
  regionCode: string;
  regionName: string;
  /** True when a REP seat exists for this (line, area) and nobody occupies it. */
  repIsVacant: boolean;
  /** Every occupant of the rep seat, joined " / " — never truncated. */
  repName: string | null;
  salesValue: number;
  targetValue: number | null;
};

export type PerformanceReviewGroupRow = {
  achievement: number | null;
  /** How many areas rolled into this row. */
  areaCount: number;
  /** Manager or region name. Always a real name — see rule 2 at the top of this file. */
  label: string;
  regionCode: string;
  regionName: string;
  salesValue: number;
  targetValue: number | null;
};

export type PerformanceReviewFamilyRow = {
  achievement: number | null;
  family: string;
  /** How many distinct product codes make up this family. */
  productCount: number;
  salesUnits: number | null;
  salesValue: number;
  targetValue: number | null;
  /** False whenever the row spans more than one product code — see rule 1. */
  unitsAreAddable: boolean;
};

export type PerformanceReviewSeriesRow = {
  /**
   * Newest month over the one before it. Null when the month before has nothing on record ("new");
   * `GROWTH_NO_BASE` when it stood at zero or below, which prints "—" (see `reviewGrowthOf`).
   */
  growth: PerformanceReviewGrowth;
  key: string;
  label: string;
  /** One entry per month in `months`, oldest first. Null = that month was never uploaded. */
  perMonth: Array<number | null>;
  subLabel: string;
  /** False whenever the row spans more than one product code — see rule 1. */
  unitsAreAddable: boolean;
};

/**
 * One column of a performance matrix — a family, or a single product code.
 *
 * `unitsAreAddable` is the whole reason this type exists rather than a bare string. A column that is
 * ONE product code holds a real quantity and its units may be printed and summed down the column; a
 * family column spans concentrations, so its units are meaningless and the cell carries value only.
 */
export type PerformanceMatrixColumn = {
  key: string;
  label: string;
  productCount: number;
  subLabel: string;
  unitsAreAddable: boolean;
};

/**
 * One row of a performance matrix: WHO is on the left, and what they sold across the top.
 *
 * `units` is parallel to `values` and to the matrix's columns. It is null at any position whose
 * column is not a single product code — never 0, which would read as "sold nothing".
 */
export type PerformanceMatrixRow = {
  achievement: number | null;
  areaCode: string;
  areaName: string;
  kind: "area" | "regionSubtotal" | "grandTotal";
  managerName: string | null;
  regionCode: string;
  regionName: string;
  repIsVacant: boolean;
  repName: string | null;
  salesValue: number;
  targetValue: number | null;
  units: Array<number | null>;
  values: Array<number | null>;
};

/**
 * Reps and areas down the side, products or families across the top — the owner's shape.
 *
 * This is the closing's own grid re-cut so that a row names the PERSON who owns it, not just the
 * territory code. The Monthly Closing matrix answers "what did area CA1 sell of TB001"; this answers
 * "what did Mostafa Kamel sell of Tebofortin", which is the question a review is actually for.
 *
 * The row total is always VALUE, on both variants. Even on the by-product grid, where each single
 * column's units are real, adding those units ACROSS the row would sum different products — the one
 * thing that is never done here.
 */
export type PerformanceMatrix = {
  columns: PerformanceMatrixColumn[];
  rows: PerformanceMatrixRow[];
};

/**
 * One block of the per-rep by-month grid: ONE product code, carrying its own run of months.
 *
 * `unitsAreAddable` is always true here and is carried anyway, for the same reason a matrix column
 * carries it — the workbook builder REFUSES to print a units block whose column says it spans more
 * than one product code, so the decision has to travel on the data rather than be assumed by a
 * renderer downstream.
 */
export type PerformanceProductMonthColumn = {
  key: string;
  label: string;
  subLabel: string;
  unitsAreAddable: boolean;
};

/**
 * One row of the per-rep by-month grid — the rep and area on the left, then every product's months.
 *
 * `units[productIndex][monthIndex]` is UNITS, and it is a real quantity: a block is one product
 * code, so a figure may be read across its own months and summed down its own column. There is
 * deliberately NO row total — a row spans products, and units of different products are never
 * added. `growth[productIndex]` is that product's newest month over the one before it.
 */
export type PerformanceProductMonthRow = {
  areaCode: string;
  areaName: string;
  growth: Array<PerformanceReviewGrowth>;
  kind: "area" | "regionSubtotal" | "grandTotal";
  managerName: string | null;
  regionCode: string;
  regionName: string;
  repIsVacant: boolean;
  repName: string | null;
  units: Array<Array<number | null>>;
};

/** Reps and areas down the side, one product per block across the top, months inside each block. */
export type PerformanceProductMonthMatrix = {
  columns: PerformanceProductMonthColumn[];
  months: string[];
  rows: PerformanceProductMonthRow[];
};

export type ClosingPerformanceReview = {
  areas: PerformanceReviewAreaRow[];
  /** By-month VALUE per area, plus its growth. Value, never units — see rule 1. */
  areaValueByMonth: PerformanceReviewSeriesRow[];
  availableLines: string[];
  availablePeriods: string[];
  families: PerformanceReviewFamilyRow[];
  /**
   * What the Regions / Areas / Products pickers may offer, built from the UNFILTERED matrix.
   *
   * Derived on the server on purpose. The rows this payload carries are the ones that SURVIVED the
   * filter, so a picker built from them would offer only what is already selected — filter to Delta
   * and Upper Egypt disappears from the list that is supposed to let you switch to it.
   */
  filterOptions: MonthlyClosingFilterOptions;
  generatedAt: string;
  line: string | null;
  managers: PerformanceReviewGroupRow[];
  /** Reps and areas down the side, FAMILIES across the top. Value — a family spans concentrations. */
  matrixByFamily: PerformanceMatrix;
  /** Reps and areas down the side, PRODUCT CODES across the top. Units per cell; the row total is value. */
  matrixByProduct: PerformanceMatrix;
  /** The by-month series, oldest first, ending at the selected period. */
  months: string[];
  period: string | null;
  /** By-month VALUE per product code. */
  productValueByMonth: PerformanceReviewSeriesRow[];
  /** By-month UNITS per product code — one product code per row, so the sum is real. */
  productUnitsByMonth: PerformanceReviewSeriesRow[];
  /**
   * The same UNITS, per REP: reps and areas down the side, each product's own months across the top.
   *
   * `productUnitsByMonth` answers "how did Tebofortin 40mg move month to month on the line"; this
   * answers "how did it move for Mostafa Kamel", which is the question a review of PEOPLE is for.
   * A block is one product code, so these units are a real quantity — and there is no row total,
   * because a row spans products.
   */
  productUnitsByRepByMonth: PerformanceProductMonthMatrix;
  regions: PerformanceReviewGroupRow[];
  /**
   * True when the VIEWER was bounded to part of the line before any picker was touched — a district
   * or regional manager reading his own territory (owner, 2026-10-13: "everyone sees only his
   * scope"). False on the admin screen, which is unbounded.
   *
   * It exists because the bound is INVISIBLE to a count: a bounded viewer's pickers are built from
   * his own areas, so "rows surviving" equals "rows offered" and `reviewShowsLessThanTheWholeLine`
   * would report the whole line. That helper reads this field first, which is what keeps a district
   * manager's bottom row from printing NATIONAL TOTAL over four areas of fifty-eight.
   */
  scopeIsBounded: boolean;
  /**
   * Every month folded into the headline figures, oldest first — one entry for a single-month read.
   *
   * Distinct from `months`, which is the by-month SERIES behind the growth tabs and is always
   * several. This is what the totals, the rankings and both grids actually cover.
   */
  selectedPeriods: string[];
  /**
   * Requested but unreadable, so the screen can name the missing month rather than quietly
   * totalling fewer months than the reader asked for.
   */
  skippedPeriods: string[];
  totals: { achievement: number | null; salesValue: number; targetValue: number | null };
};

function achievementOf(sales: number, target: number | null): number | null {
  if (target == null || target === 0) return null;
  return sales / target;
}

/** Growth of the newest month over the one before it — the shared rule, `reviewGrowthOf`. */
const growthOf = reviewGrowthOf;

/** Sum a matrix cell list, keeping "no target" distinct from "target of zero". */
function sumCells(cells: MonthlyClosingCell[]): { salesUnits: number; salesValue: number; targetValue: number | null } {
  let salesUnits = 0;
  let salesValue = 0;
  let targetValue: number | null = null;
  for (const cell of cells) {
    salesUnits += cell.salesUnits;
    salesValue += cell.salesValue;
    if (cell.targetValue != null) targetValue = (targetValue ?? 0) + cell.targetValue;
  }
  return { salesUnits, salesValue, targetValue };
}

type SeatRow = {
  area_code?: string | null;
  is_other_pseudo_dm?: boolean | null;
  line_code?: string | null;
  line_name?: string | null;
  occupant_hr_id?: string | null;
  parent_seat_id?: string | null;
  seat_id?: string | null;
  seat_tier?: string | null;
};

/** Collapse every spelling of a line to one key — `au.lines` and the app disagree on casing. */
function lineKey(value: string | null | undefined): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export type AreaSeatAssignment = {
  managerName: string | null;
  repIsVacant: boolean;
  repName: string | null;
};

/**
 * (line, area) → the rep who covers it and the manager above that rep, from the seat model.
 *
 * The Organogram / AU seat model is the source of truth for org structure, so the review reads it
 * rather than inferring a manager from the area code. The manager is the REP seat's PARENT seat,
 * which is how an acting DM is picked up automatically: authority follows the seat, never a job
 * title.
 *
 * Fails soft to an empty map — a seat-model outage must leave the rep column blank, never break the
 * closing review, which is a sales report first.
 */
export async function loadAreaSeatAssignments(asOf?: string | null): Promise<Map<string, AreaSeatAssignment>> {
  const assignments = new Map<string, AreaSeatAssignment>();
  try {
    const [{ data, error }, directory] = await Promise.all([
      getSupabaseAdmin()
        .from("au_v_org_tree")
        .select("seat_id,parent_seat_id,seat_tier,line_code,line_name,area_code,is_other_pseudo_dm,occupant_hr_id"),
      getEmployeeDirectory(),
    ]);
    if (error) throw error;

    const nameByHrId = new Map<string, string>();
    for (const employee of directory.employees) {
      const key = canonicalHrIdKey(employee.hrId);
      if (key) nameByHrId.set(key, employee.displayName || employee.fullName);
    }
    const nameOf = (hrId: string | null | undefined): string | null => {
      const key = canonicalHrIdKey(hrId ?? "");
      return key ? nameByHrId.get(key) ?? null : null;
    };

    const rows = (data ?? []) as SeatRow[];
    const bySeatId = new Map<string, SeatRow>();
    for (const row of rows) {
      const seatId = String(row.seat_id ?? "").trim();
      if (seatId) bySeatId.set(seatId, row);
    }

    for (const row of rows) {
      if (String(row.seat_tier ?? "").toUpperCase() !== "REP") continue;
      const areaCode = String(row.area_code ?? "").trim().toUpperCase();
      const line = lineKey(row.line_code ?? row.line_name);
      if (!areaCode || !line) continue;

      const key = `${line}::${areaCode}`;
      const repName = nameOf(row.occupant_hr_id);
      // A pseudo-DM seat is the catch-all parent the organogram uses for areas nobody runs. It is
      // not a person, so it contributes no manager name — and the renderer must then show the row
      // with an empty manager, never a sentence standing in for one.
      const parent = row.parent_seat_id ? bySeatId.get(String(row.parent_seat_id).trim()) : undefined;
      const managerName = parent && !parent.is_other_pseudo_dm ? nameOf(parent.occupant_hr_id) : null;

      const existing = assignments.get(key);
      if (existing) {
        // Two rep seats on one (line, area): both names are shown, joined, never truncated.
        const names = [existing.repName, repName].filter((value): value is string => Boolean(value));
        assignments.set(key, {
          managerName: existing.managerName ?? managerName,
          repIsVacant: names.length === 0,
          repName: names.length > 0 ? Array.from(new Set(names)).join(" / ") : null,
        });
        continue;
      }
      assignments.set(key, { managerName, repIsVacant: !repName, repName });
    }
  } catch (error) {
    logError("Performance review seat-model read failed", {
      error,
      labels: { event: "closing_performance_review_seats_failed" },
    });
  }

  await applyManagerAsOf(assignments, asOf ?? null);
  return assignments;
}

/**
 * Whether a dated row is the one in force on `asOf`.
 *
 * HALF-OPEN — `[from, to)` — and it has to be. A dated pair closes and reopens on the SAME day: the
 * Delta (3) rows run to 2026-09-01 and the replacements run from 2026-09-01. An inclusive end would
 * match BOTH rows for 1 September, and which one won would depend on iteration order, which is not
 * a decision anybody made.
 */
export function coversAsOf(
  effectiveFrom: string | null | undefined,
  effectiveTo: string | null | undefined,
  asOf: string,
): boolean {
  const from = String(effectiveFrom ?? "").trim();
  if (!from || from > asOf) return false;
  const to = effectiveTo ? String(effectiveTo).trim() : "";
  return !to || to > asOf;
}

/** The last day of a `YYYY-MM` period, which is the date a month's attribution is resolved at. */
export function periodEndDate(period: string | null | undefined): string | null {
  const match = /^(\d{4})-(\d{2})$/.exec(String(period ?? "").trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  // Day 0 of the NEXT month is the last day of this one, and it handles February without a table.
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${match[1]}-${match[2]}-${String(last).padStart(2, "0")}`;
}

/**
 * Name the manager who held the area THEN, not the one who holds it now.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THIS WAS A REAL MISATTRIBUTION, found by checking August's District Managers against the seat model
 * in the database. `au_v_org_tree` is the CURRENT tree and carries no date, so a past month was
 * labelled with today's seats. On the five Delta (3) areas — which sit on a dated PAIR, closing
 * 2026-09-01 and reopening the same day — August was credited to the manager whose seat begins on
 * 1 September:
 *
 *     D24 Sharkia 1  seat SEAT-AIF-DM-D2  -> Salim Gomaa      was shown as Samaa Shalaby
 *     D11 Qalubeya   seat SEAT-AIF-OTHERS -> vacant           was shown as Samaa Shalaby
 *     D25 Sharkia 2  seat SEAT-AIF-OTHERS -> vacant           was shown as Samaa Shalaby
 *     OT2 Suez       seat SEAT-AIF-OTHERS -> vacant           was shown as Samaa Shalaby
 *
 * 6,215 EGP of 477,499 relabelled, and a person named for a month before she held the seat. The
 * totals always reconciled, because the money was never lost — only put under the wrong name, which
 * is why nothing downstream could notice.
 *
 * BOTH HALVES ARE NOW PERIOD-AWARE. Area -> seat comes from `au_v_line_area_map_all`, and seat ->
 * person from `au_v_seat_occupancy_all`, the history view added 2026-09-05 for exactly this. The
 * first cut could only do the first half: the occupancy history lives in `au.occupancy_history`,
 * and PostgREST exposes only `public`, `graphql_public` and `analytics`, so `.schema("au")` answers
 * PGRST106. `au_v_org_tree` is still read, but ONLY for `is_other_pseudo_dm` -- a property of the
 * seat itself, which carries no date and so cannot be got wrong by reading it today.
 *
 * FAILS SOFT. A map read that errors leaves the current-tree answer in place rather than blanking
 * every manager: a wrong-but-present name is bad, and no names at all is worse.
 */
async function applyManagerAsOf(
  assignments: Map<string, AreaSeatAssignment>,
  asOf: string | null,
): Promise<void> {
  if (!asOf) return;
  try {
    const [
      { data: mapRows, error: mapError },
      { data: seatRows, error: seatError },
      { data: occupancyRows, error: occupancyError },
    ] = await Promise.all([
      getSupabaseAdmin()
        .from("au_v_line_area_map_all")
        .select("line_code,area_code,dm_seat_id,rep_seat_id,effective_from,effective_to"),
      // The current tree, for TWO properties of the seat itself: whether it is the organogram's
      // catch-all, and which area it is the rep seat OF. Neither is about who sits in it, so neither
      // carries a date.
      getSupabaseAdmin().from("au_v_org_tree").select("seat_id,is_other_pseudo_dm,area_code"),
      getSupabaseAdmin()
        .from("au_v_seat_occupancy_all")
        .select("seat_id,occupant_hr_id,occupant_canonical_hr_id,effective_from,effective_to"),
    ]);
    if (mapError) throw mapError;
    if (seatError) throw seatError;
    if (occupancyError) throw occupancyError;

    // LEAVERS INCLUDED, and that is the point of asking as-of at all. Upper Egypt 2 was run through
    // July by a manager who resigned on 2026-08-03; the active-only directory cannot name him, so
    // his month would read "no manager seat" — losing a real person's attribution while looking like
    // an ordinary vacancy. A past month names whoever held the seat then, whether or not they are
    // still here.
    const directoryRows = await getEmployeeDirectoryRows({ includeInactive: true });
    const nameByHrId = new Map<string, string>();
    for (const employee of directoryRows) {
      const key = canonicalHrIdKey(employee.hrId);
      if (key) nameByHrId.set(key, employee.displayName || employee.fullName);
    }

    const pseudoSeat = new Set<string>();
    for (const row of (seatRows ?? []) as SeatRow[]) {
      const seatId = String(row.seat_id ?? "").trim();
      if (seatId && row.is_other_pseudo_dm) pseudoSeat.add(seatId);
    }

    // Who sat in each seat ON THAT DAY. A seat with no row in force was genuinely empty then, which
    // is a real answer rather than a gap: the organogram keeps `vacant_placeholder` rows precisely
    // so an empty seat is stated instead of inferred from an absence.
    const occupantOf = new Map<string, string | null>();
    for (const row of (occupancyRows ?? []) as Array<Record<string, string | null>>) {
      const seatId = String(row.seat_id ?? "").trim();
      if (!seatId) continue;
      if (!coversAsOf(row.effective_from, row.effective_to, asOf)) continue;
      const key = canonicalHrIdKey(row.occupant_canonical_hr_id ?? row.occupant_hr_id ?? "");
      occupantOf.set(seatId, key ? nameByHrId.get(key) ?? null : null);
    }

    const seatAreaOf = new Map<string, string>();
    for (const row of (seatRows ?? []) as SeatRow[]) {
      const seatId = String(row.seat_id ?? "").trim();
      const areaCode = String(row.area_code ?? "").trim().toUpperCase();
      if (seatId && areaCode) seatAreaOf.set(seatId, areaCode);
    }

    applyAreaMapAsOf(assignments, {
      asOf,
      mapRows: (mapRows ?? []) as Array<Record<string, string | null>>,
      occupantOf,
      pseudoSeat,
      seatAreaOf,
    });
  } catch (error) {
    logError("Performance review as-of manager read failed; keeping the current-tree answer", {
      error,
      labels: { event: "closing_performance_review_manager_asof_failed" },
    });
  }
}

/**
 * Apply the dated area map to the seat assignments: the manager in force on `asOf`, and — when the
 * map hands an area to ANOTHER area's rep seat — that seat's rep.
 *
 * 🔴 ONE REP CAN OWN TWO AREAS, AND ONLY THE MAP SAYS SO. CNS has a single Qena (owner, 2026-10-12:
 * "CNS has a single Qena and both Qenas are counted to the Qena rep"), so the map points CNS Qena 2 at
 * `SEAT-CNS-REP-UE7`. The seat tree only knows that seat as Qena 1's, so the review used to print
 * Qena 2 with NO rep and NO manager — 176,773 EGP of September CNS outside every person's figure,
 * while Sales vs Target, which reads `rep_seat_id`, already credited it to the Qena rep. An area whose
 * map row names another area's rep seat now takes that seat's rep, so the two screens agree.
 *
 * Pure, so the rule is testable without a database.
 */
export function applyAreaMapAsOf(
  assignments: Map<string, AreaSeatAssignment>,
  input: {
    asOf: string;
    mapRows: Array<Record<string, string | null>>;
    occupantOf: Map<string, string | null>;
    pseudoSeat: Set<string>;
    seatAreaOf: Map<string, string>;
  },
): void {
  const { asOf, mapRows, occupantOf, pseudoSeat, seatAreaOf } = input;
  // The seat's OWN area's rep, read before anything below rewrites a row, so a borrowed rep is the
  // seat's occupant and never a value this loop has already changed.
  const repOf = new Map(
    [...assignments].map(([key, value]) => [key, { repIsVacant: value.repIsVacant, repName: value.repName }]),
  );

  for (const row of mapRows) {
    if (!coversAsOf(row.effective_from, row.effective_to, asOf)) continue;

    const line = lineKey(row.line_code);
    const areaCode = String(row.area_code ?? "").trim().toUpperCase();
    if (!line || !areaCode) continue;
    const key = `${line}::${areaCode}`;

    const repSeatId = row.rep_seat_id ? String(row.rep_seat_id).trim() : "";
    const repSeatArea = repSeatId ? seatAreaOf.get(repSeatId) ?? "" : "";
    const borrowed = repSeatArea && repSeatArea !== areaCode ? repOf.get(`${line}::${repSeatArea}`) : undefined;

    const existing = assignments.get(key);
    if (!existing && !borrowed) continue;

    const seatId = row.dm_seat_id ? String(row.dm_seat_id).trim() : "";
    // A pseudo-DM seat is the organogram's catch-all for areas nobody runs; it is not a person.
    const managerName = seatId && !pseudoSeat.has(seatId) ? occupantOf.get(seatId) ?? null : null;
    assignments.set(key, {
      ...(existing ?? { repIsVacant: false, repName: null }),
      ...(borrowed ?? {}),
      managerName,
    });
  }
}

/**
 * The N periods up to and including `period`, oldest first, never reaching before July 2026.
 *
 * The floor is not a display preference — see PERFORMANCE_REVIEW_FIRST_PERIOD. A month below it is
 * dropped outright rather than rendered empty, because an empty column would invite the reader to
 * ask what is missing when the answer is that the month is not comparable at all.
 */
export function selectSeriesPeriods(availablePeriods: string[], period: string | null, count: number): string[] {
  const ordered = Array.from(new Set(availablePeriods.filter(Boolean)))
    .filter((value) => value >= PERFORMANCE_REVIEW_FIRST_PERIOD)
    .sort();
  const upTo = period ? ordered.filter((value) => value <= period) : ordered;
  const window = upTo.slice(Math.max(0, upTo.length - count));
  // The selected month always appears, even if the closing's period list has not caught up with it.
  // A month below the floor is the one case that yields nothing, and that is the correct answer:
  // the series has not started yet, so there is no growth to show.
  if (window.length === 0 && period && period >= PERFORMANCE_REVIEW_FIRST_PERIOD) return [period];
  return window;
}

/** Flatten a matrix into its area rows, dropping the synthetic region subtotals. */
function areaRowsOf(matrix: MonthlyClosingMatrix) {
  return matrix.regions.flatMap((group) => group.areas.map((area) => ({ area, group })));
}

type AreaHome = { areaCode: string; areaName: string; regionCode: string; regionName: string };

/**
 * Every area the series touches, each ONCE, under the region it has in the NEWEST month that holds it.
 *
 * 🔴 AN AREA IS ONE ROW, NEVER ONE ROW PER REGION IT HAS EVER SAT IN. The organogram re-homes areas
 * between months — on Pedia, Minia 1/2, Assuit 1/2, Sohag 1/2 and Qena 1/2 moved from "Upper Egypt"
 * to "Upper Egypt 1/2" in September, Kafr El-Sheikh 1 from Alex-BHR to Delta (1), Fayoum from Giza to
 * Upper Egypt 1, Luxor from Upper Egypt 2 to Others. Grouping each month's rows by that month's own
 * region printed every such area twice, each copy carrying ALL its months, so the region subtotals
 * and the national row added it twice: September Lacto Advanced 1 summed to 6,377 against the
 * closing's 5,561, Ivyronc to 12,710 against 10,642.
 *
 * The SELECTED month (the headline matrix) is asked first, then the series newest to oldest, so an
 * area sits where the reader's own month puts it and an area that has since gone keeps its last home.
 */
function areaHomesByLatestMonth(
  headline: MonthlyClosingMatrix | null,
  seriesMatrices: ReadonlyArray<{ matrix: MonthlyClosingMatrix | null }>,
): Map<string, AreaHome> {
  const homes = new Map<string, AreaHome>();
  const sources = [headline, ...[...seriesMatrices].reverse().map((entry) => entry.matrix)];
  for (const matrix of sources) {
    if (!matrix) continue;
    for (const { area, group } of areaRowsOf(matrix)) {
      const code = area.areaCode.trim().toUpperCase();
      if (homes.has(code)) continue;
      homes.set(code, {
        areaCode: area.areaCode,
        areaName: area.areaName,
        regionCode: group.regionCode,
        regionName: group.regionName,
      });
    }
  }
  return homes;
}

/**
 * Build one performance matrix: reps and areas down the side, the given columns across the top.
 *
 * `groups` maps each output column to the closing columns that feed it — one index for a product
 * grid, several for a family grid. That single parameter is what makes the two variants one piece of
 * code, and it is also where the units rule is decided: a group of one is a real quantity, a group of
 * several is not, and the flag travels on the column so no renderer downstream has to work it out
 * again.
 *
 * Region subtotals and the national total are rows here, exactly as they are on the Monthly Closing
 * matrix this re-cuts — a grid whose columns do not add up to anything is not a grid a reader trusts.
 */
function buildPerformanceMatrix(input: {
  areasWithSeats: PerformanceReviewAreaRow[];
  groups: Array<{ column: PerformanceMatrixColumn; indexes: number[] }>;
  matrix: MonthlyClosingMatrix;
}): PerformanceMatrix {
  const { areasWithSeats, groups, matrix } = input;
  const columns = groups.map((group) => group.column);
  const seatByArea = new Map(areasWithSeats.map((area) => [area.areaCode.trim().toUpperCase(), area]));

  const cellsOf = (cells: MonthlyClosingCell[]) => {
    const units: Array<number | null> = [];
    const values: Array<number | null> = [];
    for (const group of groups) {
      const picked = group.indexes.map((index) => cells[index]).filter(Boolean);
      const totals = sumCells(picked);
      // Units only where the column IS one product code. Null, never 0 — a family's units are not a
      // smaller number, they are not a number at all.
      units.push(group.column.unitsAreAddable ? totals.salesUnits : null);
      values.push(totals.salesValue);
    }
    return { units, values };
  };

  const rows: PerformanceMatrixRow[] = [];
  for (const group of matrix.regions) {
    for (const area of group.areas) {
      const seat = seatByArea.get(area.areaCode.trim().toUpperCase());
      rows.push({
        achievement: achievementOf(area.rowTotal.salesValue, area.rowTotal.targetValue),
        areaCode: area.areaCode,
        areaName: area.areaName,
        kind: "area",
        managerName: seat?.managerName ?? null,
        regionCode: group.regionCode,
        regionName: group.regionName,
        repIsVacant: seat?.repIsVacant ?? false,
        repName: seat?.repName ?? null,
        salesValue: area.rowTotal.salesValue,
        targetValue: area.rowTotal.targetValue,
        ...cellsOf(area.cells),
      });
    }
    rows.push({
      achievement: achievementOf(group.subtotal.rowTotal.salesValue, group.subtotal.rowTotal.targetValue),
      areaCode: group.regionCode,
      areaName: group.regionName,
      kind: "regionSubtotal",
      managerName: null,
      regionCode: group.regionCode,
      regionName: group.regionName,
      repIsVacant: false,
      repName: null,
      salesValue: group.subtotal.rowTotal.salesValue,
      targetValue: group.subtotal.rowTotal.targetValue,
      ...cellsOf(group.subtotal.cells),
    });
  }

  rows.push({
    achievement: achievementOf(matrix.grandTotal.rowTotal.salesValue, matrix.grandTotal.rowTotal.targetValue),
    areaCode: "",
    areaName: "National total",
    kind: "grandTotal",
    managerName: null,
    regionCode: "",
    regionName: "",
    repIsVacant: false,
    repName: null,
    salesValue: matrix.grandTotal.rowTotal.salesValue,
    targetValue: matrix.grandTotal.rowTotal.targetValue,
    ...cellsOf(matrix.grandTotal.cells),
  });

  return { columns, rows };
}

/**
 * Reps and areas down the side, each product's own run of months across the top — in UNITS.
 *
 * This is the per-rep half of "Units & growth by month": one block per product code, and inside the
 * block one column per month plus that product's growth. Every figure is a real quantity, because a
 * block never spans more than one product code — which is also why the row carries no total, and why
 * a region subtotal and the national total are legitimate here: they sum ONE product down a column.
 *
 * ROWS COVER EVERY MONTH OF THE SERIES, not just the selected one. An area that sold in July and
 * nothing in September still belongs on a sheet whose whole point is the trend; a month, an area or
 * a product that is genuinely absent reads as null — never 0, which would claim nothing was sold.
 */
function buildProductMonthMatrix(input: {
  columns: PerformanceProductMonthColumn[];
  headline: MonthlyClosingMatrix;
  line: string;
  seatAssignments: Map<string, AreaSeatAssignment>;
  seriesMatrices: Array<{ matrix: MonthlyClosingMatrix | null; period: string }>;
}): PerformanceProductMonthMatrix {
  const { columns, headline, line, seatAssignments, seriesMatrices } = input;
  const months = seriesMatrices.map((entry) => entry.period);

  // One lookup per month: which column holds a product code, and which cells belong to an area.
  // Built once, because the alternative is a findIndex per cell — areas × products × months of them.
  const perMonth = seriesMatrices.map((entry) => {
    const columnIndex = new Map<string, number>();
    const cellsByArea = new Map<string, MonthlyClosingCell[]>();
    if (entry.matrix) {
      entry.matrix.columns.forEach((column, index) => columnIndex.set(column.productCode, index));
      for (const { area } of areaRowsOf(entry.matrix)) {
        cellsByArea.set(area.areaCode.trim().toUpperCase(), area.cells);
      }
    }
    return { cellsByArea, columnIndex, uploaded: entry.matrix != null };
  });

  // Every area that appears in ANY month — ONCE, under the region the selected month gives it — then
  // grouped by that region in the closing's own region order. One row per (rep, area), so a region
  // subtotal and the national row add each area exactly once (`areaHomesByLatestMonth`).
  const regionGroups = new Map<
    string,
    { areas: Map<string, { areaCode: string; areaName: string }>; regionCode: string; regionName: string }
  >();
  for (const [code, home] of areaHomesByLatestMonth(headline, seriesMatrices)) {
    let entry = regionGroups.get(home.regionCode);
    if (!entry) {
      entry = { areas: new Map(), regionCode: home.regionCode, regionName: home.regionName };
      regionGroups.set(home.regionCode, entry);
    }
    entry.areas.set(code, { areaCode: home.areaCode, areaName: home.areaName });
  }

  const emptyBlocks = () => columns.map(() => months.map(() => null as number | null));

  const unitsFor = (areaCode: string): Array<Array<number | null>> =>
    columns.map((column) =>
      perMonth.map((month) => {
        if (!month.uploaded) return null;
        const cells = month.cellsByArea.get(areaCode);
        if (!cells) return null;
        const index = month.columnIndex.get(column.key);
        if (index == null) return null;
        return cells[index]?.salesUnits ?? null;
      }),
    );

  // A null stays null until something real lands on it: a total over three unuploaded months is
  // "not uploaded", not zero.
  const addInto = (target: Array<Array<number | null>>, source: Array<Array<number | null>>) => {
    source.forEach((series, productIndex) => {
      series.forEach((value, monthIndex) => {
        if (value == null) return;
        target[productIndex][monthIndex] = (target[productIndex][monthIndex] ?? 0) + value;
      });
    });
  };

  const rows: PerformanceProductMonthRow[] = [];
  const national = emptyBlocks();
  const ordered = [...regionGroups.values()].sort((a, b) => regionOrder(a.regionCode) - regionOrder(b.regionCode));

  for (const group of ordered) {
    const subtotal = emptyBlocks();
    for (const [code, meta] of group.areas) {
      const seat = seatAssignments.get(`${line}::${code}`);
      const units = unitsFor(code);
      addInto(subtotal, units);
      rows.push({
        areaCode: meta.areaCode,
        // The area's OWN name — see rule 2 at the top of this file.
        areaName: meta.areaName,
        growth: units.map((series) => growthOf(series)),
        kind: "area",
        managerName: seat?.managerName ?? null,
        regionCode: group.regionCode,
        regionName: group.regionName,
        repIsVacant: seat?.repIsVacant ?? false,
        repName: seat?.repName ?? null,
        units,
      });
    }
    addInto(national, subtotal);
    rows.push({
      areaCode: group.regionCode,
      areaName: group.regionName,
      growth: subtotal.map((series) => growthOf(series)),
      kind: "regionSubtotal",
      managerName: null,
      regionCode: group.regionCode,
      regionName: group.regionName,
      repIsVacant: false,
      repName: null,
      units: subtotal,
    });
  }

  rows.push({
    areaCode: "",
    areaName: "National total",
    growth: national.map((series) => growthOf(series)),
    kind: "grandTotal",
    managerName: null,
    regionCode: "",
    regionName: "",
    repIsVacant: false,
    repName: null,
    units: national,
  });

  return { columns, months, rows };
}

/**
 * Build every view of the review for one (line, period).
 *
 * `seriesMatrices` carries the earlier months. A month that was never uploaded is simply absent,
 * and the series renders "—" for it — never a zero, which would read as "sold nothing".
 */
export function buildClosingPerformanceReview(input: {
  availableLines: string[];
  availablePeriods: string[];
  /**
   * The pickers' options, built from the UNFILTERED matrix. Omitted, they are derived from `matrix`
   * itself — right for a caller that never filters (the tests, a direct single-matrix build) and
   * wrong the moment one does, which is why the loader below always passes them explicitly.
   */
  filterOptions?: MonthlyClosingFilterOptions;
  generatedAt: string;
  matrix: MonthlyClosingMatrix;
  seatAssignments: Map<string, AreaSeatAssignment>;
  /** True when the viewer is bounded to part of the line — see `scopeIsBounded` on the payload. */
  scopeIsBounded?: boolean;
  selectedPeriods?: string[];
  seriesMatrices: Array<{ matrix: MonthlyClosingMatrix | null; period: string }>;
  skippedPeriods?: string[];
}): ClosingPerformanceReview {
  const { availableLines, availablePeriods, generatedAt, matrix, seatAssignments, seriesMatrices } = input;
  // Falls back to the matrix's own months so a caller that builds directly from one matrix (the
  // tests, and any future single-month caller) still gets a truthful list rather than an empty one.
  const selectedPeriods =
    input.selectedPeriods && input.selectedPeriods.length > 0
      ? input.selectedPeriods
      : matrix.periods && matrix.periods.length > 0
        ? matrix.periods
        : matrix.period
          ? [matrix.period]
          : [];
  const line = lineKey(matrix.line);

  // ── Areas, each with the rep and manager the seat model gives it ──────────
  const areas: PerformanceReviewAreaRow[] = areaRowsOf(matrix).map(({ area, group }) => {
    const areaCode = area.areaCode.trim().toUpperCase();
    const seat = seatAssignments.get(`${line}::${areaCode}`);
    return {
      achievement: achievementOf(area.rowTotal.salesValue, area.rowTotal.targetValue),
      areaCode: area.areaCode,
      // The area's OWN name, always. An area the organogram does not carry is still a real place
      // with a real name — "Main Store" is a warehouse, not a missing record.
      areaName: area.areaName,
      managerName: seat?.managerName ?? null,
      regionCode: group.regionCode,
      regionName: group.regionName,
      repIsVacant: seat ? seat.repIsVacant : false,
      repName: seat?.repName ?? null,
      salesValue: area.rowTotal.salesValue,
      targetValue: area.rowTotal.targetValue,
    };
  });

  // Ranked on achievement. An area with no target cannot be ranked against one, so it follows the
  // ranked block ordered by value — present and visible, never dropped for lacking a target.
  const ranked = areas.filter((row) => row.achievement != null).sort((a, b) => (b.achievement ?? 0) - (a.achievement ?? 0));
  const unranked = areas.filter((row) => row.achievement == null).sort((a, b) => b.salesValue - a.salesValue);
  const orderedAreas = [...ranked, ...unranked];

  // ── Managers and regions ─────────────────────────────────────────────────
  const managerGroups = new Map<string, PerformanceReviewGroupRow>();
  for (const row of areas) {
    // An area with no manager in the seat model is grouped under its own region rather than under
    // an invented label, so every row still carries a name a reader recognises.
    const label = row.managerName ?? `${row.regionName} · no manager seat`;
    const existing = managerGroups.get(label);
    if (existing) {
      existing.areaCount += 1;
      existing.salesValue += row.salesValue;
      if (row.targetValue != null) existing.targetValue = (existing.targetValue ?? 0) + row.targetValue;
      existing.achievement = achievementOf(existing.salesValue, existing.targetValue);
      continue;
    }
    managerGroups.set(label, {
      achievement: achievementOf(row.salesValue, row.targetValue),
      areaCount: 1,
      label,
      regionCode: row.regionCode,
      regionName: row.regionName,
      salesValue: row.salesValue,
      targetValue: row.targetValue,
    });
  }
  const managers = [...managerGroups.values()].sort(
    (a, b) => (b.achievement ?? -1) - (a.achievement ?? -1) || b.salesValue - a.salesValue,
  );

  const regionGroups = new Map<string, PerformanceReviewGroupRow>();
  for (const row of areas) {
    const existing = regionGroups.get(row.regionCode);
    if (existing) {
      existing.areaCount += 1;
      existing.salesValue += row.salesValue;
      if (row.targetValue != null) existing.targetValue = (existing.targetValue ?? 0) + row.targetValue;
      existing.achievement = achievementOf(existing.salesValue, existing.targetValue);
      continue;
    }
    regionGroups.set(row.regionCode, {
      achievement: achievementOf(row.salesValue, row.targetValue),
      areaCount: 1,
      label: row.regionName,
      regionCode: row.regionCode,
      regionName: row.regionName,
      salesValue: row.salesValue,
      targetValue: row.targetValue,
    });
  }
  const regions = [...regionGroups.values()].sort((a, b) => regionOrder(a.regionCode) - regionOrder(b.regionCode));

  // ── Families, by VALUE ───────────────────────────────────────────────────
  // A family is several product codes at several concentrations, so its units are not addable and
  // are reported only when the family happens to be a single product code.
  const familyIndex = new Map<string, number[]>();
  matrix.columns.forEach((column, index) => {
    const family = column.family?.trim() || column.productName;
    const list = familyIndex.get(family);
    if (list) list.push(index);
    else familyIndex.set(family, [index]);
  });

  const families: PerformanceReviewFamilyRow[] = [...familyIndex.entries()]
    .map(([family, indexes]) => {
      const totals = sumCells(indexes.map((index) => matrix.grandTotal.cells[index]).filter(Boolean));
      const unitsAreAddable = indexes.length === 1;
      return {
        achievement: achievementOf(totals.salesValue, totals.targetValue),
        family,
        productCount: indexes.length,
        salesUnits: unitsAreAddable ? totals.salesUnits : null,
        salesValue: totals.salesValue,
        targetValue: totals.targetValue,
        unitsAreAddable,
      };
    })
    .sort((a, b) => b.salesValue - a.salesValue);

  // ── The two grids: reps and areas down the side, products or families across ─────────────────
  //
  // Families are ordered by value so the line's biggest sits nearest the names, and products are
  // ordered inside their family so a family's concentrations stay together under one banner rather
  // than scattering across the sheet.
  const familyOrder = families.map((row) => row.family);
  const matrixByFamily = buildPerformanceMatrix({
    areasWithSeats: areas,
    groups: familyOrder.map((family) => {
      const indexes = familyIndex.get(family) ?? [];
      return {
        column: {
          key: family,
          label: family,
          productCount: indexes.length,
          subLabel: indexes.length === 1 ? matrix.columns[indexes[0]]?.productName ?? family : `${indexes.length} products`,
          unitsAreAddable: indexes.length === 1,
        },
        indexes,
      };
    }),
    matrix,
  });

  const matrixByProduct = buildPerformanceMatrix({
    areasWithSeats: areas,
    groups: familyOrder.flatMap((family) =>
      (familyIndex.get(family) ?? []).map((index) => ({
        column: {
          key: matrix.columns[index]?.productCode ?? String(index),
          label: matrix.columns[index]?.productName ?? String(index),
          productCount: 1,
          subLabel: family,
          // ONE product code, so these units are a real quantity and may be read and summed DOWN
          // the column. Across the row they still may not be — that is why every row total is value.
          unitsAreAddable: true,
        },
        indexes: [index],
      })),
    ),
    matrix,
  });

  // ── The by-month series ──────────────────────────────────────────────────
  const months = seriesMatrices.map((entry) => entry.period);

  // Per product code: value AND units, because one product code is one product — the sum is real.
  const productKeys = new Map<string, { family: string; productName: string }>();
  for (const entry of seriesMatrices) {
    for (const column of entry.matrix?.columns ?? []) {
      if (!productKeys.has(column.productCode)) {
        productKeys.set(column.productCode, { family: column.family, productName: column.productName });
      }
    }
  }

  const productValueByMonth: PerformanceReviewSeriesRow[] = [];
  const productUnitsByMonth: PerformanceReviewSeriesRow[] = [];
  for (const [productCode, meta] of productKeys) {
    const values: Array<number | null> = [];
    const units: Array<number | null> = [];
    for (const entry of seriesMatrices) {
      if (!entry.matrix) {
        values.push(null);
        units.push(null);
        continue;
      }
      const index = entry.matrix.columns.findIndex((column) => column.productCode === productCode);
      const cell = index === -1 ? null : entry.matrix.grandTotal.cells[index];
      values.push(cell ? cell.salesValue : null);
      units.push(cell ? cell.salesUnits : null);
    }
    const row = {
      key: productCode,
      label: meta.productName,
      subLabel: meta.family,
      unitsAreAddable: true,
    };
    productValueByMonth.push({ ...row, growth: growthOf(values), perMonth: values });
    productUnitsByMonth.push({ ...row, growth: growthOf(units), perMonth: units });
  }
  // The same units, per REP. Blocks follow the product grid's order — each family's concentrations
  // kept together, biggest family first — and then any product that sold in an earlier month of the
  // series but not in the selected one, which would otherwise vanish from a by-month view.
  const productMonthColumns: PerformanceProductMonthColumn[] = matrixByProduct.columns.map((column) => ({
    key: column.key,
    label: column.label,
    subLabel: column.subLabel,
    unitsAreAddable: true,
  }));
  const inGrid = new Set(productMonthColumns.map((column) => column.key));
  for (const [productCode, meta] of productKeys) {
    if (inGrid.has(productCode)) continue;
    productMonthColumns.push({
      key: productCode,
      label: meta.productName,
      subLabel: meta.family,
      unitsAreAddable: true,
    });
  }
  const productUnitsByRepByMonth = buildProductMonthMatrix({
    columns: productMonthColumns,
    headline: matrix,
    line,
    seatAssignments,
    seriesMatrices,
  });

  const byLatest = (a: PerformanceReviewSeriesRow, b: PerformanceReviewSeriesRow) =>
    (b.perMonth[b.perMonth.length - 1] ?? 0) - (a.perMonth[a.perMonth.length - 1] ?? 0);
  productValueByMonth.sort(byLatest);
  productUnitsByMonth.sort(byLatest);

  // Per AREA: VALUE only. An area sells the whole line, so its units span every product code in it
  // — adding those would be exactly the error rule 1 forbids. `unitsAreAddable: false` states that
  // on the row itself so no renderer can quietly put a units column beside it.
  //
  // Labelled with the region the SELECTED month gives the area, never the first month the series met
  // it in — Minia 1 printed "Upper Egypt" beside its September figure after it had moved to Upper
  // Egypt 1. The headline is asked only for the LABEL: the rows are still the series' own areas.
  const homes = areaHomesByLatestMonth(matrix, seriesMatrices);
  const areaKeys = new Map<string, AreaHome>();
  for (const entry of seriesMatrices) {
    for (const { area } of entry.matrix ? areaRowsOf(entry.matrix) : []) {
      const code = area.areaCode.trim().toUpperCase();
      const home = homes.get(code);
      if (home && !areaKeys.has(code)) areaKeys.set(code, home);
    }
  }

  const areaValueByMonth: PerformanceReviewSeriesRow[] = [...areaKeys.entries()]
    .map(([areaCode, meta]) => {
      const perMonth: Array<number | null> = seriesMatrices.map((entry) => {
        if (!entry.matrix) return null;
        const hit = areaRowsOf(entry.matrix).find(({ area }) => area.areaCode.trim().toUpperCase() === areaCode);
        return hit ? hit.area.rowTotal.salesValue : null;
      });
      return {
        growth: growthOf(perMonth),
        key: areaCode,
        label: meta.areaName,
        perMonth,
        subLabel: meta.regionName,
        unitsAreAddable: false,
      };
    })
    .sort(byLatest);

  const totalsCell = matrix.grandTotal.rowTotal;
  return {
    areas: orderedAreas,
    areaValueByMonth,
    availableLines,
    availablePeriods,
    filterOptions: input.filterOptions ?? monthlyClosingFilterOptions(matrix),
    families,
    generatedAt,
    line: matrix.line,
    managers,
    matrixByFamily,
    matrixByProduct,
    months,
    period: matrix.period,
    productUnitsByMonth,
    productUnitsByRepByMonth,
    productValueByMonth,
    regions,
    scopeIsBounded: input.scopeIsBounded === true,
    selectedPeriods,
    skippedPeriods: input.skippedPeriods ?? [],
    totals: {
      achievement: achievementOf(totalsCell.salesValue, totalsCell.targetValue),
      salesValue: totalsCell.salesValue,
      targetValue: totalsCell.targetValue,
    },
  };
}

/**
 * The review's by-month series: one single-month matrix per period, narrowed, or null.
 *
 * REUSES A MONTH ALREADY READ (PERF-021, 2026-10-04). The selected month used to be read twice —
 * once by `loadMergedMonthlyClosingParts` for the headline and again here for its own bar. A month in
 * `byPeriod` is that first read's UNMERGED matrix for the same (line, period), so it is handed on as
 * it is; it is reused only when its own `period` AND `line` are the ones this series would request,
 * so the store split and line resolution are provably the same read. Never the folded `combined`:
 * under a multi-month selection that is several months summed, and dropping it in would draw one
 * bar carrying all of them. Every other month is loaded, and a load that falls back to the closing's
 * default month (its own `period` is not the one asked for) gives null rather than duplicating a
 * column under the wrong heading. A month that fails to load, or to narrow, renders as "not
 * uploaded" rather than losing the other five. Nothing here mutates a matrix.
 */
export async function loadSeriesMatrices(input: {
  byPeriod: ReadonlyMap<string, MonthlyClosingMatrix>;
  line: string | null;
  load: (period: string) => Promise<MonthlyClosingMatrix>;
  narrow: (matrix: MonthlyClosingMatrix) => MonthlyClosingMatrix;
  periods: string[];
}): Promise<Array<{ matrix: MonthlyClosingMatrix | null; period: string }>> {
  const { byPeriod, line, load, narrow, periods } = input;
  return Promise.all(
    periods.map(async (period) => {
      try {
        const already = byPeriod.get(period);
        if (already && already.period === period && already.line === line) {
          return { matrix: narrow(already), period };
        }
        const loaded = await load(period);
        return { matrix: loaded.period === period ? narrow(loaded) : null, period };
      } catch {
        return { matrix: null, period };
      }
    }),
  );
}

/**
 * Load the review for one (line, period), including the months behind it.
 *
 * Every month is read through `loadMonthlyClosingPartsWithStoreSplit` — the exact loader the
 * Monthly Closing screen itself uses, store split included — so a figure here and a figure there
 * cannot drift apart. Reading the un-split loader instead would move wholesaler sales between the
 * areas of one city, and this sheet ranks reps BY area.
 */
export async function loadClosingPerformanceReview(input?: {
  /**
   * The same region / area / product / area-search narrowing Monthly Closing offers.
   *
   * Applied SERVER-SIDE, unlike the closing screen's own client-side filter, because the review is
   * not the matrix — it is six views DERIVED from it (rankings, family shares, the two grids, the
   * month series). Narrowing after the derivation would leave a rank of 3rd out of 50 sitting on a
   * table that now shows four rows. Filtering the matrix first and re-deriving is the only way the
   * headline numbers can stay true to what is on screen.
   */
  filter?: ClosingPerformanceReviewFilter | null;
  line?: string | null;
  months?: number;
  period?: string | null;
  /** Multi-month form. `period` remains the single-month one; a selection of one is identical to it. */
  periods?: string[] | null;
  /**
   * The months this reader may be offered, overriding the closing's own list — the PUBLISHED months
   * for a manager reading the review in his portal (owner, 2026-10-13). Omitted on the admin screen,
   * which offers every month the closing holds, published or not.
   *
   * It bounds the SERIES as well as the picker, which is the point: a manager's growth columns must
   * not quietly include a month the company has not released.
   */
  availablePeriods?: string[] | null;
  /**
   * The lines this reader may be offered, overriding the closing's own list — the lines a bounded
   * manager holds that have a published month. Omitted on the admin screen, which offers every line.
   *
   * It matters because the workspace renders its Line picker from this list whenever it holds more
   * than one entry: handed the company list, a single-line manager was offered two lines he does not
   * hold, and selecting one was refused with "That product line is outside your scope" — the refusal
   * is correct, the offer was not. The portal Monthly Closing locks the same field for the same
   * reason.
   */
  availableLines?: string[] | null;
  /**
   * The VIEWER's own bound — his areas, his region, his products — applied BEFORE his own filter and
   * to every month of the series. Null on the admin screen.
   *
   * Narrowed before the derivation, never after: the review is six views derived from the matrix, so
   * a rank computed on the whole line and then shown over nine rows would print "3rd of 58" above a
   * district of nine. Scoping first makes the rank his district's.
   */
  viewerScope?: PerformanceReviewViewerScope | null;
}): Promise<ClosingPerformanceReview> {
  const selection = Array.from(new Set((input?.periods ?? []).filter(Boolean))).sort();
  const parts = await loadMergedMonthlyClosingParts({
    line: input?.line ?? null,
    periods: selection.length > 0 ? selection : input?.period ? [input.period] : [],
  });
  const [availableLines, closingPeriods] = await Promise.all([
    listMonthlyClosingLines(),
    listMonthlyClosingPeriods(),
  ]);
  // A bounded reader's list is the one he was handed (his published months); everyone else gets the
  // closing's own, falling back to the matrix's. 🔴 An EMPTY HANDED LIST IS HONOURED AS EMPTY — it
  // means nothing is published for him yet, which the page states; falling back there would offer a
  // manager every month the closing holds, published or not, which is the leak this gate prevents.
  const availablePeriods =
    input?.availablePeriods ??
    (closingPeriods.length > 0 ? closingPeriods : parts.combined.availablePeriods);

  const viewerScope = input?.viewerScope ?? null;
  // Scope first, then the reader's own filter. Both on every matrix — the headline month and each
  // month of the series — through this one composition, so no column can carry an area he may not see.
  const scoped = (matrix: MonthlyClosingMatrix) => narrowMatrixToViewerScope(matrix, viewerScope);
  const narrow = (matrix: MonthlyClosingMatrix) =>
    applyReviewFilter(scoped(matrix), input?.filter ?? null);
  const matrix = narrow(parts.combined);

  const periods = selectSeriesPeriods(
    availablePeriods,
    parts.combined.period,
    Math.max(2, input?.months ?? PERFORMANCE_REVIEW_MONTHS),
  );

  const seriesLine = parts.combined.line;
  const [seatAssignments, seriesMatrices] = await Promise.all([
    loadAreaSeatAssignments(periodEndDate(parts.combined.period)),
    loadSeriesMatrices({
      byPeriod: parts.byPeriod,
      line: seriesLine,
      load: async (period) => (await loadMonthlyClosingPartsWithStoreSplit({ line: seriesLine, period })).combined,
      narrow,
      periods,
    }),
  ]);

  return buildClosingPerformanceReview({
    // A bounded reader's list is the one he was handed — his own lines — exactly as his month list is.
    availableLines:
      input?.availableLines ??
      (availableLines.length > 0 ? availableLines : parts.combined.availableLines),
    availablePeriods,
    // From the SCOPED but UNFILTERED matrix. Unfiltered, because the pickers must offer every region
    // and area the reader may reach, including the ones his current filter has just removed from the
    // screen. Scoped, because the ones outside his territory are not his to be offered — and if they
    // were offered, selecting one would narrow to nothing.
    filterOptions: monthlyClosingFilterOptions(scoped(parts.combined)),
    generatedAt: new Date().toISOString(),
    matrix,
    // Bounded only when the bound LEAVES SOMETHING OUT — a National Sales Manager bound to his whole
    // line reads "National total" (`viewerBoundNarrowsTheLine`).
    scopeIsBounded: reviewScopeIsBounded(parts.combined, viewerScope),
    seatAssignments,
    selectedPeriods: parts.periods,
    seriesMatrices,
    skippedPeriods: parts.skipped,
  });
}
