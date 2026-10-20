import { redirect } from "next/navigation";

import { PrivateCalendar } from "@/components/employee-portal/private-calendar";
import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { currentCairoDateOnlyIso, currentCairoDateParts } from "@/lib/i18n/format";
import { logPortalFailure } from "@/lib/observability/portal-logging";
import { getPrivateCalendarWorkspace } from "@/lib/private-calendar/service";

export const dynamic = "force-dynamic";

export default async function EmployeePrivateCalendarPage() {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) {
    redirect("/login");
  }
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/overview");
  }

  const now = new Date();
  const { year, month } = currentCairoDateParts(now);
  let workspace = null;
  try {
    workspace = await getPrivateCalendarWorkspace({
      access,
      actualOnly: true,
      month,
      year,
    });
  } catch (error) {
    logPortalFailure(
      { route: "/employee-portals/private-calendar", module: "private_calendar", role: access.role, hrId: access.hrId },
      error,
    );
    workspace = null;
  }

  return (
    <EmployeePortalPageShell
      badge="Private Calendar"
      description="The actual activity the system recognized for you this month — attendance punches, approved vacations, approved excuses, CRM visits (single, double and chain) and national holidays. A day slot shows only what was recorded; the plan reads in the day's detail below, against the actual."
      title="Private Calendar"
    >
      {workspace ? (
        <PrivateCalendar initialWorkspace={workspace} todayIso={currentCairoDateOnlyIso(now)} viewerHrId={access.hrId} />
      ) : (
        <EmployeePortalEmptyState
          message="We could not load the private calendar right now. Please refresh in a moment."
          title="Private Calendar Unavailable"
        />
      )}
    </EmployeePortalPageShell>
  );
}
