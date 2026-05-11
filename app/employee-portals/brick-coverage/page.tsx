import { redirect } from "next/navigation";
import { MapPinned } from "lucide-react";

import { BrickCoverageDashboard } from "@/components/employee-portal/brick-coverage-dashboard";
import { TeamExpensesFilters } from "@/components/employee-portal/team-expenses-filters";
import {
  EmployeePortalActionBar,
  EmployeePortalPageShell,
  EmployeePortalEmptyState,
} from "@/components/employee-portal/enterprise-shell";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getNsmBrickCoverage } from "@/lib/employee-portal/service";

export const dynamic = "force-dynamic";

export default async function BrickCoveragePage(
  props: { searchParams: Promise<Record<string, string | string[] | undefined>> },
) {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/overview");
  }

  if (!access.role.toLowerCase().includes("national sales manager")) {
    redirect("/employee-portals");
  }

  await assertPermission(access, "expenses", "read");

  const searchParams = await props.searchParams;
  const requestedPeriods = Array.isArray(searchParams.period)
    ? searchParams.period.map((period: string) => period.trim()).filter(Boolean)
    : typeof searchParams.period === "string"
      ? searchParams.period.split(",").map((period: string) => period.trim()).filter(Boolean)
      : [];
  const requestedDsm =
    typeof searchParams.dsm === "string" ? searchParams.dsm.trim() : null;

  const data = await getNsmBrickCoverage(access, {
    dsmHrId: requestedDsm,
    period: requestedPeriods,
  });

  if (!data) {
    return (
      <EmployeePortalEmptyState
        message="Unable to load brick coverage for your line at the moment."
        title="Brick Coverage Unavailable"
      />
    );
  }

  const validPeriods = data.selectedPeriods.filter((period) => data.periods.includes(period));
  const validDsm =
    data.selectedDsmHrId &&
    data.dsms.some((dsm) => dsm.hrId.toLowerCase() === data.selectedDsmHrId?.toLowerCase())
      ? data.selectedDsmHrId
      : null;

  return (
    <EmployeePortalPageShell
      description={`${data.scopeLabel} · DSM brick visit coverage and workload`}
      title="Brick Coverage"
    >
      <div className="rounded-2xl border border-slate-100 bg-white p-6 shadow-[0_10px_24px_rgba(15,23,42,0.05)]">
        <EmployeePortalActionBar
          actions={
            <>
              <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-700">
                Filters
              </span>
              <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-700">
                <MapPinned className="h-3.5 w-3.5 inline-block" />
                <span className="ml-1">{validPeriods.length} period(s)</span>
              </span>
            </>
          }
        />
        <TeamExpensesFilters
          dsms={data.dsms.map((dsm) => ({ hrId: dsm.hrId, name: dsm.name }))}
          periods={data.periods}
          requestTypes={[]}
          selectedDsm={validDsm ?? ""}
          selectedPeriods={validPeriods}
          selectedRequestType=""
          hideRequestType
          targetPath="/employee-portals/brick-coverage"
        />
      </div>
      <BrickCoverageDashboard data={data} />
    </EmployeePortalPageShell>
  );
}
