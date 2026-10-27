import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  conductedDoubleVisitFigures,
  conductedVisitBucket,
  leaderVisitFigures,
  unmatchedConductedDoubleVisits,
} from "../src/lib/employee-360/deep-service.ts";
import { visitCountSplitTotal } from "../src/lib/crm/visit-count-buckets.ts";
import type { ManagerDayVisit } from "../src/lib/phoenix-crm/manager-visit-detail.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * A leader's "Double-visits conducted" tile adds up (2026-10-27). Dina Hamdy's year to date read 712 over a split of
 * AM 76 · PM 419 · Pharmacies 1 (496), and her reps list summed to 705. Measured on production: the 216 were 209
 * campaign double visits (the headline counted them, the split did not) and 7 Phoenix ride-alongs whose customer
 * awaits validation; the 7 were visits of 2 to 5 August on a Tanta account before its holder's hire date (no HR id).
 *
 * - A campaign double visit counts in its half, as the rep's own page counts it.
 * - The split plus the ride-alongs awaiting validation is the headline, always.
 * - The reps list prints the unmatched visits as a line of their own, so it adds up to the headline too.
 */

function ride(over: Partial<ManagerDayVisit>): ManagerDayVisit {
  return {
    address: null,
    areaName: null,
    awaitingValidation: false,
    brickName: null,
    bucket: "PM",
    comment: null,
    customerName: "Dr. Mona Adel",
    date: "2026-10-12",
    grade: null,
    hasPin: false,
    id: Math.random().toString(36).slice(2),
    inVacantTerritory: false,
    kind: "double",
    kindLabel: "",
    listType: "PM",
    loggedAt: null,
    loggedHalf: "PM",
    managerHrId: "dm-1",
    pharmacyName: null,
    placeLabel: null,
    placeSource: "none",
    planned: true,
    products: [],
    source: "ride_along",
    speciality: null,
    territoryName: null,
    withPeople: [],
    ...over,
  } as ManagerDayVisit;
}

type DoorRow = Parameters<typeof conductedDoubleVisitFigures>[0][number] & { agent_hr_id: string | null };

function door(over: Partial<DoorRow>): DoorRow {
  return {
    agent_hr_id: "rep-1",
    ampm: "PM",
    comment: null,
    crm_visit_id: 1000,
    double2_hr_id: null,
    source: "ireports360",
    speciality: null,
    visit_date: "2026-10-12",
    visit_type: 0,
    visit_type_description: "Regular Visit",
    ...over,
  };
}

export function runEmployee360DvSplitTests(): void {
  // ── 1. A campaign double visit is in its half, never in no figure ──
  assert.equal(conductedVisitBucket(door({ ampm: "AM", visit_type: -8, visit_type_description: "Campaign (Prospection)" })), "AM");
  assert.equal(conductedVisitBucket(door({ visit_type: -8, visit_type_description: "Campaign (Prospection)" })), "PM");
  assert.equal(conductedVisitBucket(door({ visit_type: -19, visit_type_description: "Meeting" })), null, "a row that is not field work is in no half");

  // ── 2. Split + awaiting validation = the headline ──
  const phoenix = leaderVisitFigures([
    ride({ listType: "AM" }),
    ride({ listType: "PM" }),
    ride({ listType: "Pharmacy", pharmacyName: "El Ezaby" }),
    ride({ awaitingValidation: true }),
  ]);
  const rows: DoorRow[] = [
    door({ ampm: "AM", crm_visit_id: 1 }),
    door({ crm_visit_id: 2 }),
    door({ ampm: "AM", crm_visit_id: 3, visit_type: -8, visit_type_description: "Campaign (Prospection)" }),
    door({ crm_visit_id: 4, visit_type: -8, visit_type_description: "Campaign (Prospection)" }),
    door({ agent_hr_id: null, crm_visit_id: 5 }),
    // The door's copy of a ride-along: counted through the ride-along, never twice and never as unmatched.
    door({ agent_hr_id: null, crm_visit_id: -9, source: "phoenix" }),
  ];
  const conducted = conductedDoubleVisitFigures(rows, phoenix);
  assert.ok(conducted);
  assert.equal(conducted.total, 9, "4 ride-alongs and 5 door rows");
  assert.equal(conducted.awaitingValidation, 1);
  assert.deepEqual(conducted.split, { am: 3, pharmacies: 1, pm: 4 }, "campaign doubles in their half; the ride-along awaiting validation in none");
  assert.equal(
    visitCountSplitTotal(conducted.split) + conducted.awaitingValidation,
    conducted.total,
    "AM + PM + Pharmacies + awaiting validation is the headline — 712 over 496 can never be printed again",
  );

  // ── 3. The reps list adds up: the unmatched visits are a line of their own ──
  assert.equal(unmatchedConductedDoubleVisits(rows), 1, "the iReports360 row with no HR id; the Phoenix copy is not counted");
  const listed = rows.filter((r) => r.source !== "phoenix" && String(r.agent_hr_id ?? "").trim()).length;
  assert.equal(listed + unmatchedConductedDoubleVisits(rows) + phoenix.rides.doubles, conducted.total);

  // ── 4. The screen prints both, so the figures add up where he reads them ──
  const view = stripComments(readFileSync("src/components/employee-360/employee-360-view.tsx", "utf8"));
  assert.match(view, /awaitingValidationTail\(leadership\.dvAwaitingValidation\)/, "the tile names the visits awaiting validation");
  assert.match(view, /Not matched to an employee/, "the reps list names the unmatched visits");
  assert.match(view, /leadership\.dvUnmatched > 0/, "and only when there are some");
}
