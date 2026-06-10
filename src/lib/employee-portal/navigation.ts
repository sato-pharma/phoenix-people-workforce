import { parseRoleStrict, type PhoenixRole } from "@/lib/auth/permissions";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { resolveJobFunctionRole } from "@/lib/employees/job-function";

export type EmployeePortalNavVisibility = {
  showDashboardTab?: boolean;
  showExcusesTab?: boolean;
  showExpenseActionTab?: boolean;
  showIncentiveTab?: boolean;
  showManagementTab?: boolean;
  showMarketingRequestsTab?: boolean;
  showMarketingInboxTab?: boolean;
  showMarketingCustomerDatabaseTab?: boolean;
  showMarketingControlTab?: boolean;
  showMarketingRoiTrackingTab?: boolean;
  showMyPerformanceTab?: boolean;
  showTeamPerformanceTab?: boolean;
  showMedRepsPerformanceTab?: boolean;
  showMedicalRepExpensesTab?: boolean;
  showDsmsPerformanceTab?: boolean;
  showTeamExpensesTab?: boolean;
  showVacanciesTab?: boolean;
  showProbationTab?: boolean;
  showOrganogramTab?: boolean;
  showPlansTab?: boolean;
  showSupportTab?: boolean;
  showMyCoachingTab?: boolean;
  showTeamCoachingTab?: boolean;
  showTrainingManagerCreateCoachingTab?: boolean;
  showTrainingManagerDashboardTab?: boolean;
  showTrainingManagerFieldCoachingTab?: boolean;
  showReportItTab?: boolean;
  showReportItDashboardTab?: boolean;
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
 * Marketing Requests has graduated from Beta to a full module and is no longer
 * gated by this flag — it is visible to already-authorized roles at all times.
 * Contact HR Support is the remaining Beta module: hidden from the employee-portal
 * navigation by default. Pages stay reachable by direct URL and keep their own
 * page-level permission guards — this flag only controls navigation visibility.
 *
 * Set PHOENIX_PORTAL_SHOW_BETA_NAV=true (server env) to surface the remaining Beta
 * modules in the nav for roles that are already authorized for them. Read at call
 * time so the launch posture can change without a rebuild and so tests can toggle it.
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

export function resolveEmployeePortalNavVisibility(
  roleLabel: string | null | undefined,
  accessRole?: string | null | undefined,
  employeeLineName?: string | null | undefined,
  employeeDepartmentName?: string | null | undefined,
  viewerHrId?: string | null | undefined,
): EmployeePortalNavVisibility {
  const resolvedRole = resolvePortalRole(roleLabel, accessRole);
  const normalizedLine = String(employeeLineName ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  const normalizedDepartment = String(employeeDepartmentName ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  const isMedicalRep = resolvedRole === "Medical Rep";
  const isDistrictManager = resolvedRole === "District Manager" || resolvedRole === "Manager";
  const isNationalSalesManager = resolvedRole === "National Sales Manager";
  const isA3Account = canonicalHrIdKey(viewerHrId) === "a-3";
  const isHeadOffice =
    ["office", "headoffice", "hq"].includes(normalizedLine) ||
    ["office", "headoffice", "hq"].includes(normalizedDepartment);
  const isTrainingManager = resolvedRole === "Training Manager";
  const showManagementTab = [
    "District Manager",
    "National Sales Manager",
    "Product Manager",
    "Training Manager",
    "Manager",
  ].includes(resolvedRole);
  const showTeamPerformanceTab = isDistrictManager;
  const showMedRepsPerformanceTab = isNationalSalesManager;
  const showExpenseActionTab = isDistrictManager || isNationalSalesManager;
  // Marketing Requests is a full module: its tabs are visible to already-authorized
  // roles regardless of the launch flag. The role checks still apply, so visibility
  // never extends to a role that is not authorized for Marketing. Contact HR Support
  // (showSupportTab) remains the only Beta nav module gated behind betaNavEnabled.
  const betaNavEnabled = isEmployeePortalBetaNavEnabled();
  const showMarketingRequestsTab = canUseEmployeePortalMarketingRequests(resolvedRole);
  const showMarketingInboxTab = canUseEmployeePortalMarketingRequests(resolvedRole);
  const showMarketingCustomerDatabaseTab = canUseEmployeePortalMarketingCustomerDatabase(resolvedRole);
  const showMarketingControlTab = canUseEmployeePortalMarketingControl(resolvedRole);
  const showMarketingRoiTrackingTab = canUseEmployeePortalMarketingRoiTracking(resolvedRole);
  const showTeamCoachingTab = showTeamPerformanceTab || showMedRepsPerformanceTab;
  const showPlansTab = [
    "Product Manager",
    "Group Product Manager",
    "Training Manager",
    "National Sales Manager",
    "CEO",
    "Super Admin",
    "Manager",
    "Regional Manager",
    "HR Specialist",
  ].includes(resolvedRole);
  const baseShowMyPerformanceTab = !isTrainingManager;
  const baseShowIncentiveTab = !isTrainingManager;

  return {
    showDashboardTab: !isTrainingManager,
    showDsmsPerformanceTab: isNationalSalesManager,
    showExcusesTab: isHeadOffice || isNationalSalesManager,
    showExpenseActionTab,
    showIncentiveTab: isA3Account ? false : baseShowIncentiveTab,
    showManagementTab,
    showMarketingCustomerDatabaseTab,
    showMarketingControlTab,
    showMarketingInboxTab,
    showMarketingRequestsTab,
    showMarketingRoiTrackingTab,
    showMedRepsPerformanceTab,
    showMedicalRepExpensesTab: isMedicalRep,
    showMyPerformanceTab: isA3Account ? false : baseShowMyPerformanceTab,
    showMyCoachingTab: isMedicalRep,
    showReportItTab: isA3Account,
    showReportItDashboardTab: isA3Account,
    showOrganogramTab: showMedRepsPerformanceTab,
    showPlansTab: isA3Account || showPlansTab,
    showProbationTab: showTeamPerformanceTab || showMedRepsPerformanceTab,
    showSupportTab: betaNavEnabled,
    showTeamCoachingTab,
    showTeamExpensesTab: isNationalSalesManager,
    showTeamPerformanceTab,
    showTrainingManagerCreateCoachingTab: isTrainingManager,
    showTrainingManagerDashboardTab: isTrainingManager,
    showTrainingManagerFieldCoachingTab: isTrainingManager,
    showVacanciesTab: showTeamPerformanceTab || showMedRepsPerformanceTab,
  };
}
