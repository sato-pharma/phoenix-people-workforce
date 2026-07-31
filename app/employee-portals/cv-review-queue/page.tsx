import { redirect } from "next/navigation";

import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { CvReviewQueueView } from "@/components/recruitment/cv-review-queue-view";
import { canAccess, isHrAuthorityRole, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canReviewCvExtractions } from "@/lib/recruitment/access";
import { listCvReviewQueue } from "@/lib/recruitment/cv-review-queue";

export const dynamic = "force-dynamic";

// Portal mirror of app/(admin)/recruitment/cv-review-queue/page.tsx — same data and permission
// logic, wrapped in the employee-portal shell instead of the admin shell. Kept in sync manually,
// exactly like the recruitment page pair next door.
//
// This mirror is what makes the queue REACHABLE for the people who work it: Talent Acquisition is
// a member of portalNavigationRoles, so resolveNavigationMode puts them in the portal shell and
// their sidebar is the portal tree. The admin hub that lists the admin copy
// (app/(admin)/admin/recruitment-hiring/page.tsx) redirects them away on that same test, so an
// admin-only page would have been navigable by Super Admin alone.
export default async function EmployeePortalCvReviewQueuePage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/recruitment/cv-review-queue");
  }
  if (!isHrAuthorityRole(access.role) || !(await canAccess(access, "recruitment", "read")) || !canReviewCvExtractions(access)) {
    return (
      <EmployeePortalEmptyState
        message="The CV review queue is available to Talent Acquisition and Super Admin only."
        title="CV Review Queue Unavailable"
      />
    );
  }

  let queue;
  try {
    queue = await listCvReviewQueue();
  } catch (error) {
    const message = String((error as { message?: unknown })?.message ?? error);
    return (
      <EmployeePortalEmptyState message={message} title="CV Review Queue Unavailable" />
    );
  }

  return (
    <EmployeePortalPageShell
      badge="Talent Acquisition"
      description="CV fields the AI read but wasn't confident enough to apply on its own. Automated WhatsApp and email intake never put these in front of anyone — reviewing one saves it onto the candidate and records it as reviewed."
      errorBoundaryTitle="CV review queue unavailable"
      title="CV Review Queue"
    >
      <CvReviewQueueView queue={queue} />
    </EmployeePortalPageShell>
  );
}
