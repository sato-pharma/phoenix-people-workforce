import { redirect } from "next/navigation";
import { Suspense } from "react";

import { RecruitmentWorkspace } from "@/components/recruitment/recruitment-workspace";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { canAccess, isHrAuthorityRole, resolveNavigationMode, type AccessContext } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { listCandidates } from "@/lib/recruitment/candidates";
import {
  listCandidateFolderAreaOptions,
  type CandidateFolderAreaOption,
} from "@/lib/recruitment/candidate-folder-options";
import { summarizeCandidatePool } from "@/lib/recruitment/candidate-stats";
import { getRecruitmentDashboard, type RecruitmentDashboard } from "@/lib/recruitment/dashboard";
import { isFileUploadEnabled } from "@/lib/recruitment/file-storage";
import { listHiringManagerOptions, type HiringManagerOption } from "@/lib/recruitment/hiring-manager-notify";
import { listOpenVacanciesForRequisition, listPositionCatalogue } from "@/lib/recruitment/requisitions";
import type { Candidate, PositionCatalogueOption } from "@/lib/recruitment/types";
import type { VacancyReportRow } from "@/lib/reports/vacancies";

export const dynamic = "force-dynamic";

type RecruitmentManagerOption = { hrId: string; fullName: string };

// Portal mirror of app/(admin)/recruitment/page.tsx — same data/permission logic,
// wrapped in the employee-portal shell instead of the admin shell. Kept in sync
// manually since the two route groups use different layout wrappers.
export default async function EmployeePortalRecruitmentPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/recruitment");
  }
  if (!isHrAuthorityRole(access.role) || !(await canAccess(access, "recruitment", "read"))) {
    return (
      <EmployeePortalEmptyState
        message="Recruitment tools are available to Talent Acquisition and Super Admin only."
        title="Recruitment Unavailable"
      />
    );
  }

  return (
    <EmployeePortalPageShell
      badge="Talent Acquisition"
      description="Requisitions, candidates, and the hiring pipeline."
      errorBoundaryTitle="Recruitment unavailable"
      title="Recruitment"
    >
      <Suspense
        fallback={
          <AppRouteLoadingState
            description="Preparing requisitions, candidates, and the hiring pipeline."
            title="Loading Recruitment"
          />
        }
      >
        <RecruitmentContent access={access} />
      </Suspense>
    </EmployeePortalPageShell>
  );
}

async function RecruitmentContent({ access }: { access: AccessContext }) {
  const [canCreateRequisition, canManage, canApprove, canManageCandidates, canImport, canViewCandidates] =
    await Promise.all([
      canAccess(access, "recruitment", "create"),
      canAccess(access, "recruitment", "update"),
      canAccess(access, "recruitment", "approve"),
      canAccess(access, "candidates", "create"),
      canAccess(access, "candidates", "import"),
      canAccess(access, "candidates", "read"),
    ]);
  // Hard delete is Super Admin only (server enforces this too).
  const canDelete = access.role === "Super Admin" || access.scope === "system";

  let dashboard: RecruitmentDashboard | null = null;
  let openVacancies: VacancyReportRow[] = [];
  let positionCatalogue: PositionCatalogueOption[] = [];
  let managers: RecruitmentManagerOption[] = [];
  // Only the ~30 people whose job title says manager -- the list a candidate is actually SENT to.
  // `managers` above is the whole employee directory (it fills the requisition form), which is the
  // wrong list to offer here: picking a District Sales Manager out of every employee is the kind of
  // ceremony that left 214 of 221 candidates sitting in the pool.
  let hiringManagers: HiringManagerOption[] = [];
  let candidates: Candidate[] = [];
  // The folder picker's area list. Empty on a load failure rather than throwing: a recruiter
  // who cannot file to an area must still get the pool, and the picker degrades to the two
  // shelves that need no database (regions are a closed list, job titles are typed).
  let areaOptions: CandidateFolderAreaOption[] = [];
  let initialError: string | null = null;

  try {
    const [dashboardData, vacancies, catalogue, managerOptions, employeeRows, areas] = await Promise.all([
      getRecruitmentDashboard(access),
      listOpenVacanciesForRequisition(),
      listPositionCatalogue(),
      listHiringManagerOptions(),
      getEmployeeDirectoryRows(),
      listCandidateFolderAreaOptions(),
    ]);
    dashboard = dashboardData;
    areaOptions = areas;
    openVacancies = vacancies;
    positionCatalogue = catalogue;
    hiringManagers = managerOptions;
    managers = employeeRows
      .map((row) => ({ hrId: row.hrId, fullName: row.displayName }))
      .sort((a, b) => a.fullName.localeCompare(b.fullName));
    if (canViewCandidates) {
      candidates = await listCandidates();
    }
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Failed to load recruitment data.";
  }

  return (
    <RecruitmentWorkspace
      areaOptions={areaOptions}
      canApprove={canApprove}
      canCreateRequisition={canCreateRequisition}
      canDelete={canDelete}
      canImport={canImport}
      canManage={canManage}
      canManageCandidates={canManageCandidates}
      canViewCandidates={canViewCandidates}
      candidates={candidates}
      candidateStats={summarizeCandidatePool(candidates)}
      dashboard={dashboard}
      filesEnabled={isFileUploadEnabled()}
      initialError={initialError}
      hiringManagers={hiringManagers}
      managers={managers}
      openVacancies={openVacancies}
      positionCatalogue={positionCatalogue}
    />
  );
}
