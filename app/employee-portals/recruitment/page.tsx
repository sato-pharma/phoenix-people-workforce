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
import { listCandidateFolderAreaOptions } from "@/lib/recruitment/candidate-folder-options";
import { summarizeCandidatePool } from "@/lib/recruitment/candidate-stats";
import { loadCvFolderCabinet } from "@/lib/recruitment/cv-folder-tree-db";
import { getRecruitmentDashboard } from "@/lib/recruitment/dashboard";
import { isFileUploadEnabled } from "@/lib/recruitment/file-storage";
import { listHiringManagerOptions } from "@/lib/recruitment/hiring-manager-notify";
import { logRecruitmentReadFailures } from "@/lib/recruitment/page-read-log";
import { settleRecruitmentPage, unavailableSources } from "@/lib/recruitment/page-reads";
import { countCandidatePoolStatuses } from "@/lib/recruitment/pool-enrichment";
import { listOpenVacanciesForRequisition, listPositionCatalogue } from "@/lib/recruitment/requisitions";
import { loadPoolWhatsAppQuestions } from "@/lib/recruitment/pool-whatsapp-questions-load";
import type { Candidate } from "@/lib/recruitment/types";

export const dynamic = "force-dynamic";

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
        message="Recruitment tools are available to the Talent Acquisition seat and the Super Admin only."
        title="Recruitment Unavailable"
      />
    );
  }

  return (
    <EmployeePortalPageShell
      badge="Recruitment & Hiring"
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

  // The dashboard's candidate tiles count the same pool, so they are counted from these rows rather
  // than from six more `head` requests — see the admin page, which this mirrors. Only when the viewer
  // reads the pool; a failed pool resolves to null and the dashboard counts for itself.
  const candidatePoolCounts = canViewCandidates
    ? poolLoad.then((pool) => (pool.ok ? countCandidatePoolStatuses(pool.rows.map((row) => row.status)) : null))
    : undefined;

  // Each read settles on its own (src/lib/recruitment/page-reads.ts): a read that fails leaves its slot
  // empty and is NAMED to the reader, instead of one rejection blanking the page and logging nothing.
  // Only the dashboard and the pool decide whether the page means anything; the rest are extras.
  //
  // This portal page loads the folder cabinet for the same reason it loads the pool: filing a CV HIDES
  // it from the pool on BOTH surfaces, so a portal recruiter without the cabinet would watch people
  // disappear with nothing on screen that could bring them back.
  const {
    areaOptions,
    candidates,
    cvFolderCabinet,
    dashboard,
    failures,
    hiringManagers,
    managers,
    openVacancies,
    positionCatalogue,
    whatsappQuestions,
  } = await settleRecruitmentPage({
    dashboard: () => getRecruitmentDashboard(access, candidatePoolCounts ? { candidatePoolCounts } : {}),
    pool: async () => {
      const pool = await poolLoad;
      if (!pool.ok) throw pool.error;
      return pool.rows;
    },
    vacancies: () => listOpenVacanciesForRequisition(),
    positionCatalogue: () => listPositionCatalogue(),
    hiringManagers: () => listHiringManagerOptions(),
    employeeDirectory: () => getEmployeeDirectoryRows(),
    areaOptions: () => listCandidateFolderAreaOptions(),
    // `withNames` resolves each folder's creator to a person's name — the owner's standing rule
    // that a screen shows names, never HR codes.
    cvFolders: () => loadCvFolderCabinet({ withNames: true }),
    // The bot's questions, so the pool's headers follow them (pool-whatsapp-columns.ts).
    whatsappQuestions: () => loadPoolWhatsAppQuestions(),
  });
  logRecruitmentReadFailures(access, failures, "/employee-portals/recruitment");

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
      hiringManagers={hiringManagers}
      managers={managers}
      openVacancies={openVacancies}
      positionCatalogue={positionCatalogue}
      unavailableSources={unavailableSources(failures)}
      whatsappQuestions={whatsappQuestions}
    />
  );
}
