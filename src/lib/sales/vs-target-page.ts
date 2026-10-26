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
import { loadSalesSeatTree, regionalManagerAbove, type SalesSeat } from "@/lib/sales/seat-hierarchy";
import {
  SALES_VS_TARGET_FLOOR,
  buildTrend,
  coverageRatio,
  emptyTotals,
  growthOf,
  isRowPublished,
  isValidVsTargetPeriod,
  loadPublishedPeriodKeys,
  loadTargetBearingPairs,
  loadVsTargetRange,
  pickLandingPeriod,
  priorPeriodOf,
  rankByAchievement,
  regroupPriorRowsByCurrentMap,
  rollupByArea,
  rollupByDm,
  rollupByProduct,
  rollupByRegionalManager,
  rollupByRegion,
  rollupByRep,
  rollupByTeam,
  salesVsTargetPeriods,
  shiftPeriod,
  splitPeriodAtPublication,
  totalRows,
  unitsAreAddable,
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
  /**
   * True only when this view's rows carry ONE product code — the only case where `totals.actualUnits`
   * and `totals.targetUnits` count one thing. Above that the "Units sold" figure is hidden: units of
   * different products are never added (Pedia's four products printed 20,521 / 38,503).
   */
  unitsAddable: boolean;
  priorTotals: VsTargetTotals | null;
  growth: number | null;
  coverage: number | null;
  teams: VsTargetNode[];
  regions: VsTargetNode[];
  areas: VsTargetNode[];
  reps: VsTargetNode[];
  managers: VsTargetNode[];
  /**
   * Regional Managers (owner, 2026-10-20) — each the sum of the District Manager nodes under his
   * seat. Filled for a company or line viewer only; empty otherwise, and then the level is hidden.
   */
  regionalManagers: VsTargetNode[];
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
   * to less than the headline. 149,288.50 EGP in 2026-07. Surfaced so the difference reads as
   * an explained split, not a missing row.
   */
  areaUnattributedValue: number;
  /**
   * Sales the engine could not place AT ALL — no area and no region. These are the `unmapped`
   * channel, counted here since the owner's ruling of 2026-08-12 so that Sales vs Target foots
   * to Monthly Closing to the piastre. 151,591.94 EGP in 2026-07.
   *
   * Held apart from `areaUnattributedValue` because they are NOT Direct Orders and the
   * footnotes name their source. They reach the headline total and nothing below it: with no
   * area there is no target, so they never touch an achievement %.
   */
  unplacedValue: number;
  /**
   * False when this period's Monthly Closing has not been PUBLISHED yet for this viewer's
   * line — distinct from "sold nothing". Targets can exist, and distributor files can even
   * have landed, for a month the owner has not yet reconciled and published; the UI must say
   * so instead of rendering a confident 0% off raw, unclosed figures.
   */
  salesLoaded: boolean;
  /**
   * Value already booked into a not-yet-published month, from the raw (unpublished) rows.
   * Often Direct Orders — Finance books those the day they are approved, weeks before that
   * month's Monthly Closing is published — but can be any real sales sitting in an
   * unpublished period. Reported inside the "not published yet" panel so the money is
   * visibly parked rather than silently missing — and so nobody reads the panel as "August
   * has nothing at all".
   */
  pendingDirectValue: number;
  /**
   * Target already loaded for a not-yet-published month, from the same raw (unpublished) rows as
   * `pendingDirectValue`. The "not published yet" panel quotes it, so a month whose target is set
   * reads as "measured the moment the closing is published". `totals.targetValue` cannot stand in:
   * `totals` is built from published rows only, so it is always 0 while that panel shows. A target,
   * never a sale — no sales figure crosses the publication gate for it.
   */
  pendingTargetValue: number;
  /** True when this viewer has no sales territory at all. */
  isEmptyScope: boolean;
};

function lineLabel(code: string): string {
  return SALES_LINES.find((line) => line.code === code)?.label ?? code;
}

/**
 * The name resolvers for one dashboard build. Pure, and exported so the period-aware area lookup
 * can be pinned without a database: `getMergedAreaName` reads its dated merge rules (Fayoum/Beni
 * Suef, Ismailia/Suez) against the CALLER's period, never "now" — the bug this closure exists to
 * avoid is building it before `period` is resolved and defaulting the lookup to today's month.
 */
export function buildVsTargetNames(
  activeLine: string | null,
  period: string,
  areaNames: ReadonlyMap<string, string>,
  employeeNames: ReadonlyMap<string, string>,
): VsTargetNames {
  return {
    lineName: lineLabel,
    regionName: (code) => regionNameOf(code) || "Unassigned region",
    areaName: (code) => getMergedAreaName(activeLine, code, period) ?? areaNames.get(code) ?? "Unassigned area",
    employeeName: (hrId) => employeeNames.get(hrId) ?? "Unnamed employee",
  };
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

  // Load the WHOLE window up front — not just up to the requested month — because the
  // landing month is chosen from which periods actually have sales, and that cannot be
  // known before reading. One range call covers the trend and both compared months.
  const windowStartCandidate = shiftPeriod(current, -(TREND_WINDOW_MONTHS - 1));
  const windowStart =
    windowStartCandidate && windowStartCandidate > SALES_VS_TARGET_FLOOR
      ? windowStartCandidate
      : SALES_VS_TARGET_FLOOR;

  // STARTED TOGETHER (2026-10-01, "slow to transfer between page and page"). The range, the name
  // masters, the target-bearing pairs and the publication keys depend on the window alone, never on
  // who is asking, so they no longer wait for the viewer's bound — which is applied to the rows below,
  // exactly as before, before anything is totalled. A viewer whose bound is `none` never awaits them;
  // the guards keep that from surfacing as an unhandled rejection. Each is still awaited, and still
  // throws, where it is used.
  const boundLoad = resolveVsTargetBound(ctx);
  const windowLoads = Promise.all([
    loadVsTargetRange(windowStart, current),
    loadAllCanonicalAreaNames(),
    loadProductNameMap(),
    loadTargetBearingPairs().catch(() => new Set<string>()),
    loadPublishedPeriodKeys(windowStart, current),
  ]);
  windowLoads.catch(() => {});
  // Employee names feed ONLY the rep and district-manager roll-ups, which run only where
  // `levels.rep` is true — never for a Medical Rep (`self`) or a `none` bound. So they are read once
  // the bound says they will be used, and not at all otherwise.
  const employeeNamesLoad = boundLoad.then((resolved) =>
    visibleLevelsForBound(resolved).rep ? loadEmployeeNameMap() : new Map<string, string>(),
  );
  employeeNamesLoad.catch(() => {});
  // The seat tree feeds ONLY the Regional Managers level, which a company or line viewer gets
  // (owner, 2026-10-20). A district manager or Regional Manager reading his own areas would find
  // only himself there, so it is not read for him. Best effort: a failed read is an empty tree,
  // which hides the level and changes no figure.
  const seatTreeLoad = boundLoad.then((resolved) =>
    resolved.kind === "company" || resolved.kind === "line" ? loadSalesSeatTree() : new Map<string, SalesSeat>(),
  );
  seatTreeLoad.catch(() => {});
  // The channel split's attribution pass, when the month is already named in the request: it is
  // the month the dashboard will show, so the pass starts now rather than after the range lands. Its
  // result is read only if that month turns out to be published, exactly as before.
  const explicitAttributionLoad = explicitPeriod
    ? loadMonthlyAttribution(explicitPeriod).catch(() => [])
    : null;

  const bound = await boundLoad;
  const levels = visibleLevelsForBound(bound);

  if (bound.kind === "none") {
    return {
      period: explicitPeriod ?? current,
      priorPeriod: priorPeriodOf(explicitPeriod ?? current),
      periods,
      scopeLabel: boundLabel(bound),
      levels,
      totals: emptyTotals(),
      unitsAddable: false,
      priorTotals: null,
      growth: null,
      coverage: null,
      teams: [],
      regions: [],
      areas: [],
      reps: [],
      managers: [],
      regionalManagers: [],
      products: [],
      leaders: { top: [], bottom: [], level: "Area" },
      trend: [],
      trendIsMeaningful: false,
      channels: null,
      uncovered: [],
      byDesignUntargetedValue: 0,
      areaUnattributedValue: 0,
      unplacedValue: 0,
      salesLoaded: false,
      pendingDirectValue: 0,
      pendingTargetValue: 0,
      isEmptyScope: true,
    };
  }

  const [[rangeRows, areaNames, productNames, targetBearing, publishedKeys], employeeNames, seatTree] = await Promise.all([
    windowLoads,
    employeeNamesLoad,
    seatTreeLoad,
  ]);

  // Scope FIRST — everything below derives from these arrays.
  // Apply area merges (Fayoum/Beni Suef) immediately after loading before any aggregation.
  const mergedRows = applyAchievementAreaMerges(rangeRows);
  const scopedAllRaw = filterRowsForBound(mergedRows, bound);
  // Only PUBLISHED (line, period) pairs are real numbers on this live dashboard — Monthly
  // Closing publication is the owner's own "this month is done" gate, separate from and later
  // than the distributor files simply landing (owner ruling, 2026-08-13). `scopedAllRaw` is
  // kept alongside for pickLandingPeriod's fallback messaging and the pending figures below.
  const scopedAll = scopedAllRaw.filter((row) => isRowPublished(row, publishedKeys));

  // If the dashboard is scoped to a single line, use that line to look up merged area names (e.g. "Fayoum - Beni Suef").
  const distinctLines = new Set(scopedAll.map((r) => r.lineCode).filter(Boolean));
  const activeLine = distinctLines.size === 1 ? [...distinctLines][0] : null;

  // Land on the newest PUBLISHED month that has sales in this viewer's scope. "Has any row
  // with an actual" is not the same question and is not safe to ask: one direct order booked
  // into a month whose Monthly Closing has not been published is enough to make that month
  // rank newest, which opened the whole company on 1,309.50 EGP against a 17.5M target in
  // August 2026 — and even a genuinely landed distributor file is not "closed" until the
  // owner publishes it.
  const period = explicitPeriod ?? pickLandingPeriod(scopedAllRaw, publishedKeys, current);
  const priorPeriod = priorPeriodOf(period);

  // Built only now that `period` is known — see buildVsTargetNames. `rows` and `priorRows` below
  // share this one closure, so both months of one dashboard read the SAME landing period's name —
  // exactly how rollupByArea folds them into a single node.
  const names = buildVsTargetNames(activeLine, period, areaNames, employeeNames);

  const rawRowsForPeriod = scopedAllRaw.filter((row) => row.period === period);
  // A company fact, not a scope fact: the month's Monthly Closing has either been published
  // or it has not. A viewer with an empty territory in a published month is `isEmptyScope`,
  // which says so — computed from the RAW bound-scoped rows, never from `rows`, so an
  // unpublished period reads as "not published" and not as "you have no territory".
  const { rows, salesLoaded, pendingDirectValue, pendingTargetValue } = splitPeriodAtPublication(
    rawRowsForPeriod,
    publishedKeys,
  );

  // Re-homed onto the selected month's area → region → district map, so an area that changed region
  // between the two months is compared with itself rather than folded under a region the selected
  // month no longer has (Upper Egypt 1 / 2 printed "—" against August). Totals are unaffected.
  const priorRows = regroupPriorRowsByCurrentMap(
    rows,
    priorPeriod ? scopedAll.filter((row) => row.period === priorPeriod) : null,
  );

  const totals = totalRows(rows);
  const priorTotals = priorRows ? totalRows(priorRows) : null;

  // The channel split is not carried by the achievement function (it aggregates the channel
  // away), so it comes from the attribution engine that function is itself built on. Loaded
  // after the period is resolved, since the period depends on what the range actually held —
  // unless the request named the period, in which case the pass started above for that same month.
  const attribution = salesLoaded
    ? await (explicitAttributionLoad ?? loadMonthlyAttribution(period).catch(() => []))
    : [];

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
  // A Medical Rep (the `self` bound) has no rep level, so the fallback above would rank his own one
  // or two areas: "Top Areas" crowned his own area #1 and "Needs attention" was always empty, since
  // rankByAchievement keeps the two lists apart and five nodes or fewer leave nothing for the bottom.
  // That is not a leaderboard. He gets none, and the dashboard hides the pair when `top` is empty.
  const leaders: VsTargetDashboardData["leaders"] =
    bound.kind === "self"
      ? { top: [], bottom: [], level: leaderLevel }
      : { ...rankByAchievement(leaderNodes, 5), level: leaderLevel };

  return {
    period,
    priorPeriod,
    periods,
    scopeLabel: boundLabel(bound),
    levels,
    totals,
    unitsAddable: unitsAreAddable(rows),
    priorTotals,
    growth: growthOf(totals, priorTotals),
    coverage: coverageRatio(totals),
    teams: levels.team ? rollupByTeam(rows, priorRows, names) : [],
    regions: levels.region ? rollupByRegion(rows, priorRows, names) : [],
    areas: areaNodes,
    reps: repNodes,
    managers: levels.rep ? rollupByDm(rows, priorRows, names) : [],
    regionalManagers: rollupByRegionalManager(rows, priorRows, names, (row) =>
      regionalManagerAbove(row.dmSeatId, seatTree)?.hrId ?? null,
    ),
    products: rollupByProduct(rows, priorRows, (code) => productNames.get(code.toUpperCase()) ?? "Unnamed product"),
    leaders,
    trend: buildTrend(scopedAll, trendPeriods),
    trendIsMeaningful: loadedPeriodCount > 1,
    channels: buildChannelSplit(attribution, bound),
    uncovered: allUncovered.filter((entry) => entry.expectsTarget),
    byDesignUntargetedValue: allUncovered
      .filter((entry) => !entry.expectsTarget)
      .reduce((sum, entry) => sum + entry.actualValue, 0),
    areaUnattributedValue: rows
      .filter((row) => row.areaCode == null && row.regionCode != null)
      .reduce((sum, row) => sum + row.actualValue, 0),
    unplacedValue: rows
      .filter((row) => row.areaCode == null && row.regionCode == null)
      .reduce((sum, row) => sum + row.actualValue, 0),
    salesLoaded,
    pendingDirectValue,
    pendingTargetValue,
    isEmptyScope: rawRowsForPeriod.length === 0,
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
