import { Gauge } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { RepCountersTable } from "@/components/direct-orders/rep-counters-table";
import { getDirectOrderRepCounters } from "@/lib/direct-orders/rep-counters";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";

export const dynamic = "force-dynamic";

/**
 * Per-rep Direct Orders counters (spec E1).
 *
 * No redirect guard here on purpose, unlike the Held Desk. That page is System-Admin-only, so
 * bouncing everyone else is right. This one is scoped rather than gated: a manager is SUPPOSED to
 * open it and see their own team. `getDirectOrderRepCounters` decides whose numbers appear, and an
 * extra role check here would only re-implement — worse, diverge from — that rule.
 */
export default async function DirectOrdersRepCountersPage() {
  const access = await resolveAuthenticatedPageAccess();
  const data = await getDirectOrderRepCounters(access);
  return (
    <div className="space-y-5">
      <AdminPageHero
        eyebrow="Sales"
        title="Direct Orders — Per-rep counters"
        description="Who is parking orders on pharmacies the master database does not know, who lets them expire, and who is shown the customer they meant and files it as new anyway. Sorted by money held, worst first."
        icon={<Gauge className="h-3.5 w-3.5" />}
      />
      <RepCountersTable data={data} />
    </div>
  );
}
