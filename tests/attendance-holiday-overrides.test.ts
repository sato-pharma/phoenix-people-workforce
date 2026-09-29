import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { applyHolidayOverrides, holidayOverrideOverlapsRange } from "../src/lib/vacation/holiday-override-store.ts";

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

  // 8. THE RANGE PREDICATE MOVED INTO MEMORY AND MUST STILL MEAN WHAT THE SQL MEANT.
  //
  //    This read was the busiest query in the system: 199,148 requests in 24h of production edge
  //    logs (2026-09-29), 16% of all Supabase traffic, against a 2-row table unchanged in six
  //    weeks — because getConfirmedNationalHolidays is called ONE MONTH AT A TIME by every
  //    calendar, plan, attendance, vacation and compliance surface, and only its Google half was
  //    cached. The table is now read once and filtered in memory, so the filter must reproduce
  //    the old SQL exactly:
  //      or( and(official_date >= from, official_date <= to),
  //          and(observed_date <= to, observed_end_date >= from) )
  const ov = (officialDate: string, observedDate: string, observedEndDate = observedDate) =>
    ({ observedDate, observedEndDate, officialDate });
  const JUL = ["2026-07-01", "2026-07-31"] as const;

  assert.equal(
    holidayOverrideOverlapsRange(ov("2026-07-10", "2026-08-02"), ...JUL),
    true,
    "an override whose OFFICIAL date is in the window must match — July loses a day off it used to have",
  );
  assert.equal(
    holidayOverrideOverlapsRange(ov("2026-06-30", "2026-07-02"), ...JUL),
    true,
    "an override whose OBSERVED date lands in the window must match — July gains a day off",
  );
  assert.equal(
    holidayOverrideOverlapsRange(ov("2026-06-25", "2026-06-28", "2026-07-01"), ...JUL),
    true,
    "a multi-day observed span overlapping the window by ONE day must match",
  );
  assert.equal(
    holidayOverrideOverlapsRange(ov("2026-05-01", "2026-05-03"), ...JUL),
    false,
    "an override with neither its official date nor its observed span in the window must NOT match",
  );
  assert.equal(
    holidayOverrideOverlapsRange(ov("2026-07-31", "2026-07-31"), ...JUL),
    true,
    "the range ends are INCLUSIVE, exactly as .gte/.lte were",
  );
  assert.equal(
    holidayOverrideOverlapsRange(ov("2026-08-01", "2026-08-01"), ...JUL),
    false,
    "the day after the window must not match",
  );

  // 9. THE READ IS CACHED AND THE WRITE DROPS IT.
  //    Asserted against the source because the defect is structural: a per-range query shares
  //    nothing between callers however fast each individual one is. Verified RED by restoring
  //    the old `.or(...)` range query — 9a fires on it.
  assert.doesNotMatch(
    store,
    /\.or\(\s*`?and\(official_date/,
    "listHolidayOverridesOverlappingRange must NOT issue a per-range .or() query — it was the "
      + "busiest statement in the instance. Read the table once and filter in memory.",
  );
  assert.match(
    store,
    /holidayOverrideCache = \{ expiresAt:/,
    "the whole-table read must populate a TTL cache",
  );
  assert.match(
    store,
    /if \(error\) throw error;\s*\n\s*const rows =/,
    "a failed read must throw BEFORE the cache is written — never pin an empty calendar for the TTL",
  );
  const upsertBody = store.slice(store.indexOf("export async function bulkUpsertHolidayOverrides"));
  assert.match(
    upsertBody,
    /invalidateHolidayOverrideCache\(\)/,
    "bulkUpsertHolidayOverrides must invalidate the cache after writing, or an admin reads back "
      + "their own confirmation stale",
  );
  // Positive control: the table IS still read in this module, so 9a cannot pass merely because
  // the query was deleted outright or renamed.
  assert.match(
    store,
    /\.from\("attendance_holiday_overrides"\)\s*\n\s*\.select\(/,
    "the module must still read the table — once, unfiltered",
  );
}
