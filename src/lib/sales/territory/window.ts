// The Sales Drilldown's trailing window — which months its figures cover, and on what basis.
//
// Pure: no IO. The page and the per-area route both read it, so the label above the tree and the
// figures inside it can never name different months.

import { todayInCairo } from "@/lib/date-only";
import { isFuturePeriod, shiftPeriod } from "@/lib/sales/periods";

export const TERRITORY_DEFAULT_WINDOW_MONTHS = 6;
export const TERRITORY_MAX_WINDOW_MONTHS = 12;

export type TerritoryWindow = {
  /** Every month in the window, oldest first — a pharmacy's monthly presence is computed for each,
   *  including the months it bought nothing in. */
  periods: string[];
  /** "published": the window ends at the newest published Monthly Closing for this line, so it never
   *  reaches into a month that is still open. "live": nothing is published for the line yet, so the
   *  window ends at the current Cairo month and the page must say the figures are live. */
  basis: "published" | "live";
  /** The newest published closing for the line that is not in the future (null when basis is "live"). */
  latestPublishedPeriod: string | null;
  /** The months inside the window that carry a published closing — the only months the region and
   *  area totals (read from the closing engine) are summed over. Oldest first. */
  publishedPeriods: string[];
};

/**
 * THE FUTURE-MONTH RULE, applied to the drilldown: the window ends at the newest PUBLISHED closing
 * that is not after today (Cairo) — never at the open month, and never at a month a forward-dated
 * Direct order has created. The old window ended at the current UTC month, so on 26 Oct 2026 it
 * mixed six months of closed figures with an October that was barely uploaded.
 *
 * `publishedNewestFirst` is `listPublishedPeriodsForLine`'s answer for the drilled line.
 */
export function territoryWindow(
  publishedNewestFirst: readonly string[],
  months: number = TERRITORY_DEFAULT_WINDOW_MONTHS,
  today: string = todayInCairo(),
): TerritoryWindow {
  const size = Number.isInteger(months) && months > 0 && months <= TERRITORY_MAX_WINDOW_MONTHS
    ? months
    : TERRITORY_DEFAULT_WINDOW_MONTHS;
  const published = publishedNewestFirst
    .map((period) => period.trim())
    .filter((period) => /^\d{4}-\d{2}$/.test(period) && !isFuturePeriod(period, today));
  const latestPublishedPeriod = published.reduce<string | null>(
    (latest, period) => (latest === null || period > latest ? period : latest),
    null,
  );
  const end = latestPublishedPeriod ?? today.slice(0, 7);

  const periods: string[] = [];
  for (let monthsBack = size - 1; monthsBack >= 0; monthsBack--) {
    const period = shiftPeriod(end, monthsBack);
    if (period) periods.push(period);
  }
  const publishedSet = new Set(published);

  return {
    periods,
    basis: latestPublishedPeriod ? "published" : "live",
    latestPublishedPeriod,
    publishedPeriods: periods.filter((period) => publishedSet.has(period)),
  };
}

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-09" → "Sep 2026"; anything else passes through. */
export function shortPeriodLabel(period: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) return period;
  const name = SHORT_MONTHS[Number(match[2]) - 1];
  return name ? `${name} ${match[1]}` : period;
}

/** ["2026-04", …, "2026-09"] → "Apr – Sep 2026" (or "Nov 2025 – Apr 2026" across a year); "" for none. */
export function periodSpanLabel(periods: readonly string[]): string {
  if (periods.length === 0) return "";
  const first = periods[0];
  const last = periods[periods.length - 1];
  if (first === last) return shortPeriodLabel(first);
  if (first.slice(0, 4) === last.slice(0, 4)) {
    return `${shortPeriodLabel(first).slice(0, 3)} – ${shortPeriodLabel(last)}`;
  }
  return `${shortPeriodLabel(first)} – ${shortPeriodLabel(last)}`;
}

/**
 * The sentence above the tree that says what the figures are and which months they cover. Every
 * figure on the page is a window total, so a page that names no period invites reading a six-month
 * sum as one month's sales.
 */
export function territoryWindowNote(drillWindow: TerritoryWindow): string {
  const span = periodSpanLabel(drillWindow.periods);
  if (drillWindow.basis === "live" || !drillWindow.latestPublishedPeriod) {
    return `Live figures, ${span}: no Monthly Closing is published for this line yet, so these are the uploaded sheets as they stand, including the month still open.`;
  }
  const closingSpan = periodSpanLabel(drillWindow.publishedPeriods);
  return `Pharmacy sales from the uploaded sheets, ${span}, up to the latest published Monthly Closing (${shortPeriodLabel(drillWindow.latestPublishedPeriod)}). Region and area totals are the published Monthly Closing, ${closingSpan}, with each area's sales on that area as drawn today; a region's total includes its areas without a target. Pharmacy sums can differ slightly from it.`;
}
