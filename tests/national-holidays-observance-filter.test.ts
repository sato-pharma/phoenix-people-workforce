import assert from "node:assert/strict";

import { getEgyptianNationalHolidays } from "../src/lib/vacation/national-holidays.ts";

// Real regression: Google's Egypt public-holiday calendar mixes two event types under DESCRIPTION —
// "Public holiday" (a real day off) and "Observance" (a cultural/religious date Google notes for
// awareness only; its own event text says "To hide observances, go to Google Calendar Settings").
// getEgyptianNationalHolidays used to merge BOTH into the holiday list, which silently treated
// "Flooding of the Nile" (Wafaa El-Nil, Aug 15) as a real national holiday with no admin ever
// confirming it — every downstream consumer (calendars, weekly/monthly plans, vacation, attendance,
// payroll) inherited the mistake.
const SYNTHETIC_ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "DTSTART;VALUE=DATE:20990815",
  "DTEND;VALUE=DATE:20990816",
  "UID:observance-flooding-of-the-nile@test",
  "SUMMARY:Flooding of the Nile",
  "DESCRIPTION:Observance\\nTo hide observances\\, go to Google Calendar Settings > Holidays in Egypt",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART;VALUE=DATE:20990826",
  "DTEND;VALUE=DATE:20990827",
  "UID:public-holiday-mawlid@test",
  "SUMMARY:Prophet Mohamed's Birthday (tentative)",
  "DESCRIPTION:Public holiday\\nDate is tentative and may change.",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

export async function runNationalHolidaysObservanceFilterTests() {
  const savedFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(SYNTHETIC_ICS, { status: 200 })) as typeof fetch;

    const result = await getEgyptianNationalHolidays({ month: 8, year: 2099 });

    assert.equal(
      result.holidays.some((holiday) => holiday.startDate === "2099-08-15"),
      false,
      "an Observance-tagged event (Flooding of the Nile) must never be treated as a real holiday",
    );
    assert.equal(
      result.holidays.some((holiday) => holiday.startDate === "2099-08-26"),
      true,
      "a genuine Public-holiday-tagged event on an adjacent date must still pass through, even when tentative",
    );
  } finally {
    globalThis.fetch = savedFetch;
  }
}
