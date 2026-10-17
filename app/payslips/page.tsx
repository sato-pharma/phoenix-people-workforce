import { WalletCards } from "lucide-react";

import { AdminInsightChip, AdminPageHero } from "@/components/admin/admin-design-system";
import { MedicalRepPayrollPage } from "@/components/employee-portal/employee-portal-dashboard-dynamic";
import { EmployeePortalChrome } from "@/components/employee-portal/employee-portal-layout";
import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { AppShell } from "@/components/layout/app-shell";
import { PageTransition } from "@/components/ui/page-transition";
import { employeeHasActiveDeviceMapping } from "@/lib/attendance/device-user-mapping";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { resolveEmployeePortalNavVisibility } from "@/lib/employee-portal/navigation";
import { getPayslipPortalData } from "@/lib/employee-portal/service";
import { NO_PHOENIX_CRM_ENTRIES, phoenixCrmSidebarEntries } from "@/lib/phoenix-crm/server/page";

export const dynamic = "force-dynamic";

export default async function PayslipsPage() {
  const access = await resolveAuthenticatedPageAccess();
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

  const [hasDeviceMapping, phoenixCrm] = access.hrId
    ? await Promise.all([
        employeeHasActiveDeviceMapping(access.hrId).catch(() => false),
        // The same gate the portal shell asks. This page builds its own chrome, so a flag left out
        // here is a sidebar row that disappears the moment the rep opens his payslips.
        phoenixCrmSidebarEntries(access).catch(() => NO_PHOENIX_CRM_ENTRIES),
      ])
    : ([false, NO_PHOENIX_CRM_ENTRIES] as const);

  const visibility = resolveEmployeePortalNavVisibility(
    data.employee.roleLabel,
    access.role,
    data.employee.line,
    data.employee.department,
    data.employee.hrId,
    hasDeviceMapping,
    // The interview-calendar share is not read on this page and never has been, so its row is absent
    // from the payslips rail. Left as it stands — passed explicitly only because the CRM flag sits
    // behind it in the argument list.
    false,
    phoenixCrm.crm,
    phoenixCrm.forecast,
    phoenixCrm.placeChecks,
    phoenixCrm.doubleVisitRequests,
    phoenixCrm.managerPlans,
  );

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
    <EmployeePortalChrome data={data} visibility={visibility}>
      {/* Same name, badge and look as /employee-portals/payslips, which a rep reaches from the
          sidebar — a payslip notification lands here instead, and must not open a different page. */}
      <EmployeePortalPageShell
        badge="Pay & Expenses"
        description="Your salary breakdown and every published payslip, month by month."
        title="Payslips"
      >
        <MedicalRepPayrollPage data={data} surface="employee-portal" />
      </EmployeePortalPageShell>
    </EmployeePortalChrome>
  );
}
