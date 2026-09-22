import { currentCairoDateParts } from "@/lib/i18n/format";

/**
 * The payroll period an outstation trip or expense pays out in — the trip/expense month + 1,
 * resolved on Africa/Cairo's calendar day, never the server's UTC clock.
 *
 * A trip/expense date is stored at UTC-midnight today, so the Cairo anchor is a no-op for it — but
 * the upstream `created_at` fallback (used when trip_start_date is null) is a real instant. Read in
 * UTC, one stamped in the first Cairo hours of the 1st would land in the previous month and pay out
 * a month early; reading it in Cairo closes that gap. An unparseable value falls back to "now",
 * exactly as the two inline copies this helper replaced did.
 *
 * Extracted from `payroll-expense-mapping.ts` and `expenses.ts`, which each held a byte-identical
 * private copy — a future edit to one and not the other would silently mis-date a payout.
 */
export function nextPayrollPeriod(dateValue: string): { month: number; year: number } {
  const date = new Date(dateValue);
  const cairo = currentCairoDateParts(Number.isNaN(date.getTime()) ? new Date() : date);
  const base = new Date(Date.UTC(cairo.year, cairo.month - 1, cairo.day));
  const month = base.getUTCMonth() + 2;

  if (month > 12) {
    return { month: 1, year: base.getUTCFullYear() + 1 };
  }

  return { month, year: base.getUTCFullYear() };
}
