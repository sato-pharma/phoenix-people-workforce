import { PayrollDashboard } from "@/components/payroll/payroll-dashboard-dynamic";
import { canAccessSystemAdministratorWorkspace } from "@/lib/auth/permissions";
import { getPayrollDashboard } from "@/lib/payroll/service";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { redirect } from "next/navigation";

export default async function PayrollExpensesPage() {
  const access = await resolveAccessContextFromPage();
  if (!canAccessSystemAdministratorWorkspace(access)) {
    redirect("/admin/access");
  }
  let data = null;
  let error: string | null = null;

  try {
    data = await getPayrollDashboard(undefined, access);
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load payroll data.";
  }

  return (
    <PayrollDashboard
      initialData={data}
      initialError={error}
      initialSheetTab="expenses"
    />
  );
}
