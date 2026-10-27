import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { buildPlaceEvidence, placeEvidenceKey, resolvePlanItemArea, withoutOfficeDays } from "../src/lib/weekly-planning/calendar.ts";

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
    { day: "Sat", activityType: "National Vacation" },
    { day: "Sun2", activityType: "Vacation" },
    { day: "Mon2", activityType: "Excuse" },
  ];
  assert.deepEqual(
    withoutOfficeDays(week).map((item) => item.day),
    ["Tue", "Wed"],
    "Office, Admin, National Vacation, Vacation and Excuse days are dropped and the field days stay",
  );

  // Owner, 2026-10-27: "planning calendar is only for field work" - approved leave is never read into it.
  const loader = readFileSync("src/lib/weekly-planning/calendar-service.ts", "utf8");
  assert.doesNotMatch(loader, /approved-leave-days|LeaveDays\(/, "the Planning Calendar never reads Vacations");

  assert.equal(resolvePlanItemArea("Behira 1", "Alex Center", "Cairo"), "Behira 1", "a stored area wins");
  assert.equal(resolvePlanItemArea("  ", "Alex Center", "Cairo"), "Alex Center", "else the rep it is planned with");
  assert.equal(resolvePlanItemArea(null, null, "Cairo"), "Cairo", "else the planner's own area");
  assert.equal(resolvePlanItemArea(null, null, null), null, "nothing known stays empty");

  // Owner, 2026-10-24: "check his CRM visits or his expenses, where was he" — what happened outranks
  // the planner's home area, but never the stored area or the rep it is planned with.
  assert.equal(resolvePlanItemArea(null, null, "Cairo", "Delta 2"), "Delta 2", "else where he actually was that day");
  assert.equal(resolvePlanItemArea(null, "Alex Center", "Cairo", "Delta 2"), "Alex Center", "the rep it is planned with still wins over the evidence");
  assert.equal(resolvePlanItemArea("Behira 1", null, "Cairo", "Delta 2"), "Behira 1", "a stored area still wins over the evidence");

  const evidence = buildPlaceEvidence(
    [
      { hrId: "b-7", date: "2026-10-12", areaName: "Giza" },
      { hrId: "B-7", date: "2026-10-12", areaName: "Giza" },
      { hrId: "B-7", date: "2026-10-12", areaName: "Cairo East" },
      { hrId: "B-7", date: "2026-10-13", areaName: "  " },
    ],
    [
      { hrId: "B-7", startDate: "2026-10-11", endDate: "2026-10-13", areaName: "Upper Egypt 1" },
      { hrId: "B-9", startDate: "2026-10-30", endDate: "2026-11-01", areaName: "Delta 2" },
      { hrId: "B-5", startDate: "2026-01-01", endDate: "2026-12-31", areaName: "Too Long" },
    ],
  );
  assert.equal(evidence.get(placeEvidenceKey("B-7", "2026-10-12")), "Giza", "the most visited area that day, and a visit outranks a claim");
  assert.equal(evidence.get(placeEvidenceKey("b-7", "2026-10-11")), "Upper Egypt 1", "a trip covers each of its days, whatever the case of the id");
  assert.equal(evidence.get(placeEvidenceKey("B-7", "2026-10-13")), "Upper Egypt 1", "a blank visit area is no evidence, so the trip answers");
  assert.equal(evidence.get(placeEvidenceKey("B-9", "2026-11-01")), "Delta 2", "a trip runs across the month end");
  assert.equal(evidence.has(placeEvidenceKey("B-5", "2026-06-01")), false, "a claim spanning more than a month is not a place on any one day");
  assert.equal(evidence.has(placeEvidenceKey("B-7", "2026-10-14")), false, "no visit and no trip means no evidence");

  const service = readFileSync("src/lib/weekly-planning/calendar-service.ts", "utf8");
  assert.match(
    service,
    /const planItems = mergeFullDayPlanItems\(withoutOfficeDays\(visiblePlanItems\)\)/,
    "the shared loader drops Office before conflicts, counts and the returned items",
  );
  assert.match(
    service,
    /new Set\(visiblePlanItems\.map/,
    "the submitted-owner count still reads the items before Office is dropped",
  );
  assert.match(
    service,
    /resolvePlanItemArea\(row\.area, medicalRepEmployee\?\.areaName, employee\.areaName, placeEvidence\.get\(placeEvidenceKey\(header\.employee_hr_id, row\.activity_date\)\)\)/,
    "the legacy plan rows fill an empty area from the rep, then where he was that day, then the planner",
  );
  assert.match(
    service,
    /resolvePlanItemArea\(storedArea, rep\?\.areaName, employee\.areaName, placeEvidence\.get\(placeEvidenceKey\(halfDay\.managerHrId, halfDay\.date\)\)\)/,
    "a manager's half-day fills its area the same way",
  );
  assert.match(service, /loadManagerVisitAreas\(\{ end, start \}\)/, "the CRM visits are one source of where he was, read through the module's own door");
  assert.equal(/from\("phoenix_crm_manager_visits"\)/.test(service), false, "the calendar never reads the manager-plan table directly");
  assert.match(service, /from\("expense_claims"\)[\s\S]*\.neq\("status", "rejected"\)/, "a rejected expense trip is no evidence");
}
