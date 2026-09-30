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
/** One line of the broken-down column: the days that share a set of weeks, and those weeks. */
export type PlanPatternGroup = { days: string[]; weeks: number[]; weeksLabel: string };

/**
 * 🔴 THE COLUMN IS BROKEN DOWN, NOT A SENTENCE (owner, 2026-09-30: "usually planned — break it down,
 * don't put it as if it is one sentence"). "Sat, Sun & Tue every week · Mon weeks 1, 2 and 4" is a
 * paragraph in a narrow column: a reader has to parse it to find the one day he wanted. As rows —
 * the days as chips, their weeks beside them — he reads it at a glance.
 *
 * Days that share a set of weeks stay on ONE line: that is the grouping, not a flattening.
 */
export function planPatternGroups(weekdays: readonly PlanWeekday[], short = true): PlanPatternGroup[] {
  const names = short ? DAY_SHORT : DAY_NAMES;
  const byWeeks = new Map<string, PlanPatternGroup>();
  for (const entry of weekdays) {
    const key = entry.weeks.join(",");
    const day = names[entry.weekday] ?? "?";
    const found = byWeeks.get(key);
    if (found) found.days.push(day);
    else byWeeks.set(key, { days: [day], weeks: entry.weeks, weeksLabel: describeWeeks(entry.weeks) });
  }
  // The fullest line first — "every week" above "weeks 1 and 4" — so the shape reads top-down.
  return [...byWeeks.values()].sort((left, right) => right.weeks.length - left.weeks.length || right.days.length - left.days.length);
}

/** One line of the column read as a table: a single day, and the weeks it is planned in. */
export type PlanPatternRow = { day: string; weeks: number[]; weeksLabel: string };

/**
 * 🔴 ONE ROW PER DAY, DAY AND WEEKS IN THEIR OWN COLUMNS (owner, 2026-09-30: "in the column which is
 * called Usually planned, its cell — it is a table: put day, put week corresponding. Make it a table,
 * make it more tidy than this").
 *
 * `planPatternGroups` above folds days that share a set of weeks onto one line, which is the tidiest
 * SENTENCE but not the tidiest TABLE: the day chips wrap, and the weeks they belong to sit underneath
 * them rather than beside them, so the eye has to pair the two by position. Read as rows — the day in
 * a fixed left column, its weeks in a fixed right one — every pairing is on one line and the days all
 * start at the same x. The field week's own order (Saturday first) comes through from `planWeekdays`.
 */
export function planPatternRows(weekdays: readonly PlanWeekday[], short = true): PlanPatternRow[] {
  const names = short ? DAY_SHORT : DAY_NAMES;
  return weekdays.map((entry) => ({
    day: names[entry.weekday] ?? "?",
    weeks: entry.weeks,
    weeksLabel: describeWeeks(entry.weeks),
  }));
}

export function describePlanPattern(weekdays: readonly PlanWeekday[], short = true): string | null {
  if (weekdays.length === 0) return null;
  const names = short ? DAY_SHORT : DAY_NAMES;

  // 🔴 DAYS THAT SHARE A SET OF WEEKS ARE SAID ONCE. Measured on production, a rep's carried-over
  // doctor is often planned four days a week, and naming the weeks after every day printed a
  // paragraph into a narrow column — "Sat every week · Sun every week · Mon weeks 1, 2 and 4 · Tue
  // every week". Grouping loses nothing and says the same thing in a third of the width:
  // "Sat, Sun & Tue every week · Mon weeks 1, 2 and 4".
  const byWeeks = new Map<string, { days: string[]; weeks: number[] }>();
  for (const entry of weekdays) {
    const key = entry.weeks.join(",");
    const found = byWeeks.get(key);
    if (found) found.days.push(names[entry.weekday] ?? "?");
    else byWeeks.set(key, { days: [names[entry.weekday] ?? "?"], weeks: entry.weeks });
  }
  return [...byWeeks.values()].map((group) => `${joinDays(group.days)} ${describeWeeks(group.weeks)}`).join(" · ");
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
