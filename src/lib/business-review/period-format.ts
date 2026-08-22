// Business Review — period formatting. A LEAF module: it imports nothing.
//
// That is the whole point of it existing separately from period.ts. Both client components render
// month column headers, and period.ts reaches into the sales domain for the data floor and the
// period enumerator. Importing it from a "use client" file would drag server-side sales code into
// the browser bundle. Everything here is pure string arithmetic, safe on either side.
//
// Month names are formatted from the period STRING, never from a Date. `new Date("2026-01")`
// parses as UTC midnight and renders as December 2025 for anyone behind UTC — exactly the
// off-by-one-month class of bug the Africa/Cairo reporting rule exists to prevent.

export const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

export function isReviewPeriod(value: unknown): value is string {
  return typeof value === "string" && PERIOD_PATTERN.test(value);
}

/** "2026-01" -> "Jan 2026". */
export function periodLabel(period: string): string {
  if (!isReviewPeriod(period)) return period;
  return `${MONTH_NAMES[Number(period.slice(5, 7)) - 1]} ${period.slice(0, 4)}`;
}

/** "2026-01" -> "Jan". Column headers only, where the window already states the year. */
export function periodShortLabel(period: string): string {
  if (!isReviewPeriod(period)) return period;
  return MONTH_NAMES[Number(period.slice(5, 7)) - 1];
}

/** True when every period in the window falls in the same calendar year — the case where a
 *  bare "Jan" column header is unambiguous. */
export function isSingleYear(periods: readonly string[]): boolean {
  if (periods.length === 0) return true;
  const year = periods[0].slice(0, 4);
  return periods.every((p) => p.slice(0, 4) === year);
}

/** Column header for a period, given the window it sits in. A window spanning a year boundary
 *  gets "Dec 2025" / "Jan 2026" rather than two indistinguishable bare month names. */
export function periodColumnLabel(period: string, periods: readonly string[]): string {
  return isSingleYear(periods) ? periodShortLabel(period) : periodLabel(period);
}

/** Header labels for a whole window, positionally aligned with `periods`. */
export function periodColumnLabels(periods: readonly string[]): string[] {
  return periods.map((period) => periodColumnLabel(period, periods));
}

export function windowLabel(from: string, to: string): string {
  if (from === to) return periodLabel(from);
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  return sameYear
    ? `${periodShortLabel(from)} – ${periodLabel(to)}`
    : `${periodLabel(from)} – ${periodLabel(to)}`;
}

/** Calendar quarters the window touches, in order. A quarter the window only partly covers is
 *  still reported, with `complete: false`, so a Q2 column built from two of its three months can
 *  never be read as a full quarter. */
export function quartersInWindow(periods: readonly string[]): {
  key: string;
  label: string;
  periods: string[];
  complete: boolean;
}[] {
  const byQuarter = new Map<string, string[]>();
  for (const period of periods) {
    const quarter = Math.floor((Number(period.slice(5, 7)) - 1) / 3) + 1;
    const key = `${period.slice(0, 4)}-Q${quarter}`;
    const bucket = byQuarter.get(key);
    if (bucket) bucket.push(period);
    else byQuarter.set(key, [period]);
  }
  return [...byQuarter]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, quarterPeriods]) => ({
      key,
      label: `${key.slice(5)} ${key.slice(0, 4)}`,
      periods: quarterPeriods,
      complete: quarterPeriods.length === 3,
    }));
}
