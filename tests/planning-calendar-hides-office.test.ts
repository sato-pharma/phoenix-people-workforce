import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { withoutOfficeDays } from "../src/lib/weekly-planning/calendar.ts";

/**
 * Owner, 2026-10-24: in the Planning Calendar a day planned as Office is not shown at all. A National
 * Sales Manager planning Sunday and Monday Office, Tuesday Behira 1 and Wednesday Alex Center shows
 * Tuesday and Wednesday only. The one loader every surface reads is where it is dropped, while the
 * person still counts as having submitted a plan.
 */
export async function runPlanningCalendarHidesOfficeTests() {
  const week = [
    { day: "Sun", activityType: "Office" },
    { day: "Mon", activityType: "Office" },
    { day: "Tue", activityType: "Field" },
    { day: "Wed", activityType: "Other" },
  ];
  assert.deepEqual(
    withoutOfficeDays(week).map((item) => item.day),
    ["Tue", "Wed"],
    "Office days are dropped and the field days stay",
  );

  const service = readFileSync("src/lib/weekly-planning/calendar-service.ts", "utf8");
  assert.match(
    service,
    /const planItems = withoutOfficeDays\(visiblePlanItems\)/,
    "the shared loader drops Office before conflicts, counts and the returned items",
  );
  assert.match(
    service,
    /new Set\(visiblePlanItems\.map/,
    "the submitted-owner count still reads the items before Office is dropped",
  );
}
