/**
 * The Team Calendar's month, cut into weeks.
 *
 * WHY THIS EXISTS. The Team Calendar drew one column per day of the month with a `minmax(2.5rem,
 * 1fr)` floor — a **1,240px hard minimum** for a 31-day month, inside an `overflow-x-auto`. No
 * `min-w-` search ever finds that floor, because it is written as a grid template. On a 375px phone
 * a manager could see roughly three days at a time and had to drag sideways through the other
 * twenty-eight, once per person, for every person on his team.
 *
 * The owner's ruling (2026-09-29, asked directly): **one week at a time on the phone.**
 *
 * Weeks are cut on SATURDAY, because that is where Egypt's working week starts — Saturday to
 * Thursday, with Friday off. Cutting every seven days from the 1st instead would have been simpler
 * and wrong: it would scatter the Friday rest day across a different column each week, and "this
 * week" would stop being the unit a district manager actually thinks in. The first and last week of
 * a month are therefore usually PARTIAL, which is the honest shape of a calendar month and not a
 * defect to pad away.
 *
 * DATE-ONLY throughout. Every date here is a calendar day (a `date` column), so `new Date` is fed
 * an explicit UTC midnight and read back with `timeZone: "UTC"`. That is what stops a calendar day
 * being shifted into its neighbour by a zone offset, and it is CORRECT here — these are not
 * instants. Do not "fix" this file to Africa/Cairo.
 */

export type TeamCalendarWeek = {
  /** Inclusive first day, `YYYY-MM-DD`. */
  startDateIso: string;
  /** Inclusive last day, `YYYY-MM-DD`. */
  endDateIso: string;
  /** Human label, e.g. "Sat 4 – Fri 10" or "Thu 1 – Fri 2" for a partial opening week. */
  label: string;
  /** How many days this week actually holds inside the month (1–7). */
  dayCount: number;
  /**
   * Which of the seven columns this week's FIRST day belongs in, 1 on Saturday through 7 on Friday.
   *
   * A month almost never opens on a Saturday, so the opening week is short at its LEFT edge — and
   * the days have to be pushed right into their real weekday columns, or the 1st of the month lands
   * under "Sat" whatever day it actually was. That misreads the whole week: a manager checking who
   * worked Sunday would be looking at the wrong column. The closing week runs out at its RIGHT edge
   * instead, which needs no offset.
   */
  startColumn: number;
};

const WEEKDAY = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" });

function utcDay(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

function toDateOnlyIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Days in the month, from the calendar rather than a lookup table (leap years included). */
export function daysInMonth(year: number, month: number): number {
  return utcDay(year, month + 1, 0).getUTCDate();
}

/**
 * How far a date sits into Egypt's week, 0 on Saturday through 6 on Friday.
 * `getUTCDay()` is Sunday-based (Sun 0 … Sat 6), so Saturday has to be rotated to the front.
 */
function daysSinceWeekStart(date: Date): number {
  return (date.getUTCDay() + 1) % 7;
}

/**
 * Cut one month into Saturday-aligned weeks. Built from the year and month ALONE, never from an
 * employee's timeline: two people in the same month can legitimately carry timelines of different
 * lengths (a mid-month joiner, a pre-hire run-in), and weeks derived from one person's array would
 * then be wrong for the next. Each row slices its own cells by DATE against these ranges.
 */
export function buildTeamCalendarWeeks(year: number, month: number): TeamCalendarWeek[] {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return [];

  const lastDay = daysInMonth(year, month);
  const weeks: TeamCalendarWeek[] = [];
  let day = 1;

  while (day <= lastDay) {
    const start = utcDay(year, month, day);
    // The opening week is short by however far the 1st already sits into its week.
    const offset = daysSinceWeekStart(start);
    const endDay = Math.min(day + (7 - offset) - 1, lastDay);
    const end = utcDay(year, month, endDay);
    weeks.push({
      dayCount: endDay - day + 1,
      endDateIso: toDateOnlyIso(end),
      label:
        day === endDay
          ? `${WEEKDAY.format(start)} ${day}`
          : `${WEEKDAY.format(start)} ${day} – ${WEEKDAY.format(end)} ${endDay}`,
      startColumn: offset + 1,
      startDateIso: toDateOnlyIso(start),
    });
    day = endDay + 1;
  }

  return weeks;
}

/** The week holding a given day, or 0 when the date is outside the month. */
export function weekIndexForDate(weeks: TeamCalendarWeek[], dateIso: string): number {
  const found = weeks.findIndex((week) => dateIso >= week.startDateIso && dateIso <= week.endDateIso);
  return found === -1 ? 0 : found;
}

/** Keep a stored week index inside the month, so a month with fewer weeks cannot render empty. */
export function clampWeekIndex(weeks: TeamCalendarWeek[], index: number): number {
  if (weeks.length === 0) return 0;
  if (!Number.isFinite(index)) return 0;
  return Math.min(Math.max(Math.trunc(index), 0), weeks.length - 1);
}
