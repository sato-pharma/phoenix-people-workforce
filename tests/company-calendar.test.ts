import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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

  // ── MY LEAVE READS `vacation_type`, AND `v2_vacation_requests` HAS NO `type` COLUMN ───────────
  // The leave read named `type` from this feature's first commit (2026-06-11) until 2026-09-30.
  // PostgREST fails the WHOLE read on a missing column — it does not null that one field — and
  // `loadLeaveItems` catches and returns [], so every employee's approved leave was silently absent
  // from their own calendar: 551 approved requests across 92 people, measured on production the day
  // it was found (by the select-auditor, not by anyone noticing). A select is a string, so nothing
  // else in the system would have caught it.
  const leaveSource = readFileSync(new URL("../src/lib/calendar/service.ts", import.meta.url), "utf8");
  const leaveSelect = /\.from\("v2_vacation_requests"\)[\s\S]{0,600}?\.select\("([^"]*)"\)/.exec(leaveSource)?.[1];
  assert.ok(leaveSelect, "the calendar's v2_vacation_requests read must still be findable");
  const leaveColumns = leaveSelect.split(",").map((c) => c.trim());
  assert.ok(
    leaveColumns.includes("vacation_type"),
    `the leave read must ask for vacation_type — got "${leaveSelect}"`,
  );
  assert.ok(
    !leaveColumns.includes("type"),
    `v2_vacation_requests has no "type" column: asking for it 42703s the whole read, and the catch turns that into an empty calendar — got "${leaveSelect}"`,
  );
  assert.ok(
    !/row\.type\b/.test(leaveSource),
    "the mapper must read row.vacation_type — row.type is undefined and would silently drop the leave label",
  );

  // ── THE CALENDAR DESK SEES EVERY LINE'S BIRTHDAYS ─────────────────────────────────────────────
  // Everybody who publishes company-wide sits on the Head Office line, so filtering birthdays by the
  // viewer's own line showed the desk Head Office birthdays and not one of the field force's (owner,
  // 2026-10-20: "others only for head office employees and you find no field force").
  const birthdayBody = /async function loadBirthdayItems[\s\S]*?\n\}/.exec(leaveSource)?.[0] ?? "";
  assert.ok(birthdayBody, "loadBirthdayItems must still be findable");
  assert.match(
    birthdayBody,
    /const companyWide = canPublishCompanyWide\(access\.role\);/,
    "the birthday read decides company-wide from the same rule that lets a viewer publish company-wide",
  );
  assert.match(
    birthdayBody,
    /row\.birthDate && \(companyWide \|\| sameLine\(row\.lineName, viewerLineName\)\)/,
    "a company-wide viewer gets every line's birthdays; everyone else keeps their own line",
  );
}
