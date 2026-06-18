import { redirect } from "next/navigation";

import { SalesDiagnosticsWorkspace } from "@/components/sales/sales-diagnostics-workspace";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { listSalesDistributors, type SalesDistributorEntry } from "@/lib/sales/distributor-registry";

export const dynamic = "force-dynamic";

export default async function SalesDiagnosticsPage() {
  const accessContext = await resolveAccessContextFromPage();
  if (resolveNavigationMode(accessContext) === "employee-portal") {
    redirect("/employee-portals/sales");
  }
  // Admin troubleshooting surface — gate to Super Admin / system like the sibling Source-of-Sales
  // admin pages (no sales-import role leakage), redirecting denied users instead of rendering empty.
  if (accessContext.role !== "Super Admin" && accessContext.scope !== "system") {
    redirect(resolveLandingPathForRole(accessContext.role));
  }

  let distributors: SalesDistributorEntry[] = [];
  try {
    await assertPermission(accessContext, "sales", "import");
    distributors = await listSalesDistributors();
  } catch {
    // Render the shell; the workspace surfaces per-action errors + gating.
  }

  return <SalesDiagnosticsWorkspace distributors={distributors} />;
}
