import { AppShell } from "@/components/layout/app-shell";
import { ExpensesDashboard } from "@/components/payroll/expenses-dashboard";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { getPayrollExpenseDashboardData } from "@/lib/payroll/expenses";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { redirect } from "next/navigation";
import type { PayrollExpenseDashboardData } from "@/lib/payroll/expenses";

export const dynamic = "force-dynamic";

export default async function PayrollExpensesDashboardPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals/expenses");
  }
  let dashboardData: PayrollExpenseDashboardData | null = null;
  let error: string | null = null;

  try {
    await assertPermission(access, "expenses", "read");
    dashboardData = await getPayrollExpenseDashboardData(access);
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load expenses dashboard.";
  }

  return (
    <AppShell navigationMode="admin">
      <ExpensesDashboard
        initialError={error}
        initialEmployees={dashboardData?.employees ?? []}
        initialExpenses={dashboardData?.expenses ?? []}
        initialMetrics={dashboardData?.metrics ?? null}
        initialReports={dashboardData?.reports ?? []}
      />
    </AppShell>
  );
}
