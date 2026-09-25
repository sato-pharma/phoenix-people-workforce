/**
 * Phoenix CRM — the calendar a plan is built on, with no I/O.
 *
 * The field week (plan-v1.ts FIELD_WORKWEEK; owner rules 2026-08-02 and 2026-09-05): Saturday to
 * Wednesday, plus Thursday morning. Never Friday. Thursday is a half day, so it holds accounts (AM)
 * only. A week is keyed by its Saturday.
 *
 * Ramadan decides which timings a customer shows. Its dates come from the Umm al-Qura calendar,
 * pinned below so every runtime agrees (tests/phoenix-crm-calendar.test.ts re-derives the table from
 * `Intl` and fails on any drift). The Super Admin can move a year's dates for the moon sighting.
 */

import { addDaysIso } from "@/lib/crm/dates";
import type { PhoenixCrmListType } from "@/lib/phoenix-crm/types";

const ISO_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDay(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DAY_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** 0 = Sunday … 6 = Saturday, read from the calendar date itself (no clock, no zone). */
export function weekdayOfIsoDay(isoDay: string): number {
  return new Date(`${isoDay}T12:00:00Z`).getUTCDay();
}

/** The Saturday that starts the field week holding this day. A Friday belongs to the week before it. */
export function fieldWeekStart(isoDay: string): string {
  const offset = (weekdayOfIsoDay(isoDay) - 6 + 7) % 7;
  return addDaysIso(isoDay, -offset);
}

export function isFieldWeekStart(value: unknown): value is string {
  return isIsoDay(value) && weekdayOfIsoDay(value) === 6;
}

/** Saturday, Sunday, Monday, Tuesday, Wednesday, Thursday — never Friday. */
export function fieldWeekDays(weekStart: string): string[] {
  return [0, 1, 2, 3, 4, 5].map((offset) => addDaysIso(weekStart, offset));
}

/** What a plan day can hold: Thursday is a morning (accounts only); Friday holds nothing. */
export function planDayListTypes(isoDay: string): PhoenixCrmListType[] {
  const weekday = weekdayOfIsoDay(isoDay);
  if (weekday === 5) return [];
  if (weekday === 4) return ["AM"];
  return ["AM", "PM"];
}

/** The weeks a rep can plan: this week while it still has a day ahead, and the next three. */
export function plannableWeeks(cairoToday: string, weeksAhead = 3): string[] {
  const thisWeek = fieldWeekStart(cairoToday);
  const weeks: string[] = [];
  const thursday = addDaysIso(thisWeek, 5);
  if (thursday >= cairoToday) weeks.push(thisWeek);
  for (let index = 1; index <= weeksAhead; index += 1) weeks.push(addDaysIso(thisWeek, 7 * index));
  return weeks;
}

/** The days of a week a rep may still change: today onward. A day that has passed is fixed. */
export function editablePlanDays(weekStart: string, cairoToday: string): string[] {
  if (!isFieldWeekStart(weekStart)) return [];
  return fieldWeekDays(weekStart).filter((day) => day >= cairoToday);
}

// ── Ramadan ─────────────────────────────────────────────────────────────────────────────────────

export type RamadanRange = { hijriYear: number; startsOn: string; endsOn: string };

/**
 * Umm al-Qura Ramadan, first and last day, by Hijri year (derived from `Intl` islamic-umalqura on
 * 2026-09-16). 1448 is the first one this module meets: 8 February – 8 March 2027.
 */
export const UMM_AL_QURA_RAMADAN: readonly RamadanRange[] = [
  { hijriYear: 1447, startsOn: "2026-02-18", endsOn: "2026-03-19" },
  { hijriYear: 1448, startsOn: "2027-02-08", endsOn: "2027-03-08" },
  { hijriYear: 1449, startsOn: "2028-01-28", endsOn: "2028-02-25" },
  { hijriYear: 1450, startsOn: "2029-01-16", endsOn: "2029-02-13" },
  { hijriYear: 1451, startsOn: "2030-01-05", endsOn: "2030-02-03" },
  { hijriYear: 1452, startsOn: "2030-12-26", endsOn: "2031-01-23" },
  { hijriYear: 1453, startsOn: "2031-12-16", endsOn: "2032-01-13" },
  { hijriYear: 1454, startsOn: "2032-12-04", endsOn: "2033-01-02" },
  { hijriYear: 1455, startsOn: "2033-11-23", endsOn: "2033-12-22" },
  { hijriYear: 1456, startsOn: "2034-11-12", endsOn: "2034-12-11" },
  { hijriYear: 1457, startsOn: "2035-11-01", endsOn: "2035-11-30" },
  { hijriYear: 1458, startsOn: "2036-10-21", endsOn: "2036-11-18" },
  { hijriYear: 1459, startsOn: "2037-10-10", endsOn: "2037-11-08" },
  { hijriYear: 1460, startsOn: "2038-09-30", endsOn: "2038-10-28" },
];

const PINNED_FIRST_DAY = UMM_AL_QURA_RAMADAN[0].startsOn.slice(0, 4);
const PINNED_LAST_DAY = UMM_AL_QURA_RAMADAN[UMM_AL_QURA_RAMADAN.length - 1].endsOn;

/** The Ramadan ranges in force: the pinned calendar, with the Super Admin's moved years in its place. */
export function effectiveRamadanRanges(overrides: readonly RamadanRange[] = []): RamadanRange[] {
  const byYear = new Map<number, RamadanRange>(UMM_AL_QURA_RAMADAN.map((range) => [range.hijriYear, range]));
  for (const override of overrides) {
    if (isIsoDay(override.startsOn) && isIsoDay(override.endsOn) && override.endsOn >= override.startsOn) {
      byYear.set(override.hijriYear, override);
    }
  }
  return [...byYear.values()].sort((left, right) => left.startsOn.localeCompare(right.startsOn));
}

/** Hijri month by `Intl`, for a day outside the pinned table. Null when the runtime lacks the calendar. */
function intlHijriMonth(isoDay: string): number | null {
  try {
    const format = new Intl.DateTimeFormat("en-u-ca-islamic-umalqura", { timeZone: "UTC", month: "numeric" });
    if (format.resolvedOptions().calendar !== "islamic-umalqura") return null;
    const month = format.formatToParts(new Date(`${isoDay}T12:00:00Z`)).find((part) => part.type === "month");
    return month ? Number(month.value) : null;
  } catch {
    return null;
  }
}

export function isRamadanDay(isoDay: string, overrides: readonly RamadanRange[] = []): boolean {
  const ranges = effectiveRamadanRanges(overrides);
  if (ranges.some((range) => isoDay >= range.startsOn && isoDay <= range.endsOn)) return true;
  if (isoDay.slice(0, 4) >= PINNED_FIRST_DAY && isoDay <= PINNED_LAST_DAY) return false;
  return intlHijriMonth(isoDay) === 9;
}

/** The next Ramadan that has not ended by `isoDay` (for the settings screen). */
export function nextRamadan(isoDay: string, overrides: readonly RamadanRange[] = []): RamadanRange | null {
  return effectiveRamadanRanges(overrides).find((range) => range.endsOn >= isoDay) ?? null;
}

// ── Month helpers ───────────────────────────────────────────────────────────────────────────────

/** "2026-09-16" → "2026-09-01". */
export function monthStartOf(isoDay: string): string {
  return `${isoDay.slice(0, 7)}-01`;
}

/** The last day of the month holding this day. */
export function monthEndOf(isoDay: string): string {
  const [year, month] = isoDay.slice(0, 7).split("-").map(Number);
  const last = new Date(Date.UTC(year, month, 0));
  return last.toISOString().slice(0, 10);
}

export function isMonthKey(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

/** "2026-09-16" → "2026-09". */
export function monthKeyOf(isoDay: string): string {
  return isoDay.slice(0, 7);
}

/**
 * The field-weeks of a month: every Saturday (a week's `week_start`) whose own date falls in the
 * calendar month. A field-week belongs to the month its Saturday falls in — one month per week, no
 * double-count — so a week that straddles a month edge sits wholly in the month its Saturday is in.
 * `monthStart` is any day of the month; the first of the month is used.
 */
export function fieldWeeksOfMonth(monthStart: string): string[] {
  const day1 = monthStartOf(monthStart);
  const monthKey = monthKeyOf(day1);
  const firstSaturday = weekdayOfIsoDay(day1) === 6 ? day1 : addDaysIso(fieldWeekStart(day1), 7);
  const weeks: string[] = [];
  for (let saturday = firstSaturday; monthKeyOf(saturday) === monthKey; saturday = addDaysIso(saturday, 7)) {
    weeks.push(saturday);
  }
  return weeks;
}

/**
 * The months a rep can plan: the month of each week the rep can still plan (calendar.ts
 * `plannableWeeks`), so month and week stay in step — a month is plannable exactly when it holds a
 * plannable week. Today's month, and the next once the horizon reaches into it.
 */
export function plannableMonths(cairoToday: string, weeksAhead = 3): string[] {
  const months: string[] = [];
  for (const week of plannableWeeks(cairoToday, weeksAhead)) {
    const monthStart = monthStartOf(week);
    if (!months.includes(monthStart)) months.push(monthStart);
  }
  return months;
}
