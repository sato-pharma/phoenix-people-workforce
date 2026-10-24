import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { groupPlanItemsByRegion, planningGroupKey, resolvePlanItemRegion } from "../src/lib/weekly-planning/calendar.ts";
import { buildPlanningCalendarDetailRows } from "../src/lib/weekly-planning/calendar-export.ts";

/**
 * Owner, 2026-10-24: "in the planning calendar tile group them by region and when press on the tile in
 * the details group them by region the area". The month tile groups each day's people by region; the
 * selected day's details group by region, then area. One region however it was typed.
 */
export async function runPlanningCalendarRegionGroupsTests() {
  const plan = (id: string, region: string | null, area: string | null) => ({ area, id, region });

  const groups = groupPlanItemsByRegion([
    plan("a", "Delta 1", "Gharbia 1 (Tanta)"),
    plan("b", "Delta (1)", "Gharbia 1 (Tanta)"),
    plan("c", "ALEX-BHR", "Behira 1"),
    plan("d", "Alex-BHR", null),
    plan("e", null, null),
    plan("f", "Cairo", "Nasr City"),
    plan("g", "delta 1", "Menofia 2"),
  ]);

  assert.deepEqual(
    groups.map((group) => group.label),
    ["Alex-BHR", "Cairo", "Delta 1", "No region"],
    "regions are one group however they were typed, sorted by name, with No region last",
  );
  const delta = groups.find((group) => group.label === "Delta 1");
  assert.deepEqual(delta?.items.map((item) => item.id), ["a", "b", "g"], "Delta 1, Delta (1) and delta 1 are one region, in their own order");
  assert.deepEqual(
    delta?.areas.map((area) => [area.label, area.items.map((item) => item.id)]),
    [["Gharbia 1 (Tanta)", ["a", "b"]], ["Menofia 2", ["g"]]],
    "inside a region the rows group by area, and an area keeps its brackets",
  );
  const alex = groups.find((group) => group.label === "Alex-BHR");
  assert.deepEqual(alex?.areas.map((area) => area.label), ["Behira 1", "No area"], "a row with no area sits last, under No area");

  assert.equal(planningGroupKey("Upper Egypt (2)"), planningGroupKey("UPPER EGYPT 2"));
  assert.notEqual(planningGroupKey("Upper Egypt 1"), planningGroupKey("Upper Egypt 2"));

  assert.equal(resolvePlanItemRegion("Giza", "Cairo", "Delta (1)"), "Giza", "the region typed on the plan wins");
  assert.equal(resolvePlanItemRegion("  ", "Cairo", "Delta (1)"), "Cairo", "then the rep it is planned with");
  assert.equal(resolvePlanItemRegion(null, null, "Delta (1)"), "Delta (1)", "then the planner's own region");
  assert.equal(resolvePlanItemRegion(null, null, null), null);

  const ui = readFileSync("src/components/employee-portal/planning-calendar.tsx", "utf8");
  assert.match(ui, /const dayRegions = groupPlanItemsByRegion\(dayPlans\)/, "the month tile groups each day's people by region");
  assert.doesNotMatch(ui, /planGroupFor|"Field Visits"/, "the tile no longer groups by Office / Field Visits / Other");
  assert.match(ui, /groupPlanItemsByRegion\(\s*rows\.filter/, "the selected day's details group by region, then area");

  // Owner, 2026-10-24: "Region / Location should see regions only, now it's showing lines". A row with no
  // region shows "-", never the person's line, on the screen and in the export.
  assert.doesNotMatch(ui, /regionLocation:[^\n]*lineName/, "the Region / Location column never falls back to the line");
  assert.doesNotMatch(ui, /item\.region \|\| item\.lineName/, "the month tile's meta never shows a line where the region goes");
  const lineless = buildPlanningCalendarDetailRows([
    { activityTitle: "Single Visit", activityType: "single_visit", area: null, conflictKey: null, conflictWarning: null, employeeHrId: "X-1", employeeJobTitle: "District Sales Manager", employeeName: "Someone", employeeDisplayName: "Someone", endDate: "2026-10-12", id: "plan-1", lineName: "CNS", medicalRepHrId: null, medicalRepName: null, medicalRepDisplayName: null, notes: null, planId: "p1", planKind: "weekly", region: null, source: "plan", startDate: "2026-10-12", status: "approved", time: null, title: "Someone" } as unknown as Parameters<typeof buildPlanningCalendarDetailRows>[0][number],
  ]);
  assert.equal(lineless[0]?.location, "-", "the export's Region / Location column shows no line either");
  assert.equal(lineless[0]?.line, "CNS", "the line keeps its own column");

  const service = readFileSync("src/lib/weekly-planning/calendar-service.ts", "utf8");
  assert.match(service, /resolvePlanItemRegion\(row\.location_text, medicalRepEmployee\?\.regionName, employee\.regionName\)/, "a legacy plan row never has an empty region when the directory knows one");
  assert.match(service, /resolvePlanItemRegion\(null, rep\?\.regionName, employee\.regionName\)/, "a Phoenix CRM manager half-day takes its region from the directory");
}
