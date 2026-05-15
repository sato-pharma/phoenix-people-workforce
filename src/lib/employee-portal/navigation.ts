export type EmployeePortalNavVisibility = {
  showDashboardTab?: boolean;
  showExpenseActionTab?: boolean;
  showIncentiveTab?: boolean;
  showManagementTab?: boolean;
  showMyPerformanceTab?: boolean;
  showTeamPerformanceTab?: boolean;
  showMedRepsPerformanceTab?: boolean;
  showDsmsPerformanceTab?: boolean;
  showTeamExpensesTab?: boolean;
  showLeaveApprovalsTab?: boolean;
  showVacanciesTab?: boolean;
  showProbationTab?: boolean;
  showOrganogramTab?: boolean;
  showMyCoachingTab?: boolean;
  showTeamCoachingTab?: boolean;
  showTrainingManagerCreateCoachingTab?: boolean;
  showTrainingManagerDashboardTab?: boolean;
  showTrainingManagerFieldCoachingTab?: boolean;
};

export function resolveEmployeePortalNavVisibility(
  roleLabel: string | null | undefined,
): EmployeePortalNavVisibility {
  const MANAGEMENT_ROLES = [
    "district sales manager",
    "regional sales manager",
    "national sales manager",
    "product manager",
    "training manager",
  ];
  const roleNormalized = String(roleLabel ?? "").trim().toLowerCase();
  const isTrainingManager = roleNormalized === "training manager";
  const showManagementTab = MANAGEMENT_ROLES.includes(roleNormalized);
  const isRegionalSalesManager =
    roleNormalized.includes("regional sales manager") ||
    roleNormalized === "rsm";
  const showTeamPerformanceTab =
    isRegionalSalesManager ||
    roleNormalized.includes("district manager") ||
    roleNormalized.includes("district sales manager") ||
    roleNormalized.includes("dsm");
  const isNationalSalesManager =
    roleNormalized.includes("national sales manager") ||
    roleNormalized === "nsm";
  const showMedRepsPerformanceTab = isNationalSalesManager || isRegionalSalesManager;
  const showExpenseActionTab = showTeamPerformanceTab || showMedRepsPerformanceTab;
  const showMyCoachingTab =
    roleNormalized.includes("medical rep") ||
    roleNormalized === "medical representative";
  const showTeamCoachingTab = showTeamPerformanceTab || showMedRepsPerformanceTab;
  const showLeaveApprovalsTab =
    !isTrainingManager &&
    (
      showTeamPerformanceTab ||
      isNationalSalesManager ||
      isRegionalSalesManager ||
      roleNormalized.includes("regional manager") ||
      roleNormalized.includes("manager")
    );

  return {
    showDashboardTab: !isTrainingManager,
    showDsmsPerformanceTab: isNationalSalesManager || isRegionalSalesManager,
    showExpenseActionTab,
    showIncentiveTab: !isTrainingManager,
    showLeaveApprovalsTab,
    showManagementTab,
    showMedRepsPerformanceTab,
    showMyPerformanceTab: !isTrainingManager,
    showMyCoachingTab,
    showOrganogramTab: showMedRepsPerformanceTab,
    showProbationTab: showTeamPerformanceTab || showMedRepsPerformanceTab,
    showTeamCoachingTab,
    showTeamExpensesTab: isNationalSalesManager || isRegionalSalesManager,
    showTeamPerformanceTab,
    showTrainingManagerCreateCoachingTab: isTrainingManager,
    showTrainingManagerDashboardTab: isTrainingManager,
    showTrainingManagerFieldCoachingTab: isTrainingManager,
    showVacanciesTab: showTeamPerformanceTab || showMedRepsPerformanceTab,
  };
}
