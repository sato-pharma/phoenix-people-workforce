// HR Daily & Weekly Reports — which days a report covers. Pure: no clock, no database.
//
// Owner, 2026-10-20: the weekly report is "field force from sat to thursday and head office from
// sun to thursday". Friday is everyone's weekly off, so there is no Friday report. A Saturday daily
// carries the field section alone (head office does not work Saturdays); a Sunday-to-Thursday daily
// carries both.
//
// Every date here is a Cairo calendar date, `YYYY-MM-DD`, stepped in UTC from a midnight anchor —
// the one arithmetic that cannot drift across a daylight-saving change.

import type { HrOpsPeriod, HrOpsReportKind } from "./types";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDay(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DAY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function addDays(dateIso: string, days: number): string {
  const date = new Date(`${dateIso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** 0 = Sunday … 5 = Friday, 6 = Saturday. */
export function weekdayOf(dateIso: string): number {
  return new Date(`${dateIso}T00:00:00Z`).getUTCDay();
}

export function isFriday(dateIso: string): boolean {
  return weekdayOf(dateIso) === 5;
}

/** Head office works Sunday to Thursday. */
export function isOfficeReportDay(dateIso: string): boolean {
  const day = weekdayOf(dateIso);
  return day >= 0 && day <= 4;
}

/** The field force works Saturday to Thursday. */
export function isFieldReportDay(dateIso: string): boolean {
  return !isFriday(dateIso);
}

/** The Saturday that opens the field week holding `dateIso`. */
export function weekStartSaturday(dateIso: string): string {
  return addDays(dateIso, -((weekdayOf(dateIso) + 1) % 7));
}

export function monthStartOf(dateIso: string): string {
  return `${dateIso.slice(0, 7)}-01`;
}

/** Every day from `from` to `to`, inclusive. Capped at 62 so a malformed pair cannot run away. */
export function eachDay(from: string, to: string): string[] {
  if (!isIsoDay(from) || !isIsoDay(to) || to < from) return [];
  const out: string[] = [];
  for (let day = from; day <= to && out.length < 62; day = addDays(day, 1)) out.push(day);
  return out;
}

/** The daily report for one day, or null on a Friday (nobody works, nothing to report). */
export function dailyPeriod(dateIso: string): HrOpsPeriod | null {
  if (!isIsoDay(dateIso) || isFriday(dateIso)) return null;
  const office = isOfficeReportDay(dateIso);
  return {
    anchor: dateIso,
    fieldFrom: dateIso,
    fieldTo: dateIso,
    kind: "daily",
    officeFrom: office ? dateIso : null,
    officeTo: office ? dateIso : null,
    periodKey: `daily:${dateIso}`,
  };
}

/**
 * The weekly report for the week holding `dateIso`: field Saturday to Thursday, head office Sunday
 * to Thursday. Named after its Saturday, so any day of the week names the same report.
 */
export function weeklyPeriod(dateIso: string): HrOpsPeriod | null {
  if (!isIsoDay(dateIso)) return null;
  const saturday = weekStartSaturday(dateIso);
  return {
    anchor: saturday,
    fieldFrom: saturday,
    fieldTo: addDays(saturday, 5),
    kind: "weekly",
    officeFrom: addDays(saturday, 1),
    officeTo: addDays(saturday, 5),
    periodKey: `weekly:${saturday}`,
  };
}

export function periodFor(kind: HrOpsReportKind, dateIso: string): HrOpsPeriod | null {
  return kind === "daily" ? dailyPeriod(dateIso) : weeklyPeriod(dateIso);
}

export function parsePeriodKey(periodKey: string): { kind: HrOpsReportKind; anchor: string } | null {
  const match = /^(daily|weekly):(\d{4}-\d{2}-\d{2})$/.exec(periodKey);
  if (!match || !isIsoDay(match[2])) return null;
  return { anchor: match[2], kind: match[1] as HrOpsReportKind };
}

/**
 * What the scheduled run builds on a given Cairo day: yesterday's daily report (none when
 * yesterday was a Friday), and on a Sunday the weekly report for the week that ended on Thursday.
 *
 * On a Sunday YESTERDAY is the Saturday that opens the NEW week, so the finished week is the one
 * whose Saturday was eight days ago — field 8 to 3 days back, head office 7 to 3 days back.
 */
export function scheduledPeriods(todayIso: string): HrOpsPeriod[] {
  if (!isIsoDay(todayIso)) return [];
  const periods: HrOpsPeriod[] = [];
  const daily = dailyPeriod(addDays(todayIso, -1));
  if (daily) periods.push(daily);
  if (weekdayOf(todayIso) === 0) {
    const weekly = weeklyPeriod(addDays(todayIso, -8));
    if (weekly) periods.push(weekly);
  }
  return periods;
}

/** A period's last day — nothing may be built before it has finished. */
export function periodEnd(period: Pick<HrOpsPeriod, "fieldTo" | "officeTo" | "anchor">): string {
  return [period.fieldTo, period.officeTo].filter((value): value is string => Boolean(value)).sort().at(-1) ?? period.anchor;
}

const LONG_DAY = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  timeZone: "UTC",
  weekday: "long",
  year: "numeric",
});
const SHORT_DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const SHORT_DAY_YEAR = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC", year: "numeric" });

export function formatDayLong(dateIso: string): string {
  return LONG_DAY.format(new Date(`${dateIso}T00:00:00Z`));
}

export function formatDayShort(dateIso: string): string {
  return SHORT_DAY.format(new Date(`${dateIso}T00:00:00Z`));
}

/** "Daily report · Monday 19 October 2026" / "Weekly report · 10 Oct to 15 Oct 2026". */
export function periodTitle(input: { kind: HrOpsReportKind; anchor: string; fieldTo?: string | null; officeTo?: string | null }): string {
  if (input.kind === "daily") return `Daily report · ${formatDayLong(input.anchor)}`;
  const end = periodEnd({ anchor: input.anchor, fieldTo: input.fieldTo ?? null, officeTo: input.officeTo ?? null });
  return `Weekly report · ${formatDayShort(input.anchor)} to ${SHORT_DAY_YEAR.format(new Date(`${end}T00:00:00Z`))}`;
}
