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

export const dynamic = "force-dynamic";

export default async function SalesUploadPage() {
  const accessContext = await resolveAccessContextFromPage();
  if (resolveNavigationMode(accessContext) === "employee-portal") {
    redirect("/employee-portals/sales");
  }

  let distributors: SalesDistributorEntry[] = [];
  const summaries: Record<string, DistributorProfileSummary> = {};
  try {
    await assertPermission(accessContext, "sales", "import");
    distributors = await listSalesDistributors();
    const monthly = distributors.filter((d) => d.monthlySupported);
    const resolved = await Promise.all(monthly.map((d) => getDistributorProfileSummary(d.code)));
    monthly.forEach((d, i) => { const s = resolved[i]; if (s) summaries[d.code] = s; });
  } catch {
    // Render the shell with whatever loaded; the workspace surfaces per-action errors + gating.
  }

  return <SalesUploadWorkspace distributors={distributors} summaries={summaries} />;
}
