import {
  normalizeHolidayName,
  substitutedHolidayName,
  type EgyptianNationalHoliday,
} from "@/lib/vacation/national-holidays";

// The National Holidays tab on Vacation Request, as an employee reads it. Display only: every
// holiday rule (which days are off, how many leave days a request costs) reads
// getConfirmedNationalHolidays directly and never this list.
//
// Two things the raw list does that an employee must not see:
//   - A confirmed day off is injected from attendance_holiday_overrides with that row's NOTES as
//     its description. Those notes are written by the administrator who confirmed the date — an
//     internal remark, not text for employees — so a confirmed row carries no description here.
//   - Two confirmed rows can land on the same day (on 8 Oct 2026: "Armed Forces Day", confirmed off
//     its 6 Oct date, and "Day off for Armed Forces Day"). Both are injected on purpose so neither
//     holiday silently disappears behind the other in the rules; on screen they are one day off, so
//     rows covering the same span are shown once.

const CONFIRMED_ROW_PREFIX = "override-";

function spanKey(holiday: EgyptianNationalHoliday): string {
  return `${holiday.startDate}..${holiday.endDate ?? holiday.startDate}`;
}

/** The name a row stands for: "Day off for Armed Forces Day" stands for "Armed Forces Day". */
function holidayKey(name: string): string {
  return substitutedHolidayName(name) ?? normalizeHolidayName(name);
}

function mergedName(rows: EgyptianNationalHoliday[]): string {
  const names: string[] = [];
  const seen = new Set<string>();
  // The holiday's own name before its "Day off for …" twin, so the twin collapses into it.
  const ordered = [...rows].sort(
    (left, right) => Number(substitutedHolidayName(left.name) !== null) - Number(substitutedHolidayName(right.name) !== null),
  );
  for (const row of ordered) {
    const key = holidayKey(row.name);
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(row.name.trim());
  }
  return names.join(" / ");
}

export function employeeHolidayList(holidays: readonly EgyptianNationalHoliday[]): EgyptianNationalHoliday[] {
  const groups = new Map<string, EgyptianNationalHoliday[]>();
  for (const holiday of holidays) {
    const row = holiday.id.startsWith(CONFIRMED_ROW_PREFIX) ? { ...holiday, description: null } : holiday;
    const key = spanKey(row);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  const list: EgyptianNationalHoliday[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      list.push(group[0]);
      continue;
    }
    const descriptions = [...new Set(group.map((row) => row.description).filter((value): value is string => Boolean(value)))];
    list.push({
      ...group[0],
      description: descriptions.length > 0 ? descriptions.join(" ") : null,
      id: group.map((row) => row.id).join("+"),
      name: mergedName(group),
    });
  }
  return list.sort((left, right) => left.startDate.localeCompare(right.startDate));
}
