import { redirect } from "next/navigation";

import { OrgTerritoryMappingWorkspace } from "@/components/admin/org-territory-mapping-workspace";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { loadTerritoryMappingData, type TerritoryMappingData } from "@/lib/sales/territory-mapping/service";

export const dynamic = "force-dynamic";

const EMPTY_DATA: TerritoryMappingData = { lines: [], regions: [], areas: [], map: [], zones: [], zoneRegions: [] };

export default async function OrgTerritoryMappingPage() {
  const accessContext = await resolveAccessContextFromPage();
  if (resolveNavigationMode(accessContext) === "employee-portal") {
    redirect("/employee-portals/source-of-sales");
  }
  // Mapping authority — restrict to Super Admin / system, matching the other Source-of-Sales
  // admin pages (Master Database, SoS Mapping).
  if (accessContext.role !== "Super Admin" && accessContext.scope !== "system") {
    redirect(resolveLandingPathForRole(accessContext.role));
  }

  let initialData: TerritoryMappingData = EMPTY_DATA;
  let initialError: string | null = null;
  try {
    await assertPermission(accessContext, "sales", "import");
    initialData = await loadTerritoryMappingData();
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Failed to load Org / Territory Mapping.";
  }

  return <OrgTerritoryMappingWorkspace initialData={initialData} initialError={initialError} />;
}
