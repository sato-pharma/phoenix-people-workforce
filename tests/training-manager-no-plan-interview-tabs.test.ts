import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { resolveEmployeePortalNavVisibility } from "../src/lib/employee-portal/navigation.ts";

export function runTrainingManagerNoPlanInterviewTabsTests() {
  // The interview calendar is shared to him on purpose here, so only the seat can hide it.
  const trainingManager = resolveEmployeePortalNavVisibility(
    "Training Manager", "Training Manager", null, null, null, false, true,
  );
  assert.equal(trainingManager.showPlansTab, false, "the Training Manager is not offered the Weekly / Monthly Plan form");
  assert.equal(trainingManager.showInterviewCalendarTab, false, "the Training Manager is not offered the Interview Calendar, shared or not");
  assert.equal(trainingManager.showPlanningCalendarTab, true, "the Planning Calendar stays");
  assert.equal(trainingManager.showVacanciesTab, false, "the Training Manager is not offered the Vacancies report");

  // Other seats keep both tabs.
  const productManager = resolveEmployeePortalNavVisibility(
    "Product Manager", "Product Manager", null, null, null, false, true,
  );
  assert.equal(productManager.showPlansTab, true);
  assert.equal(productManager.showInterviewCalendarTab, true);
  assert.equal(productManager.showVacanciesTab, true);

  const page = readFileSync("app/employee-portals/training-manager/page.tsx", "utf8");
  assert.doesNotMatch(page, /Submit Weekly Plan/, "the module page no longer links to the plan form");
}
