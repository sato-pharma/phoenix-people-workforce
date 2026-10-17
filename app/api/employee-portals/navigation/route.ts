import { NextResponse } from "next/server";

import { employeeHasActiveDeviceMapping } from "@/lib/attendance/device-user-mapping";
import { resolveModuleLocksForAccess } from "@/lib/auth/module-locks";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { buildNativePortalModuleDirectory } from "@/lib/employee-portal/native-module-directory";
import { resolveEmployeePortalNavVisibility } from "@/lib/employee-portal/navigation";
import { getEmployeePortalShellData } from "@/lib/employee-portal/service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { logPortalFailure } from "@/lib/observability/portal-logging";
import { NO_PHOENIX_CRM_ENTRIES, phoenixCrmSidebarEntries } from "@/lib/phoenix-crm/server/sidebar-entries";
import { hasInterviewCalendarAccess } from "@/lib/recruitment/interview-calendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Which portal modules this viewer has — the app's counterpart of the web sidebar.
 *
 * Deliberately NO business logic and no second access model. It resolves visibility with the exact
 * call `EmployeePortalServerShell` makes, with the same eight inputs in the same order, and hands the
 * result to `buildNativePortalModuleDirectory`, which reads the one registry the web bottom nav reads.
 * So the phone lists what the browser lists, for the same person, on the same day.
 *
 * The four side reads mirror the shell's own `Promise.all`, each failing CLOSED to "no" rather than
 * taking the whole list away: a CRM outage should cost one row, never the app's navigation. The
 * module-lock read fails open to "nothing locked", which is what the shell does for the same reason.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "employee_profile", "read");

    const locksPromise = resolveModuleLocksForAccess(access).catch(() => []);

    const [data, hasDeviceMapping, sharedInterviewCalendar, phoenixCrm] = await Promise.all([
      getEmployeePortalShellData(access),
      access.hrId ? employeeHasActiveDeviceMapping(access.hrId).catch(() => false) : Promise.resolve(false),
      access.hrId ? hasInterviewCalendarAccess(access).catch(() => false) : Promise.resolve(false),
      access.hrId ? phoenixCrmSidebarEntries(access).catch(() => NO_PHOENIX_CRM_ENTRIES) : Promise.resolve(NO_PHOENIX_CRM_ENTRIES),
    ]);

    if (!data) {
      return NextResponse.json(
        { error: "portal_shell_unavailable", message: "Your modules are temporarily unavailable." },
        { status: 503 },
      );
    }

    const visibility = resolveEmployeePortalNavVisibility(
      data.employee.roleLabel,
      access.role,
      data.employee.line,
      data.employee.department,
      data.employee.hrId,
      hasDeviceMapping,
      sharedInterviewCalendar,
      phoenixCrm.crm,
      phoenixCrm.forecast,
      phoenixCrm.placeChecks,
      phoenixCrm.doubleVisitRequests,
      phoenixCrm.managerPlans,
    );

    const activeLocks = await locksPromise;

    return NextResponse.json({
      data: {
        sections: buildNativePortalModuleDirectory({
          lockedModuleKeys: Array.from(new Set(activeLocks.map((lock) => lock.moduleKey))),
          visibility,
        }),
      },
      success: true,
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    logPortalFailure(
      { route: "/api/employee-portals/navigation", module: "native-module-directory" },
      error,
    );
    const message = clientSafeErrorMessage(error, "Unable to load your modules.");
    return NextResponse.json({ error: "portal_navigation_failed", message }, { status: 500 });
  }
}
