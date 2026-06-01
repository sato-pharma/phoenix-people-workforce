import { redirect } from "next/navigation";

import { AppShell } from "@/components/layout/app-shell";
import { SalesImportWorkspace } from "@/components/sales/sales-import-workspace";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  listSalesImportDistributors,
  loadSourceOfSalesDashboard,
  listSourceOfSalesProducts,
  listSourceOfSalesUploadBatches,
  type SourceOfSalesDashboard,
  type SourceOfSalesProduct,
  type SourceOfSalesUploadBatch,
  type SalesDistributorOption,
} from "@/lib/sales/monthly-distributor-import";

export const dynamic = "force-dynamic";

export default async function SalesImportPage() {
  const accessContext = await resolveAccessContextFromPage();
  if (resolveNavigationMode(accessContext) === "employee-portal") {
    redirect("/employee-portals/sales");
  }

  let distributors: SalesDistributorOption[] = [];
  let initialBatches: SourceOfSalesUploadBatch[] = [];
  let initialDashboard: SourceOfSalesDashboard | null = null;
  let initialProducts: SourceOfSalesProduct[] = [];
  let initialError: string | null = null;

  try {
    await assertPermission(accessContext, "sales", "import");
    [distributors, initialBatches, initialProducts, initialDashboard] = await Promise.all([
      listSalesImportDistributors(),
      listSourceOfSalesUploadBatches(),
      listSourceOfSalesProducts(),
      loadSourceOfSalesDashboard(),
    ]);
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Failed to load sales import.";
  }

  return (
    <AppShell navigationMode="admin">
      <SalesImportWorkspace
        distributors={distributors}
        initialBatches={initialBatches}
        initialDashboard={initialDashboard}
        initialError={initialError}
        initialProducts={initialProducts}
      />
    </AppShell>
  );
}
