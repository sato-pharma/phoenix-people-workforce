import {
  EmployeePortalChrome,
} from "@/components/employee-portal/employee-portal-layout";
import { EmployeePortalEmptyState } from "@/components/employee-portal/enterprise-shell";
import { resolveEmployeePortalNavVisibility } from "@/lib/employee-portal/navigation";
import { getEmployeePortalShellData } from "@/lib/employee-portal/service";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { AppShell } from "@/components/layout/app-shell";

export default async function LeaveManagementLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const access = await resolveAccessContextFromPage();

  await assertPermission(access, "employee_profile", "read");

  const navigationMode = resolveNavigationMode(access);

  if (navigationMode === "admin") {
    return <AppShell navigationMode="admin">{children}</AppShell>;
  }

  let data = null;
  try {
    data = await getEmployeePortalShellData(access);
  } catch {
    data = null;
  }

  if (!data) {
    return (
      <EmployeePortalEmptyState
        message="Your command center is temporarily unavailable. Please try again in a moment."
        title="Portal Unavailable"
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
    <EmployeePortalChrome data={data} visibility={visibility}>
      {children}
    </EmployeePortalChrome>
  );
}
