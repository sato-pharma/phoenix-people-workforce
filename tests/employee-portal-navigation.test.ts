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
  const adminPageSource = readFileSync("app/(admin)/admin/page.tsx", "utf8");
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
  assert.equal(medicalRep.showExpenseDashboardTab, false, "Medical Rep should not see the Expense Dashboard (they have their own expenses tab)");
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

  const plainEmployee = resolveEmployeePortalNavVisibility("Employee");
  assert.equal(plainEmployee.showExpenseActionTab, true, "Any non-Medical-Rep employee should see Submit Expense");
  assert.equal(plainEmployee.showExpenseDashboardTab, true, "Any non-Medical-Rep employee should see Expense Dashboard");

  const districtManager = resolveEmployeePortalNavVisibility("District Manager");
  assert.equal(districtManager.showMyCoachingTab, false, "DSM should not see My Coaching Reports");
  assert.equal(districtManager.showTeamCoachingTab, true, "DSM should see Team Coaching Reports");
  assert.equal(districtManager.showTrainingManagerCreateCoachingTab, false, "DSM should not see Create Coaching Report");

  const a3Account = resolveEmployeePortalNavVisibility("Medical Rep", undefined, undefined, undefined, "A-3");
  assert.equal(a3Account.showMyPerformanceTab, false, "A-3 should not see My Performance in employee portal");
  assert.equal(a3Account.showIncentiveTab, false, "A-3 should not see Incentive in employee portal");
  assert.equal(a3Account.showPlansTab, true, "A-3 should always see the Weekly / Monthly Plan tab");
  assert.equal(a3Account.showReportItTab, true, "A-3 should see Report It");
  assert.equal(a3Account.showReportItDashboardTab, true, "A-3 should see Reports Dashboard");

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

  // --- Marketing Requests and Contact HR Support both graduated to full modules ------
  const previousBetaFlag = process.env.PHOENIX_PORTAL_SHOW_BETA_NAV;

  // Default launch posture (flag unset): Marketing Requests is a full module and stays
  // visible for authorized roles; Contact HR Support is now a full module visible to
  // every employee-portal user (everyone must be able to reach their HR team).
  delete process.env.PHOENIX_PORTAL_SHOW_BETA_NAV;

  const nsmDefault = resolveEmployeePortalNavVisibility("National Sales Manager");
  assert.equal(nsmDefault.showMarketingRequestsTab, true, "NSM should see Marketing Requests in nav (full module, flag-independent)");
  assert.equal(nsmDefault.showSupportTab, true, "NSM should see Contact HR Support in nav (full module, flag-independent)");

  // Product Manager and Group Product Manager are authorized for Marketing and must
  // see the module in nav without the launch flag (regression coverage).
  const productManagerDefault = resolveEmployeePortalNavVisibility("Product Manager");
  assert.equal(productManagerDefault.showMyPerformanceTab, false, "Product Manager should not see My Performance");
  assert.equal(productManagerDefault.showExpenseActionTab, true, "Product Manager should see Submit Expense in nav");
  assert.equal(productManagerDefault.showMarketingRequestsTab, true, "Product Manager should see Marketing Requests in nav (full module)");
  assert.equal(productManagerDefault.showMarketingInboxTab, true, "Product Manager should see the Marketing Approval Inbox in nav");
  assert.equal(productManagerDefault.showMarketingRoiTrackingTab, true, "Product Manager should see Marketing ROI Tracking in nav");

  const groupProductManagerDefault = resolveEmployeePortalNavVisibility("Group Product Manager");
  assert.equal(groupProductManagerDefault.showMyPerformanceTab, false, "Group Product Manager should not see My Performance");
  assert.equal(groupProductManagerDefault.showExpenseActionTab, true, "Group Product Manager should see Submit Expense in nav");
  assert.equal(groupProductManagerDefault.showMarketingRequestsTab, true, "Group Product Manager should see Marketing Requests in nav (full module)");
  assert.equal(groupProductManagerDefault.showMarketingInboxTab, true, "Group Product Manager should see the Marketing Approval Inbox in nav");
  assert.equal(groupProductManagerDefault.showMarketingRoiTrackingTab, true, "Group Product Manager should see Marketing ROI Tracking in nav");

  const marketingManagerDefault = resolveEmployeePortalNavVisibility("Marketing Manager");
  assert.equal(marketingManagerDefault.showMyPerformanceTab, false, "Marketing Manager should not see My Performance");

  const sfeDefault = resolveEmployeePortalNavVisibility("SFE Manager");
  assert.equal(sfeDefault.showMarketingControlTab, true, "SFE Manager should see Marketing Control in nav (full module)");
  assert.equal(sfeDefault.showMarketingRequestsTab, true, "SFE Manager should see Marketing Requests in nav (full module)");

  const superAdminDefault = resolveEmployeePortalNavVisibility("Super Admin");
  assert.equal(superAdminDefault.showMarketingRequestsTab, true, "Super Admin should see Marketing Requests in nav (full module)");
  assert.equal(superAdminDefault.showMarketingControlTab, true, "Super Admin should see Marketing Control in nav (full module)");
  assert.equal(superAdminDefault.showMarketingCustomerDatabaseTab, true, "Super Admin should see Customer Database in nav (full module)");
  assert.equal(superAdminDefault.showSupportTab, true, "Super Admin should see Contact HR Support in nav (full module)");

  // Contact HR Support is available to every portal role, including those with a trimmed
  // nav like Training Manager — everyone must be able to reach their HR team.
  const trainingManagerSupport = resolveEmployeePortalNavVisibility("Training Manager");
  assert.equal(trainingManagerSupport.showSupportTab, true, "Contact HR Support must show for every portal role");

  // Marketing Requests visibility never extends to an unauthorized role.
  const trainingManagerDefault = resolveEmployeePortalNavVisibility("Training Manager");
  assert.equal(trainingManagerDefault.showMarketingRequestsTab, false, "Marketing Requests must not show for an unauthorized role");
  assert.equal(trainingManagerDefault.showMarketingControlTab, false, "Marketing Control must not show for an unauthorized role");

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

  // Beta flag enabled: full modules stay visible; the flag never downgrades them.
  process.env.PHOENIX_PORTAL_SHOW_BETA_NAV = "true";

  const nsmBeta = resolveEmployeePortalNavVisibility("National Sales Manager");
  assert.equal(nsmBeta.showMarketingRequestsTab, true, "NSM keeps Marketing Requests when beta nav is enabled");
  assert.equal(nsmBeta.showSupportTab, true, "Contact HR Support stays visible when beta nav is enabled");

  // Enabling the flag must never grant Marketing to a role that was not authorized.
  const trainingManagerBeta = resolveEmployeePortalNavVisibility("Training Manager");
  assert.equal(trainingManagerBeta.showMarketingRequestsTab, false, "Beta flag must not grant Marketing Requests to an unauthorized role");
  assert.equal(trainingManagerBeta.showMarketingControlTab, false, "Beta flag must not grant Marketing Control to an unauthorized role");
  assert.equal(trainingManagerBeta.showSupportTab, true, "Contact HR Support stays visible for any portal role");

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
    "Customer Validation nav item must be gated behind showMarketingRequestsTab",
  );
  assert.match(
    layoutSource,
    /showMarketingControlTab \? \[\{ href: "\/employee-portals\/marketing-requests\/control"/,
    "Marketing Control nav item must be gated behind showMarketingControlTab",
  );
  assert.match(
    layoutSource,
    /showMarketingCustomerDatabaseTab \? \[\{ href: "\/employee-portals\/marketing-requests\/customer-database"/,
    "Customer Database nav item must be gated behind showMarketingCustomerDatabaseTab",
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

  // --- Dashboard Marketing quick-action: full module, role-gated only ----------
  // Visible for authorized roles regardless of the (legacy) beta flag argument.
  assert.equal(
    shouldShowEmployeePortalMarketingQuickAction(undefined, "Medical Rep"),
    true,
    "Dashboard Marketing quick-action shows for an authorized role (full module, flag-independent)",
  );
  assert.equal(
    shouldShowEmployeePortalMarketingQuickAction(false, "National Sales Manager"),
    true,
    "Dashboard Marketing quick-action shows for NSM even when the legacy beta argument is false",
  );
  assert.equal(
    shouldShowEmployeePortalMarketingQuickAction(false, "Product Manager"),
    true,
    "Dashboard Marketing quick-action shows for Product Manager (full module)",
  );
  assert.equal(
    shouldShowEmployeePortalMarketingQuickAction(false, "Group Product Manager"),
    true,
    "Dashboard Marketing quick-action shows for Group Product Manager (full module)",
  );

  // Never surfaces for roles not authorized for Marketing.
  assert.equal(
    shouldShowEmployeePortalMarketingQuickAction(true, "Employee"),
    false,
    "Marketing quick-action must not surface for an unauthorized Employee",
  );
  assert.equal(
    shouldShowEmployeePortalMarketingQuickAction(true, "Training Manager"),
    false,
    "Marketing quick-action must not surface for Training Manager",
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
