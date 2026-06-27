import { redirect } from "next/navigation";

import { CoachingReportDetail } from "@/components/coaching/coaching-report-detail";
import {
  EmployeePortalActionBar,
  EmployeePortalActionLink,
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
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
      <EmployeePortalEmptyState
        message="This coaching report could not be found, or it is not available to your account."
        title="Report Unavailable"
      >
        <EmployeePortalActionLink href={fieldCoachingHref} label="Back to Reports" />
      </EmployeePortalEmptyState>
    );
  }

  const canCreate =
    canManageCoachingReports(access) &&
    (await canAccess(access, "coaching", "create"));

  return (
    <EmployeePortalPageShell
      badge="Coaching"
      description="Review the full coaching report, scoring structure, and employee acknowledgment status."
      title="Coaching Report Detail"
    >
      <EmployeePortalActionBar
        actions={
          <>
            <span className="rounded border border-orange-200 bg-orange-50 px-2.5 py-1 text-xs font-semibold text-orange-700">
              {detail.report.report_number}
            </span>
            <EmployeePortalActionLink href={fieldCoachingHref} label="Back to Reports" />
            {canCreate ? (
              <EmployeePortalActionLink href={createCoachingReportHref} label="Create Report" />
            ) : null}
          </>
        }
      />

      <CoachingReportDetail detail={detail} />
    </EmployeePortalPageShell>
  );
}
