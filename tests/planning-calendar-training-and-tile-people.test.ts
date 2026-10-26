import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  groupPlanItemsByRegion,
  planItemStoredRegion,
  planningTilePeople,
  resolvePlanItemRegion,
} from "../src/lib/weekly-planning/calendar.ts";

/**
 * National Sales Manager audit, 2026-10-26, on the Planning Calendar:
 *
 *   1. A Training day's month tile drew a region band "PHYSICAL": a Training item stores its FORMAT
 *      ("Zoom", "Physical", "Other") in location_text, and both loaders read that column as the region.
 *      A training format is never a region — the item groups under the region the calendar falls back to.
 *   2. One region on one tile printed "Taha Mohamed" twice — his AM and PM were two different half-days.
 *      The tile now draws each person once, reading "AM · PM".
 */
export async function runPlanningCalendarTrainingAndTilePeopleTests() {
  // ── 1. A training format is never a region ─────────────────────────────────────────────────────
  assert.equal(planItemStoredRegion("Training", "Physical"), null, "a Training item's format is not a region");
  assert.equal(planItemStoredRegion("Training", "Zoom"), null);
  assert.equal(planItemStoredRegion("Field", "Delta 1"), "Delta 1", "a field item's region is read as before");
  assert.equal(planItemStoredRegion("Double Visit", "  "), null);
  const trainingRegion = resolvePlanItemRegion(planItemStoredRegion("Training", "Physical"), null, "Alex-BHR", null);
  assert.equal(trainingRegion, "Alex-BHR", "a Training day groups under the planner's own region");
  const bands = groupPlanItemsByRegion([
    { area: null, region: trainingRegion },
    { area: "Behira 1", region: planItemStoredRegion("Field", "Alex-BHR") },
  ]).map((group) => group.label);
  assert.deepEqual(bands, ["Alex-BHR"], "no PHYSICAL band beside the real region");

  for (const file of ["src/lib/weekly-planning/calendar-service.ts", "src/lib/weekly-planning/service.ts"]) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /resolvePlanItemRegion\(row\.location_text|region: nullableText\(item\.location_text\)/, `${file} never reads location_text as a region raw`);
  }

  // ── 2. Each person once per region on the tile ─────────────────────────────────────────────────
  const half = (id: string, hrId: string, time: string | null) => ({ employeeHrId: hrId, id, time });
  const people = planningTilePeople([
    half("1", "B-94", "AM"),
    half("2", "B-12", "Full day"),
    half("3", "b-94", "PM"),
  ]);
  assert.equal(people.length, 2, "Taha Mohamed's AM and PM are ONE chip");
  assert.deepEqual(people[0].items.map((item) => item.id), ["1", "3"]);
  assert.equal(people[0].slots, "AM · PM", "the chip says which halves");
  assert.equal(people[1].slots, null, "a person with one item reads as before");

  const ui = readFileSync("src/components/employee-portal/planning-calendar.tsx", "utf8");
  assert.match(ui, /planningTilePeople\(region\.items\)/, "the month tile draws people, not items");
  assert.doesNotMatch(ui, /region\.items\.map\(/, "no tile lists a region's items one by one");
}
