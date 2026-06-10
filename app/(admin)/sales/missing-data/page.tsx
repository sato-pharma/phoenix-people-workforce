import { redirect } from "next/navigation";

import { MissingDataWorkspace } from "@/components/sales/missing-data-workspace";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { loadSalesReferenceGaps, type SalesReferenceGaps } from "@/lib/sales/reference-gaps";

export const dynamic = "force-dynamic";
// The gap scan pages every validated import row; give it more than the default function budget.
export const maxDuration = 60;

export default async function MissingDataPage() {
  const accessContext = await resolveAccessContextFromPage();
  if (resolveNavigationMode(accessContext) === "employee-portal") {
    redirect("/employee-portals/sales");
  }

  let data: SalesReferenceGaps | null = null;
  let loadError: string | null = null;
  try {
    await assertPermission(accessContext, "sales", "import");
    data = await loadSalesReferenceGaps();
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Failed to scan for missing data.";
  }

  return <MissingDataWorkspace data={data} loadError={loadError} />;
}
