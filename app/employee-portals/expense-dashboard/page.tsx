import { redirect } from "next/navigation";

import { PersonalExpenseWorkloadDashboard } from "@/components/employee-portal/personal-expense-workload-dashboard";
import {
  assertPermission,
  resolveNavigationMode,
  isMedicalRep,
} from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { getMedicalRepPortalData } from "@/lib/employee-portal/service";
import { EmployeePortalEmptyState, EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";

export const dynamic = "force-dynamic";


export default async function EmployeePortalExpenseDashboardPage() {
  const access = await resolveAccessContextFromPage();
  // A session that expired between the layout's own auth check and this page's client-side
  // navigation resolves to the guest fallback (role "Employee", hrId null) — without this,
  // assertPermission below throws a misleading "Forbidden: Employee cannot read expenses"
  // instead of sending the user back to sign in.
  if (!access.loginId && !access.hrId) {
    redirect("/login");
  }
  if (canonicalHrIdKey(access.hrId) === "a-3") {
    redirect("/employee-portals");
  }
  const isProductMarketingRole =
    access.role === "Product Manager" ||
    access.role === "Group Product Manager" ||
    access.role === "Marketing Manager";
  if (resolveNavigationMode(access) !== "employee-portal" && !isProductMarketingRole) {
    redirect("/payroll");
  }
  if (isMedicalRep(access.role)) {
    redirect("/employee-portals/expenses");
  }
  await assertPermission(access, "expenses", "read");

  let data = null;
  try {
    data = await getMedicalRepPortalData(access, {
      includePortalOverview: false,
      includeTeamRank: false,
      includeWorkforceSummary: false,
    });
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
        message="No visible outstation expense records are available for your expense scope yet."
        title="No outstation expense records"
      />
    );
  }

  return (
    <EmployeePortalPageShell
      badge="Expenses"
      description="Review workload, trip volume, and outstation expense movement using the same employee portal workspace design."
      errorBoundaryTitle="Expense Dashboard unavailable"
      title="Expense Dashboard"
    >
      <PersonalExpenseWorkloadDashboard
        adminKeyCards={null}
        data={{ workload: data.workload }}
        showHero={false}
      />
    </EmployeePortalPageShell>
  );
}
