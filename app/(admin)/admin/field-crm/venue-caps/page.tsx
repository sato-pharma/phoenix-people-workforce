import { redirect } from "next/navigation";
import { Building2 } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { CrmSurfaceProvider } from "@/components/phoenix-crm/surface";
import { VenueCapsAdmin } from "@/components/phoenix-crm/venue-caps-admin";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { canManageVenueCaps, loadVenueCapsAdmin } from "@/lib/phoenix-crm/server/venue-caps";

export const dynamic = "force-dynamic";

/**
 * Polyclinic caps — the Super Admin or the SFE Manager chooses a rep, and sets each of that rep's polyclinics. The page
 * opens on every exception that stands, at which rep, who set it and when (owner, 2026-11-03).
 *
 * Owner, 2026-11-02: "This module I filter by the medical rep. Then after I filter by the medical rep, all his
 * polyclinics appear ... When I open the toggle, then no cap for this rep in this polyclinic. And also have the
 * option to, for example, instead of making the cap 3, make it 5, make it 7."
 *
 * 🔴 THOSE TWO ALONE — `canManageVenueCaps`, on the page and inside every service it calls. The redirect
 * rather than a message is deliberate: a page that does not describe itself to somebody who may not read it.
 */
export default async function PhoenixCrmVenueCapsPage({ searchParams }: { searchParams: Promise<{ rep?: string | string[] }> }) {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "phoenix_crm", "approve"))) redirect("/admin");
  const viewer = await resolvePhoenixCrmViewer(access).catch(() => null);
  if (!viewer || !canManageVenueCaps(viewer)) redirect("/admin");

  const { rep } = await searchParams;
  const view = await loadVenueCapsAdmin(viewer, Array.isArray(rep) ? rep[0] : rep);

  return (
    <div className="space-y-5">
      <AdminPageHero
        description="The polyclinics holding an exception come first, with the rep, who set it and when. Under them, choose a rep to switch a cap off or raise a daily number."
        eyebrow="CRM"
        icon={<Building2 className="h-3.5 w-3.5" />}
        title="Polyclinic caps"
      />
      <CrmSurfaceProvider surface="admin">
        <VenueCapsAdmin view={view} />
      </CrmSurfaceProvider>
    </div>
  );
}
