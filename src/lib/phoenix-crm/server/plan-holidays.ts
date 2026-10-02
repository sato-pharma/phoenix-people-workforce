/**
 * Phoenix CRM — the public holidays inside a plan week.
 *
 * Owner, 2026-10-02: Thursday 8 October (Armed Forces Day, the day off he moved from 6 October)
 * could be planned like any working day. The Suggest button filled it, and one rep put two
 * customers on it.
 *
 * The days come from `getConfirmedNationalHolidays`, the reader the call rate and payroll use. So
 * the 6 → 8 October move he confirmed is the day the plan greys out, and 6 October stays a working
 * day. A holiday holds no customers:
 *   - its `listTypes` are empty, as on a Friday, so Suggest, every copy and the day's own list skip it;
 *   - the day picker shows it greyed as a day off;
 *   - a save that still names it is refused with a sentence (`resolvePlanItems`).
 *
 * NEVER THROWS. The calendar is read over the network. A month it cannot read gives no holiday, so
 * the day stays plannable, as before this file existed. Here that is the safe direction: a missed
 * holiday leaves a day open that should be greyed, and blocks nothing the rep wants to do.
 */

import { expandHolidayDates } from "@/lib/crm/call-rate";
import { logError } from "@/lib/observability/log";
import { getConfirmedNationalHolidays } from "@/lib/vacation/national-holidays";

/** Every `{ month, year }` between two ISO days, inclusive. String arithmetic — no timezone can move a month. */
function monthsBetween(dateFrom: string, dateTo: string): Array<{ month: number; year: number }> {
  const months: Array<{ month: number; year: number }> = [];
  let year = Number(dateFrom.slice(0, 4));
  let month = Number(dateFrom.slice(5, 7));
  const endYear = Number(dateTo.slice(0, 4));
  const endMonth = Number(dateTo.slice(5, 7));
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

/** The public holidays between two days, as `day → its name`. Days outside the range are harmless and kept. */
export async function loadPlanHolidays(dateFrom: string, dateTo: string): Promise<Map<string, string>> {
  const holidays = new Map<string, string>();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo) || dateFrom > dateTo) return holidays;
  const results = await Promise.all(
    monthsBetween(dateFrom, dateTo).map((period) =>
      getConfirmedNationalHolidays(period).catch((error: unknown) => {
        logError("Phoenix CRM plan could not read the holiday calendar", {
          error,
          labels: { event: "phoenix_crm_plan_holidays_failed", month: `${period.year}-${period.month}` },
        });
        return null;
      }),
    ),
  );
  for (const result of results) {
    for (const holiday of result?.holidays ?? []) {
      for (const day of expandHolidayDates([holiday])) {
        if (!holidays.has(day)) holidays.set(day, holiday.name);
      }
    }
  }
  return holidays;
}
