import assert from "node:assert/strict";

import { buildHolidayCalendarYearView } from "../src/lib/attendance/holiday-overrides.ts";
import {
  getConfirmedNationalHolidays,
  getEgyptianNationalHolidays,
  substitutedHolidayName,
} from "../src/lib/vacation/national-holidays.ts";

// THE 6 OCTOBER INCIDENT (2026-10-01). Google's Egypt calendar does not MOVE a postponed holiday
// — it keeps the official date and adds a second "Public holiday" event named `Day off for <X>`
// on the substitute date. Phoenix read both as days off, so ONE national holiday blocked TWO
// working days: Tuesday 6 October AND Thursday 8 October were both locked in the District
// Managers' weekly/monthly plans, and moving the 6 October row in the Bulk Holiday Calendar
// changed nothing visible, because the Thursday was carrying its own separate entry all along.
//
// The same pair is in the live feed for 25/29 January 2026, 30 June/2 July 2026 and 25/28 January
// 2027, so this is a recurrence, not an October one-off.
//
// Dated 2098 so the per-month holiday cache cannot be shared with any other test in the suite.
const SYNTHETIC_ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  // Same month: the October pair, exactly as the live feed carries it.
  ...event("20981006", "20981007", "armed-forces-day", "Armed Forces Day"),
  ...event("20981008", "20981009", "day-off-armed-forces-day", "Day off for Armed Forces Day"),
  // Across a month boundary: June 30 observed on 2 July.
  ...event("20980630", "20980701", "june-30-revolution", "June 30 Revolution"),
  ...event("20980702", "20980703", "day-off-june-30-revolution", "Day off for June 30 Revolution"),
  // The substitute can land BEFORE the official date — the 2025 feed did exactly this.
  ...event("20980424", "20980425", "day-off-sinai", "Day off for Sinai Liberation Day"),
  ...event("20980425", "20980426", "sinai", "Sinai Liberation Day"),
  // A genuine multi-day holiday: no `Day off for` prefix anywhere, so nothing may be folded.
  ...event("20980319", "20980320", "eid-el-fitr-holiday", "Eid el Fitr Holiday"),
  ...event("20980320", "20980321", "eid-el-fitr", "Eid el Fitr"),
  "END:VCALENDAR",
].join("\r\n");

function event(start: string, end: string, uid: string, summary: string) {
  return [
    "BEGIN:VEVENT",
    `DTSTART;VALUE=DATE:${start}`,
    `DTEND;VALUE=DATE:${end}`,
    `UID:${uid}@test`,
    `SUMMARY:${summary}`,
    "DESCRIPTION:Public holiday",
    "END:VEVENT",
  ];
}

async function holidayDates(month: number) {
  const result = await getConfirmedNationalHolidays({ month, year: 2098 });
  return result.holidays.map((holiday) => holiday.startDate).sort();
}

export async function runHolidaySubstituteDayOffTests() {
  // The pure half needs no feed at all.
  assert.equal(substitutedHolidayName("Day off for Armed Forces Day"), "armed forces day");
  assert.equal(substitutedHolidayName("day off  for   June 30 Revolution"), "june 30 revolution");
  assert.equal(substitutedHolidayName("Eid el Fitr Holiday"), null, "a `Holiday` suffix is not a substitute marker");
  assert.equal(substitutedHolidayName("Armed Forces Day"), null);
  assert.equal(substitutedHolidayName("Day off for "), null, "a prefix with no holiday behind it folds nothing");

  const savedFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(SYNTHETIC_ICS, { status: 200 })) as typeof fetch;

    // 1. The incident itself: ONE day off in October, on the substitute date.
    assert.deepEqual(
      await holidayDates(10),
      ["2098-10-08"],
      "Armed Forces Day must not block its official date as well as the day off Google moved it to",
    );

    // 2. The admin page still has to SEE the pair, or the official date could never be confirmed
    //    by hand when the government does something the feed does not describe.
    const rawOctober = await getEgyptianNationalHolidays({ month: 10, year: 2098 });
    assert.deepEqual(
      rawOctober.holidays.map((holiday) => holiday.startDate).sort(),
      ["2098-10-06", "2098-10-08"],
      "the RAW source must be left untouched — the fold belongs to getConfirmedNationalHolidays",
    );

    // 3. Across a month boundary, read from the official date's own month.
    assert.equal(
      (await holidayDates(6)).includes("2098-06-30"),
      false,
      "June 30 is not a day off when July carries `Day off for June 30 Revolution`",
    );
    assert.deepEqual(await holidayDates(7), ["2098-07-02"]);

    // 4. The substitute sitting BEFORE the official date folds the same way.
    assert.deepEqual(
      await holidayDates(4),
      ["2098-04-24"],
      "a `Day off for` event the day BEFORE the official date still supersedes it",
    );

    // 5. A real multi-day holiday is never folded.
    assert.deepEqual(
      await holidayDates(3),
      ["2098-03-19", "2098-03-20"],
      "Eid el Fitr and Eid el Fitr Holiday are two genuine days off — neither is a `Day off for` substitute",
    );

    // 6. The Bulk Holiday Calendar opens the official row on the substitute date, so one
    //    "Save All Changes" cannot pin the holiday back onto a day the government moved.
    const yearView = await buildHolidayCalendarYearView(2098);
    const october6 = yearView.rows.find((row) => row.officialDate === "2098-10-06");
    assert.ok(october6, "the official 6 October row must still be listed for review");
    assert.equal(october6.observedDate, "2098-10-08");
    assert.equal(october6.observedEndDate, "2098-10-08");
    assert.equal(october6.hasOverride, false, "a pre-filled substitute date is a default, never a confirmation");
    const eidHoliday = yearView.rows.find((row) => row.officialDate === "2098-03-19");
    assert.equal(eidHoliday?.observedDate, "2098-03-19", "an unmoved holiday still opens on its own date");
  } finally {
    globalThis.fetch = savedFetch;
  }
}
