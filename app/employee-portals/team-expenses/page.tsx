import { redirect } from "next/navigation";

import { NsmTeamExpensesDashboard } from "@/components/employee-portal/nsm-team-expenses-dashboard";
import { TeamExpensesFilters } from "@/components/employee-portal/team-expenses-filters";
import {
  EmployeePortalPageShell,
  EmployeePortalEmptyState,
} from "@/components/employee-portal/enterprise-shell";
import { ScopeBadge } from "@/components/employee-portal/scope-badge";
import { Card } from "@/components/ui/card";
import { assertPermission, isNationalSalesManager, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getNsmTeamExpenses } from "@/lib/employee-portal/service";

export const dynamic = "force-dynamic";

/* ---------- print stylesheet ---------- */

const printStyles = `
@media print {
  body { background: #fff !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  nav, header, footer, button, [data-no-print] { display: none !important; }
  .print\\:break-inside-avoid { break-inside: avoid; }
  .print\\:shadow-none { box-shadow: none !important; }
  * { border-color: #e2e8f0 !important; }
}
`;

type TeamExpensesPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function TeamExpensesPage(
  props: TeamExpensesPageProps,
) {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/overview");
  }

  if (!isNationalSalesManager(access.role)) {
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
        message="Unable to load team expenses for your line at the moment."
        title="Team Expenses Unavailable"
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
      badge="Expenses"
      description={`${data.scopeLabel} - Team expense workload`}
      title="Team Expenses"
    >
      {/* Print stylesheet */}
      <style dangerouslySetInnerHTML={{ __html: printStyles }} />

      <div className="flex flex-wrap items-center gap-2">
        <ScopeBadge scope={access.scope} />
      </div>

      <div
        className="max-w-full min-w-0 space-y-5 overflow-x-hidden text-slate-900 sm:space-y-7"
        dir="auto"
      >
        {/* Filters Card */}
        <Card className="rounded-lg border border-gray-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.08)] sm:p-6 print:shadow-none" data-no-print>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <span className="inline-flex rounded border border-orange-200 bg-orange-50 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-orange-600">
              Filters
            </span>
            <span className="text-[11px] font-medium text-slate-400">
              {validPeriods.length > 0 ? `${validPeriods.length} periods` : "All periods"} / {validDsm ? "1 DSM" : `${data.dsms.length} DSMs`}
            </span>
          </div>
          <TeamExpensesFilters
            dsms={data.dsms.map((dsm) => ({ hrId: dsm.hrId, name: dsm.name }))}
            periods={data.periods}
            requestTypes={data.requestTypes}
            selectedDsm={validDsm ?? ""}
            selectedPeriods={validPeriods}
            selectedRequestType={validRequestType ?? ""}
          />
        </Card>

        {/* Dashboard Content */}
        <NsmTeamExpensesDashboard data={data} />
      </div>
    </EmployeePortalPageShell>
  );
}
