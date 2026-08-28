import { ArrowLeft, ClipboardCheck } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

import {
  AdminInsightChip,
  AdminPageHero,
} from "@/components/admin/admin-design-system";
import { CoachingReportForm } from "@/components/coaching/coaching-report-form";
import {
  canAccess,
  canManageCoachingReports,
  hrIdsMatch,
  type AccessContext,
} from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getCoachingReportById } from "@/lib/coaching/service";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{
    id: string;
  }>;
};

function canOverrideDraftOwnership(access: AccessContext, coachHrId: string) {
  return (
    access.scope === "system" ||
    access.role === "Super Admin" ||
    hrIdsMatch(access.hrId, coachHrId)
  );
}

export default async function EditCoachingReportPage({ params }: PageProps) {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) {
    redirect("/login");
  }

  const { id } = await params;
  if (access.role === "Training Manager") {
    redirect(`/employee-portals/training-manager/field-coaching/${id}/edit`);
  }
  if (access.role === "Employee" || access.role === "Medical Rep") {
    redirect(`/employee-portals/coaching/${id}`);
  }
  if (!canManageCoachingReports(access) || !(await canAccess(access, "coaching", "update"))) {
    redirect("/admin/access");
  }

  let detail = null;
  try {
    detail = await getCoachingReportById(id, access);
  } catch {
    detail = null;
  }

  if (!detail) {
    return (
      <div className="space-y-6">
        <AdminPageHero
          actions={
            <Link
              className="inline-flex items-center justify-center gap-2 rounded-full border border-phx-line-strong bg-white px-5 py-2.5 text-sm font-black text-phx-ink shadow-sm transition hover:border-phx-accent/50 hover:text-phx-accent"
              href="/coaching"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to Reports
            </Link>
          }
          description="This coaching report could not be found, or it is not available to your account."
          eyebrow="Coaching"
          icon={<ClipboardCheck className="h-3.5 w-3.5" />}
          title="Draft Unavailable"
        />
      </div>
    );
  }

  // Only draft reports are editable, and only the coach who owns the draft (or a
  // Super Admin / system-scope override) may resume it. Anything else falls back
  // to the read-only detail view.
  if (detail.report.status !== "draft" || !canOverrideDraftOwnership(access, detail.report.coach_hr_id)) {
    redirect(`/coaching/${id}`);
  }

  const employees = await getEmployeeDirectoryRows();
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

  // Guarantee the draft's medical rep stays selectable even if they are no
  // longer active, so resuming never silently drops the rep selection.
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
    <div className="space-y-6">
      <AdminPageHero
        actions={
          <Link
            className="inline-flex items-center justify-center gap-2 rounded-full border border-phx-line-strong bg-white px-5 py-2.5 text-sm font-black text-phx-ink shadow-sm transition hover:border-phx-accent/50 hover:text-phx-accent"
            href={`/coaching/${id}`}
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Report
          </Link>
        }
        badges={
          <div className="flex flex-wrap gap-2">
            <AdminInsightChip>Resume Draft</AdminInsightChip>
            <AdminInsightChip tone="orange">{detail.report.report_number}</AdminInsightChip>
            <AdminInsightChip tone="slate">Save changes or submit for acknowledgment</AdminInsightChip>
          </div>
        }
        description="Continue an unsubmitted coaching draft: adjust scoring and feedback, then save it again or submit it for employee acknowledgment."
        eyebrow="Coaching"
        icon={<ClipboardCheck className="h-3.5 w-3.5" />}
        title="Resume Coaching Draft"
      />

      <CoachingReportForm
        coach={{
          hrId: detail.report.coach_hr_id,
          name: detail.summary?.coachName ?? detail.report.coach_hr_id,
          role: detail.report.coach_role ?? access.role,
        }}
        employees={activeEmployees}
        initialDraft={detail}
      />
    </div>
  );
}
