import { fieldWeekStart, isIsoDay, weekNumberInMonth, weekdayOfIsoDay } from "@/lib/phoenix-crm/calendar";

/**
 * Phoenix CRM — when a doctor is USUALLY planned, read off the iReports360 reference plans.
 *
 * 🔴 THE OWNER, 2026-09-30: "add another column and tell him that, based on the reference weekly
 * plans from iReports360, you are visiting this doctor — for example Sunday and Tuesday, in the
 * first and the fourth week." A rep arriving at a carried-over list has no idea when he used to see
 * anyone; the answer is already in the mirror, in the plans he himself sent for months.
 *
 * 🔴 THE WEEK MODEL IS PHOENIX'S OWN, NOT A NEW ONE. `fieldWeekStart` and `weekNumberInMonth`
 * (calendar.ts) decide which week a date falls in: the field week runs SATURDAY to Thursday, Friday
 * belongs to the week before it, and a week belongs to the month its Saturday falls in. Numbering a
 * month's weeks any other way here — `ceil(day / 7)` is the tempting one — would put a doctor in
 * "week 1" on this column and "Week 2" on the Plan board for the same date, which is worse than
 * showing nothing.
 *
 * WHAT IT IS NOT. It is not a target, not a frequency and not an instruction: it is what the plans
 * already say. It does not judge the rep, and it carries no count of whether he went — nothing on
 * his own List judges him (golden rule #1).
 */

/** One weekday a doctor is planned on, and the weeks of the month it happens in. */
export type PlanWeekday = {
  /** 0 = Sunday … 6 = Saturday, as `weekdayOfIsoDay` reads it. */
  weekday: number;
  /** Which weeks of the month, ascending, de-duplicated. */
  weeks: number[];
  /** How many plan entries stand behind this weekday — the evidence, not a score. */
  entries: number;
};

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/**
 * The pattern in a doctor's planned dates.
 *
 * 🔴 A WEEKDAY IS ONLY A PATTERN IF IT HAPPENED MORE THAN ONCE — one entry is a day somebody was
 * squeezed in, and printing it as "you visit him on Wednesdays" would be a claim the data does not
 * make. The exception is a doctor with only ONE planned date in the whole window: then that single
 * entry IS everything known about him, and saying so is better than saying nothing.
 */
export function planWeekdays(isoDays: readonly string[]): PlanWeekday[] {
  const days = isoDays.filter((day) => isIsoDay(day));
  if (days.length === 0) return [];

  const byWeekday = new Map<number, { weeks: Set<number>; entries: number }>();
  for (const day of days) {
    const weekday = weekdayOfIsoDay(day);
    const week = weekNumberInMonth(fieldWeekStart(day));
    const found = byWeekday.get(weekday);
    if (found) {
      found.weeks.add(week);
      found.entries += 1;
    } else {
      byWeekday.set(weekday, { entries: 1, weeks: new Set([week]) });
    }
  }

  const all = [...byWeekday.entries()].map(([weekday, found]) => ({
    entries: found.entries,
    weekday,
    weeks: [...found.weeks].sort((left, right) => left - right),
  }));
  const repeated = all.filter((entry) => entry.entries > 1);
  const kept = repeated.length > 0 ? repeated : all;
  // The week runs Saturday first, so the column reads in the order he works it.
  return kept.sort((left, right) => fieldOrder(left.weekday) - fieldOrder(right.weekday));
}

/** Saturday first, Friday last — the field week's own order, not the calendar's. */
function fieldOrder(weekday: number): number {
  return (weekday + 1) % 7;
}

/**
 * "Sun & Tue · weeks 1, 3", or "Sundays, every week" — his own example, said the short way a column
 * has room for. Null when the mirror holds no plan for this doctor at all: the row then says what it
 * always says for a thing nobody has recorded, rather than inventing a pattern.
 */
export function describePlanPattern(weekdays: readonly PlanWeekday[], short = true): string | null {
  if (weekdays.length === 0) return null;
  const names = short ? DAY_SHORT : DAY_NAMES;
  const days = weekdays.map((entry) => names[entry.weekday] ?? "?");

  // Every weekday in the pattern sharing one set of weeks is the ordinary case, and it reads far
  // better as one phrase than as the same weeks repeated after each day.
  const weekSets = weekdays.map((entry) => entry.weeks.join(","));
  const shared = weekSets.every((set) => set === weekSets[0]) ? weekdays[0].weeks : null;
  if (shared) return `${joinDays(days)} · ${describeWeeks(shared)}`;
  return weekdays.map((entry, index) => `${days[index]} ${describeWeeks(entry.weeks)}`).join(" · ");
}

function joinDays(days: readonly string[]): string {
  if (days.length <= 1) return days[0] ?? "";
  if (days.length === 2) return `${days[0]} & ${days[1]}`;
  return `${days.slice(0, -1).join(", ")} & ${days[days.length - 1]}`;
}

/** "every week" beats "weeks 1, 2, 3, 4" — the reader wants the shape, not the list. */
function describeWeeks(weeks: readonly number[]): string {
  if (weeks.length === 0) return "";
  if (weeks.length >= 4) return "every week";
  if (weeks.length === 1) return `week ${weeks[0]}`;
  return `weeks ${weeks.slice(0, -1).join(", ")} and ${weeks[weeks.length - 1]}`;
}
