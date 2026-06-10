import { redirect } from "next/navigation";

import { ReportItAdminDashboard } from "@/components/report-it/report-it-admin-dashboard";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getReportKpis, listReports } from "@/lib/report-it/service";

export const dynamic = "force-dynamic";

export default async function AdminReportItPage() {
  const access = await resolveAccessContextFromPage();

  if (!access.hrId) {
    redirect("/login");
  }

  await assertPermission(access, "report_it", "export");

  const [kpis, initial] = await Promise.all([
    getReportKpis(),
    listReports(access, { limit: 50, offset: 0 }),
  ]);

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-6">
        <h1 className="text-xl font-bold">Pharmacovigilance — Reports Dashboard</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Review and export adverse drug reaction reports submitted by employees.
        </p>
      </div>
      <ReportItAdminDashboard kpis={kpis} initialRows={initial.rows} initialTotal={initial.total} />
    </div>
  );
}
