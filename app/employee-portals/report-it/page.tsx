import { redirect } from "next/navigation";

import { ReportItEmployeeDashboard } from "@/components/report-it/report-it-employee-dashboard";
import { ReportItForm } from "@/components/report-it/report-it-form";
import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { canAccess } from "@/lib/auth/permissions";
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
    // A viewer holding report_it:read (e.g. Regional / District Manager — see the SELF_ONLY roles in
    // tests/report-it-access.test.ts) is meant to submit a report AND see their own submissions. The
    // read grant was previously unreachable: this branch rendered the form only, and listReports —
    // which already self-scopes to submitted_by_hr_id for non-dashboard viewers — was called solely
    // inside the dashboard branch below. Fetching it here makes the granted permission real.
    const own = (await canAccess(access, "report_it", "read"))
      ? await listReports(access, { limit: 50, offset: 0 }).catch(() => null)
      : null;

    return (
      <EmployeePortalPageShell
        badge="Pharmacovigilance"
        description="Submit an adverse drug reaction report."
        errorBoundaryTitle="Report It unavailable"
        title="Report It"
      >
        <ReportItForm />
        {own && own.rows.length > 0 ? (
          <section className="mt-4 space-y-2">
            <h2 className="text-phx-sm font-bold uppercase tracking-widest text-slate-500">My Reports</h2>
            <ReportItEmployeeDashboard initialRows={own.rows} initialTotal={own.total} />
          </section>
        ) : null}
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
