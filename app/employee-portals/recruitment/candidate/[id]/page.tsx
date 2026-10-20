import { redirect } from "next/navigation";
import { Suspense } from "react";

import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { CandidateRecordPage } from "@/components/recruitment/candidate-record-page";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { canAccess, isHrAuthorityRole, resolveNavigationMode, type AccessContext } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { candidatePageHref, parseCandidatePageId } from "@/lib/recruitment/candidate-page-link";
import { loadCandidateRecord } from "@/lib/recruitment/candidate-record";
import { candidateHiddenFrom } from "@/lib/recruitment/workspace/fence";

export const dynamic = "force-dynamic";

/**
 * Portal mirror of app/(admin)/recruitment/candidate/[id]/page.tsx — the same candidate page in the
 * employee-portal shell instead of the admin one.
 *
 * Kept for the same reason the screening page keeps its twin: `app/(admin)/layout.tsx` sends
 * portal-shell viewers out of the whole (admin) group, so a name pressed on the portal's recruitment
 * pages needs a page of its own to land on. Kept in sync by hand, like the pairs beside it.
 */
export default async function EmployeePortalCandidatePage({ params }: { params: Promise<{ id: string }> }) {
  const access = await resolveAccessContextFromPage();
  const { id } = await params;
  const candidateId = parseCandidatePageId(id);
  if (resolveNavigationMode(access) !== "employee-portal") {
    // The candidate travels with the redirect, so a link pasted from the portal still opens that
    // person's page in the admin shell. Rebuilt from the checked id, never the raw address.
    redirect(candidateId ? candidatePageHref("/recruitment", candidateId) : "/recruitment");
  }
  if (!isHrAuthorityRole(access.role) || !(await canAccess(access, "recruitment", "read"))) {
    return (
      <EmployeePortalEmptyState
        message="Recruitment tools are available to the Talent Acquisition seat and the Super Admin only."
        title="Candidate Unavailable"
      />
    );
  }

  return (
    <EmployeePortalPageShell
      badge="Recruitment & Hiring"
      description="Everything on file for one candidate — the record, the files, the sends and the history."
      errorBoundaryTitle="Candidate unavailable"
      title="Candidate"
    >
      <Suspense
        fallback={
          <AppRouteLoadingState description="Loading everything on file for this candidate." title="Opening the candidate" />
        }
      >
        <CandidateContent access={access} candidateId={candidateId} />
      </Suspense>
    </EmployeePortalPageShell>
  );
}

async function CandidateContent({ access, candidateId }: { access: AccessContext; candidateId: string | null }) {
  if (!(await canAccess(access, "candidates", "read"))) {
    return (
      <EmployeePortalEmptyState
        message="A candidate's page is available to roles that can read the candidate pool."
        title="Candidate Unavailable"
      />
    );
  }

  // Same separate question as the admin page: `candidates: read` is a wider set of seats than
  // `offers: read`, and an offer letter is where the salary lives.
  // The Talent Acquisition fence (owner, 2026-10-20): an HR applicant is "no such candidate" to her,
  // the same page a deleted record gets — asked before the record is read at all.
  const hidden = candidateId ? await candidateHiddenFrom(access, candidateId) : true;
  const record =
    candidateId && !hidden
      ? await loadCandidateRecord(candidateId, { withOffer: await canAccess(access, "offers", "read") })
      : null;
  if (!record) {
    return (
      <EmployeePortalEmptyState
        message="This candidate is not in the system. The link may be incomplete, or the record may have been removed. Go back to the candidate pool and open the name from there."
        title="Candidate Not Found"
      />
    );
  }

  return <CandidateRecordPage record={record} />;
}
