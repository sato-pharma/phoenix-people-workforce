import { redirect } from "next/navigation";

import { DisputeReviewInbox } from "@/components/attendance/dispute-review-inbox";
import { isAuthorizedDisputeReviewer, listOpenDisputes } from "@/lib/attendance/digest-read";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function AttendanceDisputesPage() {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "attendance", "read"))) {
    redirect("/employee-portals");
  }

  // Fail closed: a DB/config error here means "not verifiably authorized",
  // never "let them in" — Super Admin already short-circuits this check
  // without touching the DB, so only a real config lookup failure lands here.
  const authorized = await isAuthorizedDisputeReviewer(access.hrId, access.role === "Super Admin").catch(() => false);
  if (!authorized) {
    redirect("/employee-portals");
  }

  let initialDisputes: Awaited<ReturnType<typeof listOpenDisputes>> = [];
  let initialError: string | null = null;
  try {
    initialDisputes = await listOpenDisputes();
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Attendance disputes failed to load.";
  }

  return <DisputeReviewInbox initialDisputes={initialDisputes} initialError={initialError} />;
}
