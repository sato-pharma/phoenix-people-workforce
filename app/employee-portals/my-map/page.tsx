import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { MyMapScreen } from "@/components/phoenix-crm/my-map/my-map-screen";
import { CrmSurfaceProvider } from "@/components/phoenix-crm/surface";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getBrowserKey } from "@/lib/google-maps/server";
import { canReadMyMap, resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadMyMap } from "@/lib/phoenix-crm/server/my-map";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * My map — every validated customer place on the reader's territories, one square pin each, AM, PM and
 * pharmacies in their own colours, and directions from where the phone is to any of them (owner, 2026-10-27).
 *
 * The rep's map is his own territory; a district manager's is his team's; a regional or national manager's is
 * every territory beneath him, with a manager, rep and line filter; the Super Admin, the CEO and the SFE
 * Manager read the company (`canReadMyMap`). Anybody else is redirected rather than told the page exists.
 *
 * Rendered fresh on every visit (`force-dynamic`), and the screen refreshes itself when the tab comes back,
 * so a customer validated a minute ago is already on it.
 */
export default async function MyMapPage() {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "phoenix_crm", "read"))) redirect("/employee-portals");
  const viewer = await resolvePhoenixCrmViewer(access).catch(() => null);
  if (!viewer || !canReadMyMap(viewer)) redirect("/employee-portals");

  const view = await loadMyMap(viewer);

  return (
    <EmployeePortalPageShell
      badge="CRM"
      description="Every validated customer on your territories, AM, PM and pharmacies in their own colours. Tap a pin for directions from where you are."
      title="My map"
    >
      <CrmSurfaceProvider surface="portal">
        <MyMapScreen browserKey={getBrowserKey()} view={view} />
      </CrmSurfaceProvider>
    </EmployeePortalPageShell>
  );
}
