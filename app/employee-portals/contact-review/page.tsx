import { redirect } from "next/navigation";

import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { ContactReviewView } from "@/components/recruitment/contact-review-view";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canReviewCandidateContacts } from "@/lib/recruitment/access";
import { listContactReviewQueue } from "@/lib/recruitment/contact-review-service";
import { fenceRowsByCandidate } from "@/lib/recruitment/workspace/fence";

export const dynamic = "force-dynamic";

// Portal mirror of app/(admin)/recruitment/contact-review/page.tsx. Talent Acquisition works out of
// the employee portal, not the admin shell, so without this twin the page is unreachable for the
// one role that owns it — the exact way Intake Health shipped invisible.
export default async function EmployeePortalContactReviewPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/recruitment/contact-review");
  }
  if (!canReviewCandidateContacts(access)) {
    return (
      <EmployeePortalEmptyState
        message="Contact-details review is available to the Super Admin only."
        title="Contact Review Unavailable"
      />
    );
  }

  let rows;
  try {
    // The Talent Acquisition fence (owner, 2026-10-20): an HR applicant is not on the queue she reads.
    rows = await fenceRowsByCandidate(access, await listContactReviewQueue(), (row) => row.candidateId);
  } catch (error) {
    const message = String((error as { message?: unknown })?.message ?? error);
    return <EmployeePortalEmptyState message={message} title="Contact Review Unavailable" />;
  }

  return (
    <EmployeePortalPageShell
      badge="CV Pipeline"
      description="Candidates with no email or phone on record whose own CV carries one. Accepting fills only the blank column — anything already on the record always wins."
      errorBoundaryTitle="Contact review unavailable"
      title="Missing Contact Details"
    >
      <ContactReviewView rows={rows} />
    </EmployeePortalPageShell>
  );
}
