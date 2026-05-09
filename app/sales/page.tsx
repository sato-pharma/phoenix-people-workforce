import { AppShell } from "@/components/layout/app-shell";
import { SalesDashboard } from "@/components/sales/sales-dashboard";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { getSalesDashboard } from "@/lib/sales/service";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function SalesPage() {
  const accessContext = await resolveAccessContextFromPage();
  if (resolveNavigationMode(accessContext) === "employee-portal") {
    redirect("/employee-portals/sales");
  }
  let initialData = null;
  let initialError: string | null = null;

  try {
    await assertPermission(accessContext, "sales", "read");
    initialData = await getSalesDashboard({}, accessContext);
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
