import { redirect } from "next/navigation";

import { CoachingReportForm } from "@/components/coaching/coaching-report-form";
import {
  EmployeePortalActionLink,
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import {
  canAccess,
  canManageCoachingReports,
  hrIdsMatch,
  resolveNavigationMode,
} from "@/lib/auth/permissions";
import {
  resolveAccessContextFromPage,
  resolveViewerIdentityFromPage,
} from "@/lib/auth/server";
import { getCoachingReportById } from "@/lib/coaching/service";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{
    id: string;
  }>;
};

const fieldCoachingHref = "/employee-portals/training-manager/field-coaching";

export default async function TrainingManagerEditCoachingReportPage({ params }: PageProps) {
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

  if (!canManageCoachingReports(access) || !(await canAccess(access, "coaching", "update"))) {
    return (
      <EmployeePortalEmptyState
        message="Your account is not authorized to edit coaching reports."
        title="Coaching Editing Unavailable"
      />
    );
  }

  if (!access.hrId) {
    return (
      <EmployeePortalEmptyState
        message="This Training Manager account needs a linked HR_ID before coaching drafts can be edited."
        title="Training Manager Profile Unlinked"
      />
    );
  }

  const { id } = await params;
  let detail = null;
  try {
    detail = await getCoachingReportById(id, access);
  } catch {
    detail = null;
  }

  if (!detail) {
    return (
      <EmployeePortalEmptyState
        message="This coaching report could not be found, or it is not available to your account."
        title="Report Unavailable"
      >
        <EmployeePortalActionLink href={fieldCoachingHref} label="Back to Reports" />
      </EmployeePortalEmptyState>
    );
  }

  // A Training Manager may only resume their own draft; submitted/locked reports
  // and other coaches' drafts fall back to the read-only detail view.
  if (detail.report.status !== "draft" || !hrIdsMatch(access.hrId, detail.report.coach_hr_id)) {
    redirect(`${fieldCoachingHref}/${id}`);
  }

  const [viewer, employees] = await Promise.all([
    resolveViewerIdentityFromPage(access),
    getEmployeeDirectoryRows(),
  ]);

  const activeEmployees = employees
    .filter((employee) => (employee.employmentStatus ?? "active") === "active")
    .map((employee) => ({
      areaName: employee.areaName,
      fullName: employee.displayName,
      hrId: employee.hrId,
      jobTitle: employee.jobTitle,
      lineName: employee.lineName,
      teamId: employee.teamId,
    }));

  // Keep the draft's medical rep selectable even if they are no longer active.
  const repHrId = detail.report.medical_rep_hr_id;
  if (repHrId && !activeEmployees.some((employee) => employee.hrId === repHrId)) {
    const rep = employees.find((employee) => employee.hrId === repHrId);
    if (rep) {
      activeEmployees.push({
        areaName: rep.areaName,
        fullName: rep.displayName,
        hrId: rep.hrId,
        jobTitle: rep.jobTitle,
        lineName: rep.lineName,
        teamId: rep.teamId,
      });
    }
  }

  return (
    <EmployeePortalPageShell
      badge="Coaching"
      description="Continue an unsubmitted coaching draft: adjust scoring and feedback, then save it again or submit it for employee acknowledgment."
      title="Resume Coaching Draft"
    >
      <CoachingReportForm
        coach={{
          hrId: access.hrId,
          name: viewer.displayName,
          role: viewer.roleLabel || access.role,
        }}
        employees={activeEmployees}
        initialDraft={detail}
      />
    </EmployeePortalPageShell>
  );
}
