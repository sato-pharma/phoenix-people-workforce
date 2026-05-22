import { normalizeRole, parseRoleStrict, type PhoenixRole } from "@/lib/auth/permissions";

export type EmployeePortalNavVisibility = {
  showDashboardTab?: boolean;
  showExcusesTab?: boolean;
  showExpenseActionTab?: boolean;
  showIncentiveTab?: boolean;
  showManagementTab?: boolean;
  showMarketingRequestsTab?: boolean;
  showMarketingCustomerDatabaseTab?: boolean;
  showMarketingControlTab?: boolean;
  showMyPerformanceTab?: boolean;
  showTeamPerformanceTab?: boolean;
  showMedRepsPerformanceTab?: boolean;
  showMedicalRepExpensesTab?: boolean;
  showDsmsPerformanceTab?: boolean;
  showTeamExpensesTab?: boolean;
  showVacanciesTab?: boolean;
  showProbationTab?: boolean;
  showOrganogramTab?: boolean;
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
  try {
    return parseRoleStrict(roleLabel);
  } catch {}

  try {
    return parseRoleStrict(accessRole);
  } catch {}

  return normalizeRole(accessRole ?? roleLabel);
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
  const showMarketingRequestsTab = [
    "Medical Rep",
    "District Manager",
    "Regional Manager",
    "National Sales Manager",
    "Product Manager",
    "Marketing Manager",
    "SFE Manager",
    "CEO",
    "Super Admin",
  ].includes(resolvedRole);
  const showMarketingCustomerDatabaseTab = resolvedRole === "Super Admin";
  const showMarketingControlTab =
    resolvedRole === "SFE Manager" || resolvedRole === "Super Admin";
  const showTeamCoachingTab = showTeamPerformanceTab || showMedRepsPerformanceTab;

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
    showMedRepsPerformanceTab,
    showMedicalRepExpensesTab: isMedicalRep,
    showMyPerformanceTab: !isTrainingManager,
    showMyCoachingTab: isMedicalRep,
    showOrganogramTab: showMedRepsPerformanceTab,
    showProbationTab: showTeamPerformanceTab || showMedRepsPerformanceTab,
    showTeamCoachingTab,
    showTeamExpensesTab: isNationalSalesManager,
    showTeamPerformanceTab,
    showTrainingManagerCreateCoachingTab: isTrainingManager,
    showTrainingManagerDashboardTab: isTrainingManager,
    showTrainingManagerFieldCoachingTab: isTrainingManager,
    showVacanciesTab: showTeamPerformanceTab || showMedRepsPerformanceTab,
  };
}
