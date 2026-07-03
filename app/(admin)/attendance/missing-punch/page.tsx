import { redirect } from "next/navigation";

import { MissingPunchVerificationInbox } from "@/components/attendance/missing-punch-verification-inbox";
import { listMyPendingMissingPunchActions } from "@/lib/attendance/missing-punch-verification";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function AttendanceMissingPunchPage() {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "attendance", "read"))) {
    redirect("/employee-portals");
  }

  let initialVerifications: Awaited<ReturnType<typeof listMyPendingMissingPunchActions>> = [];
  let initialError: string | null = null;
  try {
    initialVerifications = await listMyPendingMissingPunchActions(access.hrId, access.role === "Super Admin");
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Missing-punch verifications failed to load.";
  }

  return <MissingPunchVerificationInbox initialError={initialError} initialVerifications={initialVerifications} />;
}
