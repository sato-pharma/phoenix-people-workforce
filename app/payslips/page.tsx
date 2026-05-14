import { redirect } from "next/navigation";

import { MedicalRepPayrollPage } from "@/components/employee-portal/employee-portal-dashboard-dynamic";
import {
  EmployeePortalSidebar,
  EmployeePortalTopNav,
} from "@/components/employee-portal/employee-portal-layout";
import { IdentityCard } from "@/components/employee-portal/identity-card";
import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { PageTransition } from "@/components/ui/page-transition";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { resolveEmployeePortalNavVisibility } from "@/lib/employee-portal/navigation";
import { getMedicalRepPortalData } from "@/lib/employee-portal/service";

export const dynamic = "force-dynamic";

export default async function PayslipsPage() {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/payroll");
  }

  await assertPermission(access, "payslips", "read");

  let data = null;
  try {
    data = await getMedicalRepPortalData(access);
  } catch {
    data = null;
  }

  if (!data) {
    return (
      <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.10),transparent_30%),linear-gradient(180deg,#F8FAFC_0%,#EEF3F8_100%)] p-4">
        <div className="mx-auto w-full max-w-[960px]">
          <EmployeePortalEmptyState
            message="Your payslips workspace is temporarily unavailable. Please try again in a moment."
            title="Payslips Unavailable"
          />
        </div>
      </div>
    );
  }

  const visibility = resolveEmployeePortalNavVisibility(data.employee.roleLabel);

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.10),transparent_30%),linear-gradient(180deg,#F8FAFC_0%,#EEF3F8_100%)]">
      <EmployeePortalTopNav data={data} visibility={visibility} />
      <div className="mx-auto flex w-full max-w-[1560px] gap-6 px-4 py-6 lg:gap-8 lg:px-8 lg:py-8">
        <EmployeePortalSidebar visibility={visibility} />
        <main className="min-w-0 flex-1 space-y-6 lg:space-y-8">
          <IdentityCard data={data} />
          <PageTransition>
            <EmployeePortalPageShell
              description="Review your monthly compensation with clarity and confidence."
              title="My Earnings"
            >
              <MedicalRepPayrollPage data={data} />
            </EmployeePortalPageShell>
          </PageTransition>
        </main>
      </div>
    </div>
  );
}
