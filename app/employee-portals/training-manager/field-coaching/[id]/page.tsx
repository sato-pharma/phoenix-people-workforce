import { ArrowLeft, ClipboardCheck, Plus } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

import {
  AdminInsightChip,
  AdminPageHero,
} from "@/components/admin/admin-design-system";
import { CoachingReportDetail } from "@/components/coaching/coaching-report-detail";
import { EmployeePortalEmptyState } from "@/components/employee-portal/enterprise-shell";
import {
  canAccess,
  canManageCoachingReports,
  resolveNavigationMode,
} from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getCoachingReportById } from "@/lib/coaching/service";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{
    id: string;
  }>;
};

const createCoachingReportHref = "/employee-portals/training-manager/create-coaching-report";
const fieldCoachingHref = "/employee-portals/training-manager/field-coaching";

export default async function TrainingManagerCoachingReportDetailPage({ params }: PageProps) {
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
  if (!(await canAccess(access, "coaching", "read"))) {
    return (
      <EmployeePortalEmptyState
        message="Your account is not authorized to view Training Manager coaching reports."
        title="Coaching Access Unavailable"
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
      <div className="space-y-6">
        <AdminPageHero
          actions={
            <Link
              className="inline-flex items-center justify-center gap-2 rounded-full border border-[#CBD5E1] bg-white px-5 py-2.5 text-sm font-black text-[#0F172A] shadow-sm transition hover:border-[#F97316]/50 hover:text-[#F97316]"
              href={fieldCoachingHref}
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

  const canCreate =
    canManageCoachingReports(access) &&
    (await canAccess(access, "coaching", "create"));

  return (
    <div className="space-y-6">
      <AdminPageHero
        actions={
          <div className="flex flex-wrap gap-2">
            <Link
              className="inline-flex items-center justify-center gap-2 rounded-full border border-[#CBD5E1] bg-white px-5 py-2.5 text-sm font-black text-[#0F172A] shadow-sm transition hover:border-[#F97316]/50 hover:text-[#F97316]"
              href={fieldCoachingHref}
            >
              <ArrowLeft className="h-4 w-4" />
              Back to Reports
            </Link>
            {canCreate ? (
              <Link
                className="inline-flex items-center justify-center gap-2 rounded-full bg-[#F97316] px-5 py-2.5 text-sm font-black text-white shadow-[0_18px_42px_rgba(249,115,22,0.22)] transition hover:bg-[#EA580C]"
                href={createCoachingReportHref}
              >
                <Plus className="h-4 w-4" />
                Create Report
              </Link>
            ) : null}
          </div>
        }
        badges={
          <div className="flex flex-wrap gap-2">
            <AdminInsightChip>Read-only Report</AdminInsightChip>
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
