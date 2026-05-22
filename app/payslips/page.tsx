import { WalletCards } from "lucide-react";

import { AdminInsightChip, AdminPageHero } from "@/components/admin/admin-design-system";
import { MedicalRepPayrollPage } from "@/components/employee-portal/employee-portal-dashboard-dynamic";
import {
  EmployeePortalSidebar,
  EmployeePortalTopNav,
} from "@/components/employee-portal/employee-portal-layout";
import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { AppShell } from "@/components/layout/app-shell";
import { PageTransition } from "@/components/ui/page-transition";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { resolveEmployeePortalNavVisibility } from "@/lib/employee-portal/navigation";
import { getPayslipPortalData } from "@/lib/employee-portal/service";

export const dynamic = "force-dynamic";

export default async function PayslipsPage() {
  const access = await resolveAccessContextFromPage();
  const navigationMode = resolveNavigationMode(access);

  await assertPermission(access, "payslips", "read");

  let data = null;
  try {
    data = await getPayslipPortalData(access);
  } catch {
    data = null;
  }

  if (!data) {
    if (navigationMode === "admin") {
      return (
        <AppShell navigationMode="admin">
          <EmployeePortalEmptyState
            message="Your payslips workspace is temporarily unavailable. Please try again in a moment."
            title="Payslips Unavailable"
          />
        </AppShell>
      );
    }

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

  const visibility = resolveEmployeePortalNavVisibility(data.employee.roleLabel, access.role);

  if (navigationMode === "admin") {
    return (
      <AppShell navigationMode="admin">
        <div className="space-y-6">
          <AdminPageHero
            badges={
              <div className="flex flex-wrap gap-2">
                <AdminInsightChip>Personal payslips</AdminInsightChip>
                <AdminInsightChip tone="orange">Self scope</AdminInsightChip>
              </div>
            }
            description="Review your own monthly compensation records without opening company payroll operations."
            eyebrow="Payroll"
            icon={<WalletCards className="h-3.5 w-3.5" />}
            title="My Payslips"
          />
          <PageTransition>
            <MedicalRepPayrollPage data={data} />
          </PageTransition>
        </div>
      </AppShell>
    );
  }

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-[linear-gradient(160deg,#f4f8fc_0%,#f8fafc_28%,#fdf8f5_58%,#f6faf8_82%,#f8fafc_100%)] pt-[64px] lg:pt-[72px]">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-sky-500 via-orange-500 to-emerald-500" />
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(15,23,42,0.028)_1px,transparent_1px),linear-gradient(90deg,rgba(15,23,42,0.028)_1px,transparent_1px)] bg-[size:52px_52px] [mask-image:linear-gradient(180deg,rgba(0,0,0,0.65),transparent_56%)]" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[480px] bg-[linear-gradient(180deg,rgba(255,255,255,0.88),rgba(255,255,255,0)_70%)]" />
      <EmployeePortalTopNav data={data} visibility={visibility} />
      <div className="relative mx-auto flex w-full max-w-[1560px] gap-6 px-4 py-6 lg:gap-8 lg:px-8 lg:py-8">
        <EmployeePortalSidebar visibility={visibility} />
        <main className="min-w-0 flex-1 space-y-6 lg:space-y-8">
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
