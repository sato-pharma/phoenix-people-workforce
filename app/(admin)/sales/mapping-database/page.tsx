import { redirect } from "next/navigation";

import { MappingDatabaseWorkspace } from "@/components/sales/mapping-database-workspace";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { listSalesDistributors, type SalesDistributorEntry } from "@/lib/sales/distributor-registry";
import { listMappingReferences } from "@/lib/sales/normalizer/service";

export const dynamic = "force-dynamic";

export default async function MappingDatabasePage() {
  const accessContext = await resolveAccessContextFromPage();
  if (resolveNavigationMode(accessContext) === "employee-portal") {
    redirect("/employee-portals/sales");
  }
  // Mapping authority — restrict to Super Admin / system, matching the other Source-of-Sales admin pages.
  if (accessContext.role !== "Super Admin" && accessContext.scope !== "system") {
    redirect(resolveLandingPathForRole(accessContext.role));
  }

  let distributors: SalesDistributorEntry[] = [];
  let products: { code: string; name: string }[] = [];
  let bricks: { id: string; name: string }[] = [];
  try {
    await assertPermission(accessContext, "sales", "import");
    const [dist, refs] = await Promise.all([listSalesDistributors(), listMappingReferences()]);
    distributors = dist;
    products = refs.products;
    bricks = refs.bricks;
  } catch {
    // Render the shell with whatever loaded; the workspace surfaces per-action errors.
  }

  return <MappingDatabaseWorkspace bricks={bricks} distributors={distributors} products={products} />;
}
