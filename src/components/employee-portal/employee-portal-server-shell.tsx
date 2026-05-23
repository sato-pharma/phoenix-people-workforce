import { EmployeePortalChrome } from "@/components/employee-portal/employee-portal-layout";
import { EmployeePortalEmptyState } from "@/components/employee-portal/enterprise-shell";
import { assertPermission, type AccessContext } from "@/lib/auth/permissions";
import { reportEmployeePortalFailure } from "@/lib/employee-portal/failure-reporting";
import { resolveEmployeePortalNavVisibility } from "@/lib/employee-portal/navigation";
import { getEmployeePortalShellData } from "@/lib/employee-portal/service";

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
  let supportReference: string | null = null;
  try {
    data = await getEmployeePortalShellData(access);
  } catch (error) {
    supportReference = await reportEmployeePortalFailure("shell-data", error);
    data = null;
  }

  if (!data) {
    return (
      <EmployeePortalEmptyState
        message={unavailableMessage}
        supportReference={supportReference}
        title={unavailableTitle}
      />
    );
  }

  const visibility = resolveEmployeePortalNavVisibility(
    data.employee.roleLabel,
    access.role,
    data.employee.line,
    data.employee.department,
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
