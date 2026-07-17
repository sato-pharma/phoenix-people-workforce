import { redirect } from "next/navigation";

import { ProbationDashboardView } from "@/components/probation/probation-dashboard-view";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { canReadAllProbation } from "@/lib/probation/service";
import { getProbationDashboard } from "@/lib/probation/intelligence/dashboard";

export const dynamic = "force-dynamic";

// CEO exception dashboard — all active probation cases, exception-first. Company-wide readers only.
export default async function ProbationDashboardPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals");
  }
  if (!canReadAllProbation(access)) {
    redirect("/employee-portals");
  }

  let data;
  try {
    data = await getProbationDashboard();
  } catch (error) {
    const message = String((error as { message?: unknown })?.message ?? error);
    return (
      <div className="mx-auto max-w-3xl p-6">
        <h1 className="text-lg font-semibold text-slate-900">Probation dashboard unavailable</h1>
        <p className="mt-2 text-sm text-slate-600">{message}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl p-4 sm:p-6">
      <div className="mb-4">
        <h1 className="text-lg font-semibold text-slate-900">Probation — Decision Readiness</h1>
        <p className="text-sm text-slate-500">Active probation cases, exception-first. Green/Amber/Red/Grey with labels.</p>
      </div>
      <ProbationDashboardView data={data} />
    </div>
  );
}
