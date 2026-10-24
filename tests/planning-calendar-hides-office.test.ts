import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { resolvePlanItemArea, withoutOfficeDays } from "../src/lib/weekly-planning/calendar.ts";

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
    { day: "Thu", activityType: "Admin" },
  ];
  assert.deepEqual(
    withoutOfficeDays(week).map((item) => item.day),
    ["Tue", "Wed"],
    "Office and Admin days are dropped and the field days stay",
  );

  assert.equal(resolvePlanItemArea("Behira 1", "Alex Center", "Cairo"), "Behira 1", "a stored area wins");
  assert.equal(resolvePlanItemArea("  ", "Alex Center", "Cairo"), "Alex Center", "else the rep it is planned with");
  assert.equal(resolvePlanItemArea(null, null, "Cairo"), "Cairo", "else the planner's own area");
  assert.equal(resolvePlanItemArea(null, null, null), null, "nothing known stays empty");

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
  assert.match(
    service,
    /resolvePlanItemArea\(row\.area, medicalRepEmployee\?\.areaName, employee\.areaName\)/,
    "the legacy plan rows fill an empty area from the rep, then the planner",
  );
  assert.match(
    service,
    /resolvePlanItemArea\(storedArea, rep\?\.areaName, employee\.areaName\)/,
    "a manager's half-day with a rep fills its area the same way",
  );
}
