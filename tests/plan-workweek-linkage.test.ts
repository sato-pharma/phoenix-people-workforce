import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { incompleteDaysHeading } from "../src/lib/weekly-planning/plan-editor-state.ts";
import {
  buildEmployeePlanPeriod,
  employeePlanActivityTypes,
  FIELD_WORKWEEK,
  GROUP_PRODUCT_MANAGER_WORKWEEK,
  HEAD_OFFICE_WORKWEEK,
  planDayGapText,
  planRequiredSlotsByDate,
  planWorkweekAllowsHalfDays,
  resolvePlanWorkweek,
  type PlanSlot,
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

  // --- The Group Product Manager plans half days (owner, 2026-10-18) ---------
  // ONLY the Group Product Manager may plan a working day as AM only or PM only.
  assert.equal(resolvePlanWorkweek({ jobTitle: "Group Product Manager" }), GROUP_PRODUCT_MANAGER_WORKWEEK);
  assert.equal(resolvePlanWorkweek({ role: "Group Product Manager" }), GROUP_PRODUCT_MANAGER_WORKWEEK);
  assert.equal(planWorkweekAllowsHalfDays(GROUP_PRODUCT_MANAGER_WORKWEEK), true);
  for (const title of ["Product Manager", "Marketing Manager", "Training Manager", "National Sales Manager", "Medical Rep"]) {
    assert.equal(planWorkweekAllowsHalfDays(resolvePlanWorkweek({ jobTitle: title })), false, `${title} must still plan full days`);
  }
  // Same Sunday–Thursday week as the rest of Head Office, every day needing one half.
  const gpm = buildEmployeePlanPeriod("weekly", "2026-07-01", GROUP_PRODUCT_MANAGER_WORKWEEK);
  assert.equal(gpm.periodStartDate, ho.periodStartDate);
  assert.equal(gpm.periodEndDate, ho.periodEndDate);
  const gpmSlots = planRequiredSlotsByDate(gpm.periodStartDate, gpm.periodEndDate, GROUP_PRODUCT_MANAGER_WORKWEEK);
  assert.equal(gpmSlots.size, 5);
  for (const [, requirement] of gpmSlots) assert.equal(requirement, "half");

  // --- What a day still lacks (the banner and the server's submit check) -----
  const slots = (...values: PlanSlot[]) => new Set<PlanSlot>(values);
  assert.equal(planDayGapText("half", slots("am")), null, "AM only completes a Group Product Manager's day");
  assert.equal(planDayGapText("half", slots("pm")), null, "PM only completes a Group Product Manager's day");
  assert.equal(planDayGapText("half", slots("full")), null);
  assert.equal(planDayGapText("half", slots()), "", "an empty day is still incomplete");
  assert.equal(planDayGapText("full", slots("am")), " (afternoon missing)", "everyone else still needs the full day");
  assert.equal(planDayGapText("full", slots("pm")), " (morning missing)");
  assert.equal(planDayGapText("full", slots("am", "pm")), null);
  assert.equal(planDayGapText("full", slots()), "");
  assert.equal(planDayGapText("am", slots("pm")), " (morning)");
  assert.equal(planDayGapText("am", slots("am")), null);

  // --- New activity types ---------------------------------------------------
  assert.ok((employeePlanActivityTypes as readonly string[]).includes("National Vacation"));
  assert.ok((employeePlanActivityTypes as readonly string[]).includes("Excuse"));

  // --- The incomplete-days banner's heading ---------------------------------
  // The half-day planner's server check (planDayGapText "half") accepts the morning OR the afternoon,
  // so "Finish every working day" asked a Group Product Manager for more than the server does.
  assert.equal(
    incompleteDaysHeading(planWorkweekAllowsHalfDays(GROUP_PRODUCT_MANAGER_WORKWEEK)),
    "Plan at least the morning or the afternoon of every working day before submitting",
  );
  assert.equal(
    incompleteDaysHeading(planWorkweekAllowsHalfDays(HEAD_OFFICE_WORKWEEK)),
    "Finish every working day before submitting",
    "everyone else keeps the copy they always had",
  );
  assert.equal(incompleteDaysHeading(planWorkweekAllowsHalfDays(FIELD_WORKWEEK)), "Finish every working day before submitting");

  // The banner's heading wraps: a nowrap line in a flex row with no min-width forced the row (and the
  // page) wider than a 375px phone. Read from the emitted JSX, comments excluded.
  const workspace = readFileSync("src/components/employee-portal/plans-workspace.tsx", "utf8");
  const bannerAt = workspace.indexOf("{incompleteDaysHeading(allowHalfDays)}");
  assert.ok(bannerAt >= 0, "the banner must render incompleteDaysHeading(allowHalfDays)");
  const bannerLine = workspace.slice(workspace.lastIndexOf("<p", bannerAt), bannerAt);
  assert.ok(
    !bannerLine.includes("whitespace-nowrap"),
    "the incomplete-days heading must be allowed to wrap, or it overflows a phone",
  );
  assert.ok(bannerLine.includes("min-w-0"), "and it needs min-w-0 to shrink inside its flex row");
}
