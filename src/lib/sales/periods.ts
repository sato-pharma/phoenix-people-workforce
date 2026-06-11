// Shared YYYY-MM period math for the sales modules (Sales Command + Sales Intelligence).

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
