// ─────────────────────────────────────────────────────────────────────────────
// The reader half of the call-rate HOLIDAY rule. The arithmetic lives in
// crm/call-rate.ts, which is pure; this file only fetches the days.
//
// THE RULE (owner, 2026-09-02): a national holiday comes out of the call-rate
// denominator, so a five-day week containing one becomes a four-day week. The
// rep's own approved leave does NOT come out — see countCallRateWorkingDays.
//
// WHY THE `complete` FLAG IS NOT OPTIONAL DECORATION. getConfirmedNationalHolidays
// merges two sources: the Google Egypt holiday calendar and the company's own
// confirmed overrides. When the calendar is unreachable it does NOT throw — it
// returns successfully carrying ONLY the company entries, with every public
// holiday missing and `calendarReachable` false. That failure is invisible in the
// data and lands on the wrong side here: a missing holiday stays in the
// denominator, so every rep's call rate reads LOW for that month. The board would
// then be accusing the whole field force of under-calling because Google was down.
//
// So this reader reports `complete`, and a caller that renders a rate MUST say so
// when it is false. The same flag is what the payroll deduction path gates on, for
// the same reason, and its header says so from the money side.
//
// The holidays that WERE read are still subtracted when `complete` is false. A
// company-confirmed override is the most authoritative day off there is, and
// dropping it too would trade one wrong denominator for another.
// ─────────────────────────────────────────────────────────────────────────────

import { expandHolidayDates, type CallRateHolidays } from "@/lib/crm/call-rate";
import { getConfirmedNationalHolidays } from "@/lib/vacation/national-holidays";

export type CallRateHolidayLookup = {
  /** Every national-holiday day touching the period, as `YYYY-MM-DD`. */
  dates: CallRateHolidays;
  /**
   * True only when every month in the range was read from a reachable holiday
   * calendar. False means the set may be short and the denominator too generous —
   * the UI must say so rather than print a rate that looks authoritative.
   */
  complete: boolean;
};

/** Every `YYYY-MM` between two dates, inclusive. String arithmetic — no Date parsing, so no
 * timezone can shift a month boundary. */
function monthsBetween(dateFrom: string, dateTo: string): { month: number; year: number }[] {
  const months: { month: number; year: number }[] = [];
  let year = Number(dateFrom.slice(0, 4));
  let month = Number(dateFrom.slice(5, 7));
  const endYear = Number(dateTo.slice(0, 4));
  const endMonth = Number(dateTo.slice(5, 7));
  // A malformed bound yields NaN; bail rather than loop forever.
  if (![year, month, endYear, endMonth].every(Number.isFinite)) return months;
  while (year < endYear || (year === endYear && month <= endMonth)) {
    months.push({ month, year });
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

/**
 * The national-holiday days overlapping `[dateFrom, dateTo]`.
 *
 * Reads per calendar month because that is the shape the holiday source offers.
 * A period spanning a month boundary therefore costs more than one read; periods
 * here are a week or a month, so that is at most two.
 *
 * Never throws. A month that fails to read contributes no days and turns
 * `complete` false, because an exception here would take down a KPI board over a
 * holiday calendar — and the honest degraded answer is the pre-2026-09-02
 * denominator plus a visible warning.
 */
export async function loadCallRateHolidays(
  dateFrom: string,
  dateTo: string,
): Promise<CallRateHolidayLookup> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo) || dateFrom > dateTo) {
    return { complete: false, dates: new Set<string>() };
  }

  const months = monthsBetween(dateFrom, dateTo);
  if (months.length === 0) return { complete: false, dates: new Set<string>() };

  const results = await Promise.all(
    months.map((month) =>
      getConfirmedNationalHolidays(month)
        .then((result) => ({ holidays: result.holidays, reachable: result.calendarReachable }))
        .catch(() => ({ holidays: [], reachable: false })),
    ),
  );

  const dates = expandHolidayDates(results.flatMap((result) => result.holidays));
  // Days outside the period are harmless — countCallRateWorkingDays only ever asks about days it is
  // already walking — so they are left in rather than filtered, which keeps this reader cheap and
  // means a caller can reuse one lookup across several periods inside the same months.
  return { complete: results.every((result) => result.reachable), dates };
}
