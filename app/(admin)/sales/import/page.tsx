import { redirect } from "next/navigation";

import { SalesImportWorkspace } from "@/components/sales/sales-import-workspace";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
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
  // Gate before loading: an admin without `sales:import` must be cleanly
  // redirected (matching the employees/coaching convention), not dropped into
  // the import workspace shell with a stray "Forbidden" error string. The
  // /sales dashboard enforces its own read gate, so this cascades safely.
  if (!(await canAccess(accessContext, "sales", "import"))) {
    redirect("/sales");
  }

  let distributors: SalesDistributorOption[] = [];
  let initialBatches: SourceOfSalesUploadBatch[] = [];
  let initialDashboard: SourceOfSalesDashboard | null = null;
  let initialProducts: SourceOfSalesProduct[] = [];
  let initialError: string | null = null;

  try {
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
    <SalesImportWorkspace
      distributors={distributors}
      initialBatches={initialBatches}
      initialDashboard={initialDashboard}
      initialError={initialError}
      initialProducts={initialProducts}
    />
  );
}
