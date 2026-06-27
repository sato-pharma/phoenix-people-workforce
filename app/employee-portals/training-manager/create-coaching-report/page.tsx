import { redirect } from "next/navigation";

import { CoachingReportForm } from "@/components/coaching/coaching-report-form";
import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import {
  canAccess,
  canManageCoachingReports,
  resolveNavigationMode,
} from "@/lib/auth/permissions";
import {
  resolveAccessContextFromPage,
  resolveViewerIdentityFromPage,
} from "@/lib/auth/server";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";

export const dynamic = "force-dynamic";

export default async function TrainingManagerCreateCoachingReportPage() {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) {
    redirect("/login");
  }
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/overview");
  }
  if (access.role !== "Training Manager") {
    redirect("/employee-portals");
  }

  if (!canManageCoachingReports(access) || !(await canAccess(access, "coaching", "create"))) {
    return (
      <EmployeePortalEmptyState
        message="Your account is not authorized to create coaching reports."
        title="Coaching Creation Unavailable"
      />
    );
  }

  if (!access.hrId) {
    return (
      <EmployeePortalEmptyState
        message="This Training Manager account needs a linked HR_ID before coaching reports can be created."
        title="Training Manager Profile Unlinked"
      />
    );
  }

  const [viewer, employees] = await Promise.all([
    resolveViewerIdentityFromPage(access),
    getEmployeeDirectoryRows(),
  ]);

  const activeEmployees = employees
    .filter((employee) => (employee.employmentStatus ?? "active") === "active")
    .map((employee) => ({
      areaName: employee.areaName,
      fullName: employee.fullName,
      hrId: employee.hrId,
      jobTitle: employee.jobTitle,
      lineName: employee.lineName,
      teamId: employee.teamId,
    }));

  return (
    <EmployeePortalPageShell
      badge="Coaching"
      description="Create a field coaching report with structured scoring, development feedback, and employee acknowledgment workflow."
      title="Coaching Report"
    >
      <CoachingReportForm
        coach={{
          hrId: access.hrId,
          name: viewer.displayName,
          role: viewer.roleLabel || access.role,
        }}
        employees={activeEmployees}
      />
    </EmployeePortalPageShell>
  );
}
