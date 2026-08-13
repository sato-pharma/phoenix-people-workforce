import { MapPinned } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { PharmacyVarianceManager } from "@/components/direct-orders/pharmacy-variance-manager";
import { listPharmacyGeoVariances } from "@/lib/direct-orders/service";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";

export const dynamic = "force-dynamic";

export default async function PharmacyVariancesPage() {
  const access = await resolveAuthenticatedPageAccess();
  const { rows, canResolve } = await listPharmacyGeoVariances(access);
  return (
    <div className="space-y-5">
      <AdminPageHero
        eyebrow="Direct Orders"
        title="Pharmacy Geography Variances"
        description="Where a submitter's brick differs from the distributor customer-code mapping. Keep the submitted brick, or apply the system mapping. System Admin resolves; SFE Manager and CEO view."
        icon={<MapPinned className="h-3.5 w-3.5" />}
      />
      <PharmacyVarianceManager rows={rows} canResolve={canResolve} />
    </div>
  );
}
