import { redirect } from "next/navigation";

import { AppShell } from "@/components/layout/app-shell";
import { SalesImportWorkspace } from "@/components/sales/sales-import-workspace";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  listSalesImportDistributors,
  listSourceOfSalesProducts,
  listSourceOfSalesUploadBatches,
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
  let initialProducts: SourceOfSalesProduct[] = [];
  let initialError: string | null = null;

  try {
    await assertPermission(accessContext, "sales", "import");
    [distributors, initialBatches, initialProducts] = await Promise.all([
      listSalesImportDistributors(),
      listSourceOfSalesUploadBatches(),
      listSourceOfSalesProducts(),
    ]);
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Failed to load sales import.";
  }

  return (
    <AppShell navigationMode="admin">
      <SalesImportWorkspace
        distributors={distributors}
        initialBatches={initialBatches}
        initialError={initialError}
        initialProducts={initialProducts}
      />
    </AppShell>
  );
}
