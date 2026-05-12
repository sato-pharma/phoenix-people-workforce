import {
  EmployeePortalTopNav,
  EmployeePortalSidebar,
} from "@/components/employee-portal/employee-portal-layout";
import { IdentityCard } from "@/components/employee-portal/employee-portal-dashboard";
import { EmployeePortalEmptyState } from "@/components/employee-portal/enterprise-shell";
import { resolveEmployeePortalNavVisibility } from "@/lib/employee-portal/navigation";
import { getMedicalRepPortalData } from "@/lib/employee-portal/service";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { assertPermission } from "@/lib/auth/permissions";
import { PageTransition } from "@/components/ui/page-transition";

export default async function EmployeePortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const access = await resolveAccessContextFromPage();
  
  // All authenticated users can access the portal to see their own data
  await assertPermission(access, "employee_profile", "read");

  let data = null;
  try {
    data = await getMedicalRepPortalData(access);
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
    <div className="relative min-h-screen bg-[#f8fafc]">
      {/* Subtle top accent line */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-orange-400 via-orange-500 to-orange-400" />
      {/* Ambient background texture */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[480px] bg-[radial-gradient(ellipse_70%_35%_at_50%_0%,rgba(249,115,22,0.04),transparent)]" />
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
