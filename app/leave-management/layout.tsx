import {
  EmployeePortalTopNav,
  EmployeePortalSidebar,
} from "@/components/employee-portal/employee-portal-layout";
import { IdentityCard } from "@/components/employee-portal/identity-card";
import { EmployeePortalEmptyState } from "@/components/employee-portal/enterprise-shell";
import { resolveEmployeePortalNavVisibility } from "@/lib/employee-portal/navigation";
import { getEmployeePortalShellData } from "@/lib/employee-portal/service";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { PageTransition } from "@/components/ui/page-transition";
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

  const visibility = resolveEmployeePortalNavVisibility(data.employee.roleLabel);

  return (
    <div className="relative min-h-screen overflow-hidden bg-[linear-gradient(180deg,#f8fafc_0%,#eef4f8_46%,#f8fafc_100%)]">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-sky-500 via-orange-500 to-emerald-500" />
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(15,23,42,0.035)_1px,transparent_1px),linear-gradient(90deg,rgba(15,23,42,0.035)_1px,transparent_1px)] bg-[size:48px_48px] [mask-image:linear-gradient(180deg,rgba(0,0,0,0.78),transparent_64%)]" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[520px] bg-[linear-gradient(180deg,rgba(255,255,255,0.92),rgba(255,255,255,0)_70%)]" />
      <EmployeePortalTopNav data={data} visibility={visibility} />
      <div className="relative mx-auto flex w-full max-w-[1560px] gap-6 px-4 py-6 lg:gap-8 lg:px-8 lg:py-8">
        <EmployeePortalSidebar visibility={visibility} />
        <main className="min-w-0 flex-1 space-y-6 lg:space-y-8">
          <IdentityCard data={data} />
          <PageTransition>{children}</PageTransition>
        </main>
      </div>
    </div>
  );
}
