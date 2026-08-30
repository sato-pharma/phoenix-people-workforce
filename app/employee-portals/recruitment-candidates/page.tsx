import { redirect } from "next/navigation";

import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { RecruitmentCandidatesPortal } from "@/components/employee-portal/recruitment-candidates-portal";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { listApplications } from "@/lib/recruitment/applications";
import { listCandidateFolderAreaOptions } from "@/lib/recruitment/candidate-folder-options";
import { listCandidatesSentToManager } from "@/lib/recruitment/candidates";
import { listCandidateCardFiles } from "@/lib/recruitment/files";
import { listViewerTeamManagers } from "@/lib/recruitment/hiring-manager-team";
import { listManagerFolderFilings } from "@/lib/recruitment/manager-folders";

export const dynamic = "force-dynamic";

export default async function EmployeePortalRecruitmentCandidatesPage() {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/overview");
  }

  if (!(await canAccess(access, "hiring_interviews", "read"))) {
    return (
      <EmployeePortalEmptyState
        message="Candidate review is available for roles that own a hiring seat (District Manager and other line/area managers) once the recruitment team sends them a CV or assigns a candidate to one of their open positions."
        title="Candidates Unavailable"
      />
    );
  }

  // Two lists, two routes into this screen, and the second one is the reason it now works.
  //
  //   • applications — already scoped: listApplications() filters to only the requisitions this
  //     caller is the hiring manager (or recruitment owner) for, see canSeeApplication in
  //     src/lib/recruitment/access.ts. Taken 7 times in the module's history.
  //   • sentToMe — the CVs a recruiter pushed straight to this caller with no requisition in
  //     between. Scoped by the caller's own HR_ID inside listCandidatesSentToManager. This is the
  //     flow the owner actually asked for, and until now the notification for it deep-linked to the
  //     CV database, which answers a District Manager with "available to Talent Acquisition and
  //     Super Admin only".
  //   • team — the managers who report to this caller, and how many CVs sit with each. Added
  //     2026-08-30 at the owner's request: "the National Sales Manager can choose any of these
  //     district managers and see all the CVs in his portal". Empty for anybody who manages nobody,
  //     which is most callers who reach this screen, and the component renders nothing at all then.
  //   • filings — what THIS manager has kept for later, on his own shelf. The owner, 2026-08-30:
  //     "and I want him to have a folders like like me". Read from ats_candidate_manager_folders,
  //     never from the candidate row: the recruitment team's own filing hides a CV from every
  //     recruiter, and a District Manager tidying his inbox must not do that. See
  //     manager-folder-shelf.ts.
  //   • areaOptions — the area list for the folder picker, tagged with each area's RECRUITMENT
  //     region (which is not always its sales region — the Delta (3) split). Loaded here because it
  //     reads the org chart and the portal component is "use client".
  const [applications, sentToMe, team, filings, areaOptions] = await Promise.all([
    listApplications(access),
    listCandidatesSentToManager(access.hrId),
    listViewerTeamManagers(access),
    listManagerFolderFilings(access.hrId),
    listCandidateFolderAreaOptions(),
  ]);
  const myCandidates = applications.filter((application) => application.candidate && application.requisition);

  // The CV files for every card on this page, in one query, before anything renders.
  //
  // "He must be able to screen and must have a button to download the CV or to view it. It is a
  // must." — the owner, 2026-08-30. The button existed before this and still failed that test: each
  // card asked for its own files after mounting, and eleven cards meant eleven requests, so the
  // control appeared long after the card it belongs to. A control that arrives that late is missing.
  //
  // Nothing is widened by loading it here. Both lists are already scoped — `sentToMe` by this
  // caller's own HR_ID, `myCandidates` by listApplications' own hiring-manager filter — so these are
  // the files of CVs this caller was already entitled to open, fetched once instead of one by one.
  const initialFiles = await listCandidateCardFiles([
    ...sentToMe.map((candidate) => candidate.id),
    ...myCandidates.map((application) => application.candidate?.id ?? ""),
  ]);

  return (
    <EmployeePortalPageShell
      badge="Hiring"
      description="CVs sent to you by the recruitment team, candidates assigned to your open positions, and the CVs sitting with the managers who report to you — read the CV, answer, comment, and keep the good ones in your own folders."
      title="My Candidates"
    >
      <RecruitmentCandidatesPortal
        areaOptions={areaOptions}
        initialApplications={myCandidates}
        initialFilings={filings}
        initialFiles={initialFiles}
        initialSentToMe={sentToMe}
        initialTeam={team}
        viewerHrId={access.hrId}
      />
    </EmployeePortalPageShell>
  );
}
