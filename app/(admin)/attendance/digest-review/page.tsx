import { redirect } from "next/navigation";

import { DigestReviewInbox } from "@/components/attendance/digest-review-inbox";
import { isAuthorizedDisputeReviewer, listPendingDigestReviews, listSettledDigestReviews } from "@/lib/attendance/digest-read";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function AttendanceDigestReviewPage() {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "attendance", "read"))) {
    redirect("/employee-portals");
  }

  // Fail closed: a DB/config error here means "not verifiably authorized",
  // never "let them in" — same pattern as the dispute-review page.
  const authorized = await isAuthorizedDisputeReviewer(access.hrId, access.role === "Super Admin").catch(() => false);
  if (!authorized) {
    redirect("/employee-portals");
  }

  let initialDigests: Awaited<ReturnType<typeof listPendingDigestReviews>> = [];
  let initialError: string | null = null;
  try {
    initialDigests = await listPendingDigestReviews();
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Digest review queue failed to load.";
  }

  let initialSettled: Awaited<ReturnType<typeof listSettledDigestReviews>> = [];
  let initialSettledError: string | null = null;
  try {
    initialSettled = await listSettledDigestReviews();
  } catch (error) {
    initialSettledError = error instanceof Error ? error.message : "Settled digest list failed to load.";
  }

  return (
    <DigestReviewInbox
      initialDigests={initialDigests}
      initialError={initialError}
      initialSettled={initialSettled}
      initialSettledError={initialSettledError}
    />
  );
}
