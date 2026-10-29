import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  buildAreaRegionIndex,
  groupPlanItemsByRegion,
  isWholeCountryPlace,
  planningGroupKey,
  regionOfArea,
  resolvePlanItemArea,
  resolvePlanItemRegion,
} from "../src/lib/weekly-planning/calendar.ts";
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

  // The whole country is never a place (owner, 2026-10-24: "magdy on 28-10 is showing travelling to egypt").
  assert.equal(isWholeCountryPlace("Egypt"), true);
  assert.equal(isWholeCountryPlace(" EGYPT "), true);
  assert.equal(isWholeCountryPlace("Upper Egypt 2"), false, "a region that names part of the country is a real place");
  assert.equal(resolvePlanItemRegion(null, null, "Egypt"), null, "the National Sales Manager's travel day with no destination shows no region");
  assert.equal(resolvePlanItemArea(null, null, "Egypt"), null, "and no area");
  assert.equal(resolvePlanItemRegion("Egypt", null, "Delta (1)"), "Delta (1)", "a stored whole-country value is skipped too");
  assert.equal(resolvePlanItemArea("Egypt", "Sohag1", "Egypt"), "Sohag1");

  // A half-day planned in an area groups under that area's region, before the planner's own.
  const areaRegions = buildAreaRegionIndex([
    { areaName: "Sohag1", regionName: "Upper Egypt 2" },
    { areaName: "Sohag1", regionName: "Upper Egypt 2" },
    { areaName: "Sohag1", regionName: "Upper Egypt" },
    { areaName: "Sharkia 1", regionName: "Delta (3)" },
    { areaName: "Sharkia 1", regionName: "Delta (2)" },
    { areaName: "Egypt", regionName: "Egypt" },
    { areaName: "Giza 1", regionName: "Egypt" },
  ]);
  assert.equal(regionOfArea(areaRegions, "sohag1"), "Upper Egypt 2", "the region most of the area's people sit in");
  assert.equal(regionOfArea(areaRegions, "Sharkia 1"), null, "a tie names no region");
  assert.equal(regionOfArea(areaRegions, "Egypt"), null, "the whole country is no area");
  assert.equal(regionOfArea(areaRegions, "Giza 1"), null, "and no region");
  assert.equal(regionOfArea(areaRegions, null), null);
  assert.equal(resolvePlanItemRegion(null, null, "Egypt", regionOfArea(areaRegions, "Sohag1")), "Upper Egypt 2", "Magdy's Sohag visit groups under Upper Egypt 2");
  assert.equal(resolvePlanItemRegion(null, "Cairo", "Egypt", "Upper Egypt 2"), "Cairo", "the rep it is planned with still wins");

  const ui = readFileSync("src/components/employee-portal/planning-calendar.tsx", "utf8");
  assert.match(ui, /const dayRegions = groupPlanItemsByRegion\(dayPlans\)/, "the month tile groups each day's people by region");
  assert.doesNotMatch(ui, /planGroupFor|"Field Visits"/, "the tile no longer groups by Office / Field Visits / Other");
  assert.match(ui, /groupPlanItemsByRegion\(\s*rows\.filter/, "the selected day's details group by region, then area");

  // Owner, 2026-10-24: "Region / Location should see regions only, now it's showing lines". A row with no
  // region shows "-", never the person's line, on the screen and in the export.
  assert.doesNotMatch(ui, /regionLocation:[^\n]*lineName/, "the Region / Location column never falls back to the line");
  assert.doesNotMatch(ui, /item\.region \|\| item\.lineName/, "the month tile's meta never shows a line where the region goes");
  // The day's details table fits its columns: a cell wraps rather than spilling into the next column or
  // past the table's edge (the HR ACKNOWLEDGED badge and the Chain Visit text did, 2026-10-24).
  const detailsTable = ui.slice(ui.indexOf('"Employee", "Activity", "Medical Rep"'), ui.indexOf("</PortalDesktopTable>"));
  assert.ok(detailsTable.length > 0, "the details table is found");
  assert.doesNotMatch(detailsTable, /<td className="whitespace-nowrap|<span className="whitespace-nowrap">\{row\.conflictWarning\}|inline-flex whitespace-nowrap border px-2/, "no details cell is held on one line past its column");
  // A chain visit is not a row of its own on top of the people's own rows (owner, 2026-10-24: "you see the
  // duplication in rasha and nermine") — each person's row carries it in the Chain Visit column.
  assert.doesNotMatch(ui, /selectedConflicts\.map|activity: "Chain visit"/, "the day's details never add a Chain visit row that repeats the people already listed");
  const lineless =buildPlanningCalendarDetailRows([
    { activityTitle: "Single Visit", activityType: "single_visit", area: null, conflictKey: null, conflictWarning: null, employeeHrId: "X-1", employeeJobTitle: "District Sales Manager", employeeName: "Someone", employeeDisplayName: "Someone", endDate: "2026-10-12", id: "plan-1", lineName: "CNS", medicalRepHrId: null, medicalRepName: null, medicalRepDisplayName: null, notes: null, planId: "p1", planKind: "weekly", region: null, source: "plan", startDate: "2026-10-12", status: "approved", time: null, title: "Someone" } as unknown as Parameters<typeof buildPlanningCalendarDetailRows>[0][number],
  ]);
  assert.equal(lineless[0]?.location, "-", "the export's Region / Location column shows no line either");
  assert.equal(lineless[0]?.line, "CNS", "the line keeps its own column");

  const service = readFileSync("src/lib/weekly-planning/calendar-service.ts", "utf8");
  assert.match(service, /resolvePlanItemRegion\(planItemStoredRegion\(row\.activity_type, row\.location_text\), medicalRepEmployee\?\.regionName, employee\.regionName, regionOfArea\(areaRegions, area\)\)/, "a legacy plan row never has an empty region when the directory knows one");
  assert.match(service, /resolvePlanItemRegion\(null, rep\?\.regionName, employee\.regionName, regionOfArea\(areaRegions, area\)\)/, "a Phoenix CRM manager half-day takes its region from the directory, its area's region first");
  assert.match(service, /const areaRegions = buildAreaRegionIndex\(directoryRows\)/, "the area's region is read from the active directory");
}
