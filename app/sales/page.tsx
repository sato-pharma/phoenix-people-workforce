import { AppShell } from "@/components/layout/app-shell";
import { SalesDashboard } from "@/components/sales/sales-dashboard";
import { getSalesDashboard } from "@/lib/sales/service";

export const dynamic = "force-dynamic";

export default async function SalesPage() {
  let initialData = null;
  let initialError: string | null = null;

  try {
    initialData = await getSalesDashboard();
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Failed to load sales dashboard.";
  }

  return (
    <AppShell>
      <SalesDashboard
        initialData={initialData}
        initialError={initialError}
      />
    </AppShell>
  );
}
