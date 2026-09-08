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

  // TEMPORARY LOCKDOWN — owner 2026-09-08, pending his rules on telling people the
  // page exists. FAILS CLOSED: a lookup that throws means "not verifiably allowed",
  // never "let them in", which is the only safe direction for a page showing somebody
  // their own pay deductions.
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
    // "you have nothing to answer" and quietly runs the response window down.
    initialError = error instanceof Error ? error.message : "Weekly attendance digests failed to load.";
  }

  return (
    <EmployeePortalPageShell
      description="Confirm or dispute each attendance day flagged for you this week."
      title="Weekly Attendance"
    >
      <WeeklyDigestPortal initialDigests={initialDigests} initialError={initialError} showAmounts={showAmounts} />
    </EmployeePortalPageShell>
  );
}
