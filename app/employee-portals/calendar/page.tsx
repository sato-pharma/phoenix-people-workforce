import { redirect } from "next/navigation";

import { CompanyCalendar } from "@/components/employee-portal/company-calendar";
import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getCompanyCalendarWorkspace } from "@/lib/calendar/service";
import { logPortalFailure } from "@/lib/observability/portal-logging";

export const dynamic = "force-dynamic";

export default async function EmployeePortalCalendarPage() {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) {
    redirect("/login");
  }
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/overview");
  }

  const now = new Date();
  let workspace = null;
  try {
    workspace = await getCompanyCalendarWorkspace(access, now.getUTCFullYear(), now.getUTCMonth() + 1);
  } catch (error) {
    logPortalFailure(
      { route: "/employee-portals/calendar", module: "calendar", role: access.role, hrId: access.hrId },
      error,
    );
    workspace = null;
  }

  return (
    <EmployeePortalPageShell
      badge="Calendar"
      description="Company and team events, public holidays, your approved leave, plan days, and team birthdays — all in one place."
      title="Company Calendar"
    >
      {workspace ? (
        <CompanyCalendar initialWorkspace={workspace} />
      ) : (
        <EmployeePortalEmptyState
          message="We could not load the calendar right now. Please refresh in a moment."
          title="Calendar Unavailable"
        />
      )}
    </EmployeePortalPageShell>
  );
}
