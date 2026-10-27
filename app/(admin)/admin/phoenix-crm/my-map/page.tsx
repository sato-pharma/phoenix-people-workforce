import { redirect } from "next/navigation";
import { Map as MapIcon } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { MyMapScreen } from "@/components/phoenix-crm/my-map/my-map-screen";
import { CrmSurfaceProvider } from "@/components/phoenix-crm/surface";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getBrowserKey } from "@/lib/google-maps/server";
import { canReadMyMap, resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadMyMap } from "@/lib/phoenix-crm/server/my-map";

export const dynamic = "force-dynamic";

/**
 * My map, in the admin shell — the Super Admin's, the CEO's and the SFE Manager's copy of the company's map
 * (owner, 2026-10-27: "CEO and SFE Manager too"). The field's copy is `/employee-portals/my-map`; both draw the
 * same screen from the same loader, and `canReadMyMap` decides on both. Anybody else is redirected.
 */
export default async function PhoenixCrmMyMapPage() {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "phoenix_crm", "read"))) redirect("/admin");
  const viewer = await resolvePhoenixCrmViewer(access).catch(() => null);
  if (!viewer || !canReadMyMap(viewer)) redirect("/admin");

  const view = await loadMyMap(viewer);

  return (
    <div className="space-y-5">
      <AdminPageHero
        description="Every validated customer place in the company, AM, PM and pharmacies in their own colours, with a manager, rep and line filter and directions to any pin."
        eyebrow="CRM"
        icon={<MapIcon className="h-3.5 w-3.5" />}
        title="My map"
      />
      <CrmSurfaceProvider surface="admin">
        <MyMapScreen browserKey={getBrowserKey()} view={view} />
      </CrmSurfaceProvider>
    </div>
  );
}
