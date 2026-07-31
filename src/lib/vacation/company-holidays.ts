/**
 * Company-specific holidays / closures (e.g. an extended Eid break) that are NOT present
 * in Google's Egypt public-holiday calendar. These merge into getEgyptianNationalHolidays,
 * so they are treated as national vacations everywhere they matter — Workforce Compliance
 * (never a working/absence day) and vacation handling.
 *
 * To add or change a company holiday, edit the COMPANY_HOLIDAYS list below. Dates are
 * inclusive and ISO formatted (YYYY-MM-DD); omit `endDate` for a single day.
 */
export type CompanyHoliday = {
  endDate?: string;
  name: string;
  startDate: string;
};

export const COMPANY_HOLIDAYS: readonly CompanyHoliday[] = [
  // Eid al-Adha 2026 company closure (26–31 May) — wider than the public-calendar days.
  { endDate: "2026-05-31", name: "Eid al-Adha (company closure)", startDate: "2026-05-26" },
];

/**
 * Egypt's FIXED-DATE public holidays (same Gregorian day every year). Deliberately NOT part of
 * COMPANY_HOLIDAYS: these DO exist in Google's calendar, so they must never be merged into a
 * successful lookup (that would duplicate them). They are used ONLY as a degraded-mode fallback
 * when the Google calendar cannot be read at all — before this, that fallback was effectively
 * empty and a national holiday silently became an ordinary working day for the whole field force.
 *
 * The moving Islamic/Coptic holidays (Eid al-Fitr, Eid al-Adha, Islamic New Year, Prophet's
 * Birthday, Coptic Easter / Sham Ennessim) cannot be derived from a Gregorian rule and are still
 * missing in degraded mode — which is exactly why money-safe consumers must additionally gate on
 * `calendarReachable` rather than treat this fallback as complete.
 */
const EGYPT_FIXED_DATE_PUBLIC_HOLIDAYS: readonly { day: number; month: number; name: string }[] = [
  { day: 7, month: 1, name: "Coptic Christmas" },
  { day: 25, month: 1, name: "Revolution Day / National Police Day" },
  { day: 25, month: 4, name: "Sinai Liberation Day" },
  { day: 1, month: 5, name: "Labour Day" },
  { day: 30, month: 6, name: "June 30 Revolution" },
  { day: 23, month: 7, name: "July 23 Revolution" },
  { day: 6, month: 10, name: "Armed Forces Day" },
];

/**
 * The fixed-date Egyptian public holidays falling in the given month, as CompanyHoliday rows.
 * Degraded-mode only — see EGYPT_FIXED_DATE_PUBLIC_HOLIDAYS.
 */
export function getEgyptFixedPublicHolidaysForMonth(input: { month: number; year: number }): CompanyHoliday[] {
  return EGYPT_FIXED_DATE_PUBLIC_HOLIDAYS.filter((holiday) => holiday.month === input.month).map((holiday) => ({
    name: holiday.name,
    startDate: `${input.year}-${String(holiday.month).padStart(2, "0")}-${String(holiday.day).padStart(2, "0")}`,
  }));
}

function lastDayOfMonthIso(year: number, month: number): string {
  const firstOfNextMonth = new Date(Date.UTC(year, month, 1));
  return new Date(firstOfNextMonth.getTime() - 86_400_000).toISOString().slice(0, 10);
}

/** Returns the configured company holidays that overlap the given month. */
export function getCompanyHolidaysForMonth(input: { month: number; year: number }): CompanyHoliday[] {
  const monthStart = `${input.year}-${String(input.month).padStart(2, "0")}-01`;
  const monthEnd = lastDayOfMonthIso(input.year, input.month);
  return COMPANY_HOLIDAYS.filter((holiday) => {
    const end = holiday.endDate ?? holiday.startDate;
    return holiday.startDate <= monthEnd && end >= monthStart;
  });
}
