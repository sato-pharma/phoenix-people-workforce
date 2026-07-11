import { redirect } from "next/navigation";

import { EmployeePortalChrome } from "@/components/employee-portal/employee-portal-layout";
import { EmployeePortalEmptyState } from "@/components/employee-portal/enterprise-shell";
import { employeeHasActiveDeviceMapping } from "@/lib/attendance/device-user-mapping";
import { getEffectiveSidebarModuleIds } from "@/lib/admin/modules-control";
import { assertPermission, type AccessContext } from "@/lib/auth/permissions";
import { isForbiddenError } from "@/lib/auth/server";
import { resolveEmployeePortalNavVisibility } from "@/lib/employee-portal/navigation";
import { getEmployeePortalShellData } from "@/lib/employee-portal/service";
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
  let effectiveModuleIds: string[] | null = null;
  try {
    [data, hasDeviceMapping, effectiveModuleIds] = await Promise.all([
      getEmployeePortalShellData(access),
      access.hrId ? employeeHasActiveDeviceMapping(access.hrId).catch(() => false) : Promise.resolve(false),
      getEffectiveSidebarModuleIds(access, "employee-portal").catch(() => null),
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
      effectiveModuleIds={effectiveModuleIds}
      visibility={visibility}
    >
      {children}
    </EmployeePortalChrome>
  );
}
