import { redirect } from "next/navigation";
import { Suspense } from "react";

import { RecruitmentWorkspace } from "@/components/recruitment/recruitment-workspace";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { canAccess, isHrAuthorityRole, type AccessContext } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { listCandidates } from "@/lib/recruitment/candidates";
import {
  listCandidateFolderAreaOptions,
  type CandidateFolderAreaOption,
} from "@/lib/recruitment/candidate-folder-options";
import { summarizeCandidatePool } from "@/lib/recruitment/candidate-stats";
import { loadCvFolderCabinet } from "@/lib/recruitment/cv-folder-tree-db";
import type { CvFolderCabinetData } from "@/components/recruitment/cv-folder-cabinet";
import { getRecruitmentDashboard, type RecruitmentDashboard } from "@/lib/recruitment/dashboard";
import { isFileUploadEnabled } from "@/lib/recruitment/file-storage";
import { listHiringManagerOptions, type HiringManagerOption } from "@/lib/recruitment/hiring-manager-notify";
import { listOpenVacanciesForRequisition, listPositionCatalogue } from "@/lib/recruitment/requisitions";
import type { Candidate, PositionCatalogueOption } from "@/lib/recruitment/types";
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
  const [
    canCreateRequisition,
    canManage,
    canApprove,
    canManageCandidates,
    canImport,
    canViewCandidates,
    // The gate on the hand-built folder tree, and it is `candidates: update` rather than the
    // `candidates: create` beside it because that is exactly what every /api/recruitment/cv-folders
    // route asks for. A UI gate spelled differently from its server boundary either hides a button
    // somebody is allowed to press, or shows one that 403s — both read as the feature being broken.
    canFileCandidates,
  ] = await Promise.all([
    canAccess(access, "recruitment", "create"),
    canAccess(access, "recruitment", "update"),
    canAccess(access, "recruitment", "approve"),
    canAccess(access, "candidates", "create"),
    canAccess(access, "candidates", "import"),
    canAccess(access, "candidates", "read"),
    canAccess(access, "candidates", "update"),
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
  // The hand-built folder tree, flattened for the client boundary. Empty is a legitimate state —
  // nobody has made a folder yet — and it is also what a load failure leaves behind, on purpose: an
  // empty cabinet shows every CV in the pool, where a half-read one would hide people.
  let cvFolderCabinet: CvFolderCabinetData = { members: {}, rows: [] };
  let initialError: string | null = null;

  // The pool starts WITH the reads below rather than after them: it needs none of their answers, and
  // run second it was a whole extra wait on every load. Settled on its own, so a failed pool still
  // leaves the dashboard, vacancies and folders on screen beside the error, exactly as when it ran last.
  // The slim read: the pool table never reads the repeating CV blocks. The profile panel that does
  // gets them from its own GET /api/recruitment/candidates/[id].
  const poolLoad: Promise<{ ok: true; rows: Candidate[] } | { ok: false; error: unknown }> = canViewCandidates
    ? listCandidates({ withRepeatingCvBlocks: false }).then(
        (rows) => ({ ok: true as const, rows }),
        (error: unknown) => ({ ok: false as const, error }),
      )
    : Promise.resolve({ ok: true as const, rows: [] });

  try {
    const [dashboardData, vacancies, catalogue, managerOptions, employeeRows, areas, cabinet] =
      await Promise.all([
        getRecruitmentDashboard(access),
        listOpenVacanciesForRequisition(),
        listPositionCatalogue(),
        listHiringManagerOptions(),
        getEmployeeDirectoryRows(),
        listCandidateFolderAreaOptions(),
        // `withNames` resolves each folder's creator to a person's name — the owner's standing rule
        // that a screen shows names, never HR codes.
        loadCvFolderCabinet({ withNames: true }),
      ]);
    dashboard = dashboardData;
    areaOptions = areas;
    // A plain object, not the Map the loader returns: this crosses into a client component, and a
    // Map that survives today's React serializer is a dependency on that serializer rather than on
    // anything this page states.
    cvFolderCabinet = {
      members: Object.fromEntries(cabinet.members),
      rows: cabinet.rows,
    };
    openVacancies = vacancies;
    positionCatalogue = catalogue;
    hiringManagers = managerOptions;
    managers = employeeRows
      .map((row) => ({ hrId: row.hrId, fullName: row.displayName }))
      .sort((a, b) => a.fullName.localeCompare(b.fullName));
    const pool = await poolLoad;
    if (!pool.ok) throw pool.error;
    candidates = pool.rows;
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Failed to load recruitment data.";
  }

  return (
    <RecruitmentWorkspace
      areaOptions={areaOptions}
      canApprove={canApprove}
      canCreateRequisition={canCreateRequisition}
      canDelete={canDelete}
      canFileCandidates={canFileCandidates}
      canImport={canImport}
      canManage={canManage}
      canManageCandidates={canManageCandidates}
      canViewCandidates={canViewCandidates}
      candidates={candidates}
      candidateStats={summarizeCandidatePool(candidates)}
      cvFolderCabinet={cvFolderCabinet}
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
