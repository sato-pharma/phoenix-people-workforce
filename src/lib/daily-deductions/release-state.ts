// Daily Deductions module: what state is each tally line in, against what has been released?
//
// Pure and browser-safe (no database, no server-only import): the workspace uses it to colour and
// enable each line's Release button, and the unit tests load it directly.
//
// A line is identified by employee x category (the snapshot's unique key). It is:
//   - "not_released" - nothing for that employee x category is in the active snapshot;
//   - "released"     - the snapshot holds the same figures the tally shows now;
//   - "changed"      - the snapshot holds this line, but the tally now counts differently
//                      (a day was added or cleared since it was released), so it can be re-released.

import type { DailyDeductionCategory } from "./types.ts";

export type ReleaseState = "not_released" | "released" | "changed";

type KeyedLine = { category: DailyDeductionCategory | string; employeeHrIdCompact: string };

export type ComparableLine = KeyedLine & {
  daysCount: number;
  amount: number;
  dates: string[];
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
  return sameFigures(tally, match) ? "released" : "changed";
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
