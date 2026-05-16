import { redirect } from "next/navigation";
import { ReceiptText } from "lucide-react";

import { NsmTeamExpensesDashboard } from "@/components/employee-portal/nsm-team-expenses-dashboard";
import { TeamExpensesFilters } from "@/components/employee-portal/team-expenses-filters";
import {
  EmployeePortalActionBar,
  EmployeePortalPageShell,
  EmployeePortalEmptyState,
} from "@/components/employee-portal/enterprise-shell";
import { assertPermission, normalizeRole, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getNsmTeamExpenses } from "@/lib/employee-portal/service";

export const dynamic = "force-dynamic";

export default async function TeamExpensesPage(
  props: PageProps<"/employee-portals/team-expenses">,
) {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/overview");
  }

  const currentRole = normalizeRole(access.role);
  const isSalesLineManager =
    currentRole === "National Sales Manager" || currentRole === "Regional Sales Manager";
  if (!isSalesLineManager) {
    redirect("/employee-portals");
  }

  await assertPermission(access, "expenses", "read");

  const searchParams = await props.searchParams;
  const requestedPeriods = Array.isArray(searchParams.period)
    ? searchParams.period.map((period) => period.trim()).filter(Boolean)
    : typeof searchParams.period === "string"
      ? searchParams.period.split(",").map((period) => period.trim()).filter(Boolean)
      : [];
  const requestedDsm =
    typeof searchParams.dsm === "string" ? searchParams.dsm.trim() : null;
  const requestedRequestType =
    typeof searchParams.requestType === "string" ? searchParams.requestType.trim() : null;

  const data = await getNsmTeamExpenses(access, {
    dsmHrId: requestedDsm,
    period: requestedPeriods,
    requestType: requestedRequestType,
  });

  if (!data) {
    return (
      <EmployeePortalEmptyState
        message="Unable to load DSM expenses for your line at the moment."
        title="Team Expenses Data Unavailable"
      />
    );
  }

  const validPeriods = data.selectedPeriods.filter((period) => data.periods.includes(period));
  const validDsm =
    data.selectedDsmHrId &&
    data.dsms.some(
      (dsm) => dsm.hrId.toLowerCase() === data.selectedDsmHrId?.toLowerCase(),
    )
      ? data.selectedDsmHrId
      : null;
  const validRequestType =
    data.selectedRequestType &&
    data.requestTypes.some(
      (requestType) =>
        requestType.toLowerCase() === data.selectedRequestType?.toLowerCase(),
    )
      ? data.selectedRequestType
      : null;
  return (
    <EmployeePortalPageShell
      description={`${data.scopeLabel} · DSM expense workload only`}
      title="Team Expenses"
    >
      <div className="rounded-2xl border border-slate-100 bg-white p-6 shadow-[0_10px_24px_rgba(15,23,42,0.05)]">
        <EmployeePortalActionBar
          actions={
            <>
              <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-700">
                Filters
              </span>
              <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-700">
                <ReceiptText className="h-3.5 w-3.5 inline-block" />
                <span className="ml-1">Data scope: {validPeriods.length} periods</span>
              </span>
            </>
          }
        />
        <div className="mt-4">
          <TeamExpensesFilters
            dsms={data.dsms.map((dsm) => ({ hrId: dsm.hrId, name: dsm.name }))}
            periods={data.periods}
            requestTypes={data.requestTypes}
            selectedDsm={validDsm ?? ""}
            selectedPeriods={validPeriods}
            selectedRequestType={validRequestType ?? ""}
          />
        </div>
      </div>
      <NsmTeamExpensesDashboard data={data} />
    </EmployeePortalPageShell>
  );
}
