import { redirect } from "next/navigation";
import { ShieldCheck } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { ValidationDesk } from "@/components/direct-orders/validation-desk";
import { listDirectOrderPharmacyValidations } from "@/lib/direct-orders/pharmacy-validation";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

// The Super Admin pharmacy validation desk (spec A2 — docs/specs/direct-orders-v2.md).
// Service enforces the gate; this redirect is UX only.
export default async function DirectOrderValidationsPage() {
  const access = await resolveAccessContextFromPage();
  if (!(access.scope === "system" || access.role === "Super Admin")) redirect("/admin/direct-orders");
  const rows = await listDirectOrderPharmacyValidations(access, { status: "pending" });
  return (
    <div className="space-y-5">
      <AdminPageHero
        eyebrow="Sales"
        title="Pharmacy Validation"
        description="Claims for pharmacies the distributor sheets do not know, each with its live photograph and location. Match one to an existing customer wherever you can — approving a new pharmacy puts it on 90-day probation."
        icon={<ShieldCheck className="h-3.5 w-3.5" />}
      />
      <ValidationDesk rows={rows} />
    </div>
  );
}
