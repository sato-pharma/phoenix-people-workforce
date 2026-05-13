import { ClipboardCheck } from "lucide-react";
import { redirect } from "next/navigation";

import {
  AdminInsightChip,
  AdminPageHero,
} from "@/components/admin/admin-design-system";
import { CoachingReportForm } from "@/components/coaching/coaching-report-form";
import { AppShell } from "@/components/layout/app-shell";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { canAccess, canManageCoachingReports } from "@/lib/auth/permissions";
import {
  resolveAccessContextFromPage,
  resolveViewerIdentityFromPage,
} from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function NewCoachingReportPage() {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) {
    redirect("/login");
  }
  if (access.role === "Training Manager") {
    redirect("/employee-portals/training-manager/create-coaching-report");
  }
  if (!canManageCoachingReports(access) || !(await canAccess(access, "coaching", "create"))) {
    redirect("/admin/access");
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
    <AppShell navigationMode="admin">
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
    </AppShell>
  );
}
