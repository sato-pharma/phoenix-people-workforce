// Daily Deductions module: the date-range arithmetic. Pure. No DB, no I/O, and —
// except for the one thin live wrapper at the bottom — no clock, so every rule
// here is unit-testable against a fixed `todayIso`.
//
// THE ELAPSED-DAY RULE. A deduction day is only judgeable once the day has fully
// ended. The month module refuses an in-progress MONTH outright (isCollectableMonth,
// the 39,225.73 EGP guard). The daily module's whole job is an in-progress range, so
// it draws the line one level finer: it counts only days strictly BEFORE today
// (Cairo). Today and any future day are clamped away — never counted, whatever the
// operator picks as `to`.

import { OFFICE_CYCLE_CLOSE_DAY } from "@/lib/deductions/cycle.ts";
import { currentCairoDateParts } from "@/lib/i18n/format";
import type { DailyDeductionRange, ResolvedDailyRange } from "./types.ts";

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = ISO_DATE.exec(value.trim());
  if (!match) return false;
  const month = Number(match[2]);
  const day = Number(match[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

export function assertIsoDate(value: unknown, label: string): string {
  if (!isIsoDate(value)) {
    throw new Error(`Validation: ${label} must be a YYYY-MM-DD date (got ${JSON.stringify(value)}).`);
  }
  return (value as string).trim();
}

/** One calendar day before `iso`, in UTC (dates are date-only, so UTC is exact). */
export function previousDayIso(iso: string): string {
  const date = new Date(`${assertIsoDate(iso, "date")}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

/** N days before `iso` (N ≥ 0), UTC. */
export function addDaysIso(iso: string, days: number): string {
  const date = new Date(`${assertIsoDate(iso, "date")}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Today in Cairo as ISO YYYY-MM-DD. The one clock touch; everything else takes it as input. */
export function cairoTodayIso(): string {
  const { year, month, day } = currentCairoDateParts();
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * The pre-filled window: the OPEN Head Office pay cycle, from its first day through today.
 *
 * The Head Office cycle runs from the 22nd of one month to the 21st of the next (owner rule
 * 2026-10-26, `OFFICE_CYCLE_CLOSE_DAY` in deductions/cycle.ts). This default used to open on the
 * 21st, so every tally re-counted the last day of a cycle that had already closed — and, from the
 * 22nd on, still reached a whole month back into the cycle before. Up to the 21st the open cycle
 * began on the 22nd of last month; from the 22nd it began on the 22nd of this one. The operator can
 * still widen or narrow it.
 */
export function resolveDefaultRange(todayIso: string): DailyDeductionRange {
  const today = new Date(`${assertIsoDate(todayIso, "todayIso")}T00:00:00Z`);
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth(); // 0-based
  const opensThisMonth = today.getUTCDate() > OFFICE_CYCLE_CLOSE_DAY;
  const start = new Date(Date.UTC(year, opensThisMonth ? month : month - 1, OFFICE_CYCLE_CLOSE_DAY + 1));
  return { from: start.toISOString().slice(0, 10), to: todayIso };
}

/**
 * Clamp a requested range to the fully-elapsed window.
 *
 * `effectiveTo = min(requested.to, yesterday)`. `empty` when even `from` has not elapsed
 * (from > effectiveTo) — nothing to count. `truncated` when the requested `to` reached
 * today or beyond and was pulled back, so the operator can be told the last counted day.
 */
export function resolveDailyRange(requested: DailyDeductionRange, todayIso: string): ResolvedDailyRange {
  const from = assertIsoDate(requested.from, "from");
  const to = assertIsoDate(requested.to, "to");
  if (from > to) {
    throw new Error(`Validation: the range start (${from}) is after the range end (${to}).`);
  }
  const yesterday = previousDayIso(assertIsoDate(todayIso, "todayIso"));
  const effectiveTo = to <= yesterday ? to : yesterday;
  const truncated = to > yesterday;
  const empty = from > effectiveTo;
  return { requested: { from, to }, from, effectiveTo, truncated, empty };
}

/** Every {month, year} a [from, effectiveTo] window touches, in order. Usually one or two. */
export function monthsInRange(from: string, effectiveTo: string): Array<{ month: number; year: number }> {
  const start = new Date(`${assertIsoDate(from, "from")}T00:00:00Z`);
  const end = new Date(`${assertIsoDate(effectiveTo, "effectiveTo")}T00:00:00Z`);
  const months: Array<{ month: number; year: number }> = [];
  let cursorYear = start.getUTCFullYear();
  let cursorMonth = start.getUTCMonth(); // 0-based
  let guard = 0;
  while (guard < 240) {
    const first = Date.UTC(cursorYear, cursorMonth, 1);
    if (first > end.getTime()) break;
    months.push({ month: cursorMonth + 1, year: cursorYear });
    cursorMonth += 1;
    if (cursorMonth > 11) {
      cursorMonth = 0;
      cursorYear += 1;
    }
    guard += 1;
  }
  return months;
}

/** Keep only the dates inside [from, effectiveTo], de-duplicated and sorted. */
export function clipDatesToRange(dates: readonly string[], from: string, effectiveTo: string): string[] {
  const kept = new Set<string>();
  for (const date of dates) {
    if (typeof date !== "string") continue;
    const trimmed = date.trim();
    if (!ISO_DATE.test(trimmed)) continue;
    if (trimmed >= from && trimmed <= effectiveTo) kept.add(trimmed);
  }
  return [...kept].sort();
}
