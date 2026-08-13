import { Store } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { PharmacyRegistryManager } from "@/components/direct-orders/pharmacy-registry-manager";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import {
  listDirectOrderAreaAndBrickOptions,
  listDirectOrderDistributorOptions,
  listDirectOrderPharmacyRegistry,
} from "@/lib/direct-orders/service";

export const dynamic = "force-dynamic";

export default async function DirectOrderPharmaciesPage() {
  const access = await resolveAuthenticatedPageAccess();
  // The registry read throws for anyone outside it, so this page cannot render a shell for a
  // viewer who is not allowed to see the list at all.
  const [{ rows, canManage, canClearReview }, geo, distributors] = await Promise.all([
    listDirectOrderPharmacyRegistry(access),
    listDirectOrderAreaAndBrickOptions(access),
    listDirectOrderDistributorOptions(),
  ]);

  return (
    <div className="space-y-5">
      <AdminPageHero
        eyebrow="Direct Orders"
        title="Pharmacy Registry"
        description="Set a pharmacy up before an order needs it. A pharmacy registered here is already confirmed, so an order placed on it later goes straight to SFE and the sales line — no System Admin step. System Admin and SFE Manager register and edit; only a System Admin can confirm a pharmacy that is already holding an order."
        icon={<Store className="h-3.5 w-3.5" />}
      />
      <PharmacyRegistryManager
        rows={rows}
        areas={geo.areas}
        bricks={geo.bricks}
        distributors={distributors}
        canManage={canManage}
        canClearReview={canClearReview}
      />
    </div>
  );
}
