// Bulk holiday calendar: admin-configured observed/postponed dates for
// official holidays, layered on top of the raw Google/company holiday
// source (national-holidays.ts) used by buildAttendanceCalendarContext.
//
// The actual read/write primitives live in
// @/lib/vacation/holiday-override-store (not attendance-specific — the same
// confirmed dates drive calendars, weekly/monthly plans, and vacation, not
// just attendance) so that national-holidays.ts can apply them without a
// circular import. Re-exported here so existing imports keep working.

import { getEgyptianNationalHolidays } from "@/lib/vacation/national-holidays";
import { listHolidayOverridesForYear } from "@/lib/vacation/holiday-override-store";

export {
  bulkUpsertHolidayOverrides,
  listHolidayOverridesForYear,
  listHolidayOverridesOverlappingRange,
} from "@/lib/vacation/holiday-override-store";
export type { HolidayOverride, HolidayOverrideInput } from "@/lib/vacation/holiday-override-store";

export type HolidayCalendarYearRow = {
  officialDate: string;
  /** Defaults to officialDate until an admin override is saved. */
  observedDate: string;
  /** Defaults to observedDate (single day) until an admin override is saved. */
  observedEndDate: string;
  holidayName: string;
  source: "company" | "google_calendar";
  notes: string | null;
  hasOverride: boolean;
};

/**
 * The whole year's computed holidays (Google + company), each pre-filled
 * with its saved observed-date override if one exists — the row set the
 * bulk holiday calendar admin UI reviews and edits in one pass.
 */
export async function buildHolidayCalendarYearView(year: number): Promise<{ rows: HolidayCalendarYearRow[]; sourceConnected: boolean }> {
  const monthResults = await Promise.all(
    Array.from({ length: 12 }, (_, index) => getEgyptianNationalHolidays({ month: index + 1, year }).catch(() => null)),
  );

  const byOfficialDate = new Map<string, HolidayCalendarYearRow>();
  let sourceConnected = true;
  for (const result of monthResults) {
    if (!result) {
      sourceConnected = false;
      continue;
    }
    if (!result.connected) sourceConnected = false;
    for (const holiday of result.holidays) {
      if (byOfficialDate.has(holiday.startDate)) continue;
      byOfficialDate.set(holiday.startDate, {
        hasOverride: false,
        holidayName: holiday.name,
        notes: null,
        observedDate: holiday.startDate,
        observedEndDate: holiday.startDate,
        officialDate: holiday.startDate,
        source: holiday.source,
      });
    }
  }

  const overrides = await listHolidayOverridesForYear(year).catch(() => []);
  for (const override of overrides) {
    const existing = byOfficialDate.get(override.officialDate);
    byOfficialDate.set(override.officialDate, {
      hasOverride: true,
      holidayName: override.holidayName,
      notes: override.notes,
      observedDate: override.observedDate,
      observedEndDate: override.observedEndDate,
      officialDate: override.officialDate,
      source: existing?.source ?? "company",
    });
  }

  return {
    rows: Array.from(byOfficialDate.values()).sort((left, right) => left.officialDate.localeCompare(right.officialDate)),
    sourceConnected,
  };
}
