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
    ...collectSourceFiles("app/(admin)/leave-management"),
    ...collectSourceFiles("src/components/employee-portal"),
    ...collectSourceFiles("src/components/vacation"),
    "app/payslips/page.tsx",
  ]
    .map((filePath) => `${filePath}\n${readFileSync(filePath, "utf8")}`)
    .join("\n");
  const dashboardSource = readFileSync("src/components/employee-portal/employee-portal-dashboard.tsx", "utf8");
  const layoutSource = readFileSync("src/components/employee-portal/employee-portal-layout.tsx", "utf8");
  const marketingDraftsSource = readFileSync("src/components/employee-portal/marketing-request-drafts.tsx", "utf8");
  const portalPrimitivesSource = readFileSync("src/components/employee-portal/portal-primitives.tsx", "utf8");
  const portalShellSource = readFileSync("src/components/employee-portal/enterprise-shell.tsx", "utf8");
  const adminPageSource = readFileSync("app/(admin)/admin/page.tsx", "utf8");
  const vacanciesPageSource = readFileSync("app/employee-portals/vacancies/page.tsx", "utf8");
  const teamPerformancePageSource = readFileSync("app/employee-portals/team-performance/page.tsx", "utf8");
  const roiPageSource = readFileSync("app/employee-portals/roi/page.tsx", "utf8");
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
  assert.doesNotMatch(
    layoutSource,
    /marketing-requests\/roi-tracking/,
    "ROI Tracking must no longer be a sidebar tab for any role now that Coverage Report replaces it (the page/permission stay live for direct-URL access).",
  );
  assert.match(
    layoutSource,
    /marketing-requests\/coverage-report/,
    "Coverage Report must remain the Marketing & ROI sidebar tab",
  );
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
  assert.match(
    roiPageSource,
    /ROI_PORTAL_ROLES = new Set\(\[[^\]]*"National Sales Manager"[^\]]*\]\)/,
    "ROI Intelligence page-level role gate must include National Sales Manager to match the sidebar tab",
  );
  assert.match(launchSmokeSource, /employeePortalStaticRoutes/);
  assert.match(launchSmokeSource, /employeePortalReachableRoutes/);
  assert.match(launchSmokeSource, /\/payslips/);
  assert.match(launchSmokeSource, /\/leave-management\/vacation-request/);
  assert.match(launchSmokeSource, /\/leave-management\/vacation-report/);
  assert.match(launchSmokeSource, /PHOENIX_EMPLOYEE_PORTAL_SMOKE_USERS_JSON/);
  assert.match(launchSmokeSource, /\/api\/auth\/login/);
  assert.match(launchSmokeSource, /runDirectRouteSweep/);
  assert.match(launchSmokeSource, /portal error/);
  assert.match(portalPrimitivesSource, /export function PortalResponsiveDataList/);
  assert.match(portalPrimitivesSource, /export function PortalRecordCard/);
  assert.match(portalPrimitivesSource, /export function PortalDesktopTable/);
  assert.match(portalPrimitivesSource, /data-portal-desktop-table/);
  assert.match(portalShellSource, /employee-portal-mobile-safe/);
  assert.match(portalShellSource, /overflow-x: hidden/);
  assert.doesNotMatch(
    employeePortalSource,
    /hidden xs:block|block xs:hidden|xs:hidden/,
    "Portal-owned pages must keep card/mobile layouts through md instead of exposing tables at xs.",
  );
  assert.doesNotMatch(
    employeePortalSource,
    /min-w-\[(?:1[12-9]\d{2}|[2-9]\d{3})px\]/,
    "Portal-owned pages must not ship 1200px+ Tailwind min-width tables as the mobile data strategy.",
  );

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
  assert.equal(a3Account.showPlanningCalendarTab, true, "A-3 should always see the Planning Calendar tab (split from showPlansTab, 2026-07-25)");
  assert.equal(a3Account.showReportItTab, true, "A-3 should see Report It");
  assert.equal(a3Account.showReportItDashboardTab, false, "A-3 Reports Dashboard is merged into the single Report It tab (no separate dashboard tab needed)");

  // Owner-requested 2026-07-25: Talent Acquisition keeps the read-only, HO-scoped
  // Planning Calendar but loses the Weekly/Monthly Plan submission tab (showPlansTab
  // split from showPlanningCalendarTab specifically for this role).
  const talentAcquisitionNav = resolveEmployeePortalNavVisibility("Talent Acquisition");
  assert.equal(talentAcquisitionNav.showPlansTab, false, "Talent Acquisition should not see the Weekly / Monthly Plan tab");
  assert.equal(talentAcquisitionNav.showPlanningCalendarTab, true, "Talent Acquisition should still see the Planning Calendar tab");
  assert.equal(talentAcquisitionNav.showPrivateCalendarTab, true, "Talent Acquisition should see Private Calendar");

  const nationalSalesManager = resolveEmployeePortalNavVisibility("National Sales Manager");
  assert.equal(nationalSalesManager.showMyCoachingTab, false, "NSM should not see My Coaching Reports");
  assert.equal(nationalSalesManager.showTeamCoachingTab, true, "NSM should see Team Coaching Reports");
  assert.equal(
    nationalSalesManager.showRoiIntelligenceTab,
    true,
    "NSM should see the ROI/Sales Marketing Intelligence dashboard (scoped to their own line server-side)",
  );
  assert.equal(
    nationalSalesManager.showCoachingAnalyticsTab,
    false,
    "NSM gaining ROI Intelligence must not also grant Coaching Analytics (that stays PM/GPM/MM only)",
  );
  assert.equal(
    nationalSalesManager.showDoubleVisitAnalyticsTab,
    false,
    "NSM gaining ROI Intelligence must not also grant Double-Visit Analytics (that stays PM/GPM/MM only)",
  );

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
    "/admin/sfe-command-center",
    "SFE Manager should land in the dedicated SFE Manager overview",
  );

  const marketingManager = resolveEmployeePortalNavVisibility("Marketing Manager");
  assert.equal(marketingManager.showIncentiveTab, false, "Marketing Manager should NOT see Incentive (hidden from MM per portal policy)");

  // --- Marketing Requests and Contact HR Support both graduated to full modules ------
  const previousBetaFlag = process.env.PHOENIX_PORTAL_SHOW_BETA_NAV;

  // Default launch posture (flag unset): Marketing Requests is a full module and stays
  // visible for authorized roles; Contact HR Support is now a full module visible to
  // every employee-portal user (everyone must be able to reach their HR team).
  delete process.env.PHOENIX_PORTAL_SHOW_BETA_NAV;

  const nsmDefault = resolveEmployeePortalNavVisibility("National Sales Manager");
  assert.equal(nsmDefault.showMarketingRequestsTab, true, "NSM should see Marketing Requests in nav (full module, flag-independent)");
  assert.equal(nsmDefault.showSupportTab, true, "NSM should see Contact HR Support in nav (full module, flag-independent)");
  assert.equal(nsmDefault.showDoubleVisitReportTab, true, "NSM should see the Double Visit Report tab in the portal sidebar (in DV_FOCUS_ROLES)");

  // Product Manager and Group Product Manager are authorized for Marketing and must
  // see the module in nav without the launch flag (regression coverage).
  const productManagerDefault = resolveEmployeePortalNavVisibility("Product Manager");
  assert.equal(productManagerDefault.showMyPerformanceTab, true, "Product Manager now sees Sales Dashboard (showMyPerformanceTab)");
  assert.equal(productManagerDefault.showExpenseActionTab, true, "Product Manager should see Submit Expense in nav");
  assert.equal(productManagerDefault.showMarketingRequestsTab, true, "Product Manager should see Marketing Requests in nav (full module)");
  assert.equal(productManagerDefault.showMarketingInboxTab, true, "Product Manager should see the Marketing Approval Inbox in nav");
  assert.equal(productManagerDefault.showMarketingRoiTrackingTab, true, "Product Manager should stay authorized for ROI Tracking (permission-only; the tab itself is retired from the sidebar)");
  assert.equal(productManagerDefault.showVacanciesTab, true, "Product Manager should see the line-scoped Vacancies tab in nav");
  assert.equal(productManagerDefault.showProbationTab, true, "Product Manager should see the line-scoped Probation tab in nav");
  assert.equal(productManagerDefault.showOrganogramTab, true, "Product Manager should see the line-scoped Organogram tab in nav");

  const groupProductManagerDefault = resolveEmployeePortalNavVisibility("Group Product Manager");
  assert.equal(groupProductManagerDefault.showMyPerformanceTab, true, "Group Product Manager now sees Sales Dashboard (showMyPerformanceTab)");
  assert.equal(groupProductManagerDefault.showExpenseActionTab, true, "Group Product Manager should see Submit Expense in nav");
  assert.equal(groupProductManagerDefault.showMarketingRequestsTab, true, "Group Product Manager should see Marketing Requests in nav (full module)");
  assert.equal(groupProductManagerDefault.showMarketingInboxTab, true, "Group Product Manager should see the Marketing Approval Inbox in nav");
  assert.equal(groupProductManagerDefault.showMarketingRoiTrackingTab, true, "Group Product Manager should stay authorized for ROI Tracking (permission-only; the tab itself is retired from the sidebar)");
  assert.equal(groupProductManagerDefault.showVacanciesTab, true, "Group Product Manager should see the line-scoped Vacancies tab in nav");
  assert.equal(groupProductManagerDefault.showProbationTab, true, "Group Product Manager should see the line-scoped Probation tab in nav");
  assert.equal(groupProductManagerDefault.showOrganogramTab, true, "Group Product Manager should see the line-scoped Organogram tab in nav");

  // Direct Orders -- submit/report are the module's own requester-role set; approvals is
  // only the two roles that ever sit as a person-rung in the approval ladder.
  const districtManagerDefault = resolveEmployeePortalNavVisibility("District Manager");
  const regionalManagerDefault = resolveEmployeePortalNavVisibility("Regional Manager");
  assert.equal(districtManagerDefault.showDirectOrdersTab, true, "District Manager should see Direct Orders (requester role)");
  assert.equal(districtManagerDefault.showDirectOrdersReportTab, true, "District Manager should see Direct Orders Report");
  assert.equal(districtManagerDefault.showDirectOrdersApprovalsTab, false, "District Manager never sits as a person-rung, so no Approvals tab");
  assert.equal(regionalManagerDefault.showDirectOrdersTab, true, "Regional Manager should see Direct Orders (requester role)");
  assert.equal(regionalManagerDefault.showDirectOrdersApprovalsTab, true, "Regional Manager is a person-rung approver, so the Approvals tab must show");
  assert.equal(nsmDefault.showDirectOrdersTab, true, "National Sales Manager should see Direct Orders (requester role)");
  assert.equal(nsmDefault.showDirectOrdersApprovalsTab, true, "National Sales Manager is a person-rung approver, so the Approvals tab must show");
  assert.equal(productManagerDefault.showDirectOrdersTab, true, "Product Manager should see Direct Orders (requester role)");
  assert.equal(productManagerDefault.showDirectOrdersApprovalsTab, false, "Product Manager goes straight to CEO, so no Approvals tab");
  assert.equal(groupProductManagerDefault.showDirectOrdersTab, true, "Group Product Manager should see Direct Orders (requester role)");
  const trainingManagerForDirectOrders = resolveEmployeePortalNavVisibility("Training Manager");
  assert.equal(trainingManagerForDirectOrders.showDirectOrdersTab, false, "Direct Orders must not show for a role outside the module's requester set");
  assert.equal(trainingManagerForDirectOrders.showDirectOrdersApprovalsTab, false, "Direct Orders Approvals must not show for a role that never approves");

  // Direct Orders is hidden from the CNS line entirely (owner decision, 2026-07-20) --
  // even a role that would otherwise qualify never sees any of the 3 tabs on CNS.
  const cnsDistrictManager = resolveEmployeePortalNavVisibility("District Manager", undefined, "CNS");
  const cnsRegionalManager = resolveEmployeePortalNavVisibility("Regional Manager", undefined, "CNS");
  const cnsNationalSalesManager = resolveEmployeePortalNavVisibility("National Sales Manager", undefined, "CNS");
  assert.equal(cnsDistrictManager.showDirectOrdersTab, false, "CNS District Manager must not see Direct Orders");
  assert.equal(cnsDistrictManager.showDirectOrdersReportTab, false, "CNS District Manager must not see Direct Orders Report");
  assert.equal(cnsRegionalManager.showDirectOrdersTab, false, "CNS Regional Manager must not see Direct Orders");
  assert.equal(cnsRegionalManager.showDirectOrdersApprovalsTab, false, "CNS Regional Manager must not see Direct Orders Approvals even though RM is normally a person-rung approver");
  assert.equal(cnsNationalSalesManager.showDirectOrdersApprovalsTab, false, "CNS National Sales Manager must not see Direct Orders Approvals");
  // A non-CNS line for the same roles must be unaffected (the exclusion is CNS-specific).
  const pediaDistrictManager = resolveEmployeePortalNavVisibility("District Manager", undefined, "Pedia");
  assert.equal(pediaDistrictManager.showDirectOrdersTab, true, "Pedia District Manager keeps Direct Orders -- the CNS exclusion must not leak to other lines");

  const marketingManagerDefault = resolveEmployeePortalNavVisibility("Marketing Manager");
  assert.equal(marketingManagerDefault.showDirectOrdersTab, false, "Marketing Manager is NOT a Direct Orders requester role");
  // MM mirrors GPM on every nav surface EXCEPT five intentional differences:
  // - Incentive stays hidden from Marketing Manager per portal policy
  // - Attendance Analytics is visible for team attendance oversight
  // - Double Visit Report is hidden: MM is NOT in DV_FOCUS_ROLES, so its page would reject MM
  // - Direct Orders submit/report are hidden: MM is NOT in DIRECT_ORDER_REQUESTER_ROLES,
  //   so the module's own server-side gate would reject an MM submission anyway
  assert.deepEqual(
    {
      ...marketingManagerDefault,
      showIncentiveTab: groupProductManagerDefault.showIncentiveTab,
      showFingerprintReportTab: groupProductManagerDefault.showFingerprintReportTab,
      showDoubleVisitReportTab: groupProductManagerDefault.showDoubleVisitReportTab,
      showDirectOrdersTab: groupProductManagerDefault.showDirectOrdersTab,
      showDirectOrdersReportTab: groupProductManagerDefault.showDirectOrdersReportTab,
    },
    groupProductManagerDefault,
    "Marketing Manager sidebar visibility must mimic Group Product Manager (apart from the hidden Incentive tab, the Attendance Analytics tab, the Double Visit Report tab, and Direct Orders submit/report)",
  );
  assert.equal(groupProductManagerDefault.showDoubleVisitReportTab, true, "Group Product Manager sees the Double Visit Report tab (in DV_FOCUS_ROLES)");
  assert.equal(marketingManagerDefault.showDoubleVisitReportTab, false, "Marketing Manager does NOT get the Double Visit Report tab (not in DV_FOCUS_ROLES — its page would redirect)");
  assert.equal(groupProductManagerDefault.showIncentiveTab, true, "Group Product Manager still sees Incentive (only MM is hidden)");
  assert.equal(marketingManagerDefault.showIncentiveTab, false, "Marketing Manager should NOT see Incentive (hidden from MM per portal policy)");
  assert.equal(
    marketingManagerDefault.showFingerprintReportTab,
    true,
    "Marketing Manager additionally gets the Attendance Analytics tab (team attendance oversight)",
  );
  assert.equal(
    groupProductManagerDefault.showFingerprintReportTab,
    false,
    "Group Product Manager does not get the Attendance Analytics tab",
  );
  assert.equal(marketingManagerDefault.showMyPerformanceTab, true, "Marketing Manager sees Sales Dashboard like GPM");
  assert.equal(marketingManagerDefault.showPlansTab, true, "Marketing Manager should see plans like PM/GPM");
  assert.equal(marketingManagerDefault.showVacanciesTab, true, "Marketing Manager should see Vacancies like PM/GPM");
  assert.equal(marketingManagerDefault.showProbationTab, true, "Marketing Manager should see Probation like PM/GPM");
  assert.equal(marketingManagerDefault.showOrganogramTab, true, "Marketing Manager should see Organogram like PM/GPM");
  assert.equal(marketingManagerDefault.showExpenseActionTab, true, "Marketing Manager should see Submit Expense like PM/GPM");
  assert.equal(marketingManagerDefault.showMarketingRequestsTab, true, "Marketing Manager should see Marketing Requests in nav");
  assert.equal(marketingManagerDefault.showMarketingInboxTab, true, "Marketing Manager should see the Marketing Approval Inbox in nav");
  assert.equal(marketingManagerDefault.showMarketingRoiTrackingTab, true, "Marketing Manager should stay authorized for ROI Tracking (permission-only; the tab itself is retired from the sidebar)");

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
  assert.equal(nsmCore.showTeamExpensesTab, false, "NSM no longer sees the standalone Team Expenses tab (consolidated into the Expense Dashboard)");

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
    /if \(!access\.loginId && !access\.hrId\) \{[\s\S]*?redirect\("\/login"\);[\s\S]*?\}[\s\S]*?assertPermission\(access, "support_requests", "create"\)/,
    "Contact HR Support page must redirect guests before asserting support request permissions",
  );
  assert.match(
    contactHrSupportPageSource,
    /assertPermission\(access, "support_requests", "create"\)/,
    "Contact HR Support page must keep its support_requests create guard",
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
