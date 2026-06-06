import { parseRoleStrict, type PhoenixRole } from "@/lib/auth/permissions";
import { resolveJobFunctionRole } from "@/lib/employees/job-function";

export type EmployeePortalNavVisibility = {
  showDashboardTab?: boolean;
  showExcusesTab?: boolean;
  showExpenseActionTab?: boolean;
  showIncentiveTab?: boolean;
  showManagementTab?: boolean;
  showMarketingRequestsTab?: boolean;
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
 * For the Core 8 launch, Beta modules (Marketing Requests and Contact HR Support)
 * are hidden from the employee-portal navigation by default. Pages stay reachable
 * by direct URL and keep their own page-level permission guards — this flag only
 * controls navigation visibility.
 *
 * Set PHOENIX_PORTAL_SHOW_BETA_NAV=true (server env) to surface Beta modules in the
 * nav for roles that are already authorized for them. Read at call time so the
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
 * Marketing Requests is a Beta module: hidden by default, surfaced only when the
 * beta flag is enabled AND the role is already authorized for Marketing. This
 * mirrors the sidebar nav gating so the dashboard cannot leak a Beta module into
 * the Core 8 launch surface. `betaNavEnabled` is resolved server-side from
 * PHOENIX_PORTAL_SHOW_BETA_NAV and passed into the (client) dashboard.
 */
export function shouldShowEmployeePortalMarketingQuickAction(
  betaNavEnabled: boolean | undefined,
  roleLabel: string | null | undefined,
  accessRole?: string | null | undefined,
) {
  return betaNavEnabled === true && canUseEmployeePortalMarketingRequests(roleLabel, accessRole);
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
): EmployeePortalNavVisibility {
  const resolvedRole = resolvePortalRole(roleLabel, accessRole);
  const normalizedLine = String(employeeLineName ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  const normalizedDepartment = String(employeeDepartmentName ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  const isMedicalRep = resolvedRole === "Medical Rep";
  const isDistrictManager = resolvedRole === "District Manager" || resolvedRole === "Manager";
  const isNationalSalesManager = resolvedRole === "National Sales Manager";
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
  // Beta modules are hidden from launch nav unless the beta flag is enabled. The
  // role checks still apply on top, so enabling the flag never grants a module to
  // a role that was not already authorized for it.
  const betaNavEnabled = isEmployeePortalBetaNavEnabled();
  const showMarketingRequestsTab = betaNavEnabled && canUseEmployeePortalMarketingRequests(resolvedRole);
  const showMarketingCustomerDatabaseTab = betaNavEnabled && canUseEmployeePortalMarketingCustomerDatabase(resolvedRole);
  const showMarketingControlTab = betaNavEnabled && canUseEmployeePortalMarketingControl(resolvedRole);
  const showMarketingRoiTrackingTab = betaNavEnabled && canUseEmployeePortalMarketingRoiTracking(resolvedRole);
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

  return {
    showDashboardTab: !isTrainingManager,
    showDsmsPerformanceTab: isNationalSalesManager,
    showExcusesTab: isHeadOffice || isNationalSalesManager,
    showExpenseActionTab,
    showIncentiveTab: !isTrainingManager,
    showManagementTab,
    showMarketingCustomerDatabaseTab,
    showMarketingControlTab,
    showMarketingRequestsTab,
    showMarketingRoiTrackingTab,
    showMedRepsPerformanceTab,
    showMedicalRepExpensesTab: isMedicalRep,
    showMyPerformanceTab: !isTrainingManager,
    showMyCoachingTab: isMedicalRep,
    showOrganogramTab: showMedRepsPerformanceTab,
    showPlansTab,
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
