import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { applyHolidayOverrides } from "../src/lib/attendance/holiday-overrides.ts";

/**
 * Contract guards for the bulk holiday calendar
 * (src/lib/attendance/holiday-overrides.ts): admin-configured observed/
 * postponed dates layered on top of the raw Google/company holiday source
 * used across every attendance calendar consumer.
 */
export function runAttendanceHolidayOverridesTests() {
  // 1. Pure logic: a postponed holiday moves off its official date onto the
  //    observed date, carrying the (possibly admin-edited) name with it.
  const shifted = new Map([["2026-07-10", "Eid al-Adha"]]);
  applyHolidayOverrides(shifted, [
    { holidayName: "Eid al-Adha (observed)", id: 1, notes: null, observedDate: "2026-07-12", officialDate: "2026-07-10" },
  ]);
  assert.equal(shifted.has("2026-07-10"), false, "the official date must revert to a normal working day once postponed");
  assert.equal(shifted.get("2026-07-12"), "Eid al-Adha (observed)", "the observed date must carry the (possibly renamed) holiday");

  // 2. A same-day "confirmation" override (observed === official) is a no-op
  //    shift but still applies the admin's name.
  const confirmed = new Map([["2026-01-07", "Coptic Christmas"]]);
  applyHolidayOverrides(confirmed, [
    { holidayName: "Coptic Christmas (confirmed)", id: 2, notes: null, observedDate: "2026-01-07", officialDate: "2026-01-07" },
  ]);
  assert.equal(confirmed.get("2026-01-07"), "Coptic Christmas (confirmed)");
  assert.equal(confirmed.size, 1, "a same-day override must not create a duplicate entry");

  // 3. Multiple overrides apply independently.
  const multi = new Map([
    ["2026-04-25", "Sinai Liberation Day"],
    ["2026-05-01", "Labour Day"],
  ]);
  applyHolidayOverrides(multi, [
    { holidayName: "Sinai Liberation Day (observed)", id: 3, notes: null, observedDate: "2026-04-26", officialDate: "2026-04-25" },
  ]);
  assert.equal(multi.has("2026-04-25"), false);
  assert.equal(multi.get("2026-04-26"), "Sinai Liberation Day (observed)");
  assert.equal(multi.get("2026-05-01"), "Labour Day", "an unrelated holiday must be untouched");

  const service = readFileSync("src/lib/attendance/holiday-overrides.ts", "utf8");

  // 4. working-days.ts applies overrides on top of the raw source and fails
  //    open (no overrides) rather than breaking every attendance calendar
  //    consumer if the config table isn't reachable.
  const workingDays = readFileSync("src/lib/attendance/working-days.ts", "utf8");
  assert.match(
    workingDays,
    /listHolidayOverridesOverlappingRange\(input\.dateFromIso, input\.dateToIso\)\.catch\(\(\) => \[\]\)/,
    "buildAttendanceCalendarContext must fail open to no overrides, not throw and break every attendance calendar consumer",
  );
  assert.match(workingDays, /applyHolidayOverrides\(holidaysByDate, overrides\)/, "buildAttendanceCalendarContext must apply the overrides onto the built holiday map");

  // 5. Bulk upsert is keyed on official_date (one override per official
  //    holiday, editable, not append-only).
  assert.match(service, /onConflict: "official_date"/, "bulkUpsertHolidayOverrides must upsert by official_date, not insert duplicates on re-save");

  // 6. Routes registered with the correct read/update split.
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
