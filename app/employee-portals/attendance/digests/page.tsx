import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { WeeklyDigestPortal } from "@/components/employee-portal/weekly-digest-portal";
import { canOpenDigestPortal, listMyDigests } from "@/lib/attendance/digest-service.ts";
import { getDigestSettings } from "@/lib/attendance/digest-service.ts";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function EmployeeWeeklyDigestPage() {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "attendance", "read"))) {
    redirect("/employee-portals");
  }

  // Self-scoped: any employee with an HR ID sees their OWN released weeks only. FAILS
  // CLOSED on a lookup error, the only safe direction for a page showing somebody their
  // own pay deductions.
  if (!(await canOpenDigestPortal(access).catch(() => false))) {
    redirect("/employee-portals");
  }

  const hrId = access.hrId;
  if (!hrId) {
    redirect("/employee-portals");
  }

  let initialDigests: Awaited<ReturnType<typeof listMyDigests>> = [];
  let initialError: string | null = null;
  let showAmounts = true;
  try {
    const [digests, settings] = await Promise.all([listMyDigests(hrId), getDigestSettings()]);
    initialDigests = digests;
    showAmounts = settings.showEstimatedAmount;
  } catch (error) {
    // Say the page is broken rather than rendering an empty week, which reads as
    // "you have nothing to answer" while the 2-working-day deadline runs down.
    initialError = error instanceof Error ? error.message : "Weekly attendance failed to load.";
  }

  return (
    <EmployeePortalPageShell
      description="For each flagged day, choose whether it is deducted from your salary or your annual balance, then dispute it if it is wrong."
      title="Weekly Attendance"
    >
      <WeeklyDigestPortal initialDigests={initialDigests} initialError={initialError} showAmounts={showAmounts} />
    </EmployeePortalPageShell>
  );
}
