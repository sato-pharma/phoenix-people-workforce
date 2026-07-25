import { redirect } from "next/navigation";

import { PlanningCalendar } from "@/components/employee-portal/planning-calendar";
import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { currentCairoDateParts } from "@/lib/i18n/format";
import { logPortalFailure } from "@/lib/observability/portal-logging";
import { getSharedPlanningCalendarWorkspace } from "@/lib/weekly-planning/calendar-service";

export const dynamic = "force-dynamic";

export default async function EmployeePlanningCalendarPage() {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) {
    redirect("/login");
  }
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/overview");
  }
  if (!await canAccess(access, "weekly_plans", "read")) {
    return (
      <EmployeePortalEmptyState
        message="Your position is not enabled for weekly/monthly planning."
        title="Planning Calendar Unavailable"
      />
    );
  }

  const { year, month } = currentCairoDateParts();
  let workspace = null;
  try {
    workspace = await getSharedPlanningCalendarWorkspace(access, year, month);
  } catch (error) {
    logPortalFailure(
      { route: "/employee-portals/plans/calendar", module: "weekly_plans", role: access.role, hrId: access.hrId },
      error,
    );
  }

  return (
    <EmployeePortalPageShell
      badge="Planning Calendar"
      description="Submitted plan activity, national vacations, and same-line Medical Rep warnings in one shared calendar."
      title="Planning Calendar"
    >
      {workspace ? (
        <PlanningCalendar initialWorkspace={workspace} />
      ) : (
        <EmployeePortalEmptyState
          message="We could not load the planning calendar right now. Please refresh in a moment."
          title="Planning Calendar Unavailable"
        />
      )}
    </EmployeePortalPageShell>
  );
}
