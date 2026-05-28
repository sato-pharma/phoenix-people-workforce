import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { resolveLandingPathForRole } from "../src/lib/auth/landing.ts";
import { resolveEmployeePortalNavVisibility } from "../src/lib/employee-portal/navigation.ts";

function collectSourceFiles(root: string): string[] {
  return readdirSync(root)
    .flatMap((entry) => {
      const filePath = join(root, entry);
      if (statSync(filePath).isDirectory()) return collectSourceFiles(filePath);
      return /\.(tsx?|jsx?)$/.test(entry) ? [filePath] : [];
    });
}

export function runEmployeePortalNavigationTests() {
  const employeePortalSource = [
    ...collectSourceFiles("app/employee-portals"),
    ...collectSourceFiles("app/leave-management"),
    ...collectSourceFiles("src/components/employee-portal"),
    ...collectSourceFiles("src/components/vacation"),
    "app/payslips/page.tsx",
  ]
    .map((filePath) => `${filePath}\n${readFileSync(filePath, "utf8")}`)
    .join("\n");
  const dashboardSource = readFileSync("src/components/employee-portal/employee-portal-dashboard.tsx", "utf8");
  const layoutSource = readFileSync("src/components/employee-portal/employee-portal-layout.tsx", "utf8");
  const marketingDraftsSource = readFileSync("src/components/employee-portal/marketing-request-drafts.tsx", "utf8");
  const adminPageSource = readFileSync("app/admin/page.tsx", "utf8");
  const vacanciesPageSource = readFileSync("app/employee-portals/vacancies/page.tsx", "utf8");
  const teamPerformancePageSource = readFileSync("app/employee-portals/team-performance/page.tsx", "utf8");
  const launchSmokeSource = readFileSync("scripts/employee-portal-launch-smoke.mjs", "utf8");

  assert.doesNotMatch(
    employeePortalSource,
    /Ã|Â|â|�/,
    "Employee portal source should not contain mojibake in UI text, comments, or fallback strings.",
  );
  assert.doesNotMatch(dashboardSource, /href="#"/, "Employee portal dashboard must not ship dead hash links.");
  assert.match(dashboardSource, /Phoenix Workforce - \$\{employeeName\}/);
  assert.match(dashboardSource, /Loading\.\.\./);
  assert.match(layoutSource, /searchMatches/);
  assert.match(layoutSource, /navigateToSearchResult/);
  assert.match(layoutSource, /Search portal pages\.\.\./);
  assert.match(layoutSource, /timeZone: "Africa\/Cairo"/);
  assert.doesNotMatch(marketingDraftsSource, /â€¦/, "Marketing request drafts should not render mojibake ellipsis text.");
  assert.match(marketingDraftsSource, /Math\.max\(0, maxLen - 3\)\)\}\.\.\./);
  assert.match(adminPageSource, /canReadAdmin/);
  assert.match(adminPageSource, /canReadOverview/);
  assert.match(adminPageSource, /canAccess\(access, "employee_profile", "read"\)/);
  assert.match(adminPageSource, /Access unavailable/);
  assert.match(vacanciesPageSource, /canAccess\(access, "vacancies", "read"\)/);
  assert.doesNotMatch(vacanciesPageSource, /assertPermission\(access, "vacancies", "read"\)/);
  assert.match(teamPerformancePageSource, /canAccess\(access, "sales", "read"\)/);
  assert.doesNotMatch(teamPerformancePageSource, /assertPermission\(access, "sales", "read"\)/);
  assert.match(launchSmokeSource, /employeePortalStaticRoutes/);
  assert.match(launchSmokeSource, /employeePortalReachableRoutes/);
  assert.match(launchSmokeSource, /\/payslips/);
  assert.match(launchSmokeSource, /\/leave-management\/vacation-request/);
  assert.match(launchSmokeSource, /\/leave-management\/vacation-report/);
  assert.match(launchSmokeSource, /PHOENIX_EMPLOYEE_PORTAL_SMOKE_USERS_JSON/);
  assert.match(launchSmokeSource, /\/api\/auth\/login/);
  assert.match(launchSmokeSource, /runDirectRouteSweep/);
  assert.match(launchSmokeSource, /portal error/);

  const medicalRep = resolveEmployeePortalNavVisibility("Medical Rep");
  assert.equal(medicalRep.showDashboardTab, true, "Medical Rep should see Dashboard");
  assert.equal(medicalRep.showMyPerformanceTab, true, "Medical Rep should see My Performance");
  assert.equal(medicalRep.showExpenseActionTab, false, "Medical Rep should not see the manual outstation expense action");
  assert.equal(medicalRep.showMedicalRepExpensesTab, true, "Medical Rep should see their own expenses tab");
  assert.equal(medicalRep.showMyCoachingTab, true, "Medical Rep should see My Coaching Reports");
  assert.equal(medicalRep.showTeamCoachingTab, false, "Medical Rep should not see Team Coaching Reports");
  assert.equal(medicalRep.showTrainingManagerCreateCoachingTab, false, "Medical Rep should not see Create Coaching Report");

  const medicalRepWithManagerAccess = resolveEmployeePortalNavVisibility("Medical Rep", "National Sales Manager");
  assert.equal(
    medicalRepWithManagerAccess.showExpenseActionTab,
    false,
    "Medical Rep navigation should not inherit manual outstation expense actions from access role fallback",
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
