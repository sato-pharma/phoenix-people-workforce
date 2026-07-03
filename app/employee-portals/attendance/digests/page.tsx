import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { WeeklyDigestPortal } from "@/components/employee-portal/weekly-digest-portal";
import { listMyDigests } from "@/lib/attendance/digest-read";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function EmployeeWeeklyDigestPage() {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "attendance", "read"))) {
    redirect("/employee-portals");
  }
  const hrId = access.hrId;
  if (!hrId) {
    redirect("/employee-portals");
  }

  let initialDigests: Awaited<ReturnType<typeof listMyDigests>> = [];
  let initialError: string | null = null;
  try {
    initialDigests = await listMyDigests(hrId);
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Weekly attendance digests failed to load.";
  }

  return (
    <EmployeePortalPageShell description="Your weekly attendance settlement — confirm or dispute each deductible day." title="Weekly Attendance Digest">
      <WeeklyDigestPortal initialDigests={initialDigests} initialError={initialError} />
    </EmployeePortalPageShell>
  );
}
