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
  const applications = await listApplications(access);
  const myCandidates = applications.filter((application) => application.candidate && application.requisition);

  return (
    <PageContainer>
      <div className="mx-auto max-w-5xl space-y-6">
        <AdminPageHero
          description="Candidates in your final hiring round — review their details and record your interview outcome."
          eyebrow="Hiring"
          icon={<Users className="h-5 w-5" />}
          title="My Candidates"
        />
        <RecruitmentCandidatesPortal initialApplications={myCandidates} />
      </div>
    </PageContainer>
  );
}
