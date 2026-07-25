import { redirect } from "next/navigation";

import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { RecruitmentCandidatesPortal } from "@/components/employee-portal/recruitment-candidates-portal";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { listApplications } from "@/lib/recruitment/applications";

export const dynamic = "force-dynamic";

export default async function EmployeePortalRecruitmentCandidatesPage() {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/overview");
  }

  if (!(await canAccess(access, "hiring_interviews", "read"))) {
    return (
      <EmployeePortalEmptyState
        message="Candidate review is available for roles that own a hiring seat (District Manager and other line/area managers) once a candidate is assigned to one of their open positions."
        title="Candidates Unavailable"
      />
    );
  }

  // Already scoped: listApplications() filters to only the requisitions this caller is
  // the hiring manager (or recruitment owner) for — see canSeeApplication in
  // src/lib/recruitment/access.ts. A candidate assigned to someone else's vacant seat
  // never appears here.
  const applications = await listApplications(access);
  const myCandidates = applications.filter((application) => application.candidate && application.requisition);

  return (
    <EmployeePortalPageShell
      badge="Hiring"
      description="Candidates assigned to your open positions — review their details, schedule your interview, and record the outcome."
      title="My Candidates"
    >
      <RecruitmentCandidatesPortal initialApplications={myCandidates} />
    </EmployeePortalPageShell>
  );
}
