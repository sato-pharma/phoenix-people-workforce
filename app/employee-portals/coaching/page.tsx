import { redirect } from "next/navigation";

import { EmployeeCoachingList } from "@/components/coaching/employee-coaching-list";
import {
  EmployeePortalActionBar,
  EmployeePortalActionLink,
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getMyCoachingReports } from "@/lib/coaching/service";

export const dynamic = "force-dynamic";

export default async function EmployeeCoachingReportsPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/coaching/new");
  }

  if (!(await canAccess(access, "coaching", "read"))) {
    return (
      <EmployeePortalEmptyState
        message="Your account is not authorized to view coaching reports."
        title="Coaching Access Unavailable"
      />
    );
  }

  let reports = null;
  try {
    reports = await getMyCoachingReports(access);
  } catch {
    reports = null;
  }

  if (!reports) {
    return (
      <EmployeePortalEmptyState
        message="Unable to load your coaching reports. Please try again later."
        title="Coaching Reports Unavailable"
      />
    );
  }

  return (
    <EmployeePortalPageShell
      badge="Field Excellence"
      description="Review your submitted field coaching reports, scores, feedback, and acknowledgment status."
      title="My Coaching Reports"
    >
      <EmployeePortalActionBar
        actions={
          <>
            <span className="rounded-full border border-orange-200 bg-orange-50 px-3 py-1.5 text-xs font-black text-orange-700 shadow-[0_10px_24px_rgba(249,115,22,0.08)]">
              {reports.length} report{reports.length === 1 ? "" : "s"}
            </span>
            <EmployeePortalActionLink href="/employee-portals" label="Back to Dashboard" />
          </>
        }
      />
      <EmployeeCoachingList reports={reports} />
    </EmployeePortalPageShell>
  );
}
