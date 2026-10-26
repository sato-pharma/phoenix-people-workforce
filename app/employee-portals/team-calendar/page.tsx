import { redirect } from "next/navigation";

import { EmployeePortalEmptyState, EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { ScopeBadge } from "@/components/employee-portal/scope-badge";
import { TeamCalendarView } from "@/components/employee-portal/team-calendar-view";
import { isNationalSalesManager, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getNsmTeamCalendar } from "@/lib/employee-portal/team-calendar";

export const dynamic = "force-dynamic";

function parseMonthYear(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

export default async function TeamCalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; year?: string }>;
}) {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/overview");
  }
  if (!isNationalSalesManager(access.role)) {
    redirect("/employee-portals");
  }

  const params = await searchParams;
  const data = await getNsmTeamCalendar(access, {
    month: parseMonthYear(params.month),
    year: parseMonthYear(params.year),
  });

  if (!data) {
    return (
      <EmployeePortalEmptyState
        message="We couldn't resolve your sales line, so there's no team calendar to show. This view is available to National Sales Managers."
        title="Team Calendar Unavailable"
      />
    );
  }

  return (
    <EmployeePortalPageShell
      badge="Team Performance"
      description="Live field-visit calendar for every rep in your line, with field visits from Phoenix CRM and iReports360. Click a green numeric day to open that day's visits."
      errorBoundaryTitle="Team Calendar unavailable"
      title="Team Calendar"
    >
      <div className="flex flex-wrap items-center gap-2">
        <ScopeBadge scope={access.scope} />
      </div>

      {data.status === "not_ready" ? (
        <EmployeePortalEmptyState
          message={
            data.message ??
            "The iReports360 visits mirror isn't set up yet, so the team calendar has no data to show."
          }
          title="Visits Mirror Not Ready"
        />
      ) : (
        <TeamCalendarView
          employeeCount={data.employeeCount}
          groups={data.groups}
          lineName={data.lineName}
          month={data.month}
          monthLabel={data.monthLabel}
          todayIso={data.todayIso}
          year={data.year}
        />
      )}
    </EmployeePortalPageShell>
  );
}
