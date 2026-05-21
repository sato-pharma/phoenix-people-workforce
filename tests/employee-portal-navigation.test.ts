import assert from "node:assert/strict";

import { resolveLandingPathForRole } from "../src/lib/auth/landing.ts";
import { resolveEmployeePortalNavVisibility } from "../src/lib/employee-portal/navigation.ts";

export function runEmployeePortalNavigationTests() {
  const medicalRep = resolveEmployeePortalNavVisibility("Medical Rep");
  assert.equal(medicalRep.showDashboardTab, true, "Medical Rep should see Dashboard");
  assert.equal(medicalRep.showMyPerformanceTab, true, "Medical Rep should see My Performance");
  assert.equal(medicalRep.showExpenseActionTab, false, "Medical Rep should not see the manager expense action");
  assert.equal(medicalRep.showMedicalRepExpensesTab, true, "Medical Rep should see their own expenses tab");
  assert.equal(medicalRep.showMyCoachingTab, true, "Medical Rep should see My Coaching Reports");
  assert.equal(medicalRep.showTeamCoachingTab, false, "Medical Rep should not see Team Coaching Reports");
  assert.equal(medicalRep.showTrainingManagerCreateCoachingTab, false, "Medical Rep should not see Create Coaching Report");

  const medicalRepWithManagerAccess = resolveEmployeePortalNavVisibility("Medical Rep", "National Sales Manager");
  assert.equal(
    medicalRepWithManagerAccess.showExpenseActionTab,
    false,
    "Medical Rep navigation should not inherit manager expense actions from access role fallback",
  );
  assert.equal(
    medicalRepWithManagerAccess.showMedicalRepExpensesTab,
    true,
    "Medical Rep navigation should keep the rep expenses tab even when access role fallback differs",
  );

  const districtManager = resolveEmployeePortalNavVisibility("District Manager");
  assert.equal(districtManager.showMyCoachingTab, false, "DSM should not see My Coaching Reports");
  assert.equal(districtManager.showTeamCoachingTab, true, "DSM should see Team Coaching Reports");
  assert.equal(districtManager.showTrainingManagerCreateCoachingTab, false, "DSM should not see Create Coaching Report");

  const nationalSalesManager = resolveEmployeePortalNavVisibility("National Sales Manager");
  assert.equal(nationalSalesManager.showMyCoachingTab, false, "NSM should not see My Coaching Reports");
  assert.equal(nationalSalesManager.showTeamCoachingTab, true, "NSM should see Team Coaching Reports");

  const nsmAlias = resolveEmployeePortalNavVisibility("NSM");
  assert.equal(nsmAlias.showTeamCoachingTab, true, "NSM alias should see Team Coaching Reports");

  const trainingManager = resolveEmployeePortalNavVisibility("Training Manager");
  assert.equal(trainingManager.showDashboardTab, false, "Training Manager should not see Dashboard");
  assert.equal(trainingManager.showMyPerformanceTab, false, "Training Manager should not see My Performance");
  assert.equal(trainingManager.showIncentiveTab, false, "Training Manager should not see Incentive");
  assert.equal(trainingManager.showTrainingManagerDashboardTab, true, "Training Manager should see Coaching Dashboard");
  assert.equal(trainingManager.showTrainingManagerCreateCoachingTab, true, "Training Manager should see Create Coaching Report");
  assert.equal(trainingManager.showTrainingManagerFieldCoachingTab, true, "Training Manager should see Field Coaching");
  assert.equal(trainingManager.showMyCoachingTab, false, "Training Manager should not see My Coaching Reports");
  assert.equal(trainingManager.showTeamCoachingTab, false, "Training Manager should not see Team Coaching Reports");
  assert.equal(
    resolveLandingPathForRole("Training Manager"),
    "/employee-portals/training-manager",
    "Training Manager should land on the dedicated coaching dashboard",
  );
  assert.equal(
    resolveLandingPathForRole("SFE Manager"),
    "/admin/marketing-requests",
    "SFE Manager should land in the admin marketing request shell",
  );
}
