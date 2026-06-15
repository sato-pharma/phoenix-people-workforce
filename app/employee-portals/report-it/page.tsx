import { redirect } from "next/navigation";

import { ReportItEmployeeDashboard } from "@/components/report-it/report-it-employee-dashboard";
import { ReportItForm } from "@/components/report-it/report-it-form";
import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canViewAllReports, listReports } from "@/lib/report-it/service";

export const dynamic = "force-dynamic";

export default async function ReportItPage() {
  const access = await resolveAccessContextFromPage();

  if (!access.hrId) {
    redirect("/login");
  }

  // Users with report_it:export OR listed in report_it_dashboard_access see the full dashboard.
  const canViewDashboard = await canViewAllReports(access);

  if (!canViewDashboard) {
    return (
      <EmployeePortalPageShell
        badge="Pharmacovigilance"
        description="Submit an adverse drug reaction report."
        errorBoundaryTitle="Report It unavailable"
        title="Report It"
      >
        <ReportItForm />
      </EmployeePortalPageShell>
    );
  }

  const initial = await listReports(access, { limit: 50, offset: 0 });

  return (
    <EmployeePortalPageShell
      badge="Pharmacovigilance"
      description="Adverse drug reaction reports dashboard."
      errorBoundaryTitle="Report It Dashboard unavailable"
      title="Report It Dashboard"
      disableErrorBoundary={false}
    >
      <ReportItEmployeeDashboard initialRows={initial.rows} initialTotal={initial.total} />
    </EmployeePortalPageShell>
  );
}
