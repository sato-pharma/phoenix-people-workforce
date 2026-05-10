import { AppShell } from "@/components/layout/app-shell";
import { PayrollDashboard } from "@/components/payroll/payroll-dashboard";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { assertPermission } from "@/lib/auth/permissions";
import { getPayrollDashboard } from "@/lib/payroll/service";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { redirect } from "next/navigation";

export default async function PayrollExpensesPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals/expenses");
  }
  let data = null;
  let error: string | null = null;

  try {
    await assertPermission(access, "expenses", "read");
    data = await getPayrollDashboard(undefined, access);
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load payroll data.";
  }

  return (
    <AppShell navigationMode="admin">
      <PayrollDashboard
        initialData={data}
        initialError={error}
        initialSheetTab="expenses"
      />
    </AppShell>
  );
}
