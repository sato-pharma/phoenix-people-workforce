import { redirect } from "next/navigation";

import { EmployeeCoachingReview } from "@/components/coaching/employee-coaching-review";
import {
  EmployeePortalActionBar,
  EmployeePortalActionLink,
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getCoachingReportById } from "@/lib/coaching/service";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{
    id: string;
  }>;
};

export default async function EmployeeCoachingReportDetailPage({ params }: PageProps) {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/coaching/new");
  }

  if (!(await canAccess(access, "coaching", "read"))) {
    return (
      <EmployeePortalEmptyState
        message="Your account is not authorized to view this coaching report."
        title="Coaching Access Unavailable"
      />
    );
  }

  const { id } = await params;
  let report = null;
  try {
    report = await getCoachingReportById(id, access);
  } catch {
    report = null;
  }

  if (!report) {
    return (
      <EmployeePortalEmptyState
        message="This coaching report could not be found, or it is not available to your account."
        title="Coaching Report Unavailable"
      >
        <EmployeePortalActionLink href="/employee-portals/coaching" label="Back to My Coaching Reports" />
      </EmployeePortalEmptyState>
    );
  }

  return (
    <EmployeePortalPageShell
      badge="Coaching Review"
      description="Read your coaching feedback, review the structured score, and submit your acknowledgment."
      title="Coaching Report Review"
    >
      <EmployeePortalActionBar
        actions={
          <>
            <span className="rounded-full border border-orange-200 bg-orange-50 px-3 py-1.5 text-xs font-black text-orange-700 shadow-[0_10px_24px_rgba(249,115,22,0.08)]">
              {report.report.report_number}
            </span>
            <EmployeePortalActionLink href="/employee-portals/coaching" label="Back to Reports" />
          </>
        }
      />
      <EmployeeCoachingReview initialDetail={report} />
    </EmployeePortalPageShell>
  );
}
