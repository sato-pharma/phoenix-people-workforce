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
