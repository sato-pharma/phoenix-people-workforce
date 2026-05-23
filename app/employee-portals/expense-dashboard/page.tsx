import { redirect } from "next/navigation";

import { DynamicPersonalExpenseWorkloadDashboard as PersonalExpenseWorkloadDashboard } from "@/components/charts/dynamic-charts";
import {
  assertPermission,
  resolveNavigationMode,
} from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
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
  try {
    data = await getMedicalRepPortalData(access);
  } catch {
    data = null;
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
        message="No expense records are linked to your profile yet."
        title="No expense records"
      />
    );
  }

  return (
    <EmployeePortalPageShell
      badge="Expenses"
      description="Review workload, trip volume, and expense movement using the same employee portal workspace design."
      title="Workload & Expense"
    >
      <PersonalExpenseWorkloadDashboard
        data={data}
        showHero={false}
      />
    </EmployeePortalPageShell>
  );
}
