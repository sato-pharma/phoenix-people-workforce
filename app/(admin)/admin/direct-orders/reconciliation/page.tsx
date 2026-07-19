import { Scale } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { DirectOrderReconciliationWorkspace } from "@/components/direct-orders/direct-order-reconciliation-workspace";
import { getDirectSalesReconciliation } from "@/lib/direct-orders/service";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function DirectSalesReconciliationPage() {
  const access = await resolveAccessContextFromPage();
  const result = await getDirectSalesReconciliation(access);
  return (
    <div className="space-y-5">
      <AdminPageHero
        eyebrow="Direct Orders"
        title="Direct Sales Reconciliation"
        description="Detect double-count exposure between the legacy manual DIRECT upload and the module's DirectReq injection, per period · line · region · product."
        icon={<Scale className="h-3.5 w-3.5" />}
      />
      <DirectOrderReconciliationWorkspace result={result} />
    </div>
  );
}
