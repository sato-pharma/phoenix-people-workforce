// Early Birds runs on Cairo calendar half-months: the 1st-15th and the 16th to month end.
//
// Everything here is pure string arithmetic on YYYY-MM-DD. That is safe precisely BECAUSE it never
// constructs a Cairo instant: `ireports360_visits.visit_date` is already stored as the Cairo
// calendar day (the retired vendor sync stored it that way), and `cairoTodayIso()` hands back the
// Cairo day directly. Introduce a `new Date(...)` on a local timestamp anywhere in this file and a
// rep's last-day visit starts landing in the wrong fortnight for three hours every evening.

import { cairoTodayIso } from "@/lib/crm/dates";

export type EarlyBirdsPeriodHalf = 1 | 2;

export type EarlyBirdsPeriod = {
  /** `YYYY-MM-H1` | `YYYY-MM-H2`. Fixed width, so lexical order IS chronological order. */
  periodKey: string;
  year: number;
  /** 1-12. */
  month: number;
  half: EarlyBirdsPeriodHalf;
  startIso: string;
  endIso: string;
  /** Human label for the UI — never a raw key (owner rule: names, not codes). */
  label: string;
};

/**
 * The one pattern. Kept as a string so the migration's CHECK constraint and this module can be
 * asserted equal in a test — a key TypeScript mints must never be rejected by the database at 03:00
 * with nobody watching.
 */
export const EARLY_BIRDS_PERIOD_KEY_PATTERN = "^[0-9]{4}-(0[1-9]|1[0-2])-H[12]$";

const PERIOD_KEY_REGEX = new RegExp(EARLY_BIRDS_PERIOD_KEY_PATTERN);

const MONTH_LABELS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

const pad2 = (value: number): string => String(value).padStart(2, "0");

/** Days in a Gregorian month. Day 0 of the NEXT month is the last day of this one. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function buildPeriod(year: number, month: number, half: EarlyBirdsPeriodHalf): EarlyBirdsPeriod {
  const startDay = half === 1 ? 1 : 16;
  const endDay = half === 1 ? 15 : daysInMonth(year, month);
  const monthLabel = MONTH_LABELS[month - 1];
  return {
    periodKey: `${year}-${pad2(month)}-H${half}`,
    year,
    month,
    half,
    startIso: `${year}-${pad2(month)}-${pad2(startDay)}`,
    endIso: `${year}-${pad2(month)}-${pad2(endDay)}`,
    label: `${monthLabel} ${startDay}-${endDay}, ${year}`,
  };
}

export function isEarlyBirdsPeriodKey(value: unknown): value is string {
  return typeof value === "string" && PERIOD_KEY_REGEX.test(value);
}

/** The period a Cairo calendar day falls in. */
export function earlyBirdsPeriodForDate(dateIso: string): EarlyBirdsPeriod {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateIso).slice(0, 10));
  if (!match) throw new Error(`Invalid date for an Early Birds period: ${String(dateIso)}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`Invalid date for an Early Birds period: ${String(dateIso)}`);
  }
  return buildPeriod(year, month, day <= 15 ? 1 : 2);
}

export function earlyBirdsPeriodFromKey(periodKey: string): EarlyBirdsPeriod {
  if (!isEarlyBirdsPeriodKey(periodKey)) {
    throw new Error(`Invalid Early Birds period key: ${String(periodKey)}`);
  }
  const year = Number(periodKey.slice(0, 4));
  const month = Number(periodKey.slice(5, 7));
  const half = Number(periodKey.slice(9, 10)) as EarlyBirdsPeriodHalf;
  return buildPeriod(year, month, half);
}

export function currentEarlyBirdsPeriod(todayIso?: string): EarlyBirdsPeriod {
  return earlyBirdsPeriodForDate(todayIso ?? cairoTodayIso());
}

export function previousEarlyBirdsPeriod(period: EarlyBirdsPeriod): EarlyBirdsPeriod {
  if (period.half === 2) return buildPeriod(period.year, period.month, 1);
  const month = period.month === 1 ? 12 : period.month - 1;
  const year = period.month === 1 ? period.year - 1 : period.year;
  return buildPeriod(year, month, 2);
}

export function nextEarlyBirdsPeriod(period: EarlyBirdsPeriod): EarlyBirdsPeriod {
  if (period.half === 1) return buildPeriod(period.year, period.month, 2);
  const month = period.month === 12 ? 1 : period.month + 1;
  const year = period.month === 12 ? period.year + 1 : period.year;
  return buildPeriod(year, month, 1);
}

/**
 * A period is closed only once the day AFTER its end has arrived. Off-by-one here is how a period
 * gets snapshotted on its own last day, with that day's visits still arriving.
 */
export function isEarlyBirdsPeriodClosed(period: EarlyBirdsPeriod, todayIso: string): boolean {
  return todayIso > period.endIso;
}

/** The current period first, then backwards. The self-heal enumerator for a missed close. */
export function listRecentEarlyBirdsPeriods(todayIso: string, count: number): EarlyBirdsPeriod[] {
  const periods: EarlyBirdsPeriod[] = [];
  let period = earlyBirdsPeriodForDate(todayIso);
  for (let index = 0; index < Math.max(0, count); index += 1) {
    periods.push(period);
    period = previousEarlyBirdsPeriod(period);
  }
  return periods;
}

/**
 * The first fortnight this module can answer for.
 *
 * Early Birds shipped on 2026-08-08 (20260808234500_early_birds_module.sql), part-way through the
 * 1st-15th half, so August H1 is the earliest period that holds any snapshot at all. It is a
 * constant and not a query because the alternative is offering a picker that reaches back to 2019
 * and renders an empty board for every year of it — an empty ranking looks exactly like a real
 * result of zero, which is the one thing this module refuses to show. Pinned by
 * tests/early-birds-period.test.ts.
 */
export const EARLY_BIRDS_FIRST_PERIOD_KEY = "2026-08-H1";

/**
 * True when a period is one a viewer may actually ask for: not in the future, and not before the
 * module existed. Lexical comparison is sound here because the key is fixed width (see periodKey).
 */
export function isEarlyBirdsPeriodSelectable(periodKey: string, todayIso: string): boolean {
  if (!isEarlyBirdsPeriodKey(periodKey)) return false;
  if (periodKey < EARLY_BIRDS_FIRST_PERIOD_KEY) return false;
  return periodKey <= earlyBirdsPeriodForDate(todayIso).periodKey;
}

/**
 * The fortnights a picker may offer: the current one first, then backwards, stopping at the
 * module's first period rather than running off into fortnights that never had a board.
 *
 * Distinct from {@link listRecentEarlyBirdsPeriods}, which is the close job's self-heal
 * enumerator and deliberately does NOT stop — a missed close must be catchable however far back
 * it sits.
 */
export function listSelectableEarlyBirdsPeriods(todayIso: string, count = 12): EarlyBirdsPeriod[] {
  const periods: EarlyBirdsPeriod[] = [];
  let period = earlyBirdsPeriodForDate(todayIso);
  for (let index = 0; index < Math.max(0, count); index += 1) {
    if (period.periodKey < EARLY_BIRDS_FIRST_PERIOD_KEY) break;
    periods.push(period);
    period = previousEarlyBirdsPeriod(period);
  }
  return periods;
}

/**
 * The period a `?period=` search param should resolve to.
 *
 * Out-of-range and malformed keys CLAMP to the current fortnight rather than erroring. Safe
 * because every surface that renders a period names it on screen — the switcher marks the active
 * chip and the board header carries `This fortnight · <label>` — so a clamp is visible rather than
 * silent. That is the difference from the DISTRICT guard next door, which refuses instead: a
 * district substitution would show one manager another manager's reps under a heading he has no
 * reason to doubt.
 */
export function resolveEarlyBirdsPeriodParam(
  periodKey: string | null | undefined,
  todayIso: string,
): EarlyBirdsPeriod {
  if (typeof periodKey === "string" && isEarlyBirdsPeriodSelectable(periodKey, todayIso)) {
    return earlyBirdsPeriodFromKey(periodKey);
  }
  return earlyBirdsPeriodForDate(todayIso);
}

/** Inclusive list of every calendar day in the period, clamped so a live preview has no future days. */
export function earlyBirdsPeriodDays(period: EarlyBirdsPeriod, throughIso?: string): string[] {
  const last = throughIso && throughIso < period.endIso ? throughIso : period.endIso;
  if (last < period.startIso) return [];
  const days: string[] = [];
  const startDay = Number(period.startIso.slice(8, 10));
  const lastDay = Number(last.slice(8, 10));
  for (let day = startDay; day <= lastDay; day += 1) {
    days.push(`${period.year}-${pad2(period.month)}-${pad2(day)}`);
  }
  return days;
}
