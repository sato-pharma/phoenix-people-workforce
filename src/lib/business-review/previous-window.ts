// Business Review — what to compare this window against.
//
// Every figure on the page is a snapshot: 74.3% with nothing saying whether that is better or worse
// than before. This module decides the comparison basis, and NAMES it — the label travels with the
// delta, because two different bases under one word is how a comparison misleads.
//
// 🔴 THE REVIEW FLOOR IS JULY 2026, AND THAT IS WHY THIS IS NOT SIMPLY "THE WINDOW BEFORE".
// `REVIEW_FLOOR` in period.ts is the owner's decision (2026-08-23): nothing before July 2026 is
// comparable on this page — March to June carry no targets at all, and January and February hold
// most of the sales that can never be graded. So for the current Jul–Aug window there IS no
// previous window, and a page that silently showed "0%" or "—" against every tile would be
// answering a question it never asked.
//
// Two bases, in this order, and the label always says which one was used:
//
//   1. THE PREVIOUS EQUAL-LENGTH WINDOW, when it fits entirely above the floor. Jul–Sep compares
//      against Apr–Jun; from October a two-month window compares against the two before it.
//   2. THE PREVIOUS MONTH INSIDE THIS WINDOW, when it does not. Today that is August against July,
//      which is a real comparison out of data already loaded rather than an empty column.
//
// When neither is available — a single month at the floor — there is no comparison, and the caller
// renders nothing rather than a zero.

import { enumeratePeriods } from "@/lib/sales/sos-coverage";

import { periodLabel, windowLabel } from "./period-format";

export type ComparisonBasis =
  /** The equal-length span immediately before this window. */
  | { kind: "previous-window"; from: string; to: string; periods: string[]; label: string }
  /** The month before the last one, inside this window. */
  | { kind: "previous-month"; from: string; to: string; periods: string[]; label: string }
  | { kind: "none"; label: string; reason: string };

/** Step a "YYYY-MM" back by `months`. Pure string arithmetic — no Date, no timezone. */
export function shiftPeriod(period: string, months: number): string {
  const [yearText, monthText] = period.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return period;
  const zeroBased = year * 12 + (month - 1) + months;
  const newYear = Math.floor(zeroBased / 12);
  const newMonth = (zeroBased % 12) + 1;
  return `${String(newYear).padStart(4, "0")}-${String(newMonth).padStart(2, "0")}`;
}

/**
 * What this window should be compared against.
 *
 * `figurePeriods` is the FIGURE window — the months whose distributor files have landed — not the
 * requested one. Comparing a two-month figure window against a three-month span because the picker
 * asked for three would divide unlike things and print the difference as performance.
 *
 * `floor` is the earliest month the review may read, `REVIEW_FLOOR` unless a caller has a narrower
 * one. A basis is only offered when EVERY one of its months sits at or above it.
 */
export function comparisonBasisFor(
  figurePeriods: readonly string[],
  floor: string,
): ComparisonBasis {
  const periods = [...figurePeriods].filter(Boolean).sort();
  if (periods.length === 0) {
    return { kind: "none", label: "no comparison", reason: "This window holds no months with data." };
  }

  const length = periods.length;
  const prevTo = shiftPeriod(periods[0], -1);
  const prevFrom = shiftPeriod(periods[0], -length);

  if (prevFrom >= floor) {
    return {
      from: prevFrom,
      kind: "previous-window",
      label: windowLabel(prevFrom, prevTo),
      periods: enumeratePeriods(prevFrom, prevTo),
      to: prevTo,
    };
  }

  // The equal-length span reaches below the floor. Fall back to the month before the last one,
  // INSIDE this window — a real comparison from data already loaded.
  if (length >= 2) {
    const month = periods[length - 2];
    return {
      from: month,
      kind: "previous-month",
      label: periodLabel(month),
      periods: [month],
      to: month,
    };
  }

  return {
    kind: "none",
    label: "no comparison",
    reason:
      `The review reads no month before ${periodLabel(floor)}, and this window is a single month, ` +
      `so there is nothing above the floor to compare it against.`,
  };
}

/**
 * The delta between two figures, or null when it cannot honestly be stated.
 *
 * Null — never 0, and never "+100%" — when the earlier figure is zero or missing: a month that sold
 * nothing has no percentage to grow BY, and one small invoice against it reads as a doubling.
 */
export function deltaPct(now: number | null, before: number | null): number | null {
  if (now == null || before == null) return null;
  if (!Number.isFinite(now) || !Number.isFinite(before)) return null;
  if (before === 0) return null;
  return ((now - before) / Math.abs(before)) * 100;
}

/** The difference in PERCENTAGE POINTS, for two figures that are themselves percentages. */
export function deltaPoints(now: number | null, before: number | null): number | null {
  if (now == null || before == null) return null;
  if (!Number.isFinite(now) || !Number.isFinite(before)) return null;
  return now - before;
}

/**
 * "▲ 6.1 pts" / "▼ 11.4%" / "—". The arrow is the house's, and a change of less than a tenth reads
 * as level rather than as a direction nobody can act on.
 */
export function formatDelta(value: number | null, unit: "pts" | "%"): string {
  if (value == null) return "—";
  if (Math.abs(value) < 0.05) return `level`;
  const arrow = value > 0 ? "▲" : "▼";
  // A space before "pts" and none before "%" — the house register, and the same way every other
  // percentage on this page is written.
  const magnitude = Math.abs(value).toFixed(1);
  return unit === "pts" ? `${arrow} ${magnitude} pts` : `${arrow} ${magnitude}%`;
}
