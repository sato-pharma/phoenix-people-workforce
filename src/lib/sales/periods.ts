// Shared YYYY-MM period math for the sales modules (Sales Command + Sales Intelligence).

import { todayInCairo } from "@/lib/date-only";

/**
 * THE FUTURE-MONTH RULE. A month after today (Cairo) is never "the current month" and never a
 * comparison base. A Direct order's `collection_date` legitimately books an approved order into a
 * later month (an order approved on 26 Oct collecting on 1 Nov lands in 2026-11), so the newest
 * uploaded month can be one that has not started — and every reader that took "the newest" as
 * "now" then defaulted to a near-empty month, compared against it, or counted it as missing.
 *
 * Accepts "YYYY-MM" (closings) and "YYYY-MM-01" (weekly cycle months); the day part is ignored.
 * A value that is not a period is never "future".
 */
export function isFuturePeriod(period: string | null | undefined, today: string = todayInCairo()): boolean {
  const match = /^(\d{4}-\d{2})(?:-\d{2})?$/.exec(period ?? "");
  if (!match) return false;
  return match[1] > today.slice(0, 7);
}

/** The newest period that is not after today (Cairo); null when every period is in the future. */
export function latestNonFuturePeriod<T extends string>(
  periods: readonly T[],
  today: string = todayInCairo(),
): T | null {
  let latest: T | null = null;
  for (const period of periods) {
    if (isFuturePeriod(period, today)) continue;
    if (latest === null || period > latest) latest = period;
  }
  return latest;
}

/**
 * A `?months=` deep link names a month the way the closing does ("2026-10"); the weekly tables key it as
 * the first of the month ("2026-10-01"). Both spellings reach the same month, anything else passes through.
 */
export function toWeeklyCycleMonth(value: string): string {
  const trimmed = value.trim();
  return /^\d{4}-\d{2}$/.test(trimmed) ? `${trimmed}-01` : trimmed;
}

/**
 * Shift a YYYY-MM period back N months for month-over-month (N=1) and year-over-year (N=12)
 * comparisons. Returns null for anything that is not a clean YYYY-MM string.
 */
export function shiftPeriod(period: string, monthsBack: number): string | null {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) return null;
  let year = Number(match[1]);
  let month = Number(match[2]) - monthsBack;
  while (month <= 0) {
    month += 12;
    year -= 1;
  }
  while (month > 12) {
    month -= 12;
    year += 1;
  }
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** Number of civil days in a YYYY-MM period (28–31); 0 for malformed input. */
export function daysInPeriod(period: string): number {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) return 0;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return 0;
  // Day 0 of the NEXT month = last day of this month.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** ISO date for a day inside a period: ("2026-04", 5) → "2026-04-05". */
export function periodDayIso(period: string, day: number): string {
  return `${period}-${String(day).padStart(2, "0")}`;
}

/** What the Channels by Rep tab sends to ask for every month. Here so the tab and its server agree. */
export const CHANNELS_BY_REP_WHOLE_HISTORY = "all";

/** Human label: "2026-04" → "April 2026" (distinct from format.ts periodLabel(year, month)). */
export function periodProseLabel(period: string | null): string {
  if (!period) return "All time";
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) return period;
  const names = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const month = Number(match[2]);
  if (month < 1 || month > 12) return period;
  return `${names[month - 1]} ${match[1]}`;
}
