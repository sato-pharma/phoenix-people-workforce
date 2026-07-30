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
  // "My Candidates" (/employee-portals/recruitment-candidates) — candidates assigned to a hiring
  // manager's own open seats, already scoped by canSeeApplication (src/lib/recruitment/access.ts).
  // The page, the `hiring_interviews` grant and a notification deep-link into it
  // (src/lib/recruitment/applications.ts) all shipped, but no sidebar/bottom-nav link ever did — so
  // a manager notified about their candidate had no way back to the page except the command palette.
  showMyCandidatesTab?: boolean;
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
  // Monthly Closing — the portal render of the admin /sales/monthly-closing Closing Matrix +
  // Details, published-gated and scoped to the viewer (see loadPortalMonthlyClosing /
  // canAccessPortalClosing). Shown to the field-sales management roles that own a line (DM/RM/NSM/
  // PM/GPM) — NOT Marketing Manager (Head-Office line) or Medical Rep (no line).
  showMonthlyClosingTab?: boolean;
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
  // Scoped CRM Master (/employee-portals/crm) — the full CRM grid + export, row-bounded to the
  // caller's own scope. Mirrors PORTAL_CRM_ROLES in src/lib/crm/portal-crm-scope.ts (the enforcing
  // gate); spelled out here because that module pulls in the Supabase server client.
  showCrmMasterTab?: boolean;
  // Territory Management — the brick-allocation / rep-residence map at
  // /employee-portals/territory-management. A DIFFERENT module from Territory & Sales Drilldown
  // above: this one compares multiple areas' bricks against each other, which is why Medical Rep
  // is excluded. Must stay in sync with PORTAL_ROLES in that page (the server-side gate).
  showTerritoryManagementTab?: boolean;
  // Targets — READ-ONLY scoped view at /employee-portals/targets (owner decision 2026-07-30:
  // DM/RM/NSM view; editing and upload stay with SFE Manager / Super Admin on /sales/targets).
  // Must stay in sync with PORTAL_TARGETS_ROLES in src/lib/sales/portal-targets.ts, the page gate.
  showTargetsTab?: boolean;
  // S1 Business Review — the portal-scoped view of /business-review-s1, at
  // /employee-portals/business-review-s1. Same field-management role set as Source of Sales;
  // the page itself resolves each viewer's scope from the seat map (portal-scope.ts) and denies
  // anyone not in the access map, so this flag only surfaces the sidebar link.
  showBusinessReviewS1Tab?: boolean;
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
  // Regional Manager sits between DSM and NSM: region-scoped (own line, narrowed to the regions in
  // their management subtree — see regionsWithinManagerHierarchy). Their Probation, Team Coaching
  // and Organogram data access already exists server-side; these tabs surface it.
  const isRegionalManager = resolvedRole === "Regional Manager";
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
  // Regional Manager included: canAccessCoachingEmployee (coaching/service.ts) already scopes an RM
  // to their full management subtree via isWithinManagerHierarchy, so the reports exist — only the
  // sidebar link was missing.
  const showTeamCoachingTab = showTeamPerformanceTab || showMedRepsPerformanceTab || isRegionalManager;
  // Must stay in lockstep with WEEKLY_MONTHLY_PLAN_ELIGIBLE_JOB_TITLES (weekly-planning/plan-v1.ts):
  // a role listed here but not there sees the builder link and gets "Forbidden" on submit, and a
  // role eligible there but missing here can submit but has no way to reach the page. District
  // Manager was the second case until 2026-07-30 (eligible to submit, no link).
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
    "District Manager",
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
      showMedRepsPerformanceTab ||
      isRegionalManager ||
      isProductManager ||
      isGroupProductManager ||
      isMarketingManager ||
      isTalentAcquisition,
    // Talent Acquisition keeps the read-only Planning Calendar (HO-scoped) but not the
    // Weekly/Monthly Plan submission page — owner-requested removal, 2026-07-25.
    showPlanningCalendarTab: isA3Account || showPlansTab,
    showPlansTab: isA3Account || (showPlansTab && !isTalentAcquisition),
    // Regional Manager included: canReadProbationEmployee already has an RM branch that walks the
    // full management subtree (probation/service.ts), so an RM sees every med rep under every DSM
    // in their region — the tab was the only thing missing.
    showProbationTab:
      showTeamPerformanceTab ||
      showMedRepsPerformanceTab ||
      isRegionalManager ||
      isProductManager ||
      isGroupProductManager ||
      isMarketingManager ||
      isTalentAcquisition,
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
    // Regional Manager included: getEmployeePortalVacancies already has an RM branch that bounds
    // open seats to the RM's own line AND the regions in their management subtree, so the data was
    // there — the missing `vacancies` grant (added to defaultPermissionMatrix) and this flag were
    // the only two things keeping it unreachable. Same shape as the Probation/Organogram/Team
    // Coaching RM fixes above.
    showVacanciesTab:
      showTeamPerformanceTab ||
      showMedRepsPerformanceTab ||
      isRegionalManager ||
      isProductManager ||
      isGroupProductManager ||
      isMarketingManager,
    // Mirrors the roles that actually hold `hiring_interviews: ["read","update"]` in
    // defaultPermissionMatrix (the page's own canAccess gate is the enforcing check), and the same
    // set the command-palette entry in system-navigation.ts already declares. "Manager" is
    // deliberately left out here: it is in that palette list but has no hiring_interviews grant, so
    // a sidebar link would dead-end on the page's empty state.
    showMyCandidatesTab:
      resolvedRole === "District Manager" ||
      isRegionalManager ||
      isNationalSalesManager ||
      isProductManager ||
      isGroupProductManager ||
      isMarketingManager,
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
    // Monthly Closing — mirrors PORTAL_CLOSING_ROLES (monthly-closing-portal.ts), the server-side
    // gate this flag must stay in sync with. isDistrictManager already folds in the legacy "Manager"
    // alias. Marketing Manager and Medical Rep are excluded (no resolvable product line).
    showMonthlyClosingTab:
      isDistrictManager ||
      isRegionalManager ||
      isNationalSalesManager ||
      isProductManager ||
      isGroupProductManager,
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
    // Mirrors PORTAL_CRM_ROLES exactly (Medical Rep / DSM / RM / NSM). Uses the explicit
    // "District Manager" check, NOT isDistrictManager, so the Head-Office "Manager" rung — which has
    // no field reps and would get an empty grid — is excluded, matching the page's own gate.
    showCrmMasterTab:
      isMedicalRep ||
      resolvedRole === "District Manager" ||
      resolvedRole === "Regional Manager" ||
      isNationalSalesManager,
    // Mirrors PORTAL_TERRITORY_MANAGEMENT_ROLES in src/lib/territory-management/service.ts, which is
    // the enforcing gate; this flag only surfaces the sidebar link. Spelled out rather than imported
    // for the same reason as the excuse gate above — that module pulls in the Supabase server client,
    // which must never reach this nav helper (it is consumed by client components).
    // Note `resolvedRole === "District Manager"` deliberately, NOT `isDistrictManager`: the latter
    // also matches the Head-Office "Manager" rung, which the page does not admit. Medical Rep is
    // excluded by design (multi-area comparison is a District-Manager-and-up decision).
    showTerritoryManagementTab:
      resolvedRole === "District Manager" ||
      resolvedRole === "Regional Manager" ||
      isNationalSalesManager,
    // Mirrors PORTAL_TARGETS_ROLES in src/lib/sales/portal-targets.ts (the enforcing gate). Spelled
    // out rather than imported: that module reaches the Supabase server client via the sales scope
    // resolver, which must not be pulled into this client-consumed nav helper. Medical Rep excluded
    // by owner decision; the Head-Office "Manager" rung owns no areas, so exact-match again.
    showTargetsTab:
      resolvedRole === "District Manager" ||
      resolvedRole === "Regional Manager" ||
      isNationalSalesManager,
    // Same role set as Source of Sales / Weekly Sales — every field-management role, no Medical
    // Rep (owner ruling: this module is managers-only). CEO/SFE/Super Admin reach it through the
    // admin shell instead.
    showBusinessReviewS1Tab:
      resolvedRole === "District Manager" ||
      resolvedRole === "Regional Manager" ||
      isNationalSalesManager ||
      isProductManager ||
      isGroupProductManager ||
      isMarketingManager,
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
