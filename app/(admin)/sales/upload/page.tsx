import { redirect } from "next/navigation";

import { SalesUploadWorkspace } from "@/components/sales/sales-upload-workspace";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
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

export const dynamic = "force-dynamic";

export default async function SalesUploadPage() {
  const accessContext = await resolveAccessContextFromPage();
  if (resolveNavigationMode(accessContext) === "employee-portal") {
    redirect("/employee-portals/sales");
  }

  let distributors: SalesDistributorEntry[] = [];
  const summaries: Record<string, DistributorProfileSummary> = {};
  let batches: SourceOfSalesUploadBatch[] = [];
  try {
    await assertPermission(accessContext, "sales", "import");
    const [distributorList, uploadedBatches] = await Promise.all([
      listSalesDistributors(),
      listSourceOfSalesUploadBatches().catch(() => [] as SourceOfSalesUploadBatch[]),
    ]);
    distributors = distributorList;
    batches = uploadedBatches;
    const monthly = distributors.filter((d) => d.monthlySupported);
    const resolved = await Promise.all(monthly.map((d) => getDistributorProfileSummary(d.code)));
    monthly.forEach((d, i) => { const s = resolved[i]; if (s) summaries[d.code] = s; });
  } catch {
    // Render the shell with whatever loaded; the workspace surfaces per-action errors + gating.
  }

  return <SalesUploadWorkspace batches={batches} distributors={distributors} summaries={summaries} />;
}
