import { Percent } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { DirectOrderCapsManager } from "@/components/direct-orders/direct-order-caps-manager";
import { listDirectOrderCaps } from "@/lib/direct-orders/caps";
import { listDirectOrderProductOptions } from "@/lib/direct-orders/service";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function DirectOrderCapsPage() {
  const access = await resolveAccessContextFromPage();
  const [caps, products] = await Promise.all([listDirectOrderCaps(access), listDirectOrderProductOptions()]);
  return (
    <div className="space-y-5">
      <AdminPageHero
        eyebrow="Direct Orders"
        title="Bonus & Discount Caps"
        description="Set the bonus and discount caps and product public prices. System Admin edits; SFE Manager and CEO view."
        icon={<Percent className="h-3.5 w-3.5" />}
      />
      <DirectOrderCapsManager
        rows={caps.rows}
        canEdit={caps.canEdit}
        products={products.map((p) => ({ productCode: p.productCode, productName: p.productName, publicPrice: p.publicPrice }))}
      />
    </div>
  );
}
