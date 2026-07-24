import { redirect } from "next/navigation";

import { SalesUploadWorkspace } from "@/components/sales/sales-upload-workspace";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import {
  getDistributorProfileSummary,
  listSalesDistributors,
  type DistributorProfileSummary,
  type SalesDistributorEntry,
} from "@/lib/sales/distributor-registry";
import {
  listSourceOfSalesUploadBatches,
  type SourceOfSalesUploadBatch,
} from "@/lib/sales/monthly-distributor-import";
import { hasAiKey } from "@/lib/sales/normalizer/ai-suggest";
import { listMappingReferences } from "@/lib/sales/normalizer/service";

export const dynamic = "force-dynamic";

export default async function SalesUploadPage() {
  const accessContext = await resolveAuthenticatedPageAccess();
  if (resolveNavigationMode(accessContext) === "employee-portal") {
    redirect("/employee-portals/source-of-sales");
  }

  let distributors: SalesDistributorEntry[] = [];
  const summaries: Record<string, DistributorProfileSummary> = {};
  let batches: SourceOfSalesUploadBatch[] = [];
  // Option lists for the inline "map it here" comboboxes on the unmapped panel.
  let products: { code: string; name: string }[] = [];
  let bricks: { id: string; name: string }[] = [];
  try {
    await assertPermission(accessContext, "sales", "import");
    const [distributorList, uploadedBatches, refs] = await Promise.all([
      listSalesDistributors(),
      listSourceOfSalesUploadBatches().catch(() => [] as SourceOfSalesUploadBatch[]),
      listMappingReferences().catch(() => ({ products: [], bricks: [] })),
    ]);
    distributors = distributorList;
    batches = uploadedBatches;
    products = refs.products;
    bricks = refs.bricks;
    const monthly = distributors.filter((d) => d.monthlySupported);
    const resolved = await Promise.all(monthly.map((d) => getDistributorProfileSummary(d.code)));
    monthly.forEach((d, i) => { const s = resolved[i]; if (s) summaries[d.code] = s; });
  } catch {
    // Render the shell with whatever loaded; the workspace surfaces per-action errors + gating.
  }

  return <SalesUploadWorkspace aiEnabled={hasAiKey()} batches={batches} bricks={bricks} distributors={distributors} products={products} summaries={summaries} />;
}
