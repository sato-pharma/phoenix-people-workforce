import { AppShell } from "@/components/layout/app-shell";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { ExpensesDashboard } from "@/components/payroll/expenses-dashboard";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import {
  listPayrollExpenseReports,
  listPayrollExpenses,
} from "@/lib/payroll/expenses";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { redirect } from "next/navigation";
import type {
  EmployeeDirectoryRow,
} from "@/lib/employees/employee-directory";
import type {
  PayrollExpenseApproval,
  PayrollExpenseReport,
} from "@/lib/payroll/types";

export const dynamic = "force-dynamic";

export default async function PayrollExpensesDashboardPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals/expenses");
  }
  let expenses: PayrollExpenseApproval[] = [];
  let employees: EmployeeDirectoryRow[] = [];
  let reports: PayrollExpenseReport[] = [];
  let error: string | null = null;

  try {
    await assertPermission(access, "expenses", "read");
    const directory = await getEmployeeDirectory({ pageSize: -1 });
    employees = directory.employees;
    reports = await listPayrollExpenseReports(access);
    expenses = await listPayrollExpenses(undefined, undefined, undefined, access);
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load expenses dashboard.";
  }

  return (
    <AppShell navigationMode="admin">
      <ExpensesDashboard
        initialError={error}
        initialEmployees={employees}
        initialExpenses={expenses}
        initialReports={reports}
      />
    </AppShell>
  );
}
