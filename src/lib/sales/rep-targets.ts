// ─────────────────────────────────────────────────────────────────────────────
// Targets — a MEDICAL REP's own view (owner decision 2026-09-16).
//
// The portal Targets tab opened to District / Regional / National Sales Managers on 2026-07-30,
// with Medical Rep left out. The owner has now asked for reps to have it too. They do NOT get the
// manager workspace, and the reason is a leak rather than a taste: resolvePortalTargetsBound hands a
// rep `{ areaCodes: null, lineCodes: {their line} }`, and filterAchievementForScope reads a null
// area bound as "every area on the line" — one rep would see the targets and sales of every rep on
// it. vs-target-scope.ts documents the same trap for Sales vs Target, and this module takes the
// same way out.
//
// So this view:
//
//   * is bounded by resolveVsTargetBound's SELF variant — the rows the attribution engine resolved
//     to this rep's HR id as of each period end — and refuses every other kind. A rep who somehow
//     resolves wider is shown nothing, never widened.
//
//   * follows the rep's Sales vs Target rules to the letter, so the two screens can never quote
//     different numbers for the same month: the July 2026 floor, area merges BEFORE scoping, sales
//     only for a month whose Monthly Closing is PUBLISHED for the rep's line (owner ruling,
//     2026-08-13), and achievement from `totalRows` — the very function that screen divides with.
//
//   * shows TARGETS whether or not the month is published. A target exists before its month
//     closes, and targets are loaded a quarter at a time, so a forward month that already carries
//     one is offered and a forward month without one is simply not offered — normal, never an alarm.
//
//   * adds UNITS only inside one product (the same product across the rep's areas). Every total
//     that spans products is VALUE. Units of different products are never added (owner rule).
//
// Deliberately absent: the source drill-down (the breakdown route is a manager's per-area read and
// does not apply the closing's El Qema mask; a rep's bricks live in Sales vs Target), and any
// quarter or semester roll-up (payout periods belong to the incentive scheme, not to this screen).
//
// Everything except the loader at the bottom is PURE, so the rules above are unit-tested without a
// database (tests/rep-targets.test.ts).
// ─────────────────────────────────────────────────────────────────────────────

import type { AccessContext } from "@/lib/auth/permissions";
import { currentCairoDateParts } from "@/lib/i18n/format";
import { applyAchievementAreaMerges, getMergedAreaName } from "@/lib/sales/closing-area-merges";
import {
  lineName as lineNameOf,
  loadAllCanonicalAreaNames,
  loadProductNameMap,
  type AchievementRow,
} from "@/lib/sales/monthly-targets";
import {
  SALES_VS_TARGET_FLOOR,
  isRowPublished,
  loadPublishedPeriodKeys,
  loadVsTargetRange,
  shiftPeriod,
  totalRows,
} from "@/lib/sales/vs-target";
import { filterRowsForBound, resolveVsTargetBound } from "@/lib/sales/vs-target-scope";

/** How far AHEAD the tab looks for a loaded target. Targets arrive a quarter at a time. */
export const REP_TARGETS_FORWARD_MONTHS = 3;

/**
 * How far BACK it looks — the same trailing year Sales vs Target loads.
 *
 * Load-bearing, not cosmetic: the range loader expands at most 24 months from its start, so a
 * window anchored at the July 2026 floor would silently stop reaching the current month in 2028.
 */
export const REP_TARGETS_HISTORY_MONTHS = 12;

/**
 * Where a month stands. Decides what the screen may say about its sales.
 *
 *   published         the line's Monthly Closing is out — sales and achievement are real numbers
 *   in_progress       the current Cairo month; a closing is never released during its own month
 *   awaiting_closing  over, but not yet published — "not a zero", exactly as Sales vs Target says
 *   upcoming          not started; only offered when a target is already loaded for it
 */
export type RepTargetsMonthStatus = "published" | "in_progress" | "awaiting_closing" | "upcoming";

export type RepTargetsMonth = {
  period: string;
  status: RepTargetsMonthStatus;
  /** Target VALUE across every product — the only honest total across products. 0 when none. */
  targetValue: number;
  /** True when at least one product carries a target this month. */
  hasTarget: boolean;
  /** Published sales VALUE. null — never 0 — while the month is not published. */
  actualValue: number | null;
  /** null when the month is not published, or carries no target to divide by. */
  achievementValue: number | null;
};

export type RepTargetsProduct = {
  /** React key only. Never rendered. */
  key: string;
  /** A name, never a code (owner rule). */
  productName: string;
  /** This ONE product's units, summed across the rep's areas. null when no unit target exists. */
  targetUnits: number | null;
  targetValue: number | null;
  /** True when the product carries a target this month (units or value). */
  hasTarget: boolean;
  /** Share of the month's target VALUE this product carries. null when either side is missing. */
  targetShare: number | null;
  /** Published only — null (never 0) while the month is not published. */
  actualUnits: number | null;
  actualValue: number | null;
  /** Value achievement, from the same `totalRows` every other figure takes. */
  achievementValue: number | null;
  /** Sold minus target, in this product's units. Negative = short. Published and targeted only. */
  gapUnits: number | null;
  /** The same gap in value. */
  gapValue: number | null;
};

export type RepTargetsTotals = {
  targetValue: number;
  actualValue: number | null;
  achievementValue: number | null;
  /** Sales minus target, in value. null unless published and targeted. */
  gapValue: number | null;
  targetedProducts: number;
  /** Targeted products at or above 100%. null while the month is not published. */
  productsAtTarget: number | null;
  /**
   * Published sales with no target row behind them — `totalRows`' own `uncoveredActualValue`, the
   * figure Sales vs Target prints as "No target", so the two screens quote the same pounds. They are
   * INSIDE the achievement above: `totalRows` grades every pound of a targeted month, exactly as
   * the Monthly Closing does. 0 while the month is not published.
   */
  noTargetSalesValue: number;
};

export type RepTargetsData = {
  period: string;
  status: RepTargetsMonthStatus;
  /** Every month the tab offers, oldest first. */
  months: RepTargetsMonth[];
  lineNames: string[];
  areaNames: string[];
  totals: RepTargetsTotals;
  /** Targeted products first (largest target first), then untargeted products that sold. */
  products: RepTargetsProduct[];
  /** Days left in the in-progress month, today included. null for every other status. */
  daysLeft: number | null;
  /** True when nothing at all is attributed to this rep anywhere in the window. */
  isEmptyScope: boolean;
};

/** Code -> name resolvers. Every one must answer a name; a code is never shown (owner rule). */
export type RepTargetsNames = {
  productName: (productCode: string) => string;
  areaName: (lineCode: string | null, areaCode: string, period: string) => string;
  lineName: (lineCode: string) => string;
};

/** A target of either kind. Value is what achievement divides by; units alone still count as set. */
function carriesTarget(row: Pick<AchievementRow, "targetValue" | "targetUnits">): boolean {
  return (row.targetValue ?? 0) > 0 || (row.targetUnits ?? 0) > 0;
}

function productKeyOf(row: Pick<AchievementRow, "lineCode" | "productCode">): string {
  return `${row.lineCode ?? ""}|${row.productCode.trim().toUpperCase()}`;
}

function sumOrNull(values: Array<number | null>): number | null {
  let seen = false;
  let total = 0;
  for (const value of values) {
    if (value == null) continue;
    seen = true;
    total += value;
  }
  return seen ? total : null;
}

/** The window this tab loads: the trailing year (never before the floor) to three months ahead. */
export function repTargetsWindow(current: string): { from: string; to: string } {
  const start = shiftPeriod(current, -(REP_TARGETS_HISTORY_MONTHS - 1));
  const from = start && start > SALES_VS_TARGET_FLOOR ? start : SALES_VS_TARGET_FLOOR;
  const to = shiftPeriod(current, REP_TARGETS_FORWARD_MONTHS) ?? current;
  return { from, to: to < from ? from : to };
}

/** Days left in a YYYY-MM month when today is `day`, today included. */
export function daysLeftInMonth(period: string, day: number): number {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  // Day 0 of the next month is the last day of this one — pure calendar arithmetic, no clock.
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Math.max(0, lastDay - day + 1);
}

/**
 * Where a month stands for this rep.
 *
 * "Published" needs EVERY line the rep holds rows on that month to be published. A rep carries one
 * line in practice; if one ever carried two with only one closed, the month reads as awaiting its
 * closing rather than printing half a month's sales against a whole month's target.
 */
export function repMonthStatus(
  period: string,
  lineCodes: ReadonlySet<string>,
  publishedKeys: ReadonlySet<string>,
  current: string,
): RepTargetsMonthStatus {
  if (lineCodes.size > 0 && [...lineCodes].every((lineCode) => isRowPublished({ lineCode, period }, publishedKeys))) {
    return "published";
  }
  if (period === current) return "in_progress";
  return period < current ? "awaiting_closing" : "upcoming";
}

/**
 * The months the tab offers, oldest first.
 *
 *   * the current month, always — it is where a rep looks for "my target now";
 *   * any earlier month in which something is attributed to them (a target, or sales);
 *   * a LATER month only when it already carries a target — targets arrive a quarter at a time,
 *     so an empty future month is normal and is not offered as a blank page.
 */
export function repTargetsMonths(
  rows: readonly AchievementRow[],
  publishedKeys: ReadonlySet<string>,
  current: string,
): RepTargetsMonth[] {
  const byPeriod = new Map<string, AchievementRow[]>();
  const allLines = new Set<string>();
  for (const row of rows) {
    if (row.lineCode) allLines.add(row.lineCode);
    if (row.period > current && !carriesTarget(row)) continue;
    const bucket = byPeriod.get(row.period);
    if (bucket) bucket.push(row);
    else byPeriod.set(row.period, [row]);
  }
  if (!byPeriod.has(current)) byPeriod.set(current, []);

  return [...byPeriod.keys()]
    .sort()
    .map((period) => {
      const monthRows = byPeriod.get(period) ?? [];
      const monthLines = new Set(monthRows.map((row) => row.lineCode).filter((code): code is string => Boolean(code)));
      const status = repMonthStatus(period, monthLines.size > 0 ? monthLines : allLines, publishedKeys, current);
      const totals = status === "published" ? totalRows(monthRows) : null;
      return {
        period,
        status,
        targetValue: monthRows.reduce((sum, row) => sum + (row.targetValue ?? 0), 0),
        hasTarget: monthRows.some(carriesTarget),
        actualValue: totals ? totals.actualValue : null,
        achievementValue: totals ? totals.achievementValue : null,
      };
    });
}

/**
 * The month the tab opens on.
 *
 * A Targets tab answers "what am I aiming at now", so it opens on the current month when a target is
 * loaded for it — unlike Sales vs Target, which opens on the newest PUBLISHED month because results
 * are its subject. Without a current target it falls back to the newest earlier month that had one,
 * and only then to the bare current month (whose empty state says so).
 */
export function pickRepTargetsPeriod(
  months: readonly RepTargetsMonth[],
  current: string,
  requested: string | null,
): string {
  if (requested && months.some((month) => month.period === requested)) return requested;
  if (months.some((month) => month.period === current && month.hasTarget)) return current;
  let newestTargeted: string | null = null;
  for (const month of months) {
    if (month.period <= current && month.hasTarget) newestTargeted = month.period;
  }
  return newestTargeted ?? current;
}

/**
 * One line per product for one month.
 *
 * Grouped by product across the rep's areas: a rep holding two areas has ONE target for a product
 * in total, and those units may be added because they are the same product. Nothing here adds
 * units of two different products.
 *
 * While the month is not published a product appears only if it carries a target — sales are not
 * shown yet, and listing an untargeted product would announce unpublished sales by its presence.
 */
export function repTargetsProducts(
  monthRows: readonly AchievementRow[],
  published: boolean,
  productName: (productCode: string) => string,
): RepTargetsProduct[] {
  const groups = new Map<string, AchievementRow[]>();
  for (const row of monthRows) {
    if (!row.productCode.trim()) continue;
    const key = productKeyOf(row);
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  const monthTargetValue = monthRows.reduce((sum, row) => sum + (row.targetValue ?? 0), 0);

  const products: RepTargetsProduct[] = [];
  for (const [key, group] of groups) {
    const hasTarget = group.some(carriesTarget);
    const totals = published ? totalRows(group) : null;
    if (!hasTarget && (!totals || totals.actualValue === 0)) continue;

    const targetUnits = sumOrNull(group.map((row) => row.targetUnits));
    const targetValue = sumOrNull(group.map((row) => row.targetValue));
    products.push({
      key,
      productName: productName(group[0]!.productCode.trim().toUpperCase()),
      targetUnits,
      targetValue,
      hasTarget,
      targetShare: monthTargetValue > 0 && targetValue != null ? targetValue / monthTargetValue : null,
      actualUnits: totals ? totals.actualUnits : null,
      actualValue: totals ? totals.actualValue : null,
      achievementValue: totals ? totals.achievementValue : null,
      gapUnits: totals && targetUnits != null && targetUnits > 0 ? totals.actualUnits - targetUnits : null,
      gapValue: totals && targetValue != null && targetValue > 0 ? totals.actualValue - targetValue : null,
    });
  }

  return products.sort((left, right) => {
    if (left.hasTarget !== right.hasTarget) return left.hasTarget ? -1 : 1;
    const byTarget = (right.targetValue ?? 0) - (left.targetValue ?? 0);
    if (left.hasTarget && byTarget !== 0) return byTarget;
    const bySales = (right.actualValue ?? 0) - (left.actualValue ?? 0);
    return bySales !== 0 ? bySales : left.productName.localeCompare(right.productName);
  });
}

/**
 * The whole payload, from rows ALREADY merged and bounded to this rep. Pure.
 *
 * `today` is the Cairo day of the month, used only for the in-progress month's days-left figure.
 */
export function buildRepTargets(input: {
  rows: readonly AchievementRow[];
  publishedKeys: ReadonlySet<string>;
  current: string;
  today: number;
  requestedPeriod: string | null;
  names: RepTargetsNames;
}): RepTargetsData {
  const { rows, publishedKeys, current, today, requestedPeriod, names } = input;

  const months = repTargetsMonths(rows, publishedKeys, current);
  const period = pickRepTargetsPeriod(months, current, requestedPeriod);
  const month = months.find((entry) => entry.period === period);
  const status = month?.status ?? repMonthStatus(period, new Set(), publishedKeys, current);
  const published = status === "published";

  // Forward months only ever count their targeted rows — the same rule the month list applies.
  const monthRows = rows.filter((row) => row.period === period && (period <= current || carriesTarget(row)));
  const products = repTargetsProducts(monthRows, published, names.productName);
  const totals = published ? totalRows(monthRows) : null;
  const targetValue = monthRows.reduce((sum, row) => sum + (row.targetValue ?? 0), 0);

  // The subtitle names where these numbers come from. A month with no rows of its own borrows the
  // newest month up to today that has some (a later one only when nothing earlier exists), so an
  // untargeted current month still says whose tab this is.
  let contextRows = monthRows;
  if (contextRows.length === 0) {
    const pastRows = rows.filter((row) => row.period <= current);
    const pool = pastRows.length > 0 ? pastRows : rows;
    const pick = pool.reduce<string | null>(
      (chosen, row) =>
        chosen == null || (pastRows.length > 0 ? row.period > chosen : row.period < chosen) ? row.period : chosen,
      null,
    );
    contextRows = pick ? pool.filter((row) => row.period === pick) : [];
  }
  const lineNames = [
    ...new Set(contextRows.map((row) => row.lineCode).filter((code): code is string => Boolean(code)).map(names.lineName)),
  ].sort();
  const areaNames = [
    ...new Set(
      contextRows
        .filter((row) => row.areaCode)
        .map((row) => names.areaName(row.lineCode, row.areaCode!, row.period)),
    ),
  ].sort();

  return {
    period,
    status,
    months,
    lineNames,
    areaNames,
    totals: {
      targetValue,
      actualValue: totals ? totals.actualValue : null,
      achievementValue: totals ? totals.achievementValue : null,
      gapValue: totals && targetValue > 0 ? totals.actualValue - targetValue : null,
      targetedProducts: products.filter((product) => product.hasTarget).length,
      productsAtTarget: published
        ? products.filter((product) => product.hasTarget && product.achievementValue != null && product.achievementValue >= 1).length
        : null,
      noTargetSalesValue: totals ? totals.uncoveredActualValue : 0,
    },
    products,
    daysLeft: status === "in_progress" ? daysLeftInMonth(period, today) : null,
    isEmptyScope: rows.length === 0,
  };
}

/**
 * Load one Medical Rep's Targets tab.
 *
 * Deliberately NOT catching loadPublishedPeriodKeys: a failed publication read must surface as an
 * error, never as an empty set that would tell the rep a published month is still awaiting its
 * closing.
 */
export async function loadRepTargets(ctx: AccessContext, requestedPeriod: string | null): Promise<RepTargetsData> {
  // ONE Cairo clock read for both the month and the day, so the two can never straddle midnight on
  // the last day of a month. Floored like Sales vs Target's own current month.
  const { year, month, day } = currentCairoDateParts();
  const clockPeriod = `${year}-${String(month).padStart(2, "0")}`;
  const current = clockPeriod < SALES_VS_TARGET_FLOOR ? SALES_VS_TARGET_FLOOR : clockPeriod;
  const bound = await resolveVsTargetBound(ctx);

  const empty = (): RepTargetsData =>
    buildRepTargets({
      rows: [],
      publishedKeys: new Set(),
      current,
      today: day,
      requestedPeriod,
      names: { productName: () => "Unnamed product", areaName: () => "Unnamed area", lineName: lineNameOf },
    });

  // SELF only. Any wider bound on this view would be a rep reading other reps' numbers.
  if (bound.kind !== "self") return empty();

  const { from, to } = repTargetsWindow(current);
  const [rangeRows, publishedKeys, areaNames, productNames] = await Promise.all([
    loadVsTargetRange(from, to),
    loadPublishedPeriodKeys(from, to),
    loadAllCanonicalAreaNames(),
    loadProductNameMap(),
  ]);

  // Merge BEFORE scoping, exactly as Sales vs Target does, so a folded area keeps its rep's rows.
  const rows = filterRowsForBound(applyAchievementAreaMerges(rangeRows), bound);

  return buildRepTargets({
    rows,
    publishedKeys,
    current,
    today: day,
    requestedPeriod,
    names: {
      productName: (code) => productNames.get(code) ?? "Unnamed product",
      areaName: (lineCode, areaCode, period) =>
        getMergedAreaName(lineCode, areaCode, period) ?? areaNames.get(areaCode) ?? "Unnamed area",
      lineName: (code) => lineNameOf(code) || "Unnamed line",
    },
  });
}
