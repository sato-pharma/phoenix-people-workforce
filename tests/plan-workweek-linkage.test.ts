import { strict as assert } from "node:assert";

import {
  buildEmployeePlanPeriod,
  employeePlanActivityTypes,
  FIELD_WORKWEEK,
  HEAD_OFFICE_WORKWEEK,
  planRequiredSlotsByDate,
  resolvePlanWorkweek,
} from "../src/lib/weekly-planning/plan-v1.ts";

export function runPlanWorkweekLinkageTests() {
  // --- Role classification --------------------------------------------------
  // Field Force (Saturday-anchored week) — ONLY field sales roles.
  for (const title of ["Medical Rep", "District Sales Manager", "Regional Manager"]) {
    assert.equal(resolvePlanWorkweek({ jobTitle: title }).category, "field", `${title} should be field`);
  }
  assert.equal(resolvePlanWorkweek({ role: "Medical Rep" }).category, "field");
  assert.equal(resolvePlanWorkweek({ role: "District Manager" }).category, "field");
  assert.equal(resolvePlanWorkweek({ role: "Regional Manager" }).category, "field");

  // Head Office (Sunday-anchored week) — incl. National Sales Manager.
  for (const title of [
    "Product Manager",
    "Group Product Manager",
    "Marketing Manager",
    "Training Manager",
    "National Sales Manager",
    "HR Specialist",
  ]) {
    assert.equal(resolvePlanWorkweek({ jobTitle: title }).category, "head_office", `${title} should be head office`);
  }
  assert.equal(resolvePlanWorkweek({ role: "National Sales Manager" }).category, "head_office");
  // Unknown / empty defaults to the safe Head Office week.
  assert.equal(resolvePlanWorkweek({}).category, "head_office");

  // --- Weekly period anchoring ---------------------------------------------
  // Anchor on Wed 2026-07-01. Head Office week = Sun 2026-06-28 → Thu 2026-07-02.
  const ho = buildEmployeePlanPeriod("weekly", "2026-07-01", HEAD_OFFICE_WORKWEEK);
  assert.equal(ho.periodStartDate, "2026-06-28"); // Sunday
  assert.equal(ho.periodEndDate, "2026-07-02"); // Thursday

  // Field Force week for the same anchor = Sat 2026-06-27 → Thu 2026-07-02.
  const field = buildEmployeePlanPeriod("weekly", "2026-07-01", FIELD_WORKWEEK);
  assert.equal(field.periodStartDate, "2026-06-27"); // Saturday
  assert.equal(field.periodEndDate, "2026-07-02"); // Thursday

  // Default (no workweek arg) preserves the legacy Sunday-anchored behaviour.
  const legacy = buildEmployeePlanPeriod("weekly", "2026-07-01");
  assert.equal(legacy.periodStartDate, ho.periodStartDate);
  assert.equal(legacy.periodEndDate, ho.periodEndDate);

  // --- Required slots per workweek -----------------------------------------
  const hoSlots = planRequiredSlotsByDate(ho.periodStartDate, ho.periodEndDate, HEAD_OFFICE_WORKWEEK);
  assert.equal(hoSlots.size, 5); // Sun–Thu
  for (const [, requirement] of hoSlots) assert.equal(requirement, "full");

  const fieldSlots = planRequiredSlotsByDate(field.periodStartDate, field.periodEndDate, FIELD_WORKWEEK);
  assert.equal(fieldSlots.size, 6); // Sat–Thu
  assert.equal(fieldSlots.get("2026-07-02"), "am"); // Thursday is AM-only
  assert.equal(fieldSlots.get("2026-06-27"), "full"); // Saturday full
  assert.equal(fieldSlots.get("2026-07-01"), "full"); // Wednesday full
  // Friday is never a required day for either workweek.
  assert.equal(fieldSlots.has("2026-06-26"), false);

  // --- New activity types ---------------------------------------------------
  assert.ok((employeePlanActivityTypes as readonly string[]).includes("National Vacation"));
  assert.ok((employeePlanActivityTypes as readonly string[]).includes("Excuse"));
}
