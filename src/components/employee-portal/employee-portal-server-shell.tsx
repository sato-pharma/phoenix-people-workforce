import { redirect } from "next/navigation";

import { EmployeePortalChrome } from "@/components/employee-portal/employee-portal-layout";
import { EmployeePortalEmptyState } from "@/components/employee-portal/enterprise-shell";
import { employeeHasActiveDeviceMapping } from "@/lib/attendance/device-user-mapping";
import { assertPermission, type AccessContext } from "@/lib/auth/permissions";
import { isForbiddenError } from "@/lib/auth/server";
import { resolveEmployeePortalNavVisibility } from "@/lib/employee-portal/navigation";
import { getEmployeePortalShellData } from "@/lib/employee-portal/service";
import { layoutOwnerKey, type PersonalNavigationLayout } from "@/lib/navigation/personal-layout";
import { loadEffectiveLayout } from "@/lib/navigation/personal-layout-store";
import { logPortalFailure } from "@/lib/observability/portal-logging";

type EmployeePortalServerShellProps = {
  access: AccessContext;
  children: React.ReactNode;
  disableSessionGuard?: boolean;
  unavailableMessage?: string;
  unavailableTitle?: string;
};

export async function EmployeePortalServerShell({
  access,
  children,
  disableSessionGuard = false,
  unavailableMessage = "Your command center is temporarily unavailable. Please try again in a moment.",
  unavailableTitle = "Portal Unavailable",
}: EmployeePortalServerShellProps) {
  try {
    await assertPermission(access, "employee_profile", "read");
  } catch (error) {
    if (isForbiddenError(error)) {
      console.warn("[portal-shell] employee_profile:read denied — redirecting to login", {
        role: access.role,
        scope: access.scope,
        source: access.source,
      });
      redirect("/login");
    }
    throw error;
  }

  let data = null;
  let hasDeviceMapping = false;
  // The viewer's saved row arrangement, or the company default when they have saved nothing.
  // Read INSIDE the existing Promise.all rather than after it: every query from here crosses the
  // Atlantic to Frankfurt, and this runs on every portal page render. loadEffectiveLayout resolves
  // both keys in ONE round trip and never rejects — a failed read degrades to "nothing arranged",
  // which is the same thing every account sees today.
  let navLayout: PersonalNavigationLayout | null = null;
  try {
    [data, hasDeviceMapping, navLayout] = await Promise.all([
      getEmployeePortalShellData(access),
      access.hrId ? employeeHasActiveDeviceMapping(access.hrId).catch(() => false) : Promise.resolve(false),
      loadEffectiveLayout(layoutOwnerKey(access)).then((result) => result.layout),
    ]);
  } catch (error) {
    logPortalFailure(
      { route: "/employee-portals", module: "employee-portal-shell", role: access.role, hrId: access.hrId },
      error,
    );
    data = null;
  }

  if (!data) {
    return (
      <EmployeePortalEmptyState
        message={unavailableMessage}
        title={unavailableTitle}
      />
    );
  }

  const visibility = resolveEmployeePortalNavVisibility(
    data.employee.roleLabel,
    access.role,
    data.employee.line,
    data.employee.department,
    data.employee.hrId,
    hasDeviceMapping,
  );

  return (
    <EmployeePortalChrome
      data={data}
      disableSessionGuard={disableSessionGuard}
      personalLayout={navLayout}
      visibility={visibility}
    >
      {children}
    </EmployeePortalChrome>
  );
}
