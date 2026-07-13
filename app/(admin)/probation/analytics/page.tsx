import { redirect } from "next/navigation";

import { ProbationAnalyticsView } from "@/components/probation/probation-analytics-view";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { canReadAllProbation } from "@/lib/probation/service";
import { getProbationOutcomesAnalytics } from "@/lib/probation/intelligence/outcomes-analytics";

export const dynamic = "force-dynamic";

// Historical outcomes analytics (E4) — pass/terminate rates + avg frozen score by line, manager, and
// decision month, plus evaluator predictiveness. Company-wide probation readers only.
export default async function ProbationAnalyticsPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals");
  }
  if (!canReadAllProbation(access)) {
    redirect("/employee-portals");
  }

  let data;
  try {
    data = await getProbationOutcomesAnalytics();
  } catch (error) {
    const message = String((error as { message?: unknown })?.message ?? error);
    return (
      <div className="mx-auto max-w-3xl p-6">
        <h1 className="text-lg font-semibold text-slate-900">Probation analytics unavailable</h1>
        <p className="mt-2 text-sm text-slate-600">{message}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl p-4 sm:p-6">
      <div className="mb-4">
        <h1 className="text-lg font-semibold text-slate-900">Probation — Historical Outcomes</h1>
        <p className="text-sm text-slate-500">Decided cases only. Pass/terminate rates and average score by line, manager, and month, plus evaluator predictiveness.</p>
      </div>
      <ProbationAnalyticsView data={data} />
    </div>
  );
}
