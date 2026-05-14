import { ClipboardCheck } from "lucide-react";
import { redirect } from "next/navigation";

import {
  AdminInsightChip,
  AdminPageHero,
} from "@/components/admin/admin-design-system";
import { CoachingReportForm } from "@/components/coaching/coaching-report-form";
import { EmployeePortalEmptyState } from "@/components/employee-portal/enterprise-shell";
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
    <div className="space-y-6">
      <AdminPageHero
        badges={
          <div className="flex flex-wrap gap-2">
            <AdminInsightChip>Field Excellence</AdminInsightChip>
            <AdminInsightChip tone="orange">Structured 120-point score</AdminInsightChip>
            <AdminInsightChip tone="slate">Employee acknowledgment workflow</AdminInsightChip>
          </div>
        }
        description="Create a field coaching report with structured scoring, development feedback, and employee acknowledgment workflow."
        eyebrow="Coaching"
        icon={<ClipboardCheck className="h-3.5 w-3.5" />}
        title="Coaching Report"
      />

      <CoachingReportForm
        coach={{
          hrId: access.hrId,
          name: viewer.displayName,
          role: viewer.roleLabel || access.role,
        }}
        employees={activeEmployees}
      />
    </div>
  );
}
