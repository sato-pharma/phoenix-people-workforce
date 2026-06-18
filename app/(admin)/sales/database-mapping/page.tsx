import { redirect } from "next/navigation";

import { DatabaseMappingWorkspace } from "@/components/sales/database-mapping-workspace";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { MASTER_ORDER, type MasterKey } from "@/lib/sales/master-data/definitions";
import { listMasterRows, type MasterRowRecord } from "@/lib/sales/master-data/list";
import { profilesToHeaderGrid } from "@/lib/sales/normalizer/profile-grid";
import { RAW_DISTRIBUTOR_PROFILES } from "@/lib/sales/normalizer/profiles";

export const dynamic = "force-dynamic";

export default async function DatabaseMappingPage() {
  const accessContext = await resolveAccessContextFromPage();
  if (resolveNavigationMode(accessContext) === "employee-portal") {
    redirect("/employee-portals/sales");
  }
  // Master-data mutation surface — restrict to Super Admin / system, matching the other
  // Source-of-Sales admin pages (Customer Directory, Customer Mapping, Normalizer).
  if (accessContext.role !== "Super Admin" && accessContext.scope !== "system") {
    redirect(resolveLandingPathForRole(accessContext.role));
  }

  const initialRows = MASTER_ORDER.reduce((accumulator, master) => {
    accumulator[master] = [];
    return accumulator;
  }, {} as Record<MasterKey, MasterRowRecord[]>);
  let initialError: string | null = null;

  try {
    await assertPermission(accessContext, "sales", "import");
    const lists = await Promise.all(MASTER_ORDER.map((master) => listMasterRows(master)));
    MASTER_ORDER.forEach((master, index) => {
      initialRows[master] = lists[index];
    });
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Failed to load Database Mapping.";
  }

  // Pure transform of the code-defined column profiles — the Database Validation tab's header grid.
  const initialHeaderGrid = profilesToHeaderGrid(RAW_DISTRIBUTOR_PROFILES);

  return <DatabaseMappingWorkspace initialError={initialError} initialHeaderGrid={initialHeaderGrid} initialRows={initialRows} />;
}
