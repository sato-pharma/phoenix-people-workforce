import { strict as assert } from "node:assert";

import {
  classifyAttendanceDay,
  isIsoDate,
  isoWeekKey,
  listIsoDatesInRange,
  type AttendanceCalendarContext,
} from "../src/lib/attendance/working-days.ts";

function context(overrides: Partial<AttendanceCalendarContext> = {}): AttendanceCalendarContext {
  return {
    holidaysByDate: new Map<string, string>(),
    holidaySourceConnected: true,
    todayIso: "2026-06-10",
    ...overrides,
  };
}

export function runAttendanceWorkingDaysTests() {
  // --- isIsoDate ---
  assert.equal(isIsoDate("2026-06-10"), true);
  assert.equal(isIsoDate("06/10/2026"), false);
  assert.equal(isIsoDate(""), false);
  assert.equal(isIsoDate(null), false);

  // --- listIsoDatesInRange ---
  assert.deepEqual(listIsoDatesInRange("2026-06-01", "2026-06-03"), [
    "2026-06-01",
    "2026-06-02",
    "2026-06-03",
  ]);
  assert.deepEqual(listIsoDatesInRange("2026-06-10", "2026-06-10"), ["2026-06-10"]);
  // Inverted and invalid ranges return nothing.
  assert.deepEqual(listIsoDatesInRange("2026-06-10", "2026-06-01"), []);
  assert.deepEqual(listIsoDatesInRange("bad", "2026-06-01"), []);
  // Month boundary.
  assert.deepEqual(listIsoDatesInRange("2026-05-30", "2026-06-01"), [
    "2026-05-30",
    "2026-05-31",
    "2026-06-01",
  ]);

  // --- isoWeekKey ---
  // 2026-06-10 is a Wednesday in ISO week 24 of 2026 (week starts Monday 8 June).
  const wednesday = isoWeekKey("2026-06-10");
  assert.equal(wednesday.key, "2026-W24");
  assert.equal(wednesday.weekStartIso, "2026-06-08");
  // Sunday belongs to the same ISO week as the preceding Monday.
  assert.equal(isoWeekKey("2026-06-14").key, "2026-W24");
  assert.equal(isoWeekKey("2026-06-15").key, "2026-W25");
  // Jan 1 2027 is a Friday — ISO week 53 of 2026.
  assert.equal(isoWeekKey("2027-01-01").key, "2026-W53");

  // --- classifyAttendanceDay: weekend policy ---
  // 2026-06-05 is a Friday: weekly off for everyone.
  const fridayOffice = classifyAttendanceDay({ context: context(), dateIso: "2026-06-05", jobTitle: "Accountant" });
  assert.equal(fridayOffice.isWeeklyOff, true);
  assert.equal(fridayOffice.isExpectedWorkingDay, false);
  const fridayRep = classifyAttendanceDay({ context: context(), dateIso: "2026-06-05", jobTitle: "Medical Rep" });
  assert.equal(fridayRep.isWeeklyOff, true);

  // 2026-06-06 is a Saturday: off for office titles, working for Friday-only field titles.
  const saturdayOffice = classifyAttendanceDay({ context: context(), dateIso: "2026-06-06", jobTitle: "Accountant" });
  assert.equal(saturdayOffice.isWeeklyOff, true);
  assert.equal(saturdayOffice.isExpectedWorkingDay, false);
  const saturdayRep = classifyAttendanceDay({ context: context(), dateIso: "2026-06-06", jobTitle: "Medical Rep" });
  assert.equal(saturdayRep.isWeeklyOff, false);
  assert.equal(saturdayRep.isExpectedWorkingDay, true);
  // No title behaves like an office title (Fri + Sat off).
  const saturdayNoTitle = classifyAttendanceDay({ context: context(), dateIso: "2026-06-06" });
  assert.equal(saturdayNoTitle.isWeeklyOff, true);

  // --- classifyAttendanceDay: working weekday ---
  const sunday = classifyAttendanceDay({ context: context(), dateIso: "2026-06-07", jobTitle: "Accountant" });
  assert.equal(sunday.isWeeklyOff, false);
  assert.equal(sunday.isHoliday, false);
  assert.equal(sunday.isFuture, false);
  assert.equal(sunday.isExpectedWorkingDay, true);

  // --- classifyAttendanceDay: holiday ---
  const holidayContext = context({ holidaysByDate: new Map([["2026-06-08", "Test Holiday"]]) });
  const holiday = classifyAttendanceDay({ context: holidayContext, dateIso: "2026-06-08", jobTitle: "Accountant" });
  assert.equal(holiday.isHoliday, true);
  assert.equal(holiday.holidayName, "Test Holiday");
  assert.equal(holiday.isExpectedWorkingDay, false);

  // --- classifyAttendanceDay: future day ---
  const future = classifyAttendanceDay({ context: context(), dateIso: "2026-06-11", jobTitle: "Accountant" });
  assert.equal(future.isFuture, true);
  assert.equal(future.isExpectedWorkingDay, false);
  // Today itself is not future.
  const today = classifyAttendanceDay({ context: context(), dateIso: "2026-06-10", jobTitle: "Accountant" });
  assert.equal(today.isFuture, false);
}
