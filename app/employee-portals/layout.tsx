import { redirect } from "next/navigation";

import { EmployeePortalChrome } from "@/components/employee-portal/employee-portal-layout";
import { EmployeePortalEmptyState } from "@/components/employee-portal/enterprise-shell";
import { resolveEmployeePortalNavVisibility } from "@/lib/employee-portal/navigation";
import { getEmployeePortalShellData } from "@/lib/employee-portal/service";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { assertPermission } from "@/lib/auth/permissions";

export default async function EmployeePortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) {
    redirect("/login");
  }
  
  // All authenticated users can access the portal to see their own data
  await assertPermission(access, "employee_profile", "read");

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
