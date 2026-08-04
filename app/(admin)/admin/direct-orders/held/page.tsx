import { redirect } from "next/navigation";
import { PauseCircle } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { HeldDesk } from "@/components/direct-orders/held-desk";
import { listHeldDirectOrders } from "@/lib/direct-orders/service";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

// The Held Desk (spec C3 — docs/specs/direct-orders-v2.md). System Admin only: every direct
// order parked outside the approval flow because its pharmacy is not in the master database,
// with the bulk notice button. The service enforces the gate; the redirect is just UX.
export default async function DirectOrdersHeldDeskPage() {
  const access = await resolveAccessContextFromPage();
  if (!(access.scope === "system" || access.role === "Super Admin")) redirect("/admin/direct-orders");
  const rows = await listHeldDirectOrders(access);
  return (
    <div className="space-y-5">
      <AdminPageHero
        eyebrow="Sales"
        title="Direct Orders — Held Desk"
        description="Requests parked outside the approval flow: their pharmacy is not in the master database. They move only when the pharmacy passes validation, and expire after 14 days."
        icon={<PauseCircle className="h-3.5 w-3.5" />}
      />
      <HeldDesk rows={rows} />
    </div>
  );
}
