import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { mergeFullDayPlanItems, type PlanningCalendarPlanItem } from "../src/lib/weekly-planning/calendar.ts";

function half(overrides: Partial<PlanningCalendarPlanItem>): PlanningCalendarPlanItem {
  return {
    activityTitle: "Single Visit",
    activityType: "Field",
    area: "Behira 1",
    conflictKey: null,
    conflictWarning: null,
    employeeDisplayName: "Ahmed",
    employeeHrId: "B-7",
    employeeJobTitle: "District Manager",
    employeeName: "Ahmed Ali",
    endDate: "2026-10-27",
    id: "am-1",
    lineName: "CNS",
    medicalRepDisplayName: "Mona",
    medicalRepHrId: "B-40",
    medicalRepName: "Mona Samir",
    notes: null,
    planId: "plan-1",
    planKind: "weekly",
    region: "Alexandria",
    source: "plan",
    startDate: "2026-10-27",
    status: "final_approved",
    time: "AM",
    title: "Ahmed - Alexandria - Behira 1",
    ...overrides,
  } as PlanningCalendarPlanItem;
}

/**
 * Owner, 2026-10-24: "if same employee same day am and pm the same plan area then full day and do not
 * separate in calendar or details". The one loader merges an identical AM and PM into one Full day
 * entry, so every surface (grid, agenda, details table, export) shows it once.
 */
export async function runPlanningCalendarFullDayMergeTests() {
  const am = half({ id: "am-1", notes: "Hospital round", time: "AM" });
  const pm = half({ id: "pm-1", notes: "Pharmacies", time: "PM" });
  const merged = mergeFullDayPlanItems([am, pm]);
  assert.equal(merged.length, 1, "an identical AM and PM for one person on one day is one entry");
  assert.equal(merged[0].time, "Full day", "and it reads Full day");
  assert.equal(merged[0].id, "am-1", "it keeps the AM item's id");
  assert.equal(merged[0].notes, "Hospital round · Pharmacies", "both halves' notes are kept");

  assert.equal(
    mergeFullDayPlanItems([half({ notes: "Same" }), half({ id: "pm-1", notes: "same", time: "PM" })])[0].notes,
    "Same · same",
    "notes are kept as written",
  );
  assert.equal(
    mergeFullDayPlanItems([half({ area: "behira 1 " }), half({ id: "pm-1", time: "PM" })]).length,
    1,
    "area is compared without case or spacing",
  );

  const differentArea = mergeFullDayPlanItems([am, half({ area: "Alex Center", id: "pm-1", time: "PM" })]);
  assert.deepEqual(differentArea.map((item) => item.time), ["AM", "PM"], "a different area in the PM stays two halves");
  assert.equal(mergeFullDayPlanItems([am, half({ id: "pm-1", medicalRepHrId: "B-41", time: "PM" })]).length, 2, "a different rep stays two halves");
  assert.equal(mergeFullDayPlanItems([am, half({ activityTitle: "Coaching", activityType: "Other", id: "pm-1", time: "PM" })]).length, 2, "a different activity stays two halves");
  assert.equal(mergeFullDayPlanItems([am, half({ employeeHrId: "B-8", id: "pm-1", time: "PM" })]).length, 2, "two different people are never merged");
  assert.equal(mergeFullDayPlanItems([am, half({ endDate: "2026-10-28", id: "pm-1", startDate: "2026-10-28", time: "PM" })]).length, 2, "two different days are never merged");
  assert.equal(mergeFullDayPlanItems([am, half({ id: "am-2" })]).length, 2, "two AMs are never one Full day");
  assert.equal(
    mergeFullDayPlanItems([am, half({ id: "am-2", medicalRepHrId: "B-41" }), half({ id: "pm-1", time: "PM" })]).length,
    3,
    "an ambiguous day (two AMs) is left as it is",
  );

  const other = half({ employeeHrId: "B-9", id: "other", time: "Full day" });
  assert.deepEqual(
    mergeFullDayPlanItems([other, am, pm]).map((item) => item.id),
    ["other", "am-1"],
    "everything else passes through in order",
  );

  const service = readFileSync("src/lib/weekly-planning/calendar-service.ts", "utf8");
  assert.match(
    service,
    /const planItems = mergeFullDayPlanItems\(withoutOfficeDays\(visiblePlanItems\)\)/,
    "the shared loader merges before conflicts, counts, the returned items and the export",
  );
}
