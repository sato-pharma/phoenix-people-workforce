import { redirect } from "next/navigation";

import { TerritoryMapWorkspace } from "@/components/territory-management/territory-map-workspace";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { getBrowserKey } from "@/lib/google-maps/server";
import {
  isPortalTerritoryManagementRole,
  loadTerritoryFilters,
  type TerritoryFilters,
} from "@/lib/territory-management/service";
import { resolveLandingPathForRole } from "@/lib/auth/landing";

export const dynamic = "force-dynamic";

export default async function TerritoryManagementPage() {
  const access = await resolveAuthenticatedPageAccess();
  if (resolveNavigationMode(access) === "employee-portal") {
    // Portal-shell roles get the portal TWIN of THIS module — not Territory & Sales Drilldown, which
    // is a different module entirely (this used to send them there, so an admin-URL visit silently
    // landed on the wrong page). Anyone the twin does not admit goes to their own landing instead of
    // bouncing through a page that would just redirect them again.
    redirect(
      isPortalTerritoryManagementRole(access.role)
        ? "/employee-portals/territory-management"
        : resolveLandingPathForRole(access.role),
    );
  }

  let filters: TerritoryFilters = { areas: [], lines: [], regions: [] };
  let initialError: string | null = null;

  try {
    // Server-side gate. The nav hides this link for roles without sales read, but that is UX only.
    await assertPermission(access, "sales", "read");
    filters = await loadTerritoryFilters(null, access);
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
