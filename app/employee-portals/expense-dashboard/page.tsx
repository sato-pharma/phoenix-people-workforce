import { redirect } from "next/navigation";

import { PersonalExpenseWorkloadDashboard } from "@/components/employee-portal/personal-expense-workload-dashboard";
import {
  assertPermission,
  resolveNavigationMode,
} from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getAdminCommandCenterData } from "@/lib/admin/command-center";
import { getMedicalRepPortalData } from "@/lib/employee-portal/service";
import { EmployeePortalEmptyState, EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";

export const dynamic = "force-dynamic";


export default async function EmployeePortalExpenseDashboardPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/payroll");
  }
  if (access.role === "Medical Rep") {
    redirect("/employee-portals/expenses");
  }
  await assertPermission(access, "expenses", "read");

  let data = null;
  let adminCommandData = null;
  try {
    [data, adminCommandData] = await Promise.all([
      getMedicalRepPortalData(access),
      getAdminCommandCenterData(access).catch(() => null),
    ]);
  } catch {
    data = null;
    adminCommandData = null;
  }

  if (!data || data.empty.profile) {
    return (
      <EmployeePortalEmptyState
        message="Your employee profile is not linked yet. Please contact HR."
        title="Profile Not Linked"
      />
    );
  }

  if (!data.workload?.expenseRows?.length) {
    return (
      <EmployeePortalEmptyState
        message="No outstation expense records are linked to your profile yet."
        title="No outstation expense records"
      />
    );
  }

  return (
    <EmployeePortalPageShell
      badge="Expenses"
      description="Review workload, trip volume, and outstation expense movement using the same employee portal workspace design."
      title="Expense Dashboard"
    >
      <PersonalExpenseWorkloadDashboard
        adminKeyCards={adminCommandData ? {
          expenseClaimsAmount: adminCommandData.overview.expenses.approvedAmount,
          expenseClaimsEntries: adminCommandData.overview.expenses.totalRows,
          payrollBatchLabel: adminCommandData.overview.payroll.batchLabel,
          payrollEligibleCount: adminCommandData.payrollEligibleCount,
          totalSalesTarget: adminCommandData.overview.sales.targetValue,
          totalSalesValue: adminCommandData.overview.sales.salesValue,
        } : null}
        data={data}
        showHero={false}
      />
    </EmployeePortalPageShell>
  );
}
