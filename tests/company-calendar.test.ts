import assert from "node:assert/strict";

import {
  buildMonthGrid,
  canManageCompanyCalendar,
  canPublishCompanyWide,
  dateInRange,
  monthBounds,
  monthDayKey,
  normalizeCalendarCategory,
  rangesOverlap,
} from "../src/lib/calendar/logic.ts";

export function runCompanyCalendarTests() {
  // Manage permission: admins + managers yes, plain staff no.
  assert.equal(canManageCompanyCalendar("Super Admin"), true);
  // Neither HR bundle manages the company calendar today. Whether HR Operations should — she owns
  // attendance and holidays — is a Phase 3 grants decision, not something to widen inside a rename.
  assert.equal(canManageCompanyCalendar("HR Advisory"), false);
  assert.equal(canManageCompanyCalendar("HR Operations"), false);
  assert.equal(canManageCompanyCalendar("CEO"), true);
  assert.equal(canManageCompanyCalendar("National Sales Manager"), true);
  assert.equal(canManageCompanyCalendar("District Manager"), true);
  assert.equal(canManageCompanyCalendar("Employee"), false);
  assert.equal(canManageCompanyCalendar("Medical Rep"), false);

  // Company-wide publishing is admin-tier only; managers are line-scoped.
  assert.equal(canPublishCompanyWide("Super Admin"), true);
  assert.equal(canPublishCompanyWide("CEO"), true);
  assert.equal(canPublishCompanyWide("National Sales Manager"), false);
  assert.equal(canPublishCompanyWide("Employee"), false);

  // Month bounds (1-indexed month).
  assert.deepEqual(monthBounds(2026, 2), { start: "2026-02-01", end: "2026-02-28" });
  assert.deepEqual(monthBounds(2024, 2), { start: "2024-02-01", end: "2024-02-29" });
  assert.deepEqual(monthBounds(2026, 6), { start: "2026-06-01", end: "2026-06-30" });

  // Overlap + in-range helpers.
  assert.equal(rangesOverlap("2026-06-01", "2026-06-05", "2026-06-05", "2026-06-10"), true);
  assert.equal(rangesOverlap("2026-06-01", "2026-06-04", "2026-06-05", "2026-06-10"), false);
  assert.equal(dateInRange("2026-06-03", "2026-06-01", "2026-06-05"), true);
  assert.equal(dateInRange("2026-06-06", "2026-06-01", "2026-06-05"), false);

  // Month grid: always 6 weeks x 7 days, starts on a Sunday, contains the 1st.
  const grid = buildMonthGrid(2026, 6);
  assert.equal(grid.length, 6);
  assert.ok(grid.every((week) => week.length === 7));
  assert.equal(new Date(`${grid[0][0].date}T00:00:00Z`).getUTCDay(), 0);
  assert.ok(grid.flat().some((day) => day.date === "2026-06-01" && day.inMonth));
  // June 1 2026 is a Monday → first cell is May 31 (out of month).
  assert.equal(grid[0][0].date, "2026-05-31");
  assert.equal(grid[0][0].inMonth, false);

  // Category normalization + month-day key.
  assert.equal(normalizeCalendarCategory("Meeting"), "meeting");
  assert.equal(normalizeCalendarCategory("nonsense"), "other");
  assert.equal(monthDayKey("1990-06-15"), "06-15");
}
