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
    <main className="p-4 sm:p-6">
      <header className="mb-6">
        <p className="text-[11px] font-black uppercase tracking-[0.2em] text-orange-600">Pharmacovigilance</p>
        <h1 className="text-xl font-black text-slate-900">Reports Dashboard</h1>
        <p className="mt-1 text-sm text-slate-600">
          Review and export adverse drug reaction reports submitted by employees.
        </p>
      </header>
      <ReportItAdminDashboard kpis={kpis} initialRows={initial.rows} initialTotal={initial.total} />
    </main>
  );
}
