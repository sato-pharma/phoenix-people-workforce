/**
 * How long an outstation trip lasted, read from its own start and end dates.
 *
 * Expense Approvals used to show a three-day trip exactly like a same-day one — a start date, an end
 * date and nothing that said "three days" — so the reviewer had to work the span out in his head
 * before he could judge the allowance or read the day-by-day field work (owner, 2026-11-06: "so
 * confusing … specially when the trip is more than 1 day"). This is the one answer every part of
 * that screen reads.
 *
 * Dates are calendar days (`YYYY-MM-DD`, the first ten characters of whatever the row stores), so
 * the count never moves with a clock or a time zone. A missing or unreadable end date, or an end
 * before the start, reads as a same-day trip rather than inventing a span.
 */

export type TripSpan = {
  /** Calendar days from the start date to the end date, both counted. Always at least 1. */
  days: number;
  /** The trip's calendar days in order, `YYYY-MM-DD`. Empty when the start date is unreadable. */
  dayKeys: string[];
  /** `days - 1`. */
  nights: number;
  multiDay: boolean;
};

const DAY_MS = 24 * 60 * 60 * 1000;
/** A row that claims a longer trip than this is a typing error, not a trip to list day by day. */
const MAX_LISTED_DAYS = 31;

function dayKeyToUtc(value: string | null | undefined): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? "").trim());
  if (!match) return null;
  const utc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(utc) ? utc : null;
}

function utcToDayKey(utc: number): string {
  return new Date(utc).toISOString().slice(0, 10);
}

export function tripSpan(startDate: string | null | undefined, endDate: string | null | undefined): TripSpan {
  const start = dayKeyToUtc(startDate);
  if (start === null) return { dayKeys: [], days: 1, multiDay: false, nights: 0 };
  const end = dayKeyToUtc(endDate);
  const days = end === null || end < start ? 1 : Math.round((end - start) / DAY_MS) + 1;
  const listed = Math.min(days, MAX_LISTED_DAYS);
  const dayKeys = Array.from({ length: listed }, (_, index) => utcToDayKey(start + index * DAY_MS));
  return { dayKeys, days, multiDay: days > 1, nights: days - 1 };
}

/** "Same-day trip" · "2 days · 1 night" · "3 days · 2 nights". */
export function tripSpanLabel(span: TripSpan): string {
  if (!span.multiDay) return "Same-day trip";
  return `${span.days} days · ${span.nights} ${span.nights === 1 ? "night" : "nights"}`;
}
