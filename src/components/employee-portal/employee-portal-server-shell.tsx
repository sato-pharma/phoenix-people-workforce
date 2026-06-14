import { EmployeePortalChrome } from "@/components/employee-portal/employee-portal-layout";
import { EmployeePortalEmptyState } from "@/components/employee-portal/enterprise-shell";
import { employeeHasActiveDeviceMapping } from "@/lib/attendance/device-user-mapping";
import { assertPermission, type AccessContext } from "@/lib/auth/permissions";
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
  await assertPermission(access, "employee_profile", "read");

  let data = null;
  let hasDeviceMapping = false;
  try {
    [data, hasDeviceMapping] = await Promise.all([
      getEmployeePortalShellData(access),
      access.hrId ? employeeHasActiveDeviceMapping(access.hrId).catch(() => false) : Promise.resolve(false),
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
      visibility={visibility}
    >
      {children}
    </EmployeePortalChrome>
  );
}
