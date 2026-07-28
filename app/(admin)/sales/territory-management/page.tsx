import { redirect } from "next/navigation";

import { TerritoryMapWorkspace } from "@/components/territory-management/territory-map-workspace";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { getBrowserKey } from "@/lib/google-maps/server";
import { loadTerritoryFilters, type TerritoryFilters } from "@/lib/territory-management/service";

export const dynamic = "force-dynamic";

export default async function TerritoryManagementPage() {
  const access = await resolveAuthenticatedPageAccess();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals/territory-drilldown");
  }

  let filters: TerritoryFilters = { areas: [], lines: [], regions: [] };
  let initialError: string | null = null;

  try {
    // Server-side gate. The nav hides this link for roles without sales read, but that is UX only.
    await assertPermission(access, "sales", "read");
    filters = await loadTerritoryFilters(null);
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Failed to load Territory Management.";
  }

  return (
    <TerritoryMapWorkspace
      browserKey={getBrowserKey() ?? null}
      canEditPins={access.role === "Super Admin"}
      filters={filters}
      initialError={initialError}
    />
  );
}
