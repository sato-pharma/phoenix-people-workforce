import { redirect } from "next/navigation";

import {
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { TerritoryMapWorkspace } from "@/components/territory-management/territory-map-workspace";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getBrowserKey } from "@/lib/google-maps/server";
import {
  isPortalTerritoryManagementRole,
  loadTerritoryFilters,
  type TerritoryFilters,
} from "@/lib/territory-management/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// District Manager, Regional Manager and National Sales Manager land in the employee-portal shell
// (resolveNavigationMode), not the admin shell — the admin page at /sales/territory-management
// redirects them straight past this content. This is the SAME TerritoryMapWorkspace component and
// the SAME scoped service call the admin surface uses; only the shell chrome differs, exactly like
// Territory & Sales Drilldown's admin/portal split.
//
// The admitted role set now lives with the service as PORTAL_TERRITORY_MANAGEMENT_ROLES so this gate,
// the admin page's redirect target, and the sidebar flag cannot drift apart.

export default async function TerritoryManagementPortalPage() {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) redirect("/login");
  if (!isPortalTerritoryManagementRole(access.role)) redirect(resolveLandingPathForRole(access.role));
  await assertPermission(access, "sales", "read");

  let filters: TerritoryFilters = { areas: [], lines: [], regions: [] };
  let initialError: string | null = null;
  try {
    // resolveTerritoryScope (inside loadTerritoryFilters) narrows this to the caller's own
    // line/region — a District or Regional Manager sees their own patch, never the whole company.
    filters = await loadTerritoryFilters(null, access);
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Failed to load Territory Management.";
  }

  return (
    <EmployeePortalPageShell
      badge="Sales Operations"
      description="Is this area's brick allocation good, or is there a gap? And where should a Medical Rep hired here actually live?"
      errorBoundaryTitle="Territory Management unavailable"
      title="Territory Management"
    >
      <TerritoryMapWorkspace
        browserKey={getBrowserKey() ?? null}
        canEditPins={false}
        filters={filters}
        initialError={initialError}
      />
    </EmployeePortalPageShell>
  );
}
