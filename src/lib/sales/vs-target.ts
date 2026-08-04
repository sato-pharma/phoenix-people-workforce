// ─────────────────────────────────────────────────────────────────────────────
// Sales vs Target — the field force's primary performance surface.
//
// Sales come from ONE place: au.f_monthly_achievement, reached here through the
// multi-period wrapper phx_sales_vs_target_range. That function already unions Source
// of Sales (indirect, priced at factory price) with Direct Orders (at their own
// invoiced value, on the Finance-owned sales month) and attributes both down
// line → operational region → canonical area → rep seat → DM seat, using seat
// occupancy AS OF the period end. This module deliberately does NOT re-derive any of
// that: /sales/targets and Monthly Closing read the same function, and a second
// definition of "achievement" is exactly how two screens start quoting different
// numbers for the same month.
//
// What this module adds is the dashboard's own three concerns:
//
//   1. THE JULY 2026 FLOOR. The dashboard starts at 2026-07 and never reads earlier —
//      even though May/June 2026 SoS data exists. July therefore has NO prior period
//      and reports so, rather than quietly comparing against June (owner decision,
//      2026-08-04). The floor is enforced in SQL as well; this is the second lock.
//
//   2. TARGET COVERAGE. As of 2026-08-04 only 36 of 142 (line, area) pairs carrying
//      July sales have a target at all, and the whole Pedia line has none. So actuals
//      routinely exist with no target beside them. Every total below therefore splits
//      actual into COVERED (has a target) and UNCOVERED (does not), and computes
//      achievement % over the covered part only. An achievement figure that silently
//      averaged in untargeted sales would read as catastrophic underperformance when
//      the real story is "nobody set a target". Missing target is null, never 0.
//
//   3. THE HIERARCHY. Team (line) → region → area → medical rep → brick, each level
//      carrying its own prior-period comparison.
//
// Everything below the loaders is PURE, so the rules above are unit-testable without a
// database.
// ─────────────────────────────────────────────────────────────────────────────

import { getSupabaseAdmin, rpcAll } from "@/lib/supabase/server";
import { currentCairoDateParts } from "@/lib/i18n/format";
import type { AchievementRow } from "@/lib/sales/monthly-targets";

const PERIOD_RE = /^\d{4}-\d{2}$/;

/**
 * The first month this dashboard ever reports on (owner decision, 2026-08-04).
 *
 * Also hard-coded in au.f_sales_vs_target_range. Two locks on purpose: the SQL floor
 * stops any caller reading pre-July data, and this one stops the UI offering a period
 * it would then render as empty.
 */
export const SALES_VS_TARGET_FLOOR = "2026-07";

function str(value: unknown): string {
  return value == null ? "" : String(value);
}

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function optNum(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isValidVsTargetPeriod(period: string | null | undefined): period is string {
  return typeof period === "string" && PERIOD_RE.test(period) && period >= SALES_VS_TARGET_FLOOR;
}

// ── Period arithmetic ────────────────────────────────────────────────────────

/** Shift a YYYY-MM period by whole months. Returns null for a malformed input. */
export function shiftPeriod(period: string, months: number): string | null {
  if (!PERIOD_RE.test(period)) return null;
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  if (month < 1 || month > 12) return null;
  // Date.UTC normalises the month overflow/underflow for us; day 1 is never ambiguous.
  const shifted = new Date(Date.UTC(year, month - 1 + months, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * The period this one is compared against, or null when there isn't one.
 *
 * Returns null for 2026-07 BY DESIGN. June 2026 data exists and would load fine, which
 * is precisely the trap: the dashboard's window starts in July, so a July-vs-June
 * comparison would mix in a month the rest of the dashboard refuses to show. The UI
 * renders "no prior period" instead of a delta.
 */
export function priorPeriodOf(period: string): string | null {
  if (!isValidVsTargetPeriod(period)) return null;
  const prior = shiftPeriod(period, -1);
  if (!prior || prior < SALES_VS_TARGET_FLOOR) return null;
  return prior;
}

/**
 * Every period the dashboard can show: the July 2026 floor up to the current Cairo
 * month. Cairo, not UTC — on the 1st of a month, UTC is still in the previous month for
 * three hours, and the picker would offer a month the owner does not consider started.
 */
export function salesVsTargetPeriods(): { periods: string[]; current: string } {
  const { year, month } = currentCairoDateParts();
  const current = `${year}-${String(month).padStart(2, "0")}`;
  const periods: string[] = [];
  let cursor = SALES_VS_TARGET_FLOOR;
  // Guarded loop: if the clock is ever behind the floor, `periods` stays [floor].
  while (cursor <= current && periods.length < 240) {
    periods.push(cursor);
    const next = shiftPeriod(cursor, 1);
    if (!next) break;
    cursor = next;
  }
  if (periods.length === 0) periods.push(SALES_VS_TARGET_FLOOR);
  return { periods, current: periods[periods.length - 1] };
}

// ── Loaders ──────────────────────────────────────────────────────────────────

/** One brick's sales inside an area, for the rep-level drill-down. */
export type BrickSalesRow = {
  period: string;
  lineCode: string | null;
  regionCode: string | null;
  areaCode: string | null;
  areaState: string | null;
  repSeatId: string | null;
  repHrId: string | null;
  dmSeatId: string | null;
  dmHrId: string | null;
  /** null when the source row carried no brick at all — real sales, no brick recorded. */
  brickId: string | null;
  brickName: string | null;
  blockCode: string | null;
  salesUnits: number;
  salesValue: number;
  directValue: number;
  indirectValue: number;
};

/**
 * Achievement rows for every period in [from, to] in one round trip.
 *
 * Returns [] rather than throwing for a malformed or pre-floor range — the SQL applies
 * the same floor, so a caller cannot widen the window by passing an earlier `from`.
 */
export async function loadVsTargetRange(from: string, to: string): Promise<AchievementRow[]> {
  if (!isValidVsTargetPeriod(from) || !isValidVsTargetPeriod(to) || to < from) return [];
  const supabase = getSupabaseAdmin();
  const rows = await rpcAll<Record<string, unknown>>(
    supabase,
    "phx_sales_vs_target_range",
    { p_from: from, p_to: to },
    ["period", "line_code", "region_code", "area_code", "product_code"],
  );
  return rows.map((row) => ({
    period: str(row.period),
    lineCode: str(row.line_code) || null,
    regionCode: str(row.region_code) || null,
    areaCode: str(row.area_code) || null,
    areaState: str(row.area_state) || null,
    isOther: row.is_other === true,
    repSeatId: str(row.rep_seat_id) || null,
    repHrId: str(row.rep_hr_id) || null,
    dmSeatId: str(row.dm_seat_id) || null,
    dmHrId: str(row.dm_hr_id) || null,
    productCode: str(row.product_code),
    actualUnits: num(row.actual_units),
    actualValue: num(row.actual_value),
    targetUnits: optNum(row.target_units),
    targetValue: optNum(row.target_value),
    achievementValue: optNum(row.achievement_value),
    achievementUnits: optNum(row.achievement_units),
    hasTarget: row.has_target === true,
    hasActual: row.has_actual === true,
  }));
}

/**
 * The `${lineCode}|${areaCode}` pairs the canonical model says SHOULD carry a target.
 *
 * Not every untargeted area is a gap. Of the 106 line-area pairs with 2026-07 sales and no
 * target, 36 are "Other" areas (no DM, no rep, spillover geography) that carry no target by
 * design — 159,318 EGP. The real gap is the other 70, worth 1,823,610 EGP. Reporting both
 * as one number would send managers hunting for targets that were never meant to exist.
 */
export async function loadTargetBearingPairs(): Promise<Set<string>> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("au_v_line_area_map")
    .select("line_code,area_code,carries_target")
    .eq("carries_target", true);
  if (error) throw error;
  const pairs = new Set<string>();
  for (const row of data ?? []) {
    const record = row as Record<string, unknown>;
    const lineCode = str(record.line_code).trim();
    const areaCode = str(record.area_code).trim();
    if (lineCode && areaCode) pairs.add(`${lineCode}|${areaCode}`);
  }
  return pairs;
}

/** Brick-grain sales for one period. Sums exactly to the area totals in the range load. */
export async function loadBrickSales(period: string): Promise<BrickSalesRow[]> {
  if (!isValidVsTargetPeriod(period)) return [];
  const supabase = getSupabaseAdmin();
  const rows = await rpcAll<Record<string, unknown>>(
    supabase,
    "phx_sales_brick_detail",
    { p_period: period },
    ["line_code", "area_code", "brick_id"],
  );
  return rows.map((row) => ({
    period: str(row.period),
    lineCode: str(row.line_code) || null,
    regionCode: str(row.region_code) || null,
    areaCode: str(row.area_code) || null,
    areaState: str(row.area_state) || null,
    repSeatId: str(row.rep_seat_id) || null,
    repHrId: str(row.rep_hr_id) || null,
    dmSeatId: str(row.dm_seat_id) || null,
    dmHrId: str(row.dm_hr_id) || null,
    brickId: str(row.brick_id) || null,
    brickName: str(row.brick_name) || null,
    blockCode: str(row.block_code) || null,
    salesUnits: num(row.sales_units),
    salesValue: num(row.sales_value),
    directValue: num(row.direct_value),
    indirectValue: num(row.indirect_value),
  }));
}

/**
 * Does this period actually have sales loaded, or has nobody uploaded it yet?
 *
 * `has_actual` is false on a row that exists ONLY because a target exists for that key.
 * The distinction matters enormously on the current month: August 2026 carries targets
 * copied forward from July but no Source-of-Sales upload, so every figure computes to a
 * confident 0 — telling the entire field force they sold nothing, on the dashboard they
 * open daily. "Not uploaded yet" and "sold nothing" must never render the same way.
 */
export function periodHasActuals(rows: AchievementRow[], period: string): boolean {
  return rows.some((row) => row.period === period && row.hasActual);
}

/**
 * The most recent period in `rows` that has sales loaded, or null if none does.
 *
 * Used to pick the landing month, so the dashboard opens on the newest REAL month rather
 * than on an empty current month that is merely waiting for its upload.
 */
export function latestPeriodWithActuals(rows: AchievementRow[]): string | null {
  let latest: string | null = null;
  for (const row of rows) {
    if (!row.hasActual) continue;
    if (latest == null || row.period > latest) latest = row.period;
  }
  return latest;
}

// ── Totals with target-coverage accounting ───────────────────────────────────

export type VsTargetTotals = {
  actualValue: number;
  actualUnits: number;
  targetValue: number;
  targetUnits: number;
  /** Actual sitting on a key that HAS a target — the only actual achievement % uses. */
  coveredActualValue: number;
  /** Actual with no target row anywhere. Reported beside the %, never inside it. */
  uncoveredActualValue: number;
  /** Distinct (line, area, product) keys with a target, and without. */
  coveredKeys: number;
  uncoveredKeys: number;
  /** null when there is no target to divide by. NEVER 0, never Infinity. */
  achievementValue: number | null;
  achievementUnits: number | null;
};

export function emptyTotals(): VsTargetTotals {
  return {
    actualValue: 0,
    actualUnits: 0,
    targetValue: 0,
    targetUnits: 0,
    coveredActualValue: 0,
    uncoveredActualValue: 0,
    coveredKeys: 0,
    uncoveredKeys: 0,
    achievementValue: null,
    achievementUnits: null,
  };
}

/**
 * Fold one row into a running total.
 *
 * Achievement is NOT accumulated — it is recomputed from the sums by sealTotals. Adding
 * up per-row percentages averages a 10%-achieving product with a 400%-achieving one and
 * calls it 205%, which is wrong at every level above the row.
 */
function addRow(total: VsTargetTotals, row: AchievementRow): void {
  total.actualValue += row.actualValue;
  total.actualUnits += row.actualUnits;
  total.targetValue += row.targetValue ?? 0;
  total.targetUnits += row.targetUnits ?? 0;
  if (row.hasTarget) {
    total.coveredActualValue += row.actualValue;
    total.coveredKeys += 1;
  } else {
    total.uncoveredActualValue += row.actualValue;
    total.uncoveredKeys += 1;
  }
}

/**
 * Compute the percentages once the sums are final.
 *
 * A zero target yields null, not 0 and not Infinity: "no target set" and "achieved
 * nothing against a real target" are different facts and the UI renders them
 * differently. Targets are never negative, but actuals can be (returns and credit notes
 * — Anti-Infective/Haram-Faisal was −32,166 EGP in 2026-07), so a negative achievement
 * is legitimate and is left alone.
 */
function sealTotals(total: VsTargetTotals): VsTargetTotals {
  total.achievementValue = total.targetValue !== 0 ? total.coveredActualValue / total.targetValue : null;
  total.achievementUnits = total.targetUnits !== 0 ? total.actualUnits / total.targetUnits : null;
  return total;
}

/** Total a set of rows, with coverage accounting. */
export function totalRows(rows: AchievementRow[]): VsTargetTotals {
  const total = emptyTotals();
  for (const row of rows) addRow(total, row);
  return sealTotals(total);
}

/** Share of actual value that has a target beside it. null when there is no actual. */
export function coverageRatio(total: VsTargetTotals): number | null {
  const denominator = total.coveredActualValue + total.uncoveredActualValue;
  return denominator !== 0 ? total.coveredActualValue / denominator : null;
}

// ── Hierarchy roll-up ────────────────────────────────────────────────────────

export type VsTargetLevel = "team" | "region" | "area" | "rep" | "brick";

export type VsTargetNode = {
  /** Stable identity for React keys and drill-down links. Never rendered. */
  key: string;
  /** What the user reads. Always a name — never a code (owner standing rule). */
  name: string;
  level: VsTargetLevel;
  current: VsTargetTotals;
  /** null when the selected period has no prior period (July 2026) — not zero. */
  prior: VsTargetTotals | null;
  /** Fractional change in actual value vs prior. null when there is no prior, or prior was 0. */
  growth: number | null;
};

/**
 * Growth vs the prior period.
 *
 * null (not 0, not Infinity) when there is no prior period or the prior was zero —
 * "grew from nothing" is not a percentage, and rendering it as +100% or ∞ invites the
 * field force to argue with the dashboard.
 */
export function growthOf(current: VsTargetTotals, prior: VsTargetTotals | null): number | null {
  if (!prior || prior.actualValue === 0) return null;
  return (current.actualValue - prior.actualValue) / Math.abs(prior.actualValue);
}

type NodeSpec = {
  level: VsTargetLevel;
  /** Grouping key, or null to drop the row from this level entirely. */
  keyOf: (row: AchievementRow) => string | null;
  /** Code → display name. Falls back to a readable label, never to a bare code. */
  nameOf: (key: string) => string;
};

/**
 * Roll rows up one level, pairing each node with its prior-period self.
 *
 * `priorRows` must already be scoped exactly like `rows`, or a manager sees this month
 * bounded to their territory and last month bounded to the company.
 */
export function rollupLevel(
  rows: AchievementRow[],
  priorRows: AchievementRow[] | null,
  spec: NodeSpec,
): VsTargetNode[] {
  const fold = (source: AchievementRow[]) => {
    const totals = new Map<string, VsTargetTotals>();
    for (const row of source) {
      const key = spec.keyOf(row);
      if (key == null) continue;
      const total = totals.get(key) ?? emptyTotals();
      addRow(total, row);
      totals.set(key, total);
    }
    for (const total of totals.values()) sealTotals(total);
    return totals;
  };

  const currentTotals = fold(rows);
  const priorTotals = priorRows ? fold(priorRows) : null;

  return [...currentTotals.entries()]
    .map(([key, current]) => {
      const prior = priorTotals ? priorTotals.get(key) ?? emptyTotals() : null;
      return {
        key,
        name: spec.nameOf(key),
        level: spec.level,
        current,
        prior,
        growth: growthOf(current, prior),
      };
    })
    .sort((left, right) => right.current.actualValue - left.current.actualValue);
}

/** Resolvers the roll-ups need to turn codes into the names the owner insists on seeing. */
export type VsTargetNames = {
  lineName: (code: string) => string;
  regionName: (code: string) => string;
  areaName: (code: string) => string;
  employeeName: (hrId: string) => string;
};

/** Team = sales line (CNS / Pedia / Anti-infective). */
export function rollupByTeam(rows: AchievementRow[], prior: AchievementRow[] | null, names: VsTargetNames) {
  return rollupLevel(rows, prior, {
    level: "team",
    keyOf: (row) => row.lineCode,
    nameOf: names.lineName,
  });
}

export function rollupByRegion(rows: AchievementRow[], prior: AchievementRow[] | null, names: VsTargetNames) {
  return rollupLevel(rows, prior, {
    level: "region",
    keyOf: (row) => row.regionCode,
    nameOf: names.regionName,
  });
}

export function rollupByArea(rows: AchievementRow[], prior: AchievementRow[] | null, names: VsTargetNames) {
  return rollupLevel(rows, prior, {
    level: "area",
    keyOf: (row) => row.areaCode,
    nameOf: names.areaName,
  });
}

/**
 * Per medical rep.
 *
 * Rows with no resolved occupant are dropped rather than bucketed: a vacant area's sales
 * are real and appear at area level, but inventing a "rep" for them would put another
 * person's numbers under a name that does not exist. The area roll-up is where that
 * value stays visible.
 */
export function rollupByRep(rows: AchievementRow[], prior: AchievementRow[] | null, names: VsTargetNames) {
  return rollupLevel(rows, prior, {
    level: "rep",
    keyOf: (row) => row.repHrId,
    nameOf: names.employeeName,
  });
}

/** Per district manager. */
export function rollupByDm(rows: AchievementRow[], prior: AchievementRow[] | null, names: VsTargetNames) {
  return rollupLevel(rows, prior, {
    level: "rep",
    keyOf: (row) => row.dmHrId,
    nameOf: names.employeeName,
  });
}

/**
 * Per product, across whatever scope the caller already filtered to.
 *
 * The first build had no product dimension at all, which left the page with a one-bar
 * "trend" occupying a third of the screen and nothing to actually analyse. Product mix is
 * the densest real analysis available from rows we have already loaded — no extra query.
 */
export function rollupByProduct(
  rows: AchievementRow[],
  prior: AchievementRow[] | null,
  productName: (code: string) => string,
) {
  return rollupLevel(rows, prior, {
    level: "team",
    keyOf: (row) => (row.productCode ? row.productCode : null),
    nameOf: productName,
  });
}

/**
 * The N best and N worst nodes by achievement.
 *
 * Nodes with no target are excluded from BOTH ends rather than sorted as zero: an area
 * nobody set a target for is not the worst performer in the company, and putting it at the
 * bottom of a leaderboard is exactly the libel the coverage split exists to prevent.
 */
export function rankByAchievement(nodes: VsTargetNode[], count: number): { top: VsTargetNode[]; bottom: VsTargetNode[] } {
  const measurable = nodes.filter((node) => node.current.achievementValue != null);
  const sorted = [...measurable].sort(
    (left, right) => (right.current.achievementValue ?? 0) - (left.current.achievementValue ?? 0),
  );
  const top = sorted.slice(0, count);
  // Take from the end, then reverse so the worst reads first.
  const bottom = sorted.slice(Math.max(0, sorted.length - count)).reverse();
  // With fewer nodes than 2*count the two lists would overlap and show the same row twice.
  const topKeys = new Set(top.map((node) => node.key));
  return { top, bottom: bottom.filter((node) => !topKeys.has(node.key)) };
}

// ── Brick roll-up ────────────────────────────────────────────────────────────

export type BrickNode = {
  key: string;
  name: string;
  blockCode: string | null;
  salesValue: number;
  salesUnits: number;
  directValue: number;
  indirectValue: number;
  priorSalesValue: number | null;
  growth: number | null;
  /** True when the source rows carried no brick — shown as "No brick recorded". */
  isUnassigned: boolean;
};

/** Sentinel key for sales inside an area that carried no brick id at all. */
const UNASSIGNED_BRICK_KEY = " no-brick";

/**
 * Bricks for one area, paired with the prior period.
 *
 * Sales with no brick id are kept under an explicit "No brick recorded" node — 73 rows
 * worth 10,772.98 EGP in 2026-07. Dropping them would make the brick list quietly fail
 * to sum to the area total the rep sees one level up.
 */
export function rollupBricks(
  rows: BrickSalesRow[],
  priorRows: BrickSalesRow[] | null,
): BrickNode[] {
  const fold = (source: BrickSalesRow[]) => {
    const map = new Map<string, { name: string | null; blockCode: string | null; value: number; units: number; direct: number; indirect: number }>();
    for (const row of source) {
      const key = row.brickId ?? UNASSIGNED_BRICK_KEY;
      const entry = map.get(key) ?? { name: row.brickName, blockCode: row.blockCode, value: 0, units: 0, direct: 0, indirect: 0 };
      entry.value += row.salesValue;
      entry.units += row.salesUnits;
      entry.direct += row.directValue;
      entry.indirect += row.indirectValue;
      if (!entry.name && row.brickName) entry.name = row.brickName;
      map.set(key, entry);
    }
    return map;
  };

  const current = fold(rows);
  const prior = priorRows ? fold(priorRows) : null;

  return [...current.entries()]
    .map(([key, entry]) => {
      const isUnassigned = key === UNASSIGNED_BRICK_KEY;
      const priorValue = prior ? prior.get(key)?.value ?? 0 : null;
      return {
        key,
        // Never fall back to the brick id: a code in the name column is the one thing
        // the owner has ruled out everywhere in the UI.
        name: isUnassigned ? "No brick recorded" : entry.name ?? "Unnamed brick",
        blockCode: entry.blockCode,
        salesValue: entry.value,
        salesUnits: entry.units,
        directValue: entry.direct,
        indirectValue: entry.indirect,
        priorSalesValue: priorValue,
        growth: priorValue != null && priorValue !== 0 ? (entry.value - priorValue) / Math.abs(priorValue) : null,
        isUnassigned,
      };
    })
    .sort((left, right) => right.salesValue - left.salesValue);
}

// ── Trend ────────────────────────────────────────────────────────────────────

export type TrendPoint = {
  period: string;
  actualValue: number;
  targetValue: number;
  coveredActualValue: number;
  achievementValue: number | null;
};

/**
 * One point per period in the loaded range, oldest first.
 *
 * Periods present in the range but carrying no rows still get a point, so a month with
 * no uploaded sales renders as a visible gap the viewer can question rather than
 * silently vanishing from the axis.
 */
export function buildTrend(rows: AchievementRow[], periods: string[]): TrendPoint[] {
  const byPeriod = new Map<string, VsTargetTotals>();
  for (const period of periods) byPeriod.set(period, emptyTotals());
  for (const row of rows) {
    const total = byPeriod.get(row.period);
    if (!total) continue;
    addRow(total, row);
  }
  return periods.map((period) => {
    const total = sealTotals(byPeriod.get(period) ?? emptyTotals());
    return {
      period,
      actualValue: total.actualValue,
      targetValue: total.targetValue,
      coveredActualValue: total.coveredActualValue,
      achievementValue: total.achievementValue,
    };
  });
}
