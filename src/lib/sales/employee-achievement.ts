// ─────────────────────────────────────────────────────────────────────────────
// One employee's sales, month by month, from the ONE canonical engine.
//
// This exists because "how much did this person sell" was answered by two engines that
// disagree. Legacy `sales_records` (Jan–Jun 2026, last written 2026-07-17) and the SoS
// Monthly Closing engine describe the same reps in the same months and differ by +8%
// company-wide — and by −34% for at least one named rep. Rule #1 says a person's month
// must read identically everywhere in the system, so every surface that shows a person's
// sales now reads it HERE, and this reads it from au.f_monthly_achievement like Monthly
// Closing and /sales-vs-target already do.
//
// Deliberately NOT a new query. It composes what already exists:
//
//   loadAchievementRange  →  applyAchievementAreaMerges  →  group  →  totalRows
//
// Three traps are handled here once so no caller has to remember them:
//
//   1. HR-ID CASING. The attribution engine's rep_hr_id casing is not the casing the rest
//      of the repo compares with (vs-target-scope lower-cases; employee-portal and
//      analytics upper-case). A mismatch yields an EMPTY result, not an error — it looks
//      exactly like "this rep sold nothing". Callers pass HR ids in whatever case they
//      hold and get their own strings back as the map keys.
//
//   2. MISSING TARGET IS null, NEVER 0. au.monthly_targets starts at 2026-07, so H1 rows
//      legitimately carry actuals with no target. Rendering that as 0% tells a rep who
//      sold well that they achieved nothing. The null contract from vs-target.ts is
//      preserved all the way out of this module.
//
//   3. A MONTH IS "IN" ONLY IF ITS DISTRIBUTOR UPLOAD LANDED. `has_actual` is not that
//      signal: on 2026-08-10 one direct order (1,309.50 EGP) made August look loaded
//      against a 17,508,935 EGP target. Every point carries `uploaded`, and any caller
//      summing more than one month must filter on it — see uploadedPointsOnly.
// ─────────────────────────────────────────────────────────────────────────────

import { applyAchievementAreaMerges } from "@/lib/sales/closing-area-merges";
import type { AchievementRow } from "@/lib/sales/monthly-targets";
import {
  SALES_HISTORY_FLOOR,
  isValidHistoryPeriod,
  loadAchievementRange,
  loadUploadedPeriodsInRange,
  totalRows,
} from "@/lib/sales/vs-target";

/**
 * Whose row is it. `rep` reads the seat the sale was attributed to; `dm` reads the district
 * manager above it, so a manager's own surface totals their team rather than themselves.
 */
export type AchievementGrain = "rep" | "dm";

/** One month of one employee's canonical sales. Ratios, not percentages. */
export type MonthlyAchievementPoint = {
  period: string;
  actualValue: number;
  actualUnits: number;
  targetValue: number;
  targetUnits: number;
  /** Actual sitting on a key that has a target — the only actual achievement divides. */
  coveredActualValue: number;
  /** Actual with no target beside it. Reported next to the %, never inside it. */
  uncoveredActualValue: number;
  /** covered ÷ target, as a RATIO. null when there is no target — never 0. */
  achievementValue: number | null;
  /** Whether any of this month's rows carried a target at all. */
  hasTarget: boolean;
  /** Whether this month's distributor upload actually landed. */
  uploaded: boolean;
};

export type EmployeeAchievementWindow = {
  from: string;
  to: string;
  /** Months in [from, to] whose distributor upload landed. Direct orders alone do not count. */
  uploadedPeriods: ReadonlySet<string>;
  /** Keyed by the caller's own HR-id strings, in the caller's own casing. */
  byHrId: ReadonlyMap<string, MonthlyAchievementPoint[]>;
};

function normalizeIdentity(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * The pure half: fold loaded rows into per-employee monthly points.
 *
 * Split out so the casing rule, the null contract and the uploaded-month flag are all
 * unit-testable without a database — the same reason vs-target.ts keeps its roll-ups pure.
 */
export function groupAchievementByEmployee(
  rows: readonly AchievementRow[],
  hrIds: readonly string[],
  uploadedPeriods: ReadonlySet<string>,
  grain: AchievementGrain = "rep",
): Map<string, MonthlyAchievementPoint[]> {
  // Normalized id -> the caller's original string, so the returned keys are theirs.
  const wanted = new Map<string, string>();
  for (const hrId of hrIds) {
    const key = normalizeIdentity(hrId);
    if (key && !wanted.has(key)) wanted.set(key, hrId);
  }

  const byEmployeePeriod = new Map<string, Map<string, AchievementRow[]>>();
  for (const row of rows) {
    const owner = normalizeIdentity(grain === "rep" ? row.repHrId : row.dmHrId);
    // A row with no resolved occupant belongs to the area, not to a person. Dropping it
    // here is correct; reconcileUnattributed is what surfaces it at the headline.
    if (!owner || !wanted.has(owner)) continue;
    let periods = byEmployeePeriod.get(owner);
    if (!periods) {
      periods = new Map<string, AchievementRow[]>();
      byEmployeePeriod.set(owner, periods);
    }
    const bucket = periods.get(row.period);
    if (bucket) bucket.push(row);
    else periods.set(row.period, [row]);
  }

  const result = new Map<string, MonthlyAchievementPoint[]>();
  for (const [key, original] of wanted) {
    const periods = byEmployeePeriod.get(key);
    // Every requested employee gets an entry, even an empty one. An absent key would make
    // "no sales data" indistinguishable from "we never asked about them".
    if (!periods) {
      result.set(original, []);
      continue;
    }
    const points: MonthlyAchievementPoint[] = [];
    for (const [period, periodRows] of periods) {
      const totals = totalRows(periodRows);
      points.push({
        period,
        actualValue: totals.actualValue,
        actualUnits: totals.actualUnits,
        targetValue: totals.targetValue,
        targetUnits: totals.targetUnits,
        coveredActualValue: totals.coveredActualValue,
        uncoveredActualValue: totals.uncoveredActualValue,
        // Straight through from sealTotals — null when there is no target to divide by.
        achievementValue: totals.achievementValue,
        hasTarget: totals.coveredKeys > 0,
        uploaded: uploadedPeriods.has(period),
      });
    }
    points.sort((a, b) => a.period.localeCompare(b.period));
    result.set(original, points);
  }
  return result;
}

/**
 * Canonical monthly sales for a set of employees over [from, to].
 *
 * Two round trips total, regardless of how many employees or months are asked for: one
 * range call for the rows and one for the upload ledger. Never loop a per-period RPC in a
 * caller — the database is in eu-central-1 and every trip is charged in latency.
 */
export async function loadEmployeeMonthlyAchievement(
  hrIds: readonly string[],
  from: string,
  to: string,
  options: { grain?: AchievementGrain } = {},
): Promise<EmployeeAchievementWindow> {
  const grain = options.grain ?? "rep";
  const empty: EmployeeAchievementWindow = {
    from,
    to,
    uploadedPeriods: new Set<string>(),
    byHrId: new Map<string, MonthlyAchievementPoint[]>(),
  };
  if (!isValidHistoryPeriod(from) || !isValidHistoryPeriod(to) || to < from) return empty;
  if (hrIds.length === 0) return empty;

  const [rows, uploadedPeriods] = await Promise.all([
    loadAchievementRange(from, to),
    loadUploadedPeriodsInRange(from, to),
  ]);

  // Merge Fayoum/Beni Suef BEFORE grouping — the merge rewrites areaCode, and grouping
  // first would leave the same rep split across two codes on the lines that merge.
  const merged = applyAchievementAreaMerges(rows);
  return {
    from,
    to,
    uploadedPeriods,
    byHrId: groupAchievementByEmployee(merged, hrIds, uploadedPeriods, grain),
  };
}

/** The months whose distributor upload landed. Use before summing more than one month. */
export function uploadedPointsOnly(
  points: readonly MonthlyAchievementPoint[],
): MonthlyAchievementPoint[] {
  return points.filter((point) => point.uploaded);
}

export type AchievementSummary = {
  /** How many months actually contributed. Callers render "N of 6" from this. */
  months: number;
  periods: string[];
  actualValue: number;
  actualUnits: number;
  targetValue: number;
  coveredActualValue: number;
  uncoveredActualValue: number;
  /** covered ÷ target across the whole window, as a RATIO. null when there is no target. */
  achievementValue: number | null;
};

/**
 * Total a window of months.
 *
 * Achievement is recomputed from the sums, never averaged across the per-month ratios:
 * averaging a 10% month with a 400% month and calling it 205% is wrong at every level
 * above the row, and is how a semester figure drifts from the months it is made of.
 */
export function summarizeAchievement(
  points: readonly MonthlyAchievementPoint[],
): AchievementSummary {
  const summary: AchievementSummary = {
    months: 0,
    periods: [],
    actualValue: 0,
    actualUnits: 0,
    targetValue: 0,
    coveredActualValue: 0,
    uncoveredActualValue: 0,
    achievementValue: null,
  };
  for (const point of points) {
    summary.months += 1;
    summary.periods.push(point.period);
    summary.actualValue += point.actualValue;
    summary.actualUnits += point.actualUnits;
    summary.targetValue += point.targetValue;
    summary.coveredActualValue += point.coveredActualValue;
    summary.uncoveredActualValue += point.uncoveredActualValue;
  }
  summary.periods.sort((a, b) => a.localeCompare(b));
  summary.achievementValue =
    summary.targetValue !== 0 ? summary.coveredActualValue / summary.targetValue : null;
  return summary;
}

/**
 * The summary's achievement as a PERCENT, which is what the incentive scheme consumes.
 *
 * calculateIncentive2026 takes a 0–150 scale and clamps; it cannot represent "no target",
 * so the null has to be resolved by the caller with a decision it can explain to the rep,
 * not silently turned into a zero here.
 */
export function achievementPercentOf(summary: AchievementSummary): number | null {
  return summary.achievementValue == null ? null : summary.achievementValue * 100;
}

export { SALES_HISTORY_FLOOR };
