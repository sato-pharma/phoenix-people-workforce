// The weeks of the weekly attendance review.
//
// OWNER DECISION 2026-09-17 — replaces the day-24 payroll cycle this module tiled until then.
//
//   "1–30 September. Keep payroll as it is. From October the weekly review's weeks start on the 1st
//    to match."
//
// Month-end payroll collects fingerprint deductions by CALENDAR month, and the review's answers reach
// those deductions by the calendar month of the day (digest-bridge.ts). A review month that ran 24th to
// 23rd put the last week of every month into the next month's review, so the two never agreed about
// which month a day belongs to. From October 2026 a review month is the calendar month, cut into
// 1–7, 8–14, 15–21 and 22 to the month end. The key stays `YYYY-MM` (the `cycle_key` column).
//
// SEPTEMBER 2026 is the one month in between. Week 3 (7–13 Sep) had already been built on the old
// cycle, so its dates stay exactly as they are; week 4 keeps the old cycle's 14–23 Sep; and a fifth week,
// 24–30 Sep, closes the month so no day is lost before October. The old cycle's week 1 (24–30 Aug) and
// the 31 August day of its week 2 are August's: those days are already in August's month-end
// deductions, so September's review starts on 1 September. Nothing before September 2026 is reviewed.
//
// "Show live, release any time" (owner, 2026-09-17). A week is listed from its first day, while it is
// still running, and holds the days up to YESTERDAY: today has not finished being worked, and its
// punches have not arrived. So the review month is the month of yesterday — on 1 October, September.
//
// Pure calendar arithmetic — no timezone, no clock, no database — so it is deterministic and testable.

import { addDays } from "@/lib/payroll/copilot/cycle-window.ts";

export type SettlementWeek = {
  /** 1..5. Calendar months use 1..4; September 2026 uses 2..5. */
  index: number;
  startIso: string;
  endIso: string;
};

/** A week as the review sees it on a given day. */
export type ReviewWeekWindow = SettlementWeek & {
  /** The review month, `YYYY-MM`. Stored as `cycle_key`. */
  monthKey: string;
  /** The week has not ended yet: its later days are still to come. */
  running: boolean;
  /** The last day the review holds for this week: the week end, or yesterday while it runs. */
  throughIso: string;
};

/** The first month the review covers. */
export const FIRST_REVIEW_MONTH = "2026-09";

/** September 2026, the month between the old day-24 cycle and calendar months. */
export const SEPTEMBER_2026_WEEKS: readonly SettlementWeek[] = Object.freeze([
  { index: 2, startIso: "2026-09-01", endIso: "2026-09-06" },
  { index: 3, startIso: "2026-09-07", endIso: "2026-09-13" },
  { index: 4, startIso: "2026-09-14", endIso: "2026-09-23" },
  { index: 5, startIso: "2026-09-24", endIso: "2026-09-30" },
]);

function parseMonthKey(monthKey: string): { year: number; month: number } {
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!match) throw new Error(`Validation: monthKey must be YYYY-MM, received "${monthKey}".`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new Error(`Validation: month out of range in "${monthKey}".`);
  return { year, month };
}

/**
 * The weeks of one review month. A month before September 2026 has none. September 2026 is the
 * transition table above; every later month is 1–7, 8–14, 15–21 and 22 to its last day.
 */
export function tileReviewMonth(monthKey: string): SettlementWeek[] {
  const { year, month } = parseMonthKey(monthKey);
  if (monthKey < FIRST_REVIEW_MONTH) return [];
  if (monthKey === FIRST_REVIEW_MONTH) return SEPTEMBER_2026_WEEKS.map((week) => ({ ...week }));
  const prefix = `${year}-${String(month).padStart(2, "0")}`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return [
    { index: 1, startIso: `${prefix}-01`, endIso: `${prefix}-07` },
    { index: 2, startIso: `${prefix}-08`, endIso: `${prefix}-14` },
    { index: 3, startIso: `${prefix}-15`, endIso: `${prefix}-21` },
    { index: 4, startIso: `${prefix}-22`, endIso: `${prefix}-${String(lastDay).padStart(2, "0")}` },
  ];
}

/** One week of a review month, or null when the month has no such week. */
export function reviewWeekOf(monthKey: string, weekIndex: number): SettlementWeek | null {
  return tileReviewMonth(monthKey).find((week) => week.index === weekIndex) ?? null;
}

/**
 * The month key before `monthKey` ("2026-01" -> "2025-12").
 *
 * The January boundary is the whole reason it exists: `month - 1` in January is 0, and a key built
 * from that without rolling the year reads "2026-00" — a month the deductions collector has never
 * heard of. Every answer given about December would then be silently stranded, on the one day of the
 * year nobody is watching for it.
 */
export function previousMonthKey(monthKey: string): string {
  const { year, month } = parseMonthKey(monthKey);
  const previous = month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
  return `${previous.year}-${String(previous.month).padStart(2, "0")}`;
}

/** The review month on `todayIso`: the month of yesterday, the last day with a full day of punches. */
export function currentReviewMonth(todayIso: string): string {
  return addDays(todayIso, -1).slice(0, 7);
}

/** A week as it stands on `todayIso`, or null when it has not started by yesterday. */
export function reviewWeekWindow(monthKey: string, week: SettlementWeek, todayIso: string): ReviewWeekWindow | null {
  const yesterday = addDays(todayIso, -1);
  if (week.startIso > yesterday) return null;
  return {
    ...week,
    monthKey,
    running: week.endIso >= todayIso,
    throughIso: week.endIso < yesterday ? week.endIso : yesterday,
  };
}

/** Every week of a review month that has started by yesterday, in order. */
export function startedReviewWeeks(monthKey: string, todayIso: string): ReviewWeekWindow[] {
  return tileReviewMonth(monthKey)
    .map((week) => reviewWeekWindow(monthKey, week, todayIso))
    .filter((window): window is ReviewWeekWindow => window !== null);
}

/**
 * A week the Super Admin may refresh from the review page: a started week of the current review month
 * or of the month before it. Older weeks are closed; their days are in month-end payroll by then.
 */
export function refreshableReviewWeek(monthKey: string, weekIndex: number, todayIso: string): ReviewWeekWindow | null {
  const current = currentReviewMonth(todayIso);
  if (monthKey !== current && monthKey !== previousMonthKey(current)) return null;
  const week = reviewWeekOf(monthKey, weekIndex);
  return week ? reviewWeekWindow(monthKey, week, todayIso) : null;
}

/**
 * The weeks the daily job brings up to date on `todayIso`: every started week of the current review
 * month, and — for the first three days of a month — the previous month's last week too, so a late
 * punch, excuse or leave for the month's last days still reaches the review.
 */
export function reviewWeeksToSync(todayIso: string): ReviewWeekWindow[] {
  const current = currentReviewMonth(todayIso);
  const weeks = startedReviewWeeks(current, todayIso);
  if (Number(addDays(todayIso, -1).slice(8, 10)) <= 3) {
    const previous = previousMonthKey(current);
    const last = startedReviewWeeks(previous, todayIso).at(-1);
    if (last) weeks.unshift(last);
  }
  return weeks;
}
