import { redirect } from "next/navigation";

import { SalesImportWorkspace } from "@/components/sales/sales-import-workspace";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canViewRestrictedProducts, isRestrictedProductCode } from "@/lib/sales/access-scope";
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
import { listMappingReferences, listNormalizerDistributors, type MappingReferences } from "@/lib/sales/normalizer/service";

export const dynamic = "force-dynamic";

export default async function SalesImportPage() {
  const accessContext = await resolveAccessContextFromPage();
  if (resolveNavigationMode(accessContext) === "employee-portal") {
    redirect("/employee-portals/source-of-sales");
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
  let mappingReferences: MappingReferences = { bricks: [], products: [] };
  let initialError: string | null = null;

  try {
    [distributors, initialBatches, initialProducts, initialDashboard, mappingReferences] = await Promise.all([
      listSalesImportDistributors(),
      listSourceOfSalesUploadBatches(),
      listSourceOfSalesProducts(),
      loadSourceOfSalesDashboard(undefined, canViewRestrictedProducts(accessContext.role)),
      listMappingReferences().catch(() => ({ bricks: [], products: [] })),
    ]);
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Failed to load sales import.";
  }

  // Confidential products (LA003 / LA004): product lists + mapping references stripped
  // for non-CEO/SuperAdmin. Dashboard dimensions (totals, byLine, byRegion/Area/Brick,
  // byDistributor) are already corrected inside loadSourceOfSalesDashboard.
  if (!canViewRestrictedProducts(accessContext.role)) {
    initialProducts = initialProducts.filter((product) => !isRestrictedProductCode(product.productCode));
    mappingReferences = {
      ...mappingReferences,
      products: mappingReferences.products.filter((product) => !isRestrictedProductCode(product.code)),
    };
  }

  return (
    <SalesImportWorkspace
      distributors={distributors}
      initialBatches={initialBatches}
      initialDashboard={initialDashboard}
      initialError={initialError}
      initialProducts={initialProducts}
      mappingReferences={mappingReferences}
      profiledDistributorCodes={listNormalizerDistributors().map((distributor) => distributor.code)}
    />
  );
}
