import { redirect } from "next/navigation";

import { CvReviewQueueView } from "@/components/recruitment/cv-review-queue-view";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canAccess, isHrAuthorityRole } from "@/lib/auth/permissions";
import { canReviewCvExtractions } from "@/lib/recruitment/access";
import { listCvReviewQueue } from "@/lib/recruitment/cv-review-queue";

export const dynamic = "force-dynamic";

// Worklist of CV extractions no human has ever reviewed — the route to the AI proposals that
// automated WhatsApp/email intake left invisible (see src/lib/recruitment/cv-review-queue.ts).
// Saving a row goes through the existing candidate PATCH, which records applied_fields.
export default async function CvReviewQueuePage() {
  const access = await resolveAccessContextFromPage();
  // Guarded like app/(admin)/recruitment/page.tsx, NOT like the two sibling pages
  // (cv-extraction-analytics, intake-health). Those redirect on
  // `resolveNavigationMode(access) === "employee-portal"`, but Talent Acquisition is a member of
  // portalNavigationRoles, so that test sends the queue's primary user straight back out. Role +
  // permission is the check that actually expresses "may an HR authority read recruitment here".
  if (!isHrAuthorityRole(access.role) || !(await canAccess(access, "recruitment", "read"))) {
    redirect("/employee-portals");
  }
  if (!canReviewCvExtractions(access)) {
    redirect("/employee-portals");
  }

  let queue;
  try {
    queue = await listCvReviewQueue();
  } catch (error) {
    const message = String((error as { message?: unknown })?.message ?? error);
    return (
      <div className="mx-auto max-w-3xl p-6">
        <h1 className="text-lg font-semibold text-slate-900">CV review queue unavailable</h1>
        <p className="mt-2 text-sm text-slate-600">{message}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6">
      <div className="mb-4">
        <h1 className="text-lg font-semibold text-slate-900">CV Review Queue</h1>
        <p className="text-sm text-slate-500">
          CV fields the AI read but was not confident enough to apply on its own. Automated WhatsApp and email
          intake never put these in front of anyone — reviewing one here saves it onto the candidate and records
          it as reviewed, which is also what feeds the extraction-accuracy stats.
        </p>
      </div>
      <CvReviewQueueView queue={queue} />
    </div>
  );
}
