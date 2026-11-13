// Daily Deductions module: what state is each tally line in, against what has been released?
//
// Pure and browser-safe (no database, no server-only import): the workspace uses it to colour and
// enable each line's Release button, and the unit tests load it directly.
//
// A line is identified by employee x category (the snapshot's unique key). It is:
//   - "not_released" - nothing for that employee x category is in the active snapshot;
//   - "released"     - the snapshot holds the same figures the tally shows now;
//   - "partly_released" - the snapshot holds SOME of this line's days, released day by day, at exactly
//                      what those days are worth in the tally now (owner, 2026-11-13);
//   - "changed"      - the snapshot holds this line, but the tally now counts differently
//                      (a day was added or cleared since it was released), so it can be re-released.

import type { DailyDeductionCategory, DailyDeductionDayFigure } from "./types.ts";

export type ReleaseState = "not_released" | "partly_released" | "released" | "changed";

type KeyedLine = { category: DailyDeductionCategory | string; employeeHrIdCompact: string };

export type ComparableLine = KeyedLine & {
  daysCount: number;
  amount: number;
  dates: string[];
  /** Each day priced alone (DailyDeductionTallyLine.days); absent on a released row. */
  days?: DailyDeductionDayFigure[];
  /** No computable amount — never sent to release (see DailyDeductionTallyLine.amountUnknown). */
  amountUnknown?: boolean;
};

export function releaseLineKey(line: KeyedLine): string {
  return `${line.category}|${line.employeeHrIdCompact}`;
}

function sameDates(a: string[], b: string[]): boolean {
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

/** Index the released lines by employee x category. */
export function indexReleasedLines<T extends KeyedLine>(released: readonly T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const line of released) map.set(releaseLineKey(line), line);
  return map;
}

export function releaseStateOf(tally: ComparableLine, released: ReadonlyMap<string, ComparableLine>): ReleaseState {
  const match = released.get(releaseLineKey(tally));
  if (!match) return "not_released";
  if (sameFigures(tally, match)) return "released";
  // Released day by day: the snapshot holds some of the days, at what those days are worth now.
  const tallyDates = new Set(tally.dates);
  if (match.dates.length > 0 && match.dates.every((date) => tallyDates.has(date))) {
    const expected = figuresForDates(tally, match.dates);
    if (expected && sameFigures(expected, match)) return "partly_released";
  }
  return "changed";
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** What one day of a line charges, or null when the line carries no per-day price for it. */
export function dayFigureOf(line: ComparableLine, date: string): DailyDeductionDayFigure | null {
  if (!line.dates.includes(date)) return null;
  if (line.dates.length === 1) return { amount: line.amount, date, daysCount: line.daysCount };
  return line.days?.find((day) => day.date === date) ?? null;
}

/**
 * What a line charges for SOME of its days. Every day → the line's own figures to the piaster (so a
 * day-by-day release that ends up covering the whole line equals the whole-line release exactly); a
 * subset → the sum of those days' own prices; null when a day has no price of its own.
 */
export function figuresForDates<T extends ComparableLine>(
  line: T,
  dates: readonly string[],
): (KeyedLine & { amount: number; daysCount: number; dates: string[] }) | null {
  const lineDates = new Set(line.dates);
  const kept = [...new Set(dates)].filter((date) => lineDates.has(date)).sort();
  if (kept.length === 0) return null;
  if (kept.length === lineDates.size) {
    return { category: line.category, employeeHrIdCompact: line.employeeHrIdCompact, amount: line.amount, daysCount: line.daysCount, dates: [...line.dates].sort() };
  }
  let amount = 0;
  let daysCount = 0;
  for (const date of kept) {
    const day = dayFigureOf(line, date);
    if (!day) return null;
    amount += day.amount;
    daysCount += day.daysCount;
  }
  return { category: line.category, employeeHrIdCompact: line.employeeHrIdCompact, amount: round2(amount), daysCount: round2(daysCount), dates: kept };
}

/** The days of a line that are out in the snapshot as the tally prices them now. */
export function releasedDaysOf(tally: ComparableLine, released: ReadonlyMap<string, ComparableLine>): Set<string> {
  const state = releaseStateOf(tally, released);
  if (state === "released") return new Set(tally.dates);
  if (state === "partly_released") return new Set(released.get(releaseLineKey(tally))?.dates ?? []);
  return new Set();
}

export type DayReleaseSkip = {
  line: KeyedLine & { employeeName?: string | null };
  reason: "no_salary" | "released_outside_range" | "no_day_price";
};

export type DayReleasePlan<T extends ComparableLine> = {
  /** The lines to send: each carries its already-released days PLUS the ticked days, priced now. */
  lines: T[];
  /** How much the snapshot moves by — what the ticked days add, not the lines' running totals. */
  addedAmount: number;
  skipped: DayReleaseSkip[];
};

/**
 * Release only the ticked DAYS (owner, 2026-11-13: "select day 9 and day 11 in November and release
 * only their deductions"). The snapshot keeps one row per employee × type, so a release on the 11th
 * after the 9th is out sends that row with BOTH days — the RPC replaces the row, never adds a second.
 *
 * A row whose released days reach OUTSIDE the counted window is skipped and named, never re-sent:
 * the tally cannot price those days, and re-sending only the in-range ones would silently take the
 * outside days back out of the employee's deductions.
 */
export function planDayRelease<T extends ComparableLine & { employeeName?: string | null }>(
  lines: readonly T[],
  selectedDays: ReadonlySet<string>,
  released: ReadonlyMap<string, ComparableLine>,
  window: { from: string; to: string },
): DayReleasePlan<T> {
  const out: T[] = [];
  const skipped: DayReleaseSkip[] = [];
  let addedAmount = 0;
  for (const line of lines) {
    const picked = line.dates.filter((date) => selectedDays.has(date));
    if (picked.length === 0) continue;
    if (line.amountUnknown === true) {
      skipped.push({ line, reason: "no_salary" });
      continue;
    }
    const match = released.get(releaseLineKey(line));
    if (match && match.dates.some((date) => date < window.from || date > window.to)) {
      skipped.push({ line, reason: "released_outside_range" });
      continue;
    }
    const target = [...new Set([...(match?.dates ?? []), ...picked])];
    const figures = figuresForDates(line, target);
    if (!figures) {
      skipped.push({ line, reason: "no_day_price" });
      continue;
    }
    if (match && sameFigures(figures, match)) continue;
    addedAmount += figures.amount - (match?.amount ?? 0);
    // The per-day prices stay behind: the stored row carries the days and their total, nothing more.
    const sent: T = { ...line, amount: figures.amount, daysCount: figures.daysCount, dates: figures.dates };
    delete sent.days;
    out.push(sent);
  }
  return { addedAmount: round2(addedAmount), lines: out, skipped };
}

export type DaySummary = {
  date: string;
  /** Deduction lines touching this day, and the people they belong to. */
  lineCount: number;
  employeeCount: number;
  /** What this day charges across every priced line. */
  amount: number;
  /** The part of it already out in the snapshot. */
  releasedAmount: number;
  releasedLineCount: number;
  /** Lines touching this day that cannot be priced (no salary on file), never released. */
  heldLineCount: number;
  state: "not_released" | "partly_released" | "released";
};

/** One row per day of the tally — the "release by day" panel. */
export function summarizeDays(
  lines: readonly ComparableLine[],
  released: ReadonlyMap<string, ComparableLine>,
): DaySummary[] {
  const byDate = new Map<string, DaySummary & { _employees: Set<string> }>();
  for (const line of lines) {
    const releasedDays = releasedDaysOf(line, released);
    for (const date of line.dates) {
      const row =
        byDate.get(date) ??
        { _employees: new Set<string>(), amount: 0, date, employeeCount: 0, heldLineCount: 0, lineCount: 0, releasedAmount: 0, releasedLineCount: 0, state: "not_released" as const };
      byDate.set(date, row);
      row.lineCount += 1;
      row._employees.add(line.employeeHrIdCompact);
      if (line.amountUnknown === true) {
        row.heldLineCount += 1;
        continue;
      }
      const day = dayFigureOf(line, date);
      const amount = day?.amount ?? 0;
      row.amount = round2(row.amount + amount);
      if (releasedDays.has(date)) {
        row.releasedLineCount += 1;
        row.releasedAmount = round2(row.releasedAmount + amount);
      }
    }
  }
  return [...byDate.values()]
    .map(({ _employees, ...row }) => {
      const pricedLines = row.lineCount - row.heldLineCount;
      const state: DaySummary["state"] =
        row.releasedLineCount === 0 ? "not_released" : row.releasedLineCount >= pricedLines ? "released" : "partly_released";
      return { ...row, employeeCount: _employees.size, state };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * The lines a "Release" click should send: everything in the selection that is not already released
 * as-is, and that has an amount. A line with no computable amount stays back until the salary is on
 * file — releasing it would email the employee "EGP 0.00", or a total missing the unpriced part.
 */
export function linesToRelease<T extends ComparableLine>(
  selected: readonly T[],
  released: ReadonlyMap<string, ComparableLine>,
): T[] {
  return selected.filter((line) => line.amountUnknown !== true && releaseStateOf(line, released) !== "released");
}
