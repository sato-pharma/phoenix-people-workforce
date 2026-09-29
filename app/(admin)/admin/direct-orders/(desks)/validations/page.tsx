import { redirect } from "next/navigation";
import { ShieldCheck } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { ValidationDesk } from "@/components/direct-orders/validation-desk";
import { StuckVenuesPanel } from "@/components/direct-orders/stuck-venues-panel";
import {
  canDecideDirectOrderInvoiceValidations,
  canDecideDirectOrderPharmacyValidations,
  listDirectOrderPharmacyValidations,
} from "@/lib/direct-orders/pharmacy-validation";
import { listDirectOrderStuckVenues } from "@/lib/direct-orders/stuck-venues";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

// The pharmacy validation desk (spec A2 — docs/specs/direct-orders-v2.md). A System Admin decides
// every claim; an SFE Manager decides the distributor-invoice claims (owner, 2026-09-14), and the
// service narrows their desk to those. Service enforces the gate; this redirect is UX only.
export default async function DirectOrderValidationsPage() {
  const access = await resolveAccessContextFromPage();
  if (!canDecideDirectOrderInvoiceValidations(access)) redirect("/admin/direct-orders");
  const decidesEveryClaim = canDecideDirectOrderPharmacyValidations(access);
  const [rows, stuckVenues] = await Promise.all([
    listDirectOrderPharmacyValidations(access, { status: "pending" }),
    // The venues with NO claim, which by definition have no row above (owner, 2026-09-29).
    listDirectOrderStuckVenues(access),
  ]);
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
      {/* Under the desk's real work, never above it: a claim awaiting a decision is the job, and
          this panel is the blind spot beside it. Empty for an SFE Manager, whose desk is invoice
          claims only and for whom a missing FIELD capture is not a queue they can act on. */}
      {decidesEveryClaim ? <StuckVenuesPanel venues={stuckVenues} /> : null}
    </div>
  );
}
