// ─────────────────────────────────────────────────────────────────────────────
// Sales vs Target — the payload both routes render.
//
// The admin-shell page and the employee-portal page differ ONLY in their surrounding
// shell and page chrome. They share this builder so the two URLs can never drift into
// quoting different numbers for the same month and the same viewer — which is the
// failure mode whenever a "twin" page grows its own loading code.
//
// Scope is applied to the raw rows HERE, before any roll-up, and the prior period is
// scoped with the identical bound. Scoping after aggregation yields a correct-looking
// table under whole-company summary cards.
// ─────────────────────────────────────────────────────────────────────────────

import type { AccessContext } from "@/lib/auth/permissions";
import { loadMonthlyAttribution } from "@/lib/sales/monthly-attribution";
import {
  SALES_LINES,
  loadAllCanonicalAreaNames,
  loadEmployeeNameMap,
  loadProductNameMap,
  regionName as regionNameOf,
} from "@/lib/sales/monthly-targets";
import type { AchievementRow } from "@/lib/sales/monthly-targets";
import { applyAchievementAreaMerges, getMergedAreaName } from "@/lib/sales/closing-area-merges";
import {
  SALES_VS_TARGET_FLOOR,
  buildTrend,
  coverageRatio,
  emptyTotals,
  growthOf,
  isValidVsTargetPeriod,
  latestPeriodWithActuals,
  loadTargetBearingPairs,
  loadVsTargetRange,
  periodHasActuals,
  priorPeriodOf,
  rankByAchievement,
  rollupByArea,
  rollupByDm,
  rollupByProduct,
  rollupByRegion,
  rollupByRep,
  rollupByTeam,
  salesVsTargetPeriods,
  shiftPeriod,
  totalRows,
  type TrendPoint,
  type VsTargetNames,
  type VsTargetNode,
  type VsTargetTotals,
} from "@/lib/sales/vs-target";
import {
  boundLabel,
  filterRowsForBound,
  resolveVsTargetBound,
  visibleLevelsForBound,
  type VsTargetBound,
} from "@/lib/sales/vs-target-scope";

/** How many months of history the trend chart shows. Each month is one attribution pass. */
const TREND_WINDOW_MONTHS = 12;

/** A line/area pair carrying sales that nobody has set a target for. */
export type UncoveredEntry = {
  key: string;
  teamName: string;
  areaName: string;
  regionName: string;
  actualValue: number;
  /**
   * True when the canonical model says this area SHOULD carry a target — i.e. a real gap
   * someone must close. False for "Other" spillover areas that carry none by design.
   */
  expectsTarget: boolean;
};

export type VsTargetDashboardData = {
  period: string;
  /** null for 2026-07 — the dashboard's first month has nothing before it. */
  priorPeriod: string | null;
  periods: string[];
  /** Plain-language description of what this viewer's numbers cover. */
  scopeLabel: string;
  levels: ReturnType<typeof visibleLevelsForBound>;
  totals: VsTargetTotals;
  priorTotals: VsTargetTotals | null;
  growth: number | null;
  coverage: number | null;
  teams: VsTargetNode[];
  regions: VsTargetNode[];
  areas: VsTargetNode[];
  reps: VsTargetNode[];
  managers: VsTargetNode[];
  /** Product mix — real analysis for a scope that has only one month loaded. */
  products: VsTargetNode[];
  /** Best and worst measurable performers at the most useful level for this viewer. */
  leaders: { top: VsTargetNode[]; bottom: VsTargetNode[]; level: string };
  trend: TrendPoint[];
  /** True once there are at least two loaded months — gates the trend chart entirely. */
  trendIsMeaningful: boolean;
  /** Where the money came from. Both are inside `totals`. */
  channels: { direct: number; indirect: number } | null;
  /** Untargeted pockets that SHOULD have a target, largest first. Drives the honesty banner. */
  uncovered: UncoveredEntry[];
  /** Sales in areas that carry no target by design ("Other" geography). Reported, not alarmed on. */
  byDesignUntargetedValue: number;
  /**
   * Sales that belong to a team and a region but to NO area — Direct Orders the engine could
   * not place in one area, so it spreads them across regions by weight. They are inside the
   * team and region totals but absent from area / rep / brick, which is why those levels foot
   * to less than the headline. In 2026-07 this was 628,267.65 EGP: every direct order that
   * month. Surfaced so the difference reads as an explained split, not a missing row.
   */
  areaUnattributedValue: number;
  /**
   * False when NO sales have been uploaded for this period yet — distinct from "sold
   * nothing". Targets can exist for a month whose sales file has not arrived, and the UI
   * must say so instead of rendering a confident 0%.
   */
  salesLoaded: boolean;
  /** True when this viewer has no sales territory at all. */
  isEmptyScope: boolean;
};

function lineLabel(code: string): string {
  return SALES_LINES.find((line) => line.code === code)?.label ?? code;
}

/**
 * Build the whole payload for one viewer and one period.
 *
 * `period` is validated against the dashboard window; anything invalid or pre-floor
 * falls back to the current month rather than erroring, so a stale bookmark degrades to
 * "this month" instead of a crash.
 */
export async function buildVsTargetDashboard(
  ctx: AccessContext,
  requestedPeriod: string | null | undefined,
): Promise<VsTargetDashboardData> {
  const { periods, current } = salesVsTargetPeriods();
  const explicitPeriod =
    isValidVsTargetPeriod(requestedPeriod) && periods.includes(requestedPeriod) ? requestedPeriod : null;

  const bound = await resolveVsTargetBound(ctx);
  const levels = visibleLevelsForBound(bound);

  if (bound.kind === "none") {
    return {
      period: explicitPeriod ?? current,
      priorPeriod: priorPeriodOf(explicitPeriod ?? current),
      periods,
      scopeLabel: boundLabel(bound),
      levels,
      totals: emptyTotals(),
      priorTotals: null,
      growth: null,
      coverage: null,
      teams: [],
      regions: [],
      areas: [],
      reps: [],
      managers: [],
      products: [],
      leaders: { top: [], bottom: [], level: "Area" },
      trend: [],
      trendIsMeaningful: false,
      channels: null,
      uncovered: [],
      byDesignUntargetedValue: 0,
      areaUnattributedValue: 0,
      salesLoaded: false,
      isEmptyScope: true,
    };
  }

  // Load the WHOLE window up front — not just up to the requested month — because the
  // landing month is chosen from which periods actually have sales, and that cannot be
  // known before reading. One range call covers the trend and both compared months.
  const windowStartCandidate = shiftPeriod(current, -(TREND_WINDOW_MONTHS - 1));
  const windowStart =
    windowStartCandidate && windowStartCandidate > SALES_VS_TARGET_FLOOR
      ? windowStartCandidate
      : SALES_VS_TARGET_FLOOR;

  const [rangeRows, areaNames, employeeNames, productNames, targetBearing] = await Promise.all([
    loadVsTargetRange(windowStart, current),
    loadAllCanonicalAreaNames(),
    loadEmployeeNameMap(),
    loadProductNameMap(),
    loadTargetBearingPairs().catch(() => new Set<string>()),
  ]);

  // Scope FIRST — everything below derives from these arrays.
  // Apply area merges (Fayoum/Beni Suef) immediately after loading before any aggregation.
  const mergedRows = applyAchievementAreaMerges(rangeRows);
  const scopedAll = filterRowsForBound(mergedRows, bound);

  // If the dashboard is scoped to a single line, use that line to look up merged area names (e.g. "Fayoum - Beni Suef").
  const distinctLines = new Set(scopedAll.map((r) => r.lineCode).filter(Boolean));
  const activeLine = distinctLines.size === 1 ? [...distinctLines][0] : null;

  const names: VsTargetNames = {
    lineName: lineLabel,
    regionName: (code) => regionNameOf(code) || "Unassigned region",
    areaName: (code) => getMergedAreaName(activeLine, code) ?? areaNames.get(code) ?? "Unassigned area",
    employeeName: (hrId) => employeeNames.get(hrId) ?? "Unnamed employee",
  };

  // Land on the newest month that actually has sales. Defaulting to the calendar month
  // would open the dashboard on an un-uploaded August showing 0% against targets copied
  // forward from July — a confident zero that reads as company-wide collapse.
  const period = explicitPeriod ?? latestPeriodWithActuals(scopedAll) ?? current;
  const priorPeriod = priorPeriodOf(period);
  const salesLoaded = periodHasActuals(scopedAll, period);

  const rows = scopedAll.filter((row) => row.period === period);
  const priorRows = priorPeriod ? scopedAll.filter((row) => row.period === priorPeriod) : null;

  const totals = totalRows(rows);
  const priorTotals = priorRows ? totalRows(priorRows) : null;

  // The channel split is not carried by the achievement function (it aggregates the channel
  // away), so it comes from the attribution engine that function is itself built on. Loaded
  // after the period is resolved, since the period depends on what the range actually held.
  const attribution = salesLoaded ? await loadMonthlyAttribution(period).catch(() => []) : [];

  const trendPeriods = periods.filter((entry) => entry >= windowStart && entry <= period);
  const allUncovered = buildUncovered(rows, names, targetBearing);

  // A "trend" over a single loaded month is one bar in an empty grid — it reads as a broken
  // chart, not as data. Gate the chart on there actually being something to trend.
  const loadedPeriodCount = new Set(scopedAll.filter((entry) => entry.hasActual).map((entry) => entry.period)).size;

  const areaNodes = levels.area ? rollupByArea(rows, priorRows, names) : [];
  const repNodes = levels.rep ? rollupByRep(rows, priorRows, names) : [];
  // Rank at the finest level this viewer actually has more than one of, so a leaderboard is
  // never a list of one.
  const leaderNodes = repNodes.length > 1 ? repNodes : areaNodes;
  const leaderLevel = repNodes.length > 1 ? "Medical Rep" : "Area";

  return {
    period,
    priorPeriod,
    periods,
    scopeLabel: boundLabel(bound),
    levels,
    totals,
    priorTotals,
    growth: growthOf(totals, priorTotals),
    coverage: coverageRatio(totals),
    teams: levels.team ? rollupByTeam(rows, priorRows, names) : [],
    regions: levels.region ? rollupByRegion(rows, priorRows, names) : [],
    areas: areaNodes,
    reps: repNodes,
    managers: levels.rep ? rollupByDm(rows, priorRows, names) : [],
    products: rollupByProduct(rows, priorRows, (code) => productNames.get(code.toUpperCase()) ?? code),
    leaders: { ...rankByAchievement(leaderNodes, 5), level: leaderLevel },
    trend: buildTrend(scopedAll, trendPeriods),
    trendIsMeaningful: loadedPeriodCount > 1,
    channels: buildChannelSplit(attribution, bound),
    uncovered: allUncovered.filter((entry) => entry.expectsTarget),
    byDesignUntargetedValue: allUncovered
      .filter((entry) => !entry.expectsTarget)
      .reduce((sum, entry) => sum + entry.actualValue, 0),
    areaUnattributedValue: rows
      .filter((row) => row.areaCode == null)
      .reduce((sum, row) => sum + row.actualValue, 0),
    salesLoaded,
    isEmptyScope: rows.length === 0,
  };
}

/**
 * Source of Sales vs Direct Orders for the selected period.
 *
 * Returns null when the attribution read failed — the caller then hides the panel
 * instead of drawing a chart that says the company sold nothing through one channel.
 */
function buildChannelSplit(
  attribution: Awaited<ReturnType<typeof loadMonthlyAttribution>>,
  bound: VsTargetBound,
): { direct: number; indirect: number } | null {
  if (attribution.length === 0) return null;
  let direct = 0;
  let indirect = 0;
  for (const row of attribution) {
    if (!row.mapped) continue;
    if (!inBound(row, bound)) continue;
    if (row.channel === "direct") direct += row.salesValue;
    else if (row.channel === "indirect") indirect += row.salesValue;
  }
  return direct === 0 && indirect === 0 ? null : { direct, indirect };
}

/** The bound applied to attribution rows, which carry the same keys as achievement rows. */
function inBound(
  row: { lineCode: string | null; areaCode: string | null; repHrId: string | null },
  bound: VsTargetBound,
): boolean {
  switch (bound.kind) {
    case "company":
      return true;
    case "none":
      return false;
    case "self":
      return String(row.repHrId ?? "").trim().toLowerCase() === bound.hrId;
    case "line":
      return row.lineCode != null && bound.lineCodes.has(row.lineCode);
    case "areas": {
      if (bound.lineCodes && (row.lineCode == null || !bound.lineCodes.has(row.lineCode))) return false;
      const areaCode = String(row.areaCode ?? "").trim().toUpperCase();
      return Boolean(areaCode) && bound.areaCodes.has(areaCode);
    }
  }
}

/**
 * Sales with no target, grouped by (team, area), biggest first.
 *
 * This is the number the dashboard must never hide. In 2026-07, 106 of 142 line-area pairs
 * had sales and no target — but only 70 of those (1,823,610 EGP, including the entire Pedia
 * line) are areas the canonical model says SHOULD carry one. The other 36 (159,318 EGP) are
 * "Other" spillover geography that carries no target by design. `expectsTarget` keeps the
 * two apart so the banner asks for the 70 that are genuinely missing and merely reports the
 * rest — an alert nobody can action is an alert people learn to ignore.
 */
function buildUncovered(
  rows: AchievementRow[],
  names: VsTargetNames,
  targetBearing: Set<string>,
): UncoveredEntry[] {
  const buckets = new Map<string, UncoveredEntry>();
  for (const row of rows) {
    if (row.hasTarget || row.actualValue === 0) continue;
    if (!row.lineCode || !row.areaCode) continue;
    const key = `${row.lineCode}|${row.areaCode}`;
    const entry = buckets.get(key) ?? {
      key,
      teamName: names.lineName(row.lineCode),
      areaName: names.areaName(row.areaCode),
      regionName: row.regionCode ? names.regionName(row.regionCode) : "Unassigned region",
      actualValue: 0,
      // An empty targetBearing set means the lookup failed. Treat every area as expecting a
      // target then: over-reporting the gap is recoverable, silently hiding it is not.
      expectsTarget: targetBearing.size === 0 || targetBearing.has(key),
    };
    entry.actualValue += row.actualValue;
    buckets.set(key, entry);
  }
  return [...buckets.values()].sort((left, right) => right.actualValue - left.actualValue);
}
