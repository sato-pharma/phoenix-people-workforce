import { strict as assert } from "node:assert";

import { getCompanyHolidaysForMonth } from "../src/lib/vacation/company-holidays.ts";

export function runCompanyHolidaysTests() {
  // May 2026 includes the Eid al-Adha company closure (26–31 May).
  const may = getCompanyHolidaysForMonth({ month: 5, year: 2026 });
  assert.equal(may.length, 1);
  assert.equal(may[0].startDate, "2026-05-26");
  assert.equal(may[0].endDate, "2026-05-31");
  assert.match(may[0].name, /eid/i);

  // A month with no configured company holiday returns nothing.
  assert.equal(getCompanyHolidaysForMonth({ month: 1, year: 2026 }).length, 0);
  // A different year (no matching entry) also returns nothing for May.
  assert.equal(getCompanyHolidaysForMonth({ month: 5, year: 2025 }).length, 0);
}
