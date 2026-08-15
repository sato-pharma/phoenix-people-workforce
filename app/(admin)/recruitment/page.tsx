import { redirect } from "next/navigation";
import { Suspense } from "react";

import { RecruitmentWorkspace } from "@/components/recruitment/recruitment-workspace";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { canAccess, isHrAuthorityRole, type AccessContext } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { listCandidates } from "@/lib/recruitment/candidates";
import { summarizeCandidatePool } from "@/lib/recruitment/candidate-stats";
import { getRecruitmentDashboard, type RecruitmentDashboard } from "@/lib/recruitment/dashboard";
import { isFileUploadEnabled } from "@/lib/recruitment/file-storage";
import { listHiringManagerOptions, type HiringManagerOption } from "@/lib/recruitment/hiring-manager-notify";
import { listOpenVacanciesForRequisition } from "@/lib/recruitment/requisitions";
import type { Candidate } from "@/lib/recruitment/types";
import type { VacancyReportRow } from "@/lib/reports/vacancies";

export const dynamic = "force-dynamic";

export type RecruitmentManagerOption = { hrId: string; fullName: string };

export default async function RecruitmentPage() {
  const access = await resolveAccessContextFromPage();
  if (!isHrAuthorityRole(access.role) || !(await canAccess(access, "recruitment", "read"))) {
    redirect("/employee-portals");
  }

  return (
    <Suspense
      fallback={
        <AppRouteLoadingState
          title="Loading Recruitment"
          description="Preparing requisitions, candidates, and the hiring pipeline."
        />
      }
    >
      <RecruitmentContent access={access} />
    </Suspense>
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
  let managers: RecruitmentManagerOption[] = [];
  // Only the ~30 people whose job title says manager -- the list a candidate is actually SENT to.
  // `managers` above is the whole employee directory (it fills the requisition form), which is the
  // wrong list to offer here: picking a District Sales Manager out of every employee is the kind of
  // ceremony that left 214 of 221 candidates sitting in the pool.
  let hiringManagers: HiringManagerOption[] = [];
  let candidates: Candidate[] = [];
  let initialError: string | null = null;

  try {
    const [dashboardData, vacancies, managerOptions, employeeRows] = await Promise.all([
      getRecruitmentDashboard(access),
      listOpenVacanciesForRequisition(),
      listHiringManagerOptions(),
      getEmployeeDirectoryRows(),
    ]);
    dashboard = dashboardData;
    openVacancies = vacancies;
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
    />
  );
}
