import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { resolveLandingPathForRole } from "../src/lib/auth/landing.ts";
import {
  resolveEmployeePortalNavVisibility,
  shouldShowEmployeePortalMarketingQuickAction,
} from "../src/lib/employee-portal/navigation.ts";

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

  // --- Workstream 4: Beta module launch navigation gating ----------------------
  const previousBetaFlag = process.env.PHOENIX_PORTAL_SHOW_BETA_NAV;

  // Default launch posture (flag unset): Beta modules are hidden from portal nav.
  delete process.env.PHOENIX_PORTAL_SHOW_BETA_NAV;

  const nsmDefault = resolveEmployeePortalNavVisibility("National Sales Manager");
  assert.equal(nsmDefault.showMarketingRequestsTab, false, "NSM should not see Marketing Requests in nav by default");
  assert.equal(nsmDefault.showSupportTab, false, "NSM should not see Contact HR Support in nav by default");

  const sfeDefault = resolveEmployeePortalNavVisibility("SFE Manager");
  assert.equal(sfeDefault.showMarketingControlTab, false, "SFE Manager should not see Marketing Control in nav by default");
  assert.equal(sfeDefault.showMarketingRequestsTab, false, "SFE Manager should not see Marketing Requests in nav by default");

  const superAdminDefault = resolveEmployeePortalNavVisibility("Super Admin");
  assert.equal(superAdminDefault.showMarketingRequestsTab, false, "Super Admin should not see Marketing Requests in nav by default");
  assert.equal(superAdminDefault.showMarketingControlTab, false, "Super Admin should not see Marketing Control in nav by default");
  assert.equal(superAdminDefault.showMarketingCustomerDatabaseTab, false, "Super Admin should not see SCP / PH Database in nav by default");
  assert.equal(superAdminDefault.showSupportTab, false, "Super Admin should not see Contact HR Support in nav by default");

  // Core 8 launch modules stay visible for the correct roles regardless of the flag.
  const medRepCore = resolveEmployeePortalNavVisibility("Medical Rep");
  assert.equal(medRepCore.showDashboardTab, true, "Core: Medical Rep keeps Dashboard with beta nav off");
  assert.equal(medRepCore.showMyPerformanceTab, true, "Core: Medical Rep keeps My Performance with beta nav off");
  assert.equal(medRepCore.showIncentiveTab, true, "Core: Medical Rep keeps Incentive with beta nav off");
  assert.equal(medRepCore.showMedicalRepExpensesTab, true, "Core: Medical Rep keeps outstation expenses with beta nav off");

  const nsmCore = resolveEmployeePortalNavVisibility("National Sales Manager");
  assert.equal(nsmCore.showMedRepsPerformanceTab, true, "Core: NSM keeps MRs Performance with beta nav off");
  assert.equal(nsmCore.showDsmsPerformanceTab, true, "Core: NSM keeps DSMs Performance with beta nav off");
  assert.equal(nsmCore.showTeamExpensesTab, true, "Core: NSM keeps Team Expenses with beta nav off");

  // Beta flag enabled: Beta modules appear for already-authorized roles only.
  process.env.PHOENIX_PORTAL_SHOW_BETA_NAV = "true";

  const nsmBeta = resolveEmployeePortalNavVisibility("National Sales Manager");
  assert.equal(nsmBeta.showMarketingRequestsTab, true, "NSM should see Marketing Requests when beta nav is enabled");
  assert.equal(nsmBeta.showSupportTab, true, "Contact HR Support should appear when beta nav is enabled");

  const sfeBeta = resolveEmployeePortalNavVisibility("SFE Manager");
  assert.equal(sfeBeta.showMarketingControlTab, true, "SFE Manager should see Marketing Control when beta nav is enabled");
  assert.equal(sfeBeta.showMarketingRequestsTab, true, "SFE Manager should see Marketing Requests when beta nav is enabled");

  const superAdminBeta = resolveEmployeePortalNavVisibility("Super Admin");
  assert.equal(superAdminBeta.showMarketingCustomerDatabaseTab, true, "Super Admin should see SCP / PH Database when beta nav is enabled");

  // Enabling the flag must never grant Marketing to a role that was not authorized.
  const trainingManagerBeta = resolveEmployeePortalNavVisibility("Training Manager");
  assert.equal(trainingManagerBeta.showMarketingRequestsTab, false, "Beta flag must not grant Marketing Requests to an unauthorized role");
  assert.equal(trainingManagerBeta.showMarketingControlTab, false, "Beta flag must not grant Marketing Control to an unauthorized role");
  assert.equal(trainingManagerBeta.showSupportTab, true, "Contact HR Support returns for any portal role when beta nav is enabled");

  // Restore the launch posture so the flag never leaks into other suites.
  if (previousBetaFlag === undefined) {
    delete process.env.PHOENIX_PORTAL_SHOW_BETA_NAV;
  } else {
    process.env.PHOENIX_PORTAL_SHOW_BETA_NAV = previousBetaFlag;
  }

  // buildEmployeePortalSections wires every Beta nav item behind its flag, and the
  // flags default to false, so the launch nav hides them unless explicitly enabled.
  assert.match(
    layoutSource,
    /showSupportTab = false/,
    "Support nav flag must default to hidden in buildEmployeePortalSections",
  );
  assert.match(
    layoutSource,
    /showSupportTab \? \[\{ href: "\/employee-portals\/contact-hr-support"/,
    "Contact HR Support nav item must be gated behind showSupportTab",
  );
  assert.match(
    layoutSource,
    /showMarketingRequestsTab \? \[\{ href: "\/employee-portals\/marketing-requests\/validation"/,
    "HCP / PH Validation nav item must be gated behind showMarketingRequestsTab",
  );
  assert.match(
    layoutSource,
    /showMarketingControlTab \? \[\{ href: "\/employee-portals\/marketing-requests\/control"/,
    "Marketing Control nav item must be gated behind showMarketingControlTab",
  );
  assert.match(
    layoutSource,
    /showMarketingCustomerDatabaseTab \? \[\{ href: "\/employee-portals\/marketing-requests\/customer-database"/,
    "SCP / PH Database nav item must be gated behind showMarketingCustomerDatabaseTab",
  );

  // Page-level guards must remain unchanged: hiding nav never weakens direct-URL access.
  const contactHrSupportPageSource = readFileSync("app/employee-portals/contact-hr-support/page.tsx", "utf8");
  assert.match(
    contactHrSupportPageSource,
    /assertPermission\(access, "support_requests", "read"\)/,
    "Contact HR Support page must keep its support_requests read guard",
  );
  const marketingRequestsPageSource = readFileSync("app/employee-portals/marketing-requests/page.tsx", "utf8");
  assert.match(
    marketingRequestsPageSource,
    /assertEmployeePortalMarketingPageAccess/,
    "Marketing Requests page must keep its page-level access guard",
  );

  // --- Workstream 4 follow-up: dashboard Marketing quick-action gating ---------
  // Hidden by default (beta flag unset/false), regardless of role authorization.
  assert.equal(
    shouldShowEmployeePortalMarketingQuickAction(undefined, "Medical Rep"),
    false,
    "Dashboard Marketing quick-action must be hidden when the beta flag is unset",
  );
  assert.equal(
    shouldShowEmployeePortalMarketingQuickAction(false, "National Sales Manager"),
    false,
    "Dashboard Marketing quick-action must be hidden when the beta flag is false (even for authorized roles)",
  );
  assert.equal(
    shouldShowEmployeePortalMarketingQuickAction(false, "Super Admin"),
    false,
    "Dashboard Marketing quick-action stays hidden for Super Admin when beta is off",
  );

  // Appears only when beta flag is true AND the role is already authorized.
  assert.equal(
    shouldShowEmployeePortalMarketingQuickAction(true, "Medical Rep"),
    true,
    "Dashboard Marketing quick-action appears for an authorized role when beta is enabled",
  );
  assert.equal(
    shouldShowEmployeePortalMarketingQuickAction(true, "National Sales Manager"),
    true,
    "Dashboard Marketing quick-action appears for NSM when beta is enabled",
  );

  // Beta on must NOT surface it for roles not authorized for Marketing.
  assert.equal(
    shouldShowEmployeePortalMarketingQuickAction(true, "Employee"),
    false,
    "Beta flag must not surface the Marketing quick-action for an unauthorized Employee",
  );
  assert.equal(
    shouldShowEmployeePortalMarketingQuickAction(true, "Training Manager"),
    false,
    "Beta flag must not surface the Marketing quick-action for Training Manager",
  );

  // The dashboard wires the quick-action through the gating helper, and Core 8
  // quick-actions (Submit Expense, Submit Vacation Request) remain ungated.
  assert.match(
    dashboardSource,
    /shouldShowEmployeePortalMarketingQuickAction\(data\.betaNavEnabled, data\.employee\.roleLabel\)/,
    "Dashboard Marketing quick-action must be gated via shouldShowEmployeePortalMarketingQuickAction",
  );
  assert.match(dashboardSource, /label: "Submit Expense"/, "Core 8 Submit Expense quick-action must remain present");
  assert.match(dashboardSource, /label: "Submit Vacation Request"/, "Core 8 Submit Vacation Request quick-action must remain present");
}
