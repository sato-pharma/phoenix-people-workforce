// The Details tab is ONE month. The Closing Matrix beside it can be several.
//
// The Details tab exists so the invoice lines under the headline can be checked without leaving the
// page — "Matrix = the published headline, Details = the invoice lines underneath it". That only
// holds while both describe the same months, and they stop doing so the moment the picker's
// "Several months" side is used: mergeMonthlyClosingPeriods sets the merged matrix's `period` to the
// LAST month of the span (periods[periods.length - 1]), the workspace hands that single month to
// ClosingDetailsPanel, and the panel loads, totals, filters and exports that month alone.
//
// 🔴 NOTHING ON SCREEN SAID SO. A reader who had just been looking at a three-month matrix opened
// Details, saw rows, four summary cards and an Export XLSX button, and had no way to tell that all
// of it was September while the totals above it were July + August + September. The rows were never
// wrong — they were unlabelled, which on a page whose whole purpose is reconciliation reads as
// disagreement between the two tabs.
//
// Naming the month is the fix: a span cannot be shown in the Details grain without re-querying
// every month behind it, and the owner's rule is that a closing figure comes from the closing
// engine, not from a second query beside it.

import { describePeriodSelection, periodLabel } from "@/lib/sales/monthly-closing-period-merge";

/**
 * The sentence shown above the Details rows when the matrix beside them covers several months, or
 * null when there is nothing to disclose (one month in view, or no month at all).
 *
 * `periodsInView` is what the matrix is showing — `matrix.periods` when a span is folded together,
 * otherwise the single month. `period` is the month the Details rows were actually loaded for.
 */
export function describeClosingDetailsSpan(input: {
  period?: string | null;
  periodsInView?: readonly string[] | null;
}): string | null {
  const period = String(input.period ?? "").trim();
  const inView = Array.from(new Set((input.periodsInView ?? []).map((value) => String(value ?? "").trim()).filter(Boolean)));
  if (!period || inView.length < 2) return null;

  const others = inView.filter((value) => value !== period).length;
  return `These rows, their four totals and the Export XLSX beside them are ${periodLabel(period)} only. `
    + `The Closing Matrix covers ${describePeriodSelection(inView)} — ${others} further `
    + `${others === 1 ? "month is" : "months are"} in those figures and not in these.`;
}
