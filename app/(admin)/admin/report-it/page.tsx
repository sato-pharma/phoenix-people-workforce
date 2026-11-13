import { redirect } from "next/navigation";

import { ReportItAccessPanel } from "@/components/report-it/report-it-access-panel";
import { ReportItAdminDashboard } from "@/components/report-it/report-it-admin-dashboard";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import {
  canViewAllReports,
  getDashboardAccessOverview,
  getReportKpis,
  listGrantableEmployees,
  listReports,
} from "@/lib/report-it/service";

export const dynamic = "force-dynamic";

export default async function AdminReportItPage() {
  const access = await resolveAccessContextFromPage();

  if (!access.hrId) {
    redirect("/login");
  }

  // Portal-mode users (e.g. Manager) must use the employee portal version.
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals/report-it");
  }

  const canView = await canViewAllReports(access);
  if (!canView) {
    redirect("/admin");
  }

  // The read-all list and the read log belong to `report_it:export` holders alone (owner, 2026-11-13);
  // someone given read-all by name sees the reports, never who else may read them.
  const managesAccess = await canAccess(access, "report_it", "export");
  const [kpis, initial, accessOverview, grantable] = await Promise.all([
    getReportKpis(),
    listReports(access, { limit: 50, offset: 0 }),
    managesAccess ? getDashboardAccessOverview(access) : Promise.resolve(null),
    managesAccess ? listGrantableEmployees(access) : Promise.resolve([]),
  ]);

  return (
    <main className="p-4 sm:p-6">
      <header className="mb-6">
        <p className="text-phx-xs font-black uppercase tracking-[0.2em] text-orange-600">Pharmacovigilance</p>
        <h1 className="text-xl font-black text-slate-900">Reports Dashboard</h1>
        <p className="mt-1 text-sm text-slate-600">
          Review and export adverse drug reaction reports submitted by employees.
        </p>
      </header>
      <ReportItAdminDashboard kpis={kpis} initialRows={initial.rows} initialTotal={initial.total} />
      {accessOverview ? <ReportItAccessPanel employees={grantable} initial={accessOverview} /> : null}
    </main>
  );
}
