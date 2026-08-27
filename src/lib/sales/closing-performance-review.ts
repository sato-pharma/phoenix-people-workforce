import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  listMonthlyClosingLines,
  listMonthlyClosingPeriods,
  type MonthlyClosingCell,
  type MonthlyClosingMatrix,
} from "@/lib/sales/monthly-distributor-import";
import { loadMonthlyClosingPartsWithStoreSplit } from "@/lib/sales/monthly-closing-with-store-split";

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

/**
 * The first month the by-month series may ever reach back to. Owner's rule: start from July.
 *
 * The closing holds months back to January, and reaching into them is not a longer series — it is a
 * different one. `au.line_area_map` has no history before 2026-07-13, so an earlier month's sales are
 * attributed to today's geography with no as-was map behind them; pre-July months also need
 * per-customer-by-product reconciliation and re-valuation at the current price with targets
 * backfilled before their numbers mean what July's mean. Putting the two regimes side by side and
 * subtracting one from the other produces a growth figure that measures the regime change, not the
 * business — CNS Alex East reads 436,143 / 497,525 / 163,247 / 402,173 / 158,903 / 381,466 across
 * February to July, a sawtooth no sales force produced.
 *
 * July 2026 is the first month closed on today's map, so it is where every series starts. The window
 * fills forward on its own: one column now, two once August closes, up to PERFORMANCE_REVIEW_MONTHS.
 */
export const PERFORMANCE_REVIEW_FIRST_PERIOD = "2026-07";

/**
 * The region palette, in the order the reader expects to meet the regions.
 *
 * It lives here rather than in the workbook builder because the screen and the export must agree:
 * the same region is the same colour on every tab and in the page's own tables.
 */
export const PERFORMANCE_REVIEW_REGIONS: Array<{
  chip: string;
  regionCode: string;
  regionName: string;
  tint: string;
}> = [
  { chip: "FF2F5D8C", regionCode: "CA", regionName: "Cairo", tint: "FFEDF2F9" },
  { chip: "FF3D7A57", regionCode: "GZ", regionName: "Giza", tint: "FFECF4EE" },
  { chip: "FF9C6B32", regionCode: "AB", regionName: "Alex-BHR", tint: "FFFAF2E9" },
  { chip: "FF5F4E8F", regionCode: "D1", regionName: "Delta (1)", tint: "FFF3EFF8" },
  { chip: "FF9C4A63", regionCode: "D2", regionName: "Delta (2)", tint: "FFFCEFF2" },
  { chip: "FFA07A1E", regionCode: "UE", regionName: "Upper Egypt", tint: "FFFDF6E7" },
  { chip: "FF68757E", regionCode: "OT", regionName: "Others", tint: "FFEFF1F3" },
];

const FALLBACK_REGION = { chip: "FF8A8A8A", tint: "FFF4F4F4" };

/**
 * The region family a code belongs to, which is the code itself on every line but one.
 *
 * Anti Infective splits Upper Egypt into two regions, `UE-1` and `UE-2`, while CNS and Pedia carry a
 * single `UE`. Both halves are real regions with their own names and their own managers, so the name
 * column always prints "Upper Egypt 1" and "Upper Egypt 2" in full — the suffix is never hidden. What
 * it must not do is knock the region out of the palette and out of reading order, which is exactly
 * what matching the code exactly did: every Anti Infective Upper Egypt row took the neutral fallback
 * grey and sorted below Others, on the one line where those regions carry the most money.
 *
 * Only a trailing `-<number>` is stripped, so `D1` and `D2` stay the distinct regions they are.
 */
function regionFamilyCode(regionCode: string | null | undefined): string {
  return String(regionCode ?? "")
    .trim()
    .toUpperCase()
    .replace(/-\d+$/, "");
}

/** Palette for a region code. An unknown code keeps its own name and takes the neutral swatch. */
export function performanceReviewRegionStyle(regionCode: string | null | undefined) {
  const code = regionFamilyCode(regionCode);
  return PERFORMANCE_REVIEW_REGIONS.find((row) => row.regionCode === code) ?? FALLBACK_REGION;
}

/** Sort key placing known regions in reading order and anything else after them, alphabetically. */
function regionOrder(regionCode: string): number {
  const code = regionFamilyCode(regionCode);
  const index = PERFORMANCE_REVIEW_REGIONS.findIndex((row) => row.regionCode === code);
  return index === -1 ? PERFORMANCE_REVIEW_REGIONS.length : index;
}

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
  /** Newest month over the one before it. Null when the previous month sold nothing ("new"). */
  growth: number | null;
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

export type ClosingPerformanceReview = {
  areas: PerformanceReviewAreaRow[];
  /** By-month VALUE per area, plus its growth. Value, never units — see rule 1. */
  areaValueByMonth: PerformanceReviewSeriesRow[];
  availableLines: string[];
  availablePeriods: string[];
  families: PerformanceReviewFamilyRow[];
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
  regions: PerformanceReviewGroupRow[];
  totals: { achievement: number | null; salesValue: number; targetValue: number | null };
};

function achievementOf(sales: number, target: number | null): number | null {
  if (target == null || target === 0) return null;
  return sales / target;
}

/** Growth of the newest month over the one before it. Null when there is nothing to grow from. */
function growthOf(perMonth: Array<number | null>): number | null {
  if (perMonth.length < 2) return null;
  const latest = perMonth[perMonth.length - 1];
  const previous = perMonth[perMonth.length - 2];
  if (latest == null || previous == null || previous === 0) return null;
  return (latest - previous) / previous;
}

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
export async function loadAreaSeatAssignments(): Promise<Map<string, AreaSeatAssignment>> {
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
  return assignments;
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
 * Build every view of the review for one (line, period).
 *
 * `seriesMatrices` carries the earlier months. A month that was never uploaded is simply absent,
 * and the series renders "—" for it — never a zero, which would read as "sold nothing".
 */
export function buildClosingPerformanceReview(input: {
  availableLines: string[];
  availablePeriods: string[];
  generatedAt: string;
  matrix: MonthlyClosingMatrix;
  seatAssignments: Map<string, AreaSeatAssignment>;
  seriesMatrices: Array<{ matrix: MonthlyClosingMatrix | null; period: string }>;
}): ClosingPerformanceReview {
  const { availableLines, availablePeriods, generatedAt, matrix, seatAssignments, seriesMatrices } = input;
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
  const byLatest = (a: PerformanceReviewSeriesRow, b: PerformanceReviewSeriesRow) =>
    (b.perMonth[b.perMonth.length - 1] ?? 0) - (a.perMonth[a.perMonth.length - 1] ?? 0);
  productValueByMonth.sort(byLatest);
  productUnitsByMonth.sort(byLatest);

  // Per AREA: VALUE only. An area sells the whole line, so its units span every product code in it
  // — adding those would be exactly the error rule 1 forbids. `unitsAreAddable: false` states that
  // on the row itself so no renderer can quietly put a units column beside it.
  const areaKeys = new Map<string, { areaName: string; regionCode: string; regionName: string }>();
  for (const entry of seriesMatrices) {
    for (const { area, group } of entry.matrix ? areaRowsOf(entry.matrix) : []) {
      const code = area.areaCode.trim().toUpperCase();
      if (!areaKeys.has(code)) {
        areaKeys.set(code, { areaName: area.areaName, regionCode: group.regionCode, regionName: group.regionName });
      }
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
    families,
    generatedAt,
    line: matrix.line,
    managers,
    matrixByFamily,
    matrixByProduct,
    months,
    period: matrix.period,
    productUnitsByMonth,
    productValueByMonth,
    regions,
    totals: {
      achievement: achievementOf(totalsCell.salesValue, totalsCell.targetValue),
      salesValue: totalsCell.salesValue,
      targetValue: totalsCell.targetValue,
    },
  };
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
  line?: string | null;
  months?: number;
  period?: string | null;
}): Promise<ClosingPerformanceReview> {
  const parts = await loadMonthlyClosingPartsWithStoreSplit({
    line: input?.line ?? null,
    period: input?.period ?? null,
  });
  const [availableLines, availablePeriods] = await Promise.all([
    listMonthlyClosingLines(),
    listMonthlyClosingPeriods(),
  ]);

  const periods = selectSeriesPeriods(
    availablePeriods.length > 0 ? availablePeriods : parts.combined.availablePeriods,
    parts.combined.period,
    Math.max(2, input?.months ?? PERFORMANCE_REVIEW_MONTHS),
  );

  const [seatAssignments, seriesMatrices] = await Promise.all([
    loadAreaSeatAssignments(),
    Promise.all(
      periods.map(async (period) => {
        if (period === parts.combined.period) return { matrix: parts.combined, period };
        try {
          const loaded = await loadMonthlyClosingPartsWithStoreSplit({ line: parts.combined.line, period });
          // Guard against the loader falling back to its default month: a matrix for the wrong
          // period would silently duplicate a column of the series under the wrong heading.
          return { matrix: loaded.combined.period === period ? loaded.combined : null, period };
        } catch {
          // One unreadable month must not lose the other five — it renders as "not uploaded".
          return { matrix: null, period };
        }
      }),
    ),
  ]);

  return buildClosingPerformanceReview({
    availableLines: availableLines.length > 0 ? availableLines : parts.combined.availableLines,
    availablePeriods: availablePeriods.length > 0 ? availablePeriods : parts.combined.availablePeriods,
    generatedAt: new Date().toISOString(),
    matrix: parts.combined,
    seatAssignments,
    seriesMatrices,
  });
}
