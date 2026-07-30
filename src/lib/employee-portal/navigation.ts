import { parseRoleStrict, type PhoenixRole } from "@/lib/auth/permissions";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { resolveJobFunctionRole } from "@/lib/employees/job-function";
import { canViewMarketingCoverageReport } from "@/lib/marketing-requests/coverage-report-access";
import { isDirectOrderRequesterRole } from "@/lib/direct-orders/types";

export type EmployeePortalNavVisibility = {
  showDashboardTab?: boolean;
  showExcusesTab?: boolean;
  showExpenseActionTab?: boolean;
  showExpenseDashboardTab?: boolean;
  showMyVisitsTab?: boolean;
  showDeductionsTab?: boolean;
  showIncentiveTab?: boolean;
  showMarketingRequestsTab?: boolean;
  showMarketingInboxTab?: boolean;
  showMarketingCustomerDatabaseTab?: boolean;
  showMarketingControlTab?: boolean;
  showMarketingRoiTrackingTab?: boolean;
  showMarketingCoverageReportTab?: boolean;
  showMyPerformanceTab?: boolean;
  showTeamPerformanceTab?: boolean;
  showMedRepsPerformanceTab?: boolean;
  showMedicalRepExpensesTab?: boolean;
  showDsmsPerformanceTab?: boolean;
  // Team Calendar — NSM-only live field-visit month grid for their whole line, scoped
  // server-side (see src/lib/employee-portal/team-calendar.ts). Reads the iReports360
  // visits mirror; each green numeric day deep-links to that rep's day drill-down.
  showTeamCalendarTab?: boolean;
  showTeamExpensesTab?: boolean;
  showVacanciesTab?: boolean;
  showProbationTab?: boolean;
  showOrganogramTab?: boolean;
  showPlansTab?: boolean;
  // Planning Calendar (read-only, HO-scoped for Talent Acquisition — see
  // isPlanItemVisibleToViewer). Split from showPlansTab (2026-07-25) so the Weekly/
  // Monthly Plan submission link can be removed for a role while keeping this one.
  showPlanningCalendarTab?: boolean;
  showSupportTab?: boolean;
  // Recruitment & Hiring group (Recruitment, CV Database, Hiring Documents) plus HR
  // Support Requests (which lives in the "HR Support" section) — Talent Acquisition's
  // portal mirror of the admin-shell hrAuthorityNavigationRoles tools. See
  // employee-portal-layout.tsx. Vacation Control has a page but is deliberately unlinked
  // (owner-requested removal, 2026-07-24).
  showRecruitmentHiringTab?: boolean;
  // People Management group (Employees, Contract Renewal, Resignations, Vacancies
  // Report) — Talent Acquisition's company-wide HR tooling, separate from the
  // Recruitment & Hiring group above. See employee-portal-layout.tsx.
  showPeopleManagementTab?: boolean;
  // Private Calendar is deliberately hidden from every portal role's nav by default
  // (owner decision — see app/employee-portals/private-calendar/page.tsx, which has no
  // role gate). This flag is a scoped, Talent-Acquisition-only exception to that default.
  showPrivateCalendarTab?: boolean;
  // Narrow account activate/deactivate tool — see src/lib/recruitment/account-activation.ts.
  showAccountActivationTab?: boolean;
  showMyCoachingTab?: boolean;
  showTeamCoachingTab?: boolean;
  showTrainingManagerCreateCoachingTab?: boolean;
  showTrainingManagerDashboardTab?: boolean;
  showTrainingManagerFieldCoachingTab?: boolean;
  showReportItTab?: boolean;
  showReportItDashboardTab?: boolean;
  showFingerprintReportTab?: boolean;
  // Sales Intelligence (Product / Group Product Managers): line- or product-scoped
  // analytics surfaces that mirror the admin dashboards inside the employee portal.
  showRoiIntelligenceTab?: boolean;
  // Source of Sales — distributor sell-in dashboard, scope-aware. Shown to the field sales
  // management roles + product/marketing managers (see /employee-portals/source-of-sales).
  showSourceOfSalesTab?: boolean;
  // Weekly Sales — de-cumulated weekly distributor sell-in, same role set as Source of Sales.
  showWeeklyTab?: boolean;
  // Sales Analytics — the portal-native analytics module at /employee-portals/sales-analytics
  // (Source of Sales + Monthly Closing + Weekly for everyone; + Executive Comparison + Reconciliation
  // for RM and line managers). Every page enforces sales/weekly_sales read AND the per-viewer
  // AnalyticsViewerScope server-side; this flag only surfaces the sidebar link.
  showSalesAnalyticsTab?: boolean;
  // Territory & Sales Drilldown — geography-rooted (Region>Area>Block>Brick>Pharmacy) sales
  // tree at /employee-portals/territory-drilldown. All four sales roles now shipped (see
  // TERRITORY_DRILLDOWN_ROLES in src/lib/sales/territory/service.ts, the server-side gate
  // this flag must stay in sync with).
  showTerritoryDrilldownTab?: boolean;
  showCoachingAnalyticsTab?: boolean;
  showDoubleVisitAnalyticsTab?: boolean;
  showDoubleVisitReportTab?: boolean;
  showActionsTab?: boolean;
  // Direct Orders — submit/report are the same requester-role set the module itself
  // enforces server-side (DIRECT_ORDER_REQUESTER_ROLES); approvals is only the two
  // roles that ever sit as a person-rung in the approval ladder (see
  // directOrderManagementLadder) — the CEO's rung always resolves to the admin shell.
  showDirectOrdersTab?: boolean;
  showDirectOrdersReportTab?: boolean;
  showDirectOrdersApprovalsTab?: boolean;
  showVacationApprovalsTab?: boolean;
  // Excuse has its own flag (distinct from vacation) so a module can be hidden for one role
  // without touching the other — e.g. National Sales Manager sees Vacation but not Excuse.
  showExcuseApprovalsTab?: boolean;
  showPlanApprovalsTab?: boolean;
  showAttendanceTab?: boolean;
};

function resolvePortalRole(
  roleLabel: string | null | undefined,
  accessRole?: string | null | undefined,
): PhoenixRole {
  // Resolve an explicit Phoenix role where present; otherwise classify by job
  // function (title-based). roleLabel keeps precedence over accessRole to
  // preserve historical portal-nav behavior. This is UX only — every portal page
  // keeps its own server-side access guard.
  for (const candidate of [roleLabel, accessRole]) {
    if (!candidate) continue;
    try {
      return parseRoleStrict(candidate);
    } catch {}
    const jobFunctionRole = resolveJobFunctionRole(candidate);
    if (jobFunctionRole !== "Employee") return jobFunctionRole;
  }

  return "Employee";
}

/**
 * Launch posture flag for Beta employee-portal modules.
 *
 * Marketing Requests and Contact HR Support have both graduated from Beta to full
 * modules and are no longer gated by this flag. Contact HR Support is available to
 * every employee-portal user (everyone can reach their HR team); Marketing Requests
 * stays role-gated. No employee-portal module is currently gated behind this flag,
 * but it is retained for any future Beta launch.
 *
 * Set PHOENIX_PORTAL_SHOW_BETA_NAV=true (server env) to surface future Beta modules
 * in the nav for roles that are already authorized for them. Read at call time so the
 * launch posture can change without a rebuild and so tests can toggle it.
 */
export function isEmployeePortalBetaNavEnabled(): boolean {
  return String(process.env.PHOENIX_PORTAL_SHOW_BETA_NAV ?? "").trim().toLowerCase() === "true";
}

const marketingRequestRoles = new Set<PhoenixRole>([
  "Medical Rep",
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
  "Marketing Manager",
  "SFE Manager",
  "CEO",
  "Super Admin",
]);

const hideMyPerformanceTabRoles = new Set<PhoenixRole>([
  "Training Manager",
]);

export function canUseEmployeePortalMarketingRequests(
  roleLabel: string | null | undefined,
  accessRole?: string | null | undefined,
) {
  return marketingRequestRoles.has(resolvePortalRole(roleLabel, accessRole));
}

export function canUseEmployeePortalMarketingControl(
  roleLabel: string | null | undefined,
  accessRole?: string | null | undefined,
) {
  const role = resolvePortalRole(roleLabel, accessRole);
  return role === "SFE Manager" || role === "Super Admin";
}

/**
 * Whether the dashboard "Submit Marketing Request" quick-action should render.
 *
 * Marketing Requests is now a full module, so the quick-action renders whenever
 * the role is already authorized for Marketing — independent of the beta flag.
 * The leading `betaNavEnabled` parameter is retained for call-site compatibility
 * (the dashboard still passes it) but no longer gates visibility.
 */
export function shouldShowEmployeePortalMarketingQuickAction(
  _betaNavEnabled: boolean | undefined,
  roleLabel: string | null | undefined,
  accessRole?: string | null | undefined,
) {
  return canUseEmployeePortalMarketingRequests(roleLabel, accessRole);
}

export function canUseEmployeePortalMarketingCustomerDatabase(
  roleLabel: string | null | undefined,
  accessRole?: string | null | undefined,
) {
  return resolvePortalRole(roleLabel, accessRole) === "Super Admin";
}

export function canUseEmployeePortalMarketingRoiTracking(
  roleLabel: string | null | undefined,
  accessRole?: string | null | undefined,
) {
  return marketingRequestRoles.has(resolvePortalRole(roleLabel, accessRole));
}

/**
 * Broader than ROI Tracking's own role set: the Marketing Coverage Report is
 * deliberately open to the whole marketing/sales hierarchy INCLUDING Finance
 * Manager and Financial Advisor (scoped to their own subtree server-side — see
 * coverage-report-scope.ts), not just marketingRequestRoles.
 */
export function canUseEmployeePortalMarketingCoverageReport(
  roleLabel: string | null | undefined,
  accessRole?: string | null | undefined,
) {
  return canViewMarketingCoverageReport(resolvePortalRole(roleLabel, accessRole));
}

export function resolveEmployeePortalNavVisibility(
  roleLabel: string | null | undefined,
  accessRole?: string | null | undefined,
  employeeLineName?: string | null | undefined,
  employeeDepartmentName?: string | null | undefined,
  viewerHrId?: string | null | undefined,
  hasDeviceMapping?: boolean,
): EmployeePortalNavVisibility {
  const resolvedRole = resolvePortalRole(roleLabel, accessRole);
  const normalizedLine = String(employeeLineName ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  const normalizedDepartment = String(employeeDepartmentName ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  const isMedicalRep = resolvedRole === "Medical Rep";
  const isDistrictManager = resolvedRole === "District Manager" || resolvedRole === "Manager";
  const isNationalSalesManager = resolvedRole === "National Sales Manager";
  // Product / Group Product / Marketing Managers get line-scoped Vacancies, Probation, and
  // Organogram views (see getEmployeePortalVacancies, probation service, and
  // isLineScopedOrganogramRole). The sidebar tabs must mirror that data access.
  const isProductManager = resolvedRole === "Product Manager";
  const isGroupProductManager = resolvedRole === "Group Product Manager";
  const isMarketingManager = resolvedRole === "Marketing Manager";
  const isA3Account = canonicalHrIdKey(viewerHrId) === "a-3";
  const isTalentAcquisition = resolvedRole === "Talent Acquisition";
  const isHeadOffice =
    ["office", "headoffice", "hq"].includes(normalizedLine) ||
    ["office", "headoffice", "hq"].includes(normalizedDepartment);
  // Direct Orders is hidden from the CNS line entirely (owner decision) — even a role
  // that would otherwise qualify (DM/RM/NSM/PM/GPM) never sees these 3 tabs while on
  // the CNS line. This is a NAV-ONLY exclusion; it does not touch data access.
  const isCnsLine = normalizedLine === "cns";
  const isTrainingManager = resolvedRole === "Training Manager";
  // Mirrors EXCUSE_EXCLUDED_ROLES in src/lib/excuses/service.ts, which is the enforcing gate.
  // Spelled out here instead of imported: that module pulls in the Supabase server client and
  // node:crypto, neither of which may reach this nav helper (it is consumed by client components).
  const isExcuseExcludedPortalRole =
    resolvedRole === "District Manager" || resolvedRole === "Regional Manager";
  const hideMyPerformanceTab = hideMyPerformanceTabRoles.has(resolvedRole);
  const showTeamPerformanceTab = isDistrictManager;
  const showMedRepsPerformanceTab = isNationalSalesManager;
  // Talent Acquisition is HR staff processing outstation expenses, not a field claimant —
  // she has no outstation expenses of her own, so both expense tabs stay hidden for her.
  const showExpenseActionTab = !isMedicalRep && !isTalentAcquisition;
  const showExpenseDashboardTab = !isMedicalRep && !isTalentAcquisition;
  // "My Visits" (CRM field visits) and Deductions are owner-requested exclusions for
  // Talent Acquisition specifically — she is HR/office staff, not a field employee.
  const showMyVisitsTab = !isTalentAcquisition;
  const showDeductionsTab = !isTalentAcquisition;
  // Marketing Requests and Contact HR Support are full modules: their tabs are visible
  // without the launch flag. Marketing role checks still apply, so Marketing visibility
  // never extends to an unauthorized role. Contact HR Support is available to every
  // employee-portal user — everyone must be able to reach their HR team.
  const showMarketingRequestsTab = canUseEmployeePortalMarketingRequests(resolvedRole);
  const showMarketingInboxTab = canUseEmployeePortalMarketingRequests(resolvedRole);
  const showMarketingCustomerDatabaseTab = canUseEmployeePortalMarketingCustomerDatabase(resolvedRole);
  const showMarketingControlTab = canUseEmployeePortalMarketingControl(resolvedRole);
  const showMarketingRoiTrackingTab = canUseEmployeePortalMarketingRoiTracking(resolvedRole);
  const showMarketingCoverageReportTab = canUseEmployeePortalMarketingCoverageReport(resolvedRole);
  const showTeamCoachingTab = showTeamPerformanceTab || showMedRepsPerformanceTab;
  const showPlansTab = [
    "Product Manager",
    "Group Product Manager",
    "Marketing Manager",
    "Training Manager",
    "National Sales Manager",
    "CEO",
    "Super Admin",
    "Manager",
    "Regional Manager",
    "Talent Acquisition",
  ].includes(resolvedRole);
  const baseShowMyPerformanceTab = !hideMyPerformanceTab;
  const baseShowIncentiveTab = !isTrainingManager && !isMarketingManager && !isTalentAcquisition;
  // Product / Group Product Managers (and their line manager, Marketing Manager) get the
  // line/product-scoped Sales Intelligence analytics surfaces. Each page enforces its own
  // server-side scope; the sidebar visibility just mirrors that access.
  const showSalesIntelligence = isProductManager || isGroupProductManager || isMarketingManager;
  // National Sales Manager also gets the ROI/Marketing Intelligence dashboard (their business
  // scope is LINE — see getSalesScope — so the page + service already bound them to their own
  // line's data). Deliberately NOT folded into showSalesIntelligence: that flag also drives
  // Coaching Analytics and Double-Visit Analytics, which NSM was not asked to gain here.
  const showRoiIntelligenceTab = showSalesIntelligence || isNationalSalesManager;
  const showDirectOrdersTab = !isCnsLine && isDirectOrderRequesterRole(resolvedRole);
  const isDirectOrderApprovalRung = !isCnsLine && (resolvedRole === "Regional Manager" || isNationalSalesManager);

  return {
    showDashboardTab: !isTrainingManager,
    showDsmsPerformanceTab: isNationalSalesManager,
    showTeamCalendarTab: isNationalSalesManager,
    // The isHeadOffice branch is line/department-based, so a District or Regional Manager sitting
    // on the Office line would otherwise be offered a submit form the server now rejects — mirror
    // the EXCUSE_EXCLUDED_ROLES gate here so the tab never appears for those two roles.
    showExcusesTab:
      !isExcuseExcludedPortalRole &&
      (isHeadOffice ||
        isNationalSalesManager ||
        isProductManager ||
        isGroupProductManager ||
        isMarketingManager ||
        isTrainingManager ||
        isTalentAcquisition),
    showExpenseActionTab: isA3Account ? false : showExpenseActionTab,
    showExpenseDashboardTab: isA3Account ? false : showExpenseDashboardTab,
    showIncentiveTab: isA3Account ? false : baseShowIncentiveTab,
    showMarketingCustomerDatabaseTab,
    showMarketingControlTab,
    showMarketingInboxTab,
    showMarketingRequestsTab,
    showMarketingRoiTrackingTab,
    showMarketingCoverageReportTab,
    showMedRepsPerformanceTab,
    showMedicalRepExpensesTab: isMedicalRep,
    showMyPerformanceTab: isA3Account ? false : baseShowMyPerformanceTab,
    showMyCoachingTab: isMedicalRep,
    showReportItTab: isA3Account,
    showReportItDashboardTab: isProductManager || isGroupProductManager || isMarketingManager || isTrainingManager,
    showOrganogramTab:
      showMedRepsPerformanceTab || isProductManager || isGroupProductManager || isMarketingManager || isTalentAcquisition,
    // Talent Acquisition keeps the read-only Planning Calendar (HO-scoped) but not the
    // Weekly/Monthly Plan submission page — owner-requested removal, 2026-07-25.
    showPlanningCalendarTab: isA3Account || showPlansTab,
    showPlansTab: isA3Account || (showPlansTab && !isTalentAcquisition),
    showProbationTab:
      showTeamPerformanceTab || showMedRepsPerformanceTab || isProductManager || isGroupProductManager || isMarketingManager || isTalentAcquisition,
    showSupportTab: true,
    showRecruitmentHiringTab: isTalentAcquisition,
    showPeopleManagementTab: isTalentAcquisition,
    showPrivateCalendarTab: isTalentAcquisition,
    showAccountActivationTab: isTalentAcquisition,
    showTeamCoachingTab,
    // Team Expenses was an NSM-only surface. It is retired from the portal nav:
    // the NSM's single expense destination is now the Expense Dashboard, whose
    // LINE scope (see getExpensesScope) already covers self + the whole line.
    showTeamExpensesTab: false,
    showTeamPerformanceTab,
    showTrainingManagerCreateCoachingTab: isTrainingManager,
    showTrainingManagerDashboardTab: isTrainingManager,
    showTrainingManagerFieldCoachingTab: isTrainingManager,
    showVacanciesTab:
      showTeamPerformanceTab || showMedRepsPerformanceTab || isProductManager || isGroupProductManager || isMarketingManager,
    // Personally device-tracked employees see their own punch history; a head-of-department
    // Marketing Manager also gets the tab to review their team's attendance (self + direct reports,
    // gated server-side by canViewEmployeeAttendanceReport on /employee-portals/fingerprint-analytics).
    showFingerprintReportTab: hasDeviceMapping === true || isMarketingManager,
    showRoiIntelligenceTab,
    showSourceOfSalesTab:
      resolvedRole === "District Manager" ||
      resolvedRole === "Regional Manager" ||
      resolvedRole === "National Sales Manager" ||
      resolvedRole === "Product Manager" ||
      resolvedRole === "Group Product Manager" ||
      resolvedRole === "Marketing Manager",
    showWeeklyTab:
      resolvedRole === "District Manager" ||
      resolvedRole === "Regional Manager" ||
      resolvedRole === "National Sales Manager" ||
      resolvedRole === "Product Manager" ||
      resolvedRole === "Group Product Manager" ||
      resolvedRole === "Marketing Manager",
    // Portal Sales Analytics module (/employee-portals/sales-analytics) — NOT an /admin URL. Every
    // sales field/portal role gets it, scoped to their own line/region: Medical Rep + District Manager
    // see the 3 core dashboards; Regional Manager + the line managers additionally get Executive
    // Comparison + Reconciliation (see canViewPortalDetailedAnalytics). CEO/SA/SFE use /admin analytics.
    showSalesAnalyticsTab:
      isMedicalRep ||
      isDistrictManager ||
      resolvedRole === "Regional Manager" ||
      isNationalSalesManager ||
      isProductManager ||
      isGroupProductManager ||
      isMarketingManager,
    showTerritoryDrilldownTab:
      isMedicalRep ||
      resolvedRole === "District Manager" ||
      resolvedRole === "Regional Manager" ||
      isNationalSalesManager,
    showCoachingAnalyticsTab: showSalesIntelligence,
    showDoubleVisitAnalyticsTab: showSalesIntelligence || isTrainingManager,
    // Double Visit Report — sidebar link mirrors the page's own DV_FOCUS_ROLES access gate
    // (home-snapshot.ts): DSM/RM/NSM/PM/GPM/TM. Each server-scopes its own data.
    showDoubleVisitReportTab:
      resolvedRole === "District Manager" ||
      resolvedRole === "Regional Manager" ||
      resolvedRole === "National Sales Manager" ||
      resolvedRole === "Product Manager" ||
      resolvedRole === "Group Product Manager" ||
      resolvedRole === "Training Manager",
    // Other Approvals ("Approvals Hub") — Talent Acquisition has no approval authority
    // (governance restricts that to Super Admin / HR Manager, see hard-boundary notes in
    // permissions.ts), so the whole hub is hidden for her even though the other flags
    // above already evaluate false for her role.
    showActionsTab: !isTrainingManager && !isMedicalRep && !isTalentAcquisition,
    showMyVisitsTab,
    showDeductionsTab,
    showDirectOrdersTab,
    showDirectOrdersReportTab: showDirectOrdersTab,
    showDirectOrdersApprovalsTab: isDirectOrderApprovalRung,
    // Vacation Approvals — confirmed portal-shell approver roles.
    showVacationApprovalsTab:
      resolvedRole === "District Manager" ||
      resolvedRole === "Regional Manager" ||
      resolvedRole === "National Sales Manager" ||
      resolvedRole === "Product Manager" ||
      resolvedRole === "Group Product Manager" ||
      resolvedRole === "Marketing Manager" ||
      resolvedRole === "Manager",
    // Excuse Approvals — same set MINUS National Sales Manager, District Manager and Regional
    // Manager. Excuse is a Head-Office / fingerprint-attendance concept and is direct-manager-only
    // (no manager-of-manager step), so nobody in the field ladder ever routes one upward: an NSM,
    // DSM or RM never has anything actionable here. DSM/RM removed by owner decision 2026-07-30 —
    // see EXCUSE_EXCLUDED_ROLES in src/lib/excuses/service.ts, which is the enforcing gate; this
    // flag only hides the link. Note "Manager" stays: that is the Head-Office people-manager rung.
    showExcuseApprovalsTab:
      resolvedRole === "Product Manager" ||
      resolvedRole === "Group Product Manager" ||
      resolvedRole === "Marketing Manager" ||
      resolvedRole === "Manager",
    // Weekly / Monthly Plan Approvals — plan submitters + their managers (same portal set as the
    // plan builder link). Kept as its own flag so it never drifts with the leave/excuse gate.
    showPlanApprovalsTab:
      resolvedRole === "District Manager" ||
      resolvedRole === "Regional Manager" ||
      resolvedRole === "National Sales Manager" ||
      resolvedRole === "Product Manager" ||
      resolvedRole === "Group Product Manager" ||
      resolvedRole === "Marketing Manager" ||
      resolvedRole === "Manager",
    showAttendanceTab: true,
  };
}
