import { EmployeePortalServerShell } from "@/components/employee-portal/employee-portal-server-shell";
import { isForbiddenError, resolveAccessContextFromPage } from "@/lib/auth/server";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { AppShell } from "@/components/layout/app-shell";
import { redirect } from "next/navigation";

export default async function LeaveManagementLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const access = await resolveAccessContextFromPage();

  if (!access.loginId && !access.hrId) {
    redirect("/login");
  }

  try {
    await assertPermission(access, "employee_profile", "read");
  } catch (error) {
    if (isForbiddenError(error)) {
      console.warn("[leave-mgmt] employee_profile:read denied — redirecting to login", {
        role: access.role,
        scope: access.scope,
        source: access.source,
      });
      redirect("/login");
    }
    throw error;
  }

  const navigationMode = resolveNavigationMode(access);

  if (navigationMode === "admin") {
    return <AppShell navigationMode="admin">{children}</AppShell>;
  }

  return (
    <EmployeePortalServerShell access={access}>
      {children}
    </EmployeePortalServerShell>
  );
}
