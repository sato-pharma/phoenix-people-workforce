import type { DirectOrderPharmacy } from "@/lib/direct-orders/types";
import type { DirectOrderValidationRow } from "@/lib/direct-orders/pharmacy-validation";
import { buildValidationBadge, type ValidationBadge } from "@/lib/validation/validation-badge";

/**
 * The "already validated" stamp for a direct-order approver window, or null when the pharmacy is NOT
 * yet validated (a fresh pending_review or a rejected pharmacy shows no stamp — it is exactly what
 * this order's approver is being asked to confirm).
 *
 * Owner ask (2026-09-22): show WHO validated a recognised pharmacy and WHEN, on the approver window.
 * A pharmacy is "already validated" once `verificationStatus === "verified"`. Two roads to that, and
 * the stamp reads honestly for each:
 *   - a person adjudicated the held/validation claim (`approved_new`/`matched_existing`) → the
 *     decider's name, the decision time, and the route (field capture vs distributor invoice);
 *   - otherwise Phoenix already recognised it (a catalogue pharmacy, or a verification with no
 *     separate held-lane row) → "by the system", or the verifier's name when one is on file.
 *
 * Pure (only type imports beyond the shared helper) so the human/system split is testable without a
 * database and without dragging in the direct-orders service graph.
 */
export function resolveDirectOrderPharmacyValidationBadge(
  pharmacy:
    | Pick<DirectOrderPharmacy, "verificationStatus" | "verifiedByHrId" | "verifiedAt" | "entrySource">
    | null,
  evidence: Pick<DirectOrderValidationRow, "status" | "decidedByHrId" | "decidedAt" | "validationRoute"> | null,
  nameOf: (hrId: string) => string | null | undefined,
): ValidationBadge | null {
  // Only a recognised pharmacy carries a stamp. pending_review is the order under review; rejected
  // is a refusal — neither is "already validated".
  if (!pharmacy || pharmacy.verificationStatus !== "verified") return null;

  if (evidence && (evidence.status === "approved_new" || evidence.status === "matched_existing")) {
    return buildValidationBadge({
      validated: true,
      isHuman: true,
      byName: evidence.decidedByHrId ? nameOf(evidence.decidedByHrId) ?? evidence.decidedByHrId : null,
      atIso: evidence.decidedAt,
      method: evidence.validationRoute === "invoice" ? "distributor invoice" : "field capture",
    });
  }

  const verifiedBy = pharmacy.verifiedByHrId;
  const isCatalogue = pharmacy.entrySource === "catalogue";
  return buildValidationBadge({
    validated: true,
    // A catalogue pharmacy is a SYSTEM recognition from the distributor's list — in production its
    // `verified_by_hr_id` is ALWAYS set (the operator who bulk-accepted the catalogue, e.g. A-2),
    // never an independent reviewer of THIS venue's evidence — so it yields NO name, mirroring
    // marketing's `system_validated`. Only a hand-entered (`manual`) or transferred pharmacy that a
    // person actually verified names its verifier. `buildValidationBadge` drops `byName` for the
    // system case, so passing it here is harmless.
    isHuman: !isCatalogue && Boolean(verifiedBy),
    byName: verifiedBy ? nameOf(verifiedBy) ?? verifiedBy : null,
    atIso: pharmacy.verifiedAt,
    method: isCatalogue ? "distributor catalogue" : null,
  });
}
