import { redirect } from "next/navigation";

import { ReportItEmployeeDashboard } from "@/components/report-it/report-it-employee-dashboard";
import { ReportItForm } from "@/components/report-it/report-it-form";
import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { listReports } from "@/lib/report-it/service";

export const dynamic = "force-dynamic";

export default async function ReportItPage() {
  const access = await resolveAccessContextFromPage();

  if (!access.hrId) {
    redirect("/login");
  }

  // Only users with report_it:export see the full dashboard; others get the submit form only.
  const canViewDashboard = await canAccess(access, "report_it", "export");

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
