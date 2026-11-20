import { redirect } from "next/navigation";

import { NsmTeamExpensesDashboard } from "@/components/employee-portal/nsm-team-expenses-dashboard";
import { TeamExpensesFilters } from "@/components/employee-portal/team-expenses-filters";
import {
  EmployeePortalPageShell,
  EmployeePortalEmptyState,
} from "@/components/employee-portal/enterprise-shell";
import { LandingPanel } from "@/components/employee-portal/landing-kit";
import { ScopeBadge } from "@/components/employee-portal/scope-badge";
import { assertPermission, isNationalSalesManager, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
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
  const access = await resolveAuthenticatedPageAccess();

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
        className="max-w-full min-w-0 space-y-5 overflow-x-hidden text-slate-900 sm:space-y-6"
        dir="auto"
      >
        {/* Filters — the landing panel, its scope count in the header; never printed. */}
        <div data-no-print>
          <LandingPanel
            bodyClassName="px-3 py-3 sm:px-4 sm:py-4"
            right={
              <span className="text-phx-xs font-bold uppercase tracking-[0.08em] tabular-nums text-slate-500">
                {validPeriods.length > 0 ? `${validPeriods.length} periods` : "All periods"} / {validDsm ? "1 DSM" : `${data.dsms.length} DSMs`}
              </span>
            }
            title="Filters"
          >
            <TeamExpensesFilters
              dsms={data.dsms.map((dsm) => ({ hrId: dsm.hrId, name: dsm.name }))}
              periods={data.periods}
              requestTypes={data.requestTypes}
              selectedDsm={validDsm ?? ""}
              selectedPeriods={validPeriods}
              selectedRequestType={validRequestType ?? ""}
            />
          </LandingPanel>
        </div>

        {/* Dashboard Content */}
        <NsmTeamExpensesDashboard data={data} />
      </div>
    </EmployeePortalPageShell>
  );
}
