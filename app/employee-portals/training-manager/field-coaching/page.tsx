import { redirect } from "next/navigation";

import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { TrainingManagerFieldCoachingPage } from "@/components/employee-portal/training-manager-coaching";
import {
  canAccess,
  normalizeHrId,
  resolveNavigationMode,
} from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getCoachingReports } from "@/lib/coaching/service";
import type { CoachingReportSummaryRow } from "@/lib/coaching/types";

export const dynamic = "force-dynamic";

export default async function TrainingManagerFieldCoachingReportsPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/overview");
  }
  if (access.role !== "Training Manager") {
    redirect("/employee-portals");
  }

  if (!(await canAccess(access, "coaching", "read"))) {
    return (
      <EmployeePortalEmptyState
        message="Your account is not authorized to view Training Manager field coaching."
        title="Coaching Access Unavailable"
      />
    );
  }

  const coachHrId = normalizeHrId(access.hrId);
  if (!coachHrId) {
    return (
      <EmployeePortalEmptyState
        message="This Training Manager account needs a linked HR_ID before field coaching reports can be loaded."
        title="Training Manager Profile Unlinked"
      />
    );
  }

  let reports: CoachingReportSummaryRow[] = [];
  try {
    reports = await getCoachingReports({ coachHrId }, access);
  } catch {
    return (
      <EmployeePortalEmptyState
        message="Unable to load Training Manager field coaching reports. Please try again later."
        title="Field Coaching Unavailable"
      />
    );
  }

  return (
    <EmployeePortalPageShell
      badge="Training Manager"
      description="Review the coaching reports linked to your Training Manager HR_ID without opening the admin coaching workspace."
      title="Field Coaching"
    >
      <TrainingManagerFieldCoachingPage reports={reports} />
    </EmployeePortalPageShell>
  );
}
