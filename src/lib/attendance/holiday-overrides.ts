// Bulk holiday calendar: admin-configured observed/postponed dates for
// official holidays, layered on top of the raw Google/company holiday
// source (national-holidays.ts) used by buildAttendanceCalendarContext.
//
// The actual read/write primitives live in
// @/lib/vacation/holiday-override-store (not attendance-specific — the same
// confirmed dates drive calendars, weekly/monthly plans, and vacation, not
// just attendance) so that national-holidays.ts can apply them without a
// circular import. Re-exported here so existing imports keep working.

import { getEgyptianNationalHolidays, normalizeHolidayName, substitutedHolidayName } from "@/lib/vacation/national-holidays";
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

  // A HOLIDAY GOOGLE HAS ALREADY MOVED OPENS ON ITS SUBSTITUTE DATE, NOT ON ITS OFFICIAL ONE.
  //
  // Google states a postponement as a second event, `Day off for <X>`, on the substitute date
  // (see substitutedHolidayName — it is why 6 AND 8 October both read as days off on
  // 2026-10-01). getConfirmedNationalHolidays folds that pair at read time, but this page is
  // where the pair is CONFIRMED, and "Save All Changes" writes every row it is showing. Left
  // defaulting to the official date, one click would pin `<X>` back onto a day the government
  // has moved and the fold would then stand down, because an override is authoritative. So the
  // official row opens pre-filled with the substitute's date and its "Postponed" chip, and a
  // save-all confirms what the calendar actually says. It is a DEFAULT, not a confirmation:
  // hasOverride stays false, the row still reads "Awaiting confirmation", and an admin who
  // knows better types over it.
  const substituteDateByName = new Map<string, string>();
  for (const row of byOfficialDate.values()) {
    const superseded = substitutedHolidayName(row.holidayName);
    if (superseded) substituteDateByName.set(superseded, row.officialDate);
  }
  for (const row of byOfficialDate.values()) {
    const substituteDate = substituteDateByName.get(normalizeHolidayName(row.holidayName));
    if (!substituteDate || substituteDate === row.officialDate) continue;
    row.observedDate = substituteDate;
    row.observedEndDate = substituteDate;
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
