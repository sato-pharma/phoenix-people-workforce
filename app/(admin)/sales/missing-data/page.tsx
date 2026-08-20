import { redirect } from "next/navigation";

import { MissingDataWorkspace } from "@/components/sales/missing-data-workspace";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { loadSalesReferenceGaps, type SalesReferenceGaps } from "@/lib/sales/reference-gaps";

export const dynamic = "force-dynamic";
// The gap scan pages every validated import row; give it more than the default function budget.
export const maxDuration = 60;

export default async function MissingDataPage() {
  const accessContext = await resolveAuthenticatedPageAccess();
  if (resolveNavigationMode(accessContext) === "employee-portal") {
    redirect("/employee-portals/source-of-sales");
  }
  // Read-only gap report, but restricted to Super Admin / system for consistency with the
  // sibling Source-of-Sales admin pages (no sales-import role leakage).
  if (accessContext.role !== "Super Admin" && accessContext.scope !== "system") {
    redirect(resolveLandingPathForRole(accessContext.role));
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
