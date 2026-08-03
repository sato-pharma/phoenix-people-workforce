import { Percent } from "lucide-react";

import { redirect } from "next/navigation";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { DirectOrderCapsManager } from "@/components/direct-orders/direct-order-caps-manager";
import { canViewDirectOrderCaps, listDirectOrderCaps } from "@/lib/direct-orders/caps";
import { listDirectOrderProductOptions } from "@/lib/direct-orders/service";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function DirectOrderCapsPage() {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) redirect("/login");
  // Page-level gate. Without it an unauthorized caller fell straight into listDirectOrderCaps'
  // throw and got an error boundary instead of a clean redirect. The service still enforces this.
  if (!canViewDirectOrderCaps(access)) redirect(resolveLandingPathForRole(access.role));
  const [caps, products] = await Promise.all([listDirectOrderCaps(access), listDirectOrderProductOptions()]);
  return (
    <div className="space-y-5">
      <AdminPageHero
        eyebrow="Direct Orders"
        title="Caps & Product Prices"
        description="Set the bonus and discount caps, the pharmacy price that values bonus orders, and the public price that values discount orders. System Admin edits; SFE Manager and CEO view."
        icon={<Percent className="h-3.5 w-3.5" />}
      />
      <DirectOrderCapsManager
        rows={caps.rows}
        canEdit={caps.canEdit}
        products={products.map((p) => ({
          productCode: p.productCode,
          productName: p.productName,
          factoryPrice: p.factoryPrice,
          publicPrice: p.publicPrice,
          pharmacyPrice: p.pharmacyPrice,
        }))}
      />
    </div>
  );
}
