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
  let mappingReferences: MappingReferences = { bricks: [], products: [] };
  let initialError: string | null = null;

  try {
    [distributors, initialBatches, initialProducts, initialDashboard, mappingReferences] = await Promise.all([
      listSalesImportDistributors(),
      listSourceOfSalesUploadBatches(),
      listSourceOfSalesProducts(),
      loadSourceOfSalesDashboard(),
      listMappingReferences().catch(() => ({ bricks: [], products: [] })),
    ]);
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Failed to load sales import.";
  }

  // Confidential products (LA003 / LA004) are surfaced in the import workspace only to CEO /
  // Super Admin — an SFE Manager also holds sales:import. Auto-mapping still resolves these
  // products server-side; this only hides them from the workspace's product lists and the
  // per-product dashboard view.
  if (!canViewRestrictedProducts(accessContext.role)) {
    initialProducts = initialProducts.filter((product) => !isRestrictedProductCode(product.productCode));
    mappingReferences = {
      ...mappingReferences,
      products: mappingReferences.products.filter((product) => !isRestrictedProductCode(product.code)),
    };
    if (initialDashboard) {
      initialDashboard = {
        ...initialDashboard,
        byProduct: initialDashboard.byProduct.filter((group) => !isRestrictedProductCode(group.code)),
      };
    }
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
