import { redirect } from "next/navigation";
import { Undo2 } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { ReturnedAgeingDesk } from "@/components/direct-orders/returned-ageing-desk";
import { listReturnedDirectOrdersAgeing } from "@/lib/direct-orders/service";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

// The Returned Ageing Desk. System Admin only, matching its sibling the Held Desk: the service
// enforces the gate and this redirect is only UX, so a narrower service can never be widened by
// someone linking the page.
export default async function DirectOrdersReturnedDeskPage() {
  const access = await resolveAccessContextFromPage();
  if (!(access.scope === "system" || access.role === "Super Admin")) redirect("/admin/direct-orders");
  const rows = await listReturnedDirectOrdersAgeing(access);
  return (
    <div className="space-y-5">
      <AdminPageHero
        eyebrow="Sales"
        title="Direct Orders — Returned Ageing"
        description="Orders handed back to a rep and not yet answered. Unlike held requests these have no expiry clock and nothing chases them, so they age until somebody looks."
        icon={<Undo2 className="h-3.5 w-3.5" />}
      />
      <ReturnedAgeingDesk rows={rows} />
    </div>
  );
}
