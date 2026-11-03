import { redirect } from "next/navigation";
import { CalendarClock } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { RepExceptionsAdmin } from "@/components/phoenix-crm/rep-exceptions-admin";
import { CrmSurfaceProvider } from "@/components/phoenix-crm/surface";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { canManageRepExceptions, loadRepExceptionsAdmin } from "@/lib/phoenix-crm/server/rep-exceptions";

export const dynamic = "force-dynamic";

/**
 * Rep exceptions — the Super Admin switches the unplanned visit limit off for any rep, for the dates he sets.
 *
 * Owner, 2026-11-03: "build a module for admin only to open or close this feature by a toggle or be able to control
 * duration for any rep if needed exception".
 *
 * 🔴 THE SUPER ADMIN'S ALONE — `canManageRepExceptions`, on the page and inside every service it calls.
 */
export default async function PhoenixCrmRepExceptionsPage({ searchParams }: { searchParams: Promise<{ rep?: string | string[] }> }) {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "phoenix_crm", "update"))) redirect("/admin");
  const viewer = await resolvePhoenixCrmViewer(access).catch(() => null);
  if (!viewer || !canManageRepExceptions(viewer)) redirect("/admin");

  const { rep } = await searchParams;
  const view = await loadRepExceptionsAdmin(viewer, Array.isArray(rep) ? rep[0] : rep);

  return (
    <div className="space-y-5">
      <AdminPageHero
        description="Switch the unplanned visit limit off for any rep and set the dates it applies. The usual limit returns by itself after the last date."
        eyebrow="CRM"
        icon={<CalendarClock className="h-3.5 w-3.5" />}
        title="Rep exceptions"
      />
      <CrmSurfaceProvider surface="admin">
        <RepExceptionsAdmin view={view} />
      </CrmSurfaceProvider>
    </div>
  );
}
