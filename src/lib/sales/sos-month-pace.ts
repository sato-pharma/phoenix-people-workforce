// ─────────────────────────────────────────────────────────────────────────────
// MONTH PACE — this month's WEEKLY sales so far, plus the direct orders Finance has booked into the
// month, against the month's target, per area.
//
// 🔴 THIS IS NOT A SALES NUMBER. Monthly Closing is the only sales truth; weekly is depot data on a
// separate track, spread to areas partly by reading branch names. It is shown on the Source of Sales
// page as its own, labelled section — "weekly, approximate" — so a manager can see mid-month whether
// an area is behind before the closing tells him too late. It never feeds an official figure, and the
// canonical modules never import it (tests/official-numbers-exclude-weekly.test.ts).
//
// Direct orders never reach a depot upload since August, so without them an area selling through
// direct orders looks behind when it is not. They count the way the closing counts them: in the month
// Finance books them, at the pharmacy's own area. Kept as their own figure so the weekly part stays
// readable on its own.
//
// PURE. The IO is in sos-month-pace-loader.ts. VALUE ONLY — never units.
//
// NAMES, NEVER CODES (owner rule). A row takes the first real name any input gives its area; with none,
// it reads "Unnamed area" (owner's pick, 2026-09-17) and never falls back to the code.
// ─────────────────────────────────────────────────────────────────────────────

/** What a row says when no input named its area. */
export const UNNAMED_AREA_LABEL = "Unnamed area";

export type MonthPaceTargetInput = { areaCode: string; areaName?: string | null; targetValue: number };
export type MonthPaceWeeklyInput = {
  areaCode: string;
  areaName?: string | null;
  value: number;
  /** The part of `value` placed by reading a branch name rather than a hand mapping. */
  allocatedValue: number;
};
/** Direct orders booked into the month, per area (one entry per product row is fine). */
export type MonthPaceDirectInput = { areaCode: string; areaName?: string | null; value: number };

export type MonthPaceRow = {
  areaCode: string;
  /** Always a name: the area's own, else UNNAMED_AREA_LABEL. Never the code. */
  areaName: string;
  /** null when the area has no target this month. */
  targetValue: number | null;
  weeklyValue: number;
  /** Direct orders booked into this month for the area. */
  directValue: number;
  /** weekly + direct — what progress is measured on. */
  soFarValue: number;
  /** so far / target. null without a target. */
  progress: number | null;
  /** target × (day / days in month). null without a target. */
  expectedByToday: number | null;
  /** so far ≥ expected by today. null without a target. */
  onPace: boolean | null;
};

export type MonthPaceResult = {
  period: string;
  dayOfMonth: number;
  daysInMonth: number;
  rows: MonthPaceRow[];
  totals: {
    targetValue: number;
    weeklyValue: number;
    directValue: number;
    soFarValue: number;
    expectedByToday: number;
    progress: number | null;
  };
  /** Share of the weekly value that was allocated by branch name — the approximate part. */
  allocatedShare: number | null;
  hasTargets: boolean;
  hasWeeklyData: boolean;
  hasDirectOrders: boolean;
  /**
   * True when this month's weekly upload itself carries a Direct channel (as the sheets did up to
   * July 2026). The booked orders are then left out, because the weekly value already holds them.
   */
  directInWeekly: boolean;
};

const round2 = (value: number): number => Math.round(value * 100) / 100;
const upper = (value: unknown): string => String(value ?? "").trim().toUpperCase();

export function buildMonthPace(input: {
  period: string;
  dayOfMonth: number;
  daysInMonth: number;
  targets: readonly MonthPaceTargetInput[];
  weekly: readonly MonthPaceWeeklyInput[];
  direct?: readonly MonthPaceDirectInput[];
  directInWeekly?: boolean;
}): MonthPaceResult {
  const days = Math.max(1, input.daysInMonth);
  const fraction = Math.min(1, Math.max(0, input.dayOfMonth / days));
  const directInWeekly = input.directInWeekly === true;

  const byArea = new Map<string, { areaName: string; target: number | null; weekly: number; direct: number }>();
  const entry = (areaCode: string, areaName?: string | null) => {
    const code = upper(areaCode);
    const found = byArea.get(code) ?? { areaName: "", target: null, weekly: 0, direct: 0 };
    // A "name" that is only the code again is what an upstream `name || code` fallback hands over.
    const name = String(areaName ?? "").trim();
    if (!found.areaName && name && name.toUpperCase() !== code) found.areaName = name;
    byArea.set(code, found);
    return found;
  };

  for (const target of input.targets) {
    if (!upper(target.areaCode)) continue;
    const found = entry(target.areaCode, target.areaName);
    found.target = (found.target ?? 0) + (Number(target.targetValue) || 0);
  }
  let weeklyTotal = 0;
  let allocatedTotal = 0;
  for (const weekly of input.weekly) {
    if (!upper(weekly.areaCode)) continue;
    const value = Number(weekly.value) || 0;
    entry(weekly.areaCode, weekly.areaName).weekly += value;
    weeklyTotal += value;
    allocatedTotal += Number(weekly.allocatedValue) || 0;
  }
  let directTotal = 0;
  if (!directInWeekly) {
    for (const direct of input.direct ?? []) {
      if (!upper(direct.areaCode)) continue;
      const value = Number(direct.value) || 0;
      entry(direct.areaCode, direct.areaName).direct += value;
      directTotal += value;
    }
  }

  const rows: MonthPaceRow[] = [...byArea].map(([areaCode, found]) => {
    const target = found.target != null && found.target > 0 ? found.target : null;
    const expected = target != null ? target * fraction : null;
    const soFar = found.weekly + found.direct;
    return {
      areaCode,
      areaName: found.areaName || UNNAMED_AREA_LABEL,
      targetValue: target != null ? round2(target) : null,
      weeklyValue: round2(found.weekly),
      directValue: round2(found.direct),
      soFarValue: round2(soFar),
      progress: target != null ? soFar / target : null,
      expectedByToday: expected != null ? round2(expected) : null,
      onPace: expected != null ? soFar >= expected : null,
    };
  });
  // Furthest behind first — the area that needs attention leads.
  rows.sort((left, right) => {
    const leftGap = left.progress == null ? Number.POSITIVE_INFINITY : left.progress;
    const rightGap = right.progress == null ? Number.POSITIVE_INFINITY : right.progress;
    return leftGap - rightGap || left.areaName.localeCompare(right.areaName);
  });

  const targetTotal = rows.reduce((sum, row) => sum + (row.targetValue ?? 0), 0);
  const soFarTotal = weeklyTotal + directTotal;
  return {
    period: input.period,
    dayOfMonth: input.dayOfMonth,
    daysInMonth: days,
    rows,
    totals: {
      targetValue: round2(targetTotal),
      weeklyValue: round2(weeklyTotal),
      directValue: round2(directTotal),
      soFarValue: round2(soFarTotal),
      expectedByToday: round2(targetTotal * fraction),
      progress: targetTotal > 0 ? soFarTotal / targetTotal : null,
    },
    allocatedShare: weeklyTotal > 0 ? allocatedTotal / weeklyTotal : null,
    hasTargets: targetTotal > 0,
    hasWeeklyData: weeklyTotal > 0,
    hasDirectOrders: directTotal > 0,
    directInWeekly,
  };
}
