import { ArrowLeft, ClipboardCheck, Pencil, Plus } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

import {
  AdminInsightChip,
  AdminPageHero,
} from "@/components/admin/admin-design-system";
import { CoachingReportDetail } from "@/components/coaching/coaching-report-detail";
import { CoachingReportSubmitAction } from "@/components/coaching/coaching-report-submit-action";
import {
  canAccess,
  canManageCoachingReports,
  hrIdsMatch,
  normalizeHrId,
  type AccessContext,
} from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canSubmitCoachingDraft, getCoachingReportById } from "@/lib/coaching/service";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{
    id: string;
  }>;
};

function isEmployeePortalRole(access: AccessContext) {
  return access.role === "Employee" || access.role === "Medical Rep";
}

function canViewTrainingManagerReport(access: AccessContext, coachHrId: string) {
  if (access.role !== "Training Manager") return true;
  return normalizeHrId(access.hrId) === normalizeHrId(coachHrId);
}

export default async function CoachingReportDetailPage({ params }: PageProps) {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) {
    redirect("/login");
  }

  const { id } = await params;
  if (access.role === "Training Manager") {
    redirect(`/employee-portals/training-manager/field-coaching/${id}`);
  }
  if (isEmployeePortalRole(access)) {
    redirect(`/employee-portals/coaching/${id}`);
  }
  if (!(await canAccess(access, "coaching", "read"))) {
    redirect("/admin/access");
  }

  let detail = null;
  try {
    detail = await getCoachingReportById(id, access);
  } catch {
    detail = null;
  }

  if (!detail || !canViewTrainingManagerReport(access, detail.report.coach_hr_id)) {
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
          title="Report Unavailable"
        />
      </div>
    );
  }

  const canManageCoaching = canManageCoachingReports(access);
  const canCreate = canManageCoaching && (await canAccess(access, "coaching", "create"));
  // Only an unsubmitted draft owned by the coach (or a Super Admin / system
  // override) can be resumed and submitted; everything else stays read-only.
  const canEditDraft =
    detail.report.status === "draft" &&
    canManageCoaching &&
    (await canAccess(access, "coaching", "update")) &&
    (access.scope === "system" ||
      access.role === "Super Admin" ||
      hrIdsMatch(access.hrId, detail.report.coach_hr_id));
  const canSubmit = canSubmitCoachingDraft(access, detail.report);

  return (
    <div className="space-y-6">
      <AdminPageHero
        actions={
          <div className="flex flex-wrap gap-2">
            <Link
              className="inline-flex items-center justify-center gap-2 rounded-full border border-phx-line-strong bg-white px-5 py-2.5 text-sm font-black text-phx-ink shadow-sm transition hover:border-phx-accent/50 hover:text-phx-accent"
              href="/coaching"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to Reports
            </Link>
            {canEditDraft ? (
              <Link
                className="inline-flex items-center justify-center gap-2 rounded-full bg-phx-accent px-5 py-2.5 text-sm font-black text-white shadow-[0_18px_42px_rgba(249,115,22,0.22)] transition hover:bg-phx-accent-hover"
                href={`/coaching/${id}/edit`}
              >
                <Pencil className="h-4 w-4" />
                Resume Draft
              </Link>
            ) : null}
            {canCreate ? (
              <Link
                className="inline-flex items-center justify-center gap-2 rounded-full bg-phx-accent px-5 py-2.5 text-sm font-black text-white shadow-[0_18px_42px_rgba(249,115,22,0.22)] transition hover:bg-phx-accent-hover"
                href="/coaching/skills-survey"
              >
                <Plus className="h-4 w-4" />
                Team Coaching Skills Survey
              </Link>
            ) : null}
            {canSubmit ? <CoachingReportSubmitAction reportId={detail.report.id} /> : null}
          </div>
        }
        badges={
          <div className="flex flex-wrap gap-2">
            <AdminInsightChip>{canSubmit ? "Draft — Ready to Submit" : "Read-only Report"}</AdminInsightChip>
            <AdminInsightChip tone="orange">{detail.report.report_number}</AdminInsightChip>
            <AdminInsightChip tone="slate">Employee acknowledgment tracked</AdminInsightChip>
          </div>
        }
        description="Review the full coaching report, scoring structure, and employee acknowledgment status."
        eyebrow="Coaching"
        icon={<ClipboardCheck className="h-3.5 w-3.5" />}
        title="Coaching Report Detail"
      />

      <CoachingReportDetail detail={detail} />
    </div>
  );
}
