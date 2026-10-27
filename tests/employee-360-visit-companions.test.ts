import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildDoubleVisitHistory, trainingManagerVisitDates } from "../src/lib/employee-360/deep-service.ts";
import type { VisitRow } from "../src/lib/employee-360/service.ts";

/**
 * 🔒 EMPLOYEE 360 READS EVERY COMPANION ON A VISIT, NOT ONLY THE TWO SLOTS (owner, 2026-10-27: "make employee
 * 360 read every visit companion"). A Phoenix visit carries any mix of the people offered to it ("Everything
 * is applicable"); the door's `double_hr_id`/`double2_hr_id` hold the first two and `companion_hr_ids` holds
 * all of them. A rep's received double visits must credit the third and fourth as they credit the first two,
 * name them on the visit line, and count a Training Manager wherever he stands on the visit.
 */
export function runEmployee360VisitCompanionsTests() {
  const visit = (over: Partial<VisitRow> & { crm_visit_id?: number }): VisitRow =>
    ({
      ampm: "AM",
      comment: null,
      contact_crm_id: 1,
      contact_name: "Dr One",
      crm_visit_id: -1,
      customer_name: null,
      double_crm_id: null,
      double_hr_id: "D-1",
      double_name: "District Lead",
      source: "phoenix",
      visit_date: "2026-10-27",
      visit_type: 0,
      visit_type_description: "Regular",
      ...over,
    }) as VisitRow;

  // The rep went with his District Sales Manager, the Regional Sales Manager, the Group Product Manager and
  // the Training Manager: the slots carry the first two, the array carries all four.
  const chain = visit({
    double2_hr_id: "R-1",
    double2_name: "Regional Head",
    companion_hr_ids: ["D-1", "G-1", "R-1", "T-1"],
  });
  const names = new Map([
    ["g-1", "Group Product Lead"],
    ["t-1", "Trainer"],
  ]);
  const tmIds = new Set(["t-1"]);

  const history = buildDoubleVisitHistory([chain], tmIds, names, "full");
  assert.equal(history.totalReceived, 1, "the chain is still ONE visit the rep received");
  assert.equal(history.distinctVisitors, 4, "all four companions are credited, not only the two slots");
  assert.deepEqual(
    Object.fromEntries(history.byVisitor.map((v) => [v.hrId, v.count])),
    { "d-1": 1, "r-1": 1, "g-1": 1, "t-1": 1 },
    "each companion is credited once",
  );
  assert.deepEqual(history.events[0].otherNames, ["Group Product Lead", "Trainer"], "the visit line names the third and fourth");
  assert.equal(history.events[0].isTrainingManager, true, "a Training Manager in the fourth place makes it a training double visit");
  assert.equal(history.tmCount, 1);
  assert.equal(
    history.byVisitor.find((v) => v.hrId === "t-1")?.isTrainingManager,
    true,
    "the Training Manager is marked as one in the per-visitor list",
  );

  // A visit of two keeps its shape: no extra names, no double credit when the array repeats the slots.
  const pair = buildDoubleVisitHistory([visit({ crm_visit_id: -2, companion_hr_ids: ["D-1"] })], tmIds, names, "full");
  assert.deepEqual(pair.events[0].otherNames, [], "a companion already in a slot is never named twice");
  assert.equal(pair.distinctVisitors, 1);
  // A vendor row has no array: the slots are the whole answer.
  const vendor = buildDoubleVisitHistory([visit({ crm_visit_id: 7, source: "crm", double_crm_id: 501, companion_hr_ids: null })], tmIds, names, "full");
  assert.deepEqual(vendor.events[0].otherNames, []);

  // The training-impact window pools around every day a Training Manager was on the visit, in any place.
  assert.deepEqual(trainingManagerVisitDates([chain], tmIds), ["2026-10-27"], "the Training Manager in the fourth place counts");
  assert.deepEqual(trainingManagerVisitDates([visit({ crm_visit_id: -3, companion_hr_ids: ["D-1", "G-1"] })], tmIds), []);

  // The rows reach the builder only if the read asks the door for the array.
  const service = readFileSync("src/lib/employee-360/service.ts", "utf8");
  assert.match(service, /double2_name,companion_hr_ids,/, "the visit read selects companion_hr_ids from the door");
  const view = readFileSync("src/components/employee-360/employee-360-view.tsx", "utf8");
  assert.match(view, /\.\.\.e\.otherNames\.map\(/, "the visit line renders every companion's name");
}
