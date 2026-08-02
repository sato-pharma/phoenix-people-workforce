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
import { listSalesQueue } from "@/lib/sales/service";
import type { SalesHistoryRow } from "@/lib/sales/types";

export const dynamic = "force-dynamic";

const TAB_KEYS = ["approvals", "coverage", "dashboard", "mapping", "monthly-sales", "products", "sheets"] as const;
type SalesImportTab = (typeof TAB_KEYS)[number];

export default async function SalesImportPage({ searchParams }: { searchParams: Promise<{ tab?: string; search?: string }> }) {
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

  const sp = await searchParams;
  const initialTab: SalesImportTab | undefined = TAB_KEYS.includes(sp?.tab as SalesImportTab)
    ? (sp?.tab as SalesImportTab)
    : undefined;
  const initialProductsSearch = sp?.search?.trim() || undefined;

  let distributors: SalesDistributorOption[] = [];
  let initialBatches: SourceOfSalesUploadBatch[] = [];
  let initialDashboard: SourceOfSalesDashboard | null = null;
  let initialProducts: SourceOfSalesProduct[] = [];
  let mappingReferences: MappingReferences = { bricks: [], products: [] };
  let initialError: string | null = null;
  // Batch approvals — the retired Sales Queue's workflow. Loaded separately from the block below
  // so a queue failure degrades to an error inside the Approvals tab instead of blanking the whole
  // workspace, which is what the old dedicated page did.
  let initialQueue: SalesHistoryRow[] | null = null;
  let initialQueueError: string | null = null;
  try {
    initialQueue = await listSalesQueue(accessContext);
  } catch (error) {
    initialQueueError = error instanceof Error ? error.message : "Failed to load sales approvals.";
  }

  try {
    [distributors, initialBatches, initialProducts, initialDashboard, mappingReferences] = await Promise.all([
      listSalesImportDistributors(),
      listSourceOfSalesUploadBatches(),
      listSourceOfSalesProducts(),
      loadSourceOfSalesDashboard(undefined, { role: accessContext.role }),
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
      initialProductsSearch={initialProductsSearch}
      initialQueue={initialQueue}
      initialQueueError={initialQueueError}
      initialTab={initialTab}
      mappingReferences={mappingReferences}
      profiledDistributorCodes={listNormalizerDistributors().map((distributor) => distributor.code)}
    />
  );
}
