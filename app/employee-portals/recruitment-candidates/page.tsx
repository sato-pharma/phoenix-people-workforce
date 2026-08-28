import { redirect } from "next/navigation";

import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { RecruitmentCandidatesPortal } from "@/components/employee-portal/recruitment-candidates-portal";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { listApplications } from "@/lib/recruitment/applications";
import { listCandidatesSentToManager } from "@/lib/recruitment/candidates";

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
  const [applications, sentToMe] = await Promise.all([
    listApplications(access),
    listCandidatesSentToManager(access.hrId),
  ]);
  const myCandidates = applications.filter((application) => application.candidate && application.requisition);

  return (
    <EmployeePortalPageShell
      badge="Hiring"
      description="CVs sent to you by the recruitment team, and candidates assigned to your open positions — read the CV, answer, and record your interview outcome."
      title="My Candidates"
    >
      <RecruitmentCandidatesPortal initialApplications={myCandidates} initialSentToMe={sentToMe} />
    </EmployeePortalPageShell>
  );
}
