import { AppShell } from "@/components/layout/app-shell";
import { PayrollAnalyticsDashboard } from "@/components/payroll/payroll-analytics-dashboard";
import { getPayrollDashboard } from "@/lib/payroll/service";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { assertPermission, getPayrollScope } from "@/lib/auth/permissions";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function PayrollDashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const access = await resolveAccessContextFromPage();
  const scope = getPayrollScope(access);
  if (scope !== "COMPANY") {
    const month = sp.month ? `?month=${sp.month}${sp.year ? `&year=${sp.year}` : ""}` : "";
    redirect(`/employee-portals/payroll${month}`);
  }
  await assertPermission(access, "payroll", "read");
  let data = null;
  let error: string | null = null;

  try {
    const month = Number(sp.month);
    const year = Number(sp.year);
    const initialData = await getPayrollDashboard(undefined, access);
    const selectedBatch =
      month && year
        ? initialData.batches.find((batch) => batch.month === month && batch.year === year)
        : null;

    data = selectedBatch
      ? await getPayrollDashboard(selectedBatch.id, access)
      : initialData;
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load payroll dashboard.";
  }

  return (
    <AppShell showTopbar={false}>
      <PayrollAnalyticsDashboard initialData={data} initialError={error} />
    </AppShell>
  );
}
