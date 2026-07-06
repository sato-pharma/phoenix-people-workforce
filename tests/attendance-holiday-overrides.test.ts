import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { applyHolidayOverrides } from "../src/lib/vacation/holiday-override-store.ts";

/**
 * Contract guards for admin-confirmed holiday overrides
 * (src/lib/vacation/holiday-override-store.ts): observed/postponed dates
 * layered on top of the raw Google/company holiday source
 * (src/lib/vacation/national-holidays.ts), centralized there via
 * getConfirmedNationalHolidays so every calendar/plan/attendance/vacation
 * consumer sees the same confirmed date, not just attendance.
 */
export function runAttendanceHolidayOverridesTests() {
  // 1. Pure logic: a postponed holiday moves off its official date onto the
  //    observed date, carrying the (possibly admin-edited) name with it.
  const shifted = new Map([["2026-07-10", "Eid al-Adha"]]);
  applyHolidayOverrides(shifted, [
    { holidayName: "Eid al-Adha (observed)", id: 1, notes: null, observedDate: "2026-07-12", observedEndDate: "2026-07-12", officialDate: "2026-07-10" },
  ]);
  assert.equal(shifted.has("2026-07-10"), false, "the official date must revert to a normal working day once postponed");
  assert.equal(shifted.get("2026-07-12"), "Eid al-Adha (observed)", "the observed date must carry the (possibly renamed) holiday");

  // 2. A same-day "confirmation" override (observed === official) is a no-op
  //    shift but still applies the admin's name.
  const confirmed = new Map([["2026-01-07", "Coptic Christmas"]]);
  applyHolidayOverrides(confirmed, [
    { holidayName: "Coptic Christmas (confirmed)", id: 2, notes: null, observedDate: "2026-01-07", observedEndDate: "2026-01-07", officialDate: "2026-01-07" },
  ]);
  assert.equal(confirmed.get("2026-01-07"), "Coptic Christmas (confirmed)");
  assert.equal(confirmed.size, 1, "a same-day override must not create a duplicate entry");

  // 3. Multiple overrides apply independently.
  const multi = new Map([
    ["2026-04-25", "Sinai Liberation Day"],
    ["2026-05-01", "Labour Day"],
  ]);
  applyHolidayOverrides(multi, [
    { holidayName: "Sinai Liberation Day (observed)", id: 3, notes: null, observedDate: "2026-04-26", observedEndDate: "2026-04-26", officialDate: "2026-04-25" },
  ]);
  assert.equal(multi.has("2026-04-25"), false);
  assert.equal(multi.get("2026-04-26"), "Sinai Liberation Day (observed)");
  assert.equal(multi.get("2026-05-01"), "Labour Day", "an unrelated holiday must be untouched");

  const store = readFileSync("src/lib/vacation/holiday-override-store.ts", "utf8");
  const nationalHolidays = readFileSync("src/lib/vacation/national-holidays.ts", "utf8");

  // 4. getConfirmedNationalHolidays is the single source every calendar/plan/
  //    vacation/attendance/field-workforce-compliance consumer must call, and
  //    it fails open (no overrides) rather than breaking every consumer if
  //    the config table isn't reachable.
  assert.match(
    nationalHolidays,
    /listHolidayOverridesOverlappingRange\(monthStart, monthEnd\)\.catch\(\(\) => \[\]\)/,
    "getConfirmedNationalHolidays must fail open to no overrides, not throw and break every consumer",
  );
  assert.match(
    nationalHolidays,
    /export async function getConfirmedNationalHolidays/,
    "national-holidays.ts must expose the centralized confirmed-holiday function",
  );

  // 5. working-days.ts (attendance) must call the centralized confirmed
  //    source, not the raw one directly, and must not duplicate its own
  //    separate override-fetch-and-apply pass anymore.
  const workingDays = readFileSync("src/lib/attendance/working-days.ts", "utf8");
  assert.match(
    workingDays,
    /getConfirmedNationalHolidays\(entry\)\.catch\(\(\) => null\)/,
    "buildAttendanceCalendarContext must source holidays from getConfirmedNationalHolidays, not the raw getEgyptianNationalHolidays",
  );
  assert.doesNotMatch(
    workingDays,
    /getEgyptianNationalHolidays/,
    "attendance must not call the raw holiday source directly — it would bypass System Admin confirmation",
  );

  // 6. Bulk upsert is keyed on official_date (one override per official
  //    holiday, editable, not append-only), and the observed period is a
  //    range (some national vacations span more than one day).
  assert.match(store, /onConflict: "official_date"/, "bulkUpsertHolidayOverrides must upsert by official_date, not insert duplicates on re-save");
  assert.match(store, /observedEndDate/, "the confirmed observed period must be a range (observedDate..observedEndDate), not a single day");

  // 7. Routes registered with the correct read/update split.
  const registry = readFileSync("src/lib/security/access-registry.ts", "utf8");
  assert.match(
    registry,
    /pattern: "\/api\/attendance\/holiday-calendar", permission: \{ resource: "employees", action: "read" \}/,
    "GET /api/attendance/holiday-calendar must require read permission",
  );
  assert.match(
    registry,
    /methods: \["POST"\], pattern: "\/api\/attendance\/holiday-calendar", permission: \{ resource: "employees", action: "update" \}.*csrfRequired: true/,
    "POST /api/attendance/holiday-calendar must require update permission and CSRF protection",
  );

  const route = readFileSync("app/api/attendance/holiday-calendar/route.ts", "utf8");
  assert.match(route, /assertSameOriginMutation\(request\)/, "the bulk-save route must enforce same-origin CSRF protection");
  assert.match(route, /assertAttendanceSetupPermission\(access, "update"\)/, "the bulk-save route must require update permission, not just read");
}
