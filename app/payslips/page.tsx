import { WalletCards } from "lucide-react";

import { AdminInsightChip, AdminPageHero } from "@/components/admin/admin-design-system";
import { MedicalRepPayrollPage } from "@/components/employee-portal/employee-portal-dashboard-dynamic";
import { EmployeePortalChrome } from "@/components/employee-portal/employee-portal-layout";
import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { AppShell } from "@/components/layout/app-shell";
import { SentryUserIdentity } from "@/components/layout/sentry-user-identity";
import { PageTransition } from "@/components/ui/page-transition";
import { employeeHasActiveDeviceMapping } from "@/lib/attendance/device-user-mapping";
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
          <SentryUserIdentity hrId={access.hrId} role={access.role} />
          <EmployeePortalEmptyState
            message="Your payslips workspace is temporarily unavailable. Please try again in a moment."
            title="Payslips Unavailable"
          />
        </AppShell>
      );
    }

    return (
      <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.10),transparent_30%),linear-gradient(180deg,#F8FAFC_0%,#EEF3F8_100%)] p-4">
        <SentryUserIdentity hrId={access.hrId} role={access.role} />
        <div className="mx-auto w-full max-w-[960px]">
          <EmployeePortalEmptyState
            message="Your payslips workspace is temporarily unavailable. Please try again in a moment."
            title="Payslips Unavailable"
          />
        </div>
      </div>
    );
  }

  const hasDeviceMapping = access.hrId
    ? await employeeHasActiveDeviceMapping(access.hrId).catch(() => false)
    : false;

  const visibility = resolveEmployeePortalNavVisibility(
    data.employee.roleLabel,
    access.role,
    data.employee.line,
    data.employee.department,
    data.employee.hrId,
    hasDeviceMapping,
  );

  if (navigationMode === "admin") {
    return (
      <AppShell navigationMode="admin">
        <SentryUserIdentity hrId={access.hrId} role={access.role} />
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
    <EmployeePortalChrome data={data} visibility={visibility}>
      <SentryUserIdentity hrId={access.hrId} role={access.role} />
      <EmployeePortalPageShell
        description="Review your monthly compensation with clarity and confidence."
        title="My Earnings"
      >
        <MedicalRepPayrollPage data={data} />
      </EmployeePortalPageShell>
    </EmployeePortalChrome>
  );
}
