import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { MyMilestones } from "@/components/employee-portal/my-milestones";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canUseEmployeePortalMilestones } from "@/lib/employee-portal/navigation";
import { logPortalFailure } from "@/lib/observability/portal-logging";
import { listEmployeeMilestones, type MyMilestoneEntry } from "@/lib/milestones/service";

export const dynamic = "force-dynamic";

/**
 * My Milestones — a rep's own service-anniversary and Sato-Pharma birthday keepsake cards.
 *
 * SELF-SCOPED, and that is the whole point. The Super-Admin workspace at /milestones prints anyone's
 * card across the company; this page lists only the signed-in rep's own occasions, and each downloads
 * only his own card through /api/milestones/my-card. The redirects here are UX; the real boundary is
 * that the export route only ever builds the caller's own card. Medical-Rep only, matching the
 * sidebar (owner, 2026-09-30).
 */
export default async function EmployeePortalMilestonesPage() {
  const access = await resolveAccessContextFromPage();

  if (!access.loginId && !access.hrId) {
    redirect("/login");
  }
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/overview");
  }
  if (!canUseEmployeePortalMilestones(access.role)) {
    redirect("/employee-portals");
  }

  let entries: MyMilestoneEntry[] = [];
  try {
    entries = access.hrId ? await listEmployeeMilestones(access.hrId) : [];
  } catch (error) {
    logPortalFailure(
      { route: "/employee-portals/milestones", module: "milestones", role: access.role, hrId: access.hrId },
      error,
    );
    entries = [];
  }

  return (
    <EmployeePortalPageShell
      badge="My Workspace"
      title="My Milestones"
      description="Your service anniversaries and birthdays at Sato Pharma. Download any of them as a keepsake card to keep or print."
    >
      <MyMilestones entries={entries} />
    </EmployeePortalPageShell>
  );
}
