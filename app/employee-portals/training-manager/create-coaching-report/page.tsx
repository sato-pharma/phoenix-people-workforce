import { ClipboardCheck } from "lucide-react";
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
      badge="Training Manager"
      description="Create field coaching reports for employees, save drafts, and submit completed reports for employee acknowledgment."
      title="Create Coaching Report"
    >
      <div className="rounded-[28px] border border-white/80 bg-white/90 p-3 shadow-[0_18px_46px_rgba(15,23,42,0.07)] ring-1 ring-slate-200/70 sm:p-4">
        <div className="mb-4 flex items-center gap-2 rounded-2xl border border-orange-100 bg-orange-50 px-4 py-3 text-sm font-bold text-orange-700">
          <ClipboardCheck className="h-4 w-4" />
          <span>Coach identity is locked to your Training Manager account.</span>
        </div>
        <CoachingReportForm
          coach={{
            hrId: access.hrId,
            name: viewer.displayName,
            role: viewer.roleLabel || access.role,
          }}
          employees={activeEmployees}
        />
      </div>
    </EmployeePortalPageShell>
  );
}
