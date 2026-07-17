import { ExpensesDashboard } from "@/components/outstation/expenses-dashboard";
import { canAccessSystemAdministratorWorkspace } from "@/lib/auth/permissions";
import { getPayrollExpenseDashboardData } from "@/lib/outstation/expenses";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { redirect } from "next/navigation";
import type { PayrollExpenseDashboardData } from "@/lib/outstation/expenses";

export const dynamic = "force-dynamic";

export default async function PayrollExpensesDashboardPage() {
  const access = await resolveAccessContextFromPage();
  if (!canAccessSystemAdministratorWorkspace(access)) {
    redirect("/admin/access");
  }
  let dashboardData: PayrollExpenseDashboardData | null = null;
  let error: string | null = null;

  try {
    dashboardData = await getPayrollExpenseDashboardData(access);
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load expenses dashboard.";
  }

  return (
    <ExpensesDashboard
      initialError={error}
      initialEmployees={dashboardData?.employees ?? []}
      initialExpenses={dashboardData?.expenses ?? []}
      initialMetrics={dashboardData?.metrics ?? null}
      initialReports={dashboardData?.reports ?? []}
    />
  );
}
