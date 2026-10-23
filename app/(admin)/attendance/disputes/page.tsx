import { redirect } from "next/navigation";

import { DisputeReviewInbox } from "@/components/attendance/dispute-review-inbox";
import { canReviewDisputes, listPendingDisputes } from "@/lib/attendance/digest-service.ts";
import { canAccess } from "@/lib/auth/permissions";
import { guardSeatPage } from "@/lib/auth/seat-page-guard";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function AttendanceDisputesPage() {
  const access = await resolveAccessContextFromPage();
  guardSeatPage(access, "/attendance/disputes");
  if (!(await canAccess(access, "attendance", "read"))) {
    redirect("/employee-portals");
  }

  // Fail CLOSED: a config lookup that throws means "not verifiably a reviewer",
  // never "let them in". Super Admin short-circuits without touching the database,
  // so only a real failure reaches the catch.
  const authorized = await canReviewDisputes(access).catch(() => false);
  if (!authorized) {
    redirect("/employee-portals");
  }

  let initialDisputes: Awaited<ReturnType<typeof listPendingDisputes>> = [];
  let initialError: string | null = null;
  try {
    initialDisputes = await listPendingDisputes();
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Attendance disputes failed to load.";
  }

  return <DisputeReviewInbox initialDisputes={initialDisputes} initialError={initialError} />;
}
