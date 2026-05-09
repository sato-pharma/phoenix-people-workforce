import { EmployeePortalTopNav, EmployeePortalSidebar } from "@/components/employee-portal/employee-portal-layout";
import { IdentityCard } from "@/components/employee-portal/employee-portal-dashboard";
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
      <div className="min-h-screen bg-[#f7f8fb] p-4">
        <div className="mx-auto w-full max-w-[1200px]">
          <div className="rounded-3xl border border-slate-200 bg-white p-8 text-center shadow-sm">
            <p className="text-lg font-semibold text-slate-900">Portal Unavailable</p>
            <p className="mt-2 text-sm text-slate-600">Your command center is temporarily unavailable. Please try again in a moment.</p>
          </div>
        </div>
      </div>
    );
  }

  const MANAGEMENT_ROLES = ["district sales manager", "national sales manager", "product manager", "training manager"];
  const roleLabel = String(data.employee.roleLabel ?? "").trim();
  const roleNormalized = roleLabel.toLowerCase();
  const showManagementTab = MANAGEMENT_ROLES.includes(roleNormalized);
  const showTeamPerformanceTab =
    roleNormalized.includes("district manager") ||
    roleNormalized.includes("district sales manager") ||
    roleNormalized.includes("dsm");
  const showMedRepsPerformanceTab = roleNormalized.includes("national sales manager");
  const showDsmsPerformanceTab = roleNormalized.includes("national sales manager");
  const showVacanciesTab = showTeamPerformanceTab || showMedRepsPerformanceTab;

  return (
    <div className="min-h-screen bg-[#f6f7fb]">
      <EmployeePortalTopNav
        data={data}
        showManagementTab={showManagementTab}
        showTeamPerformanceTab={showTeamPerformanceTab}
        showMedRepsPerformanceTab={showMedRepsPerformanceTab}
        showDsmsPerformanceTab={showDsmsPerformanceTab}
        showVacanciesTab={showVacanciesTab}
      />
      <div className="mx-auto flex w-full max-w-[1600px] gap-6 px-4 py-6 lg:gap-8 lg:px-8 lg:py-8">
        <EmployeePortalSidebar
          showManagementTab={showManagementTab}
          showTeamPerformanceTab={showTeamPerformanceTab}
          showMedRepsPerformanceTab={showMedRepsPerformanceTab}
          showDsmsPerformanceTab={showDsmsPerformanceTab}
          showVacanciesTab={showVacanciesTab}
        />
        <main className="min-w-0 flex-1 space-y-6 lg:space-y-8">
          <IdentityCard data={data} />
          <PageTransition>{children}</PageTransition>
        </main>
      </div>
    </div>
  );
}
