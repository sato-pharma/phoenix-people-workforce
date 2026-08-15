import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Users } from "lucide-react";

import { PageContainer } from "@/components/layout/page-container";
import { AdminPageHero } from "@/components/admin/admin-design-system";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { RecruitmentCandidatesPortal } from "@/components/employee-portal/recruitment-candidates-portal";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { listApplications } from "@/lib/recruitment/applications";
import { listCandidatesSentToManager } from "@/lib/recruitment/candidates";

export const dynamic = "force-dynamic";

// CEO's entry point onto the same candidate-tracking surface District Manager/Regional
// Manager/National Sales Manager reach via the employee portal — CEO's primary surface is
// the admin shell, not the employee portal, so this is a thin admin-shell wrapper around
// the exact same RecruitmentCandidatesPortal component, not a new UI.
export default async function AdminRecruitmentCandidatesPage() {
  const access = await resolveAccessContextFromPage();

  if (access.role !== "CEO" || !(await canAccess(access, "hiring_interviews", "read"))) {
    redirect("/overview");
  }

  return (
    <Suspense
      fallback={
        <AppRouteLoadingState
          description="Preparing your candidates and interview rounds."
          title="Loading Candidates"
        />
      }
    >
      <AdminRecruitmentCandidatesContent />
    </Suspense>
  );
}

async function AdminRecruitmentCandidatesContent() {
  const access = await resolveAccessContextFromPage();
  // Already scoped: listApplications() filters to only the requisitions this caller is
  // the hiring manager (or recruitment owner) for — see canSeeApplication in
  // src/lib/recruitment/access.ts. A candidate outside the CEO's own round never appears.
  //
  // The second list is the direct push, scoped by the caller's own HR_ID. It is loaded here as well
  // as on the portal twin because the CEO's job title matches the manager list a recruiter picks
  // from, so a CV can be sent straight to them — and this admin page is where the CEO would look.
  const [applications, sentToMe] = await Promise.all([
    listApplications(access),
    listCandidatesSentToManager(access.hrId),
  ]);
  const myCandidates = applications.filter((application) => application.candidate && application.requisition);

  return (
    <PageContainer>
      <div className="mx-auto max-w-5xl space-y-6">
        <AdminPageHero
          description="CVs sent to you, and candidates in your final hiring round — read the CV, answer, and record your interview outcome."
          eyebrow="Hiring"
          icon={<Users className="h-5 w-5" />}
          title="My Candidates"
        />
        <RecruitmentCandidatesPortal initialApplications={myCandidates} initialSentToMe={sentToMe} />
      </div>
    </PageContainer>
  );
}
