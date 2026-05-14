import { PayrollDashboard } from "@/components/payroll/payroll-dashboard-dynamic";
import { AppShell } from "@/components/layout/app-shell";
import { assertPermission, getPayrollScope } from "@/lib/auth/permissions";
import { getPayrollDashboard } from "@/lib/payroll/service";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { redirect } from "next/navigation";

export default async function PayrollPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const sp = await searchParams;
  const access = await resolveAccessContextFromPage();
  const scope = getPayrollScope(access);
  if (scope !== "COMPANY") {
    redirect("/payslips");
  }
  await assertPermission(access, "payroll", "read");
  let data = null;
  let error: string | null = null;

  try {
    data = await getPayrollDashboard(sp.batchId, access);
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load payroll data.";
  }

  return (
    <AppShell navigationMode="admin">
      <PayrollDashboard
        initialData={data}
        initialError={error}
      />
    </AppShell>
  );
}
