// Daily Deductions module: every deduction stands ALONE — one employee, one type, one day — and what
// state is it in, against what has been released?
//
// Owner, 2026-11-13: "never group a group of deductions ... Ahmad Sharaf Din have a 3 days unpaid
// vacation, 9, 10, 11 ... I can select day 9 alone and release, or day 10 alone and release ... Never
// group them. I want each deduction to be single." So the tally the server returns (one line per
// employee x type, every day of the range) is split here into SINGLE deductions, one per day, each
// priced by the server on its own (DailyDeductionTallyLine.days), and each released as its own row
// (daily_deductions_lines.deduction_date). A line whose days cannot be priced one by one exactly stays
// ONE deduction for the whole range — never split on a guess.
//
// Pure and browser-safe (no database, no server-only import): the workspace uses it to colour and
// enable each Release button, and the unit tests load it directly.
//
// A single deduction is:
//   - "not_released" - nothing for it is in the active snapshot;
//   - "released"     - the snapshot holds it at the figures the tally shows now (or, for a day, an
//                      older whole-range row of the same employee x type already carries that day);
//   - "changed"      - the snapshot holds it, but the tally now counts it differently.

import type { DailyDeductionCategory, DailyDeductionDayFigure } from "./types.ts";

export type ReleaseState = "not_released" | "released" | "changed";

type KeyedLine = {
  category: DailyDeductionCategory | string;
  employeeHrIdCompact: string;
  /** The one day a single deduction charges; null (or absent) for a whole-range one. */
  deductionDate?: string | null;
};

export type ComparableLine = KeyedLine & {
  daysCount: number;
  amount: number;
  dates: string[];
  /** Each day priced alone (DailyDeductionTallyLine.days); absent on a single or a released row. */
  days?: DailyDeductionDayFigure[];
  /** No computable amount — never sent to release (see DailyDeductionTallyLine.amountUnknown). */
  amountUnknown?: boolean;
};

/** The identity of a single deduction, and of a released row: employee x type x day. */
export function releaseLineKey(line: KeyedLine): string {
  return `${line.category}|${line.employeeHrIdCompact}|${line.deductionDate ?? ""}`;
}

function pairKey(line: KeyedLine): string {
  return `${line.category}|${line.employeeHrIdCompact}`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Split the tally into single deductions — one per employee x type x DAY. A day's figure is the
 * server's own price for that day; a line with one day is already single; a line whose days cannot
 * be priced one by one stays one deduction for the whole range (deductionDate null). A line with no
 * salary on file is split by day too, so each day shows on its own, held.
 */
export function splitIntoSingles<T extends ComparableLine & { rawDaysCount?: number }>(
  lines: readonly T[],
): Array<T & { deductionDate: string | null }> {
  const out: Array<T & { deductionDate: string | null }> = [];
  for (const line of lines) {
    const dates = [...new Set(line.dates)].sort();
    const { days, ...rest } = line;
    if (dates.length === 1) {
      out.push({ ...(rest as T), dates, deductionDate: dates[0]! });
      continue;
    }
    if (line.amountUnknown === true && dates.length > 1) {
      for (const date of dates) out.push({ ...(rest as T), amount: 0, daysCount: 1, dates: [date], deductionDate: date });
      continue;
    }
    const byDate = new Map((days ?? []).map((day) => [day.date, day]));
    if (dates.length > 1 && dates.every((date) => byDate.has(date))) {
      for (const date of dates) {
        const day = byDate.get(date)!;
        out.push({
          ...(rest as T),
          amount: day.amount,
          daysCount: day.daysCount,
          ...("rawDaysCount" in rest ? { rawDaysCount: day.daysCount } : {}),
          dates: [date],
          deductionDate: date,
        });
      }
      continue;
    }
    out.push({ ...(rest as T), dates, deductionDate: null });
  }
  return out;
}

export type ReleasedIndex<T extends ComparableLine = ComparableLine> = {
  /** Released rows by employee x type x day. */
  byKey: Map<string, T>;
  /** Days carried by older whole-range rows (deductionDate null), by employee x type. */
  wholeRangeDays: Map<string, Set<string>>;
  /** Days released on their own, by employee x type. */
  singleDays: Map<string, Set<string>>;
};

/** Index the released rows. */
export function indexReleasedLines<T extends ComparableLine>(released: readonly T[]): ReleasedIndex<T> {
  const byKey = new Map<string, T>();
  const wholeRangeDays = new Map<string, Set<string>>();
  const singleDays = new Map<string, Set<string>>();
  for (const line of released) {
    byKey.set(releaseLineKey(line), line);
    const target = line.deductionDate ? singleDays : wholeRangeDays;
    const set = target.get(pairKey(line)) ?? new Set<string>();
    for (const date of line.deductionDate ? [line.deductionDate] : line.dates) set.add(date);
    target.set(pairKey(line), set);
  }
  return { byKey, singleDays, wholeRangeDays };
}

function sameDates(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

function sameFigures(a: ComparableLine, b: ComparableLine): boolean {
  return (
    Math.round(a.daysCount * 100) === Math.round(b.daysCount * 100) &&
    Math.round(a.amount * 100) === Math.round(b.amount * 100) &&
    sameDates(a.dates, b.dates)
  );
}

export function releaseStateOf(single: ComparableLine, released: ReleasedIndex): ReleaseState {
  const match = released.byKey.get(releaseLineKey(single));
  if (match) return sameFigures(single, match) ? "released" : "changed";
  // A day already carried by an older whole-range row is out — releasing it alone would charge it twice.
  if (single.deductionDate && released.wholeRangeDays.get(pairKey(single))?.has(single.deductionDate)) return "released";
  return "not_released";
}

export type HeldReason = "no_salary" | "released_outside_range" | "days_released_alone";

/**
 * Why a single deduction cannot be released from this tally, or null when it can.
 *   - no_salary: the tally could not price it — the employee would be emailed "EGP 0.00".
 *   - released_outside_range: a whole-range row already out holds days outside the counted window; a
 *     release REPLACES that row, so the outside days would silently drop out.
 *   - days_released_alone: a whole-range deduction over days already released one by one would
 *     charge those days twice (the database refuses it too).
 */
export function heldReasonOf(
  single: ComparableLine,
  released: ReleasedIndex,
  window: { from: string; to: string } | null,
): HeldReason | null {
  if (single.amountUnknown === true) return "no_salary";
  if (single.deductionDate) return null;
  const match = released.byKey.get(releaseLineKey(single));
  if (window && match && match.dates.some((date) => date < window.from || date > window.to)) return "released_outside_range";
  const alone = released.singleDays.get(pairKey(single));
  if (alone && single.dates.some((date) => alone.has(date))) return "days_released_alone";
  return null;
}

/**
 * The single deductions a Release click should send: those not already out as shown, and not held.
 * Each one is its own row — releasing the 9th never touches the 10th or the 11th.
 */
export function linesToRelease<T extends ComparableLine>(
  selected: readonly T[],
  released: ReleasedIndex,
  window: { from: string; to: string } | null,
): T[] {
  return selected.filter(
    (single) => heldReasonOf(single, released, window) === null && releaseStateOf(single, released) !== "released",
  );
}

/** The days of a released row, for the per-day dots on a whole-range deduction. */
export function releasedDaysOf(single: ComparableLine, released: ReleasedIndex): Set<string> {
  return releaseStateOf(single, released) === "released" ? new Set(single.dates) : new Set();
}

/** Total of a set of single deductions, to the piaster. */
export function sumSingles(singles: ReadonlyArray<{ amount: number }>): number {
  return round2(singles.reduce((sum, single) => sum + single.amount, 0));
}
