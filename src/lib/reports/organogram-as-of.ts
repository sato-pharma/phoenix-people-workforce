/**
 * "View the organogram as of a month" — the pure rules, shared by the API route, the report
 * builder and both screens that draw the chart.
 *
 * The chart's default is TODAY: the live seat tree. A viewer may instead pick a month that has
 * already ended and see the structure as it stood on that month's LAST DAY — who sat in which
 * seat, who they reported to, and which seats existed. The answer comes from the seat model's own
 * dated history (`public.au_f_org_tree_as_of`); nothing here guesses or interpolates.
 *
 * Three decisions live in this file so they cannot drift between the places that need them:
 *  - the earliest month offered is the month the seat model begins (its first seat starts
 *    2026-07-13). Earlier months have no seats at all, so offering them would draw an empty chart
 *    that reads as "the company had nobody" instead of "no record";
 *  - the CURRENT month is never an as-of choice. It has not ended, so its "last day" is in the
 *    future — "today" is the live chart, and is offered as such;
 *  - a month is validated against Cairo's clock, never the server's UTC one.
 */

import { todayInCairo } from "@/lib/date-only";

/** The month the seat model begins. The earliest seat starts 2026-07-13. */
export const ORGANOGRAM_HISTORY_START_MONTH = "2026-07";

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** `YYYY-MM` of the current month in Africa/Cairo. */
export function currentCairoMonth(now: Date = new Date()): string {
  return todayInCairo(now).slice(0, 7);
}

/**
 * Is this a month the chart can be asked to show: well-formed, no earlier than the seat model's
 * first month, and strictly before the current Cairo month (a month that has ended).
 */
export function isValidOrganogramAsOfMonth(
  value: string | null | undefined,
  currentMonth: string = currentCairoMonth(),
): boolean {
  const month = String(value ?? "").trim();
  if (!MONTH_PATTERN.test(month)) return false;
  return month >= ORGANOGRAM_HISTORY_START_MONTH && month < currentMonth;
}

/** The last calendar day of `YYYY-MM`, as `YYYY-MM-DD`. The date the seat history is read at. */
export function organogramAsOfMonthEnd(month: string): string {
  const match = MONTH_PATTERN.exec(month);
  if (!match) throw new Error(`organogram as-of month is not YYYY-MM: ${month}`);
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  // Day 0 of the NEXT month is the last day of this one.
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return `${match[1]}-${match[2]}-${String(lastDay).padStart(2, "0")}`;
}

/** Months the picker offers, newest first: from the month before this one back to the start. */
export function listOrganogramAsOfMonths(currentMonth: string = currentCairoMonth()): string[] {
  const match = MONTH_PATTERN.exec(currentMonth);
  if (!match) return [];
  let year = Number(match[1]);
  let monthNumber = Number(match[2]) - 1;
  const months: string[] = [];
  for (;;) {
    if (monthNumber === 0) {
      year -= 1;
      monthNumber = 12;
    }
    const month = `${year}-${String(monthNumber).padStart(2, "0")}`;
    if (month < ORGANOGRAM_HISTORY_START_MONTH) break;
    months.push(month);
    monthNumber -= 1;
  }
  return months;
}

/** `2026-09` -> `September 2026`. A malformed value is returned as given, never thrown on. */
export function formatOrganogramAsOfMonth(month: string): string {
  const match = MONTH_PATTERN.exec(month);
  if (!match) return month;
  return `${MONTH_NAMES[Number(match[2]) - 1]} ${match[1]}`;
}

/** `2026-09` -> `30 September 2026`: the day the chart is drawn at, spelled out for the banner. */
export function formatOrganogramAsOfDay(month: string): string {
  if (!MONTH_PATTERN.test(month)) return month;
  const day = Number(organogramAsOfMonthEnd(month).slice(8));
  return `${day} ${formatOrganogramAsOfMonth(month)}`;
}

export type OrganogramAsOfParam =
  | { ok: true; month: string | null }
  | { ok: false; message: string };

/**
 * Read the `asOf` query parameter. Absent or blank is the live chart. A value that is present but
 * not a choosable month is REFUSED, not quietly turned into "today" — a link that asked for
 * September must never answer with a chart of a different date.
 */
export function parseOrganogramAsOfParam(
  raw: string | null | undefined,
  currentMonth: string = currentCairoMonth(),
): OrganogramAsOfParam {
  const value = String(raw ?? "").trim();
  if (!value) return { ok: true, month: null };
  if (isValidOrganogramAsOfMonth(value, currentMonth)) return { ok: true, month: value };
  return {
    ok: false,
    message: `The organogram can be shown as of a finished month from ${formatOrganogramAsOfMonth(
      ORGANOGRAM_HISTORY_START_MONTH,
    )} on; "${value.slice(0, 20)}" is not one.`,
  };
}
