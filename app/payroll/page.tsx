import { PayrollDashboard } from "@/components/payroll/payroll-dashboard";
import { AppShell } from "@/components/layout/app-shell";
import { getPayrollDashboard } from "@/lib/payroll/service";

export default async function PayrollPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const sp = await searchParams;
  let data = null;
  let error: string | null = null;

  try {
    data = await getPayrollDashboard(sp.batchId);
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load payroll data.";
  }

  return (
    <AppShell showTopbar={false}>
      <PayrollDashboard
        initialData={data}
        initialError={error}
        initialTab={
          sp.tab === "governance"
            ? "governance"
            : sp.tab === "generate"
              ? "generate"
              : "governance"
        }
      />
    </AppShell>
  );
}
