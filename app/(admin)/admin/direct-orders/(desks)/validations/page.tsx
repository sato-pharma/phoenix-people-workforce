import { redirect } from "next/navigation";
import { ShieldCheck } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { ValidationDesk } from "@/components/direct-orders/validation-desk";
import {
  canDecideDirectOrderInvoiceValidations,
  canDecideDirectOrderPharmacyValidations,
  listDirectOrderPharmacyValidations,
} from "@/lib/direct-orders/pharmacy-validation";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

// The pharmacy validation desk (spec A2 — docs/specs/direct-orders-v2.md). A System Admin decides
// every claim; an SFE Manager decides the distributor-invoice claims (owner, 2026-09-14), and the
// service narrows their desk to those. Service enforces the gate; this redirect is UX only.
export default async function DirectOrderValidationsPage() {
  const access = await resolveAccessContextFromPage();
  if (!canDecideDirectOrderInvoiceValidations(access)) redirect("/admin/direct-orders");
  const decidesEveryClaim = canDecideDirectOrderPharmacyValidations(access);
  const rows = await listDirectOrderPharmacyValidations(access, { status: "pending" });
  return (
    <div className="space-y-5">
      <AdminPageHero
        eyebrow="Sales"
        title="Pharmacy Validation"
        description={
          decidesEveryClaim
            ? "Claims for pharmacies the distributor sheets do not know, each with its live photograph and location or the distributor invoice the rep attached. Match one to an existing customer wherever you can — approving a new pharmacy puts it on 90-day probation."
            : "Pharmacies your reps validated with a distributor invoice. Open each invoice and match it to an existing customer wherever you can — approving a new pharmacy puts it on 90-day probation."
        }
        icon={<ShieldCheck className="h-3.5 w-3.5" />}
      />
      <ValidationDesk rows={rows} />
    </div>
  );
}
