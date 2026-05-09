export type EmployeePortalNavVisibility = {
  showExpenseActionTab?: boolean;
  showManagementTab?: boolean;
  showTeamPerformanceTab?: boolean;
  showMedRepsPerformanceTab?: boolean;
  showDsmsPerformanceTab?: boolean;
  showTeamExpensesTab?: boolean;
  showBrickCoverageTab?: boolean;
  showVacanciesTab?: boolean;
  showProbationTab?: boolean;
  showOrganogramTab?: boolean;
};

export function resolveEmployeePortalNavVisibility(
  roleLabel: string | null | undefined,
): EmployeePortalNavVisibility {
  const MANAGEMENT_ROLES = [
    "district sales manager",
    "national sales manager",
    "product manager",
    "training manager",
  ];
  const roleNormalized = String(roleLabel ?? "").trim().toLowerCase();
  const showManagementTab = MANAGEMENT_ROLES.includes(roleNormalized);
  const showTeamPerformanceTab =
    roleNormalized.includes("district manager") ||
    roleNormalized.includes("district sales manager") ||
    roleNormalized.includes("dsm");
  const showMedRepsPerformanceTab = roleNormalized.includes("national sales manager");
  const showExpenseActionTab = showTeamPerformanceTab || showMedRepsPerformanceTab;

  return {
    showBrickCoverageTab: roleNormalized.includes("national sales manager"),
    showDsmsPerformanceTab: roleNormalized.includes("national sales manager"),
    showExpenseActionTab,
    showManagementTab,
    showMedRepsPerformanceTab,
    showOrganogramTab: showMedRepsPerformanceTab,
    showProbationTab: showTeamPerformanceTab || showMedRepsPerformanceTab,
    showTeamExpensesTab: roleNormalized.includes("national sales manager"),
    showTeamPerformanceTab,
    showVacanciesTab: showTeamPerformanceTab || showMedRepsPerformanceTab,
  };
}
