/**
 * The one gate that decides whether a customer-validation submission can be saved — and, in the
 * same pass, the reason it cannot.
 *
 * It used to be two: a boolean `canSave` that disabled the Save button, and a
 * `describeMissingRequirement` that named the first unmet requirement for the screen. They were
 * written to walk the same checks in the same order, with comments on both sides saying so, and
 * they drifted anyway — in exactly the case the comments were about. A nursery carries no
 * distributor code at all, so the reason-giver skips the code checks for one, while the boolean
 * still demanded a distributor and a code on every venue. The codes block is `hidden` for a
 * nursery, so there was no field left to fill: picking "Nursery" greyed the Save button for good
 * and printed no reason, because the reason-giver had nothing to complain about. That is a dead
 * form, and the rep (or the Super Admin validating on someone's behalf) could only guess.
 *
 * So the boolean is now derived from the reason: **Save is enabled exactly when there is nothing
 * left to name.** Two functions, one list of checks, and a new requirement can only ever be added
 * to the list — never to one half of it.
 *
 * The input types are structural on purpose. They name only the fields the gate reads, so the
 * form's own richer `CustomerLine` / `PharmacyLine` / `CaptureState` satisfy them without the
 * component having to hand its state over to a library module.
 */

import {
  CODELESS_VENUES_GO_TO_DIRECT_ORDERS,
  venueWithoutDistributorCodeMessage,
} from "@/lib/marketing-requests/coded-venues-only";
import { describeMissingDoctorPick, type CrmDoctorPickState } from "@/lib/marketing-requests/crm-doctor-pick";
import {
  VENUE_TYPE_UNANSWERED_MESSAGE,
  venueRequiresDistributorCode,
  venueTypeIsAnswered,
  type VenueTypeChoice,
} from "@/lib/venues/venue-type";

/** The evidence fields of a capture: where, when, and the stamped photo itself. */
export type SaveGateCapture = {
  capturedAt: string | null;
  latitude: number | null;
  longitude: number | null;
  photoCapturedAt: string | null;
  photoDataUrl: string | null;
  photoName: string;
};

export type SaveGateVendorCode = {
  distributorCode: string;
  distributorId: string;
};

export type SaveGatePharmacy = {
  capture: SaveGateCapture;
  existingPharmacyId: string;
  /**
   * The pharmacy licence the rep attached, if any. Only its presence is read, to drop blank code
   * rows. Since 2026-10-21 a licence never stands in for a distributor code: a venue with no code
   * is validated in Direct Orders, not here (owner: "any thing with no distributor code never reach
   * the marketing requests").
   */
  license?: unknown;
  name: string;
  source: "new" | "existing";
  vendorCodes: readonly SaveGateVendorCode[];
  venueType: VenueTypeChoice;
};

export type SaveGateCustomer = {
  capture: SaveGateCapture;
  customerComplete: boolean;
  /**
   * The area → doctor pick (owner, 2026-10-23: no free-typed doctor name). Absent on a customer
   * already on record, whose name is locked; present on every new customer line.
   */
  doctorPick?: CrmDoctorPickState;
  name: string;
  pharmacies: readonly SaveGatePharmacy[];
};

/**
 * The pharmacy's code rows as they will be SAVED: all of them, except that once the licence is
 * attached a row with no code typed is dropped. Without a licence nothing is dropped, so a blank
 * row still reads "Enter the distributor code" exactly as before.
 */
export function withoutBlankCodeRows<T extends SaveGateVendorCode>(pharmacy: {
  license?: unknown;
  vendorCodes: readonly T[];
}): readonly T[] {
  if (!pharmacy.license) return pharmacy.vendorCodes;
  return pharmacy.vendorCodes.filter((line) => line.distributorCode.trim() !== "");
}

function hasPin(capture: SaveGateCapture): boolean {
  return capture.latitude !== null && capture.longitude !== null;
}

/**
 * A capture good enough to stand as a venue's proof: a pin, a time, and the stamped photo itself.
 *
 * Mirrors `evidenceStatusFromInput` on the server, which is what actually decides. Kept here so the
 * form only sends a capture for an attached shop when that capture could change anything — an
 * ordinary attach still sends the id and nothing else.
 */
export function hasCompleteCapture(capture: SaveGateCapture): boolean {
  return (
    capture.latitude !== null &&
    capture.longitude !== null &&
    Boolean(capture.capturedAt) &&
    Boolean(capture.photoName) &&
    Boolean(capture.photoCapturedAt) &&
    Boolean(capture.photoDataUrl)
  );
}

/**
 * A customer that is complete and is being saved only to complete its venue, with no venue capture
 * in hand yet. Saving that would write nothing — the customer is never touched and the venue's
 * proof is what was missing — so the form refuses it rather than report a success that did nothing.
 */
export function customerIsVenueOnlyWithoutCapture(customer: SaveGateCustomer): boolean {
  return (
    customer.customerComplete &&
    !customer.pharmacies.some((pharmacy) => pharmacy.source === "existing" && hasCompleteCapture(pharmacy.capture))
  );
}

/**
 * The exact reason Save is blocked, or null when nothing is missing.
 *
 * The Save button is natively `disabled` while the form is incomplete, so a tap never reaches the
 * submit handler and its messages never show — a field rep got no feedback at all about which
 * customer, pharmacy, or code line still needed something, only a button that did nothing. This
 * names the first unmet requirement so the reason is visible without ever having to tap a dead
 * button, and `canSaveMarketingValidation` reads the same answer, so the button and the reason
 * cannot disagree.
 */
export function describeMissingSaveRequirement(
  customers: readonly SaveGateCustomer[],
  isDeskMode: boolean,
): string | null {
  for (const [customerIndex, customer] of customers.entries()) {
    const customerLabel = customer.name.trim() ? `"${customer.name.trim()}"` : `Customer ${customerIndex + 1}`;
    // Area first, then the doctor from that area's CRM lists — or "Not on the list", then a name.
    const missingPick = customer.doctorPick ? describeMissingDoctorPick(customer.doctorPick, customerIndex + 1) : null;
    if (missingPick) return missingPick;
    if (!customer.name.trim()) return `Enter a name for Customer ${customerIndex + 1}.`;
    // Desk mode saves straight to validated, so a missing pin would mint a "validated" customer
    // with no coordinates at all — worse than the field path, where incomplete evidence simply
    // parks the row on pending. Require the pin here instead.
    if (isDeskMode && !hasPin(customer.capture)) return `Pin ${customerLabel}'s location on the map.`;
    if (customer.pharmacies.length === 0) return `${customerLabel} needs at least one pharmacy.`;
    // A customer that is already complete has only its venue left to capture, so saving without one
    // would change nothing and still report success.
    if (customerIsVenueOnlyWithoutCapture(customer)) {
      return `Capture the venue's live photo and location for ${customerLabel} before saving.`;
    }

    for (const [pharmacyIndex, pharmacy] of customer.pharmacies.entries()) {
      const pharmacyLabel = pharmacy.name.trim() ? `"${pharmacy.name.trim()}"` : `Pharmacy ${pharmacyIndex + 1}`;
      // On the My Pharmacies tab there is exactly one thing to get right: which shop. Name, GPS,
      // live photo and distributor codes all come from the record already stored for it.
      if (pharmacy.source === "existing") {
        if (!pharmacy.existingPharmacyId) {
          return `Choose which pharmacy to attach for Pharmacy ${pharmacyIndex + 1} under ${customerLabel}.`;
        }
        continue;
      }
      if (!pharmacy.name.trim()) return `Enter a name for Pharmacy ${pharmacyIndex + 1} under ${customerLabel}.`;
      if (isDeskMode && !hasPin(pharmacy.capture)) return `Pin ${pharmacyLabel}'s location on the map.`;
      // Asked before anything below it, because everything below it depends on the answer. An
      // unanswered type used to read as "pharmacy" and sail straight through this loop.
      if (!venueTypeIsAnswered(pharmacy.venueType)) {
        return `${pharmacyLabel}: ${VENUE_TYPE_UNANSWERED_MESSAGE}`;
      }
      // A venue with no distributor account — a nursery — is not validated in Marketing at all
      // (owner, 2026-10-21). Saying so here, in the server's own sentence, is what keeps Save from
      // greying with no reason: the codes block is not even rendered for one.
      if (!venueRequiresDistributorCode(pharmacy.venueType)) {
        return venueWithoutDistributorCodeMessage(pharmacy.name);
      }
      // A code row the rep left blank beside an attached licence is not a code — the submit drops the
      // same rows (`withoutBlankCodeRows`), so the gate and the payload agree. A licence no longer
      // stands in for a code: with none, the pharmacy belongs to Direct Orders.
      const codeLines = withoutBlankCodeRows(pharmacy);
      if (codeLines.length === 0) {
        return `${pharmacyLabel} needs at least one distributor code. ${CODELESS_VENUES_GO_TO_DIRECT_ORDERS}`;
      }

      for (const [codeIndex, line] of codeLines.entries()) {
        const codeSuffix = pharmacy.vendorCodes.length > 1 ? ` (row ${codeIndex + 1})` : "";
        if (!line.distributorId) return `Pick a distributor for ${pharmacyLabel}${codeSuffix}.`;
        if (!line.distributorCode.trim()) return `Enter the distributor code for ${pharmacyLabel}${codeSuffix}.`;
      }
    }
  }
  return null;
}

/**
 * Whether the submission can be saved: at least one customer, and nothing left to name.
 *
 * Derived from `describeMissingSaveRequirement` rather than re-walking the checks, which is the
 * whole point of this module — a greyed Save button now always has a sentence to go with it.
 */
export function canSaveMarketingValidation(
  customers: readonly SaveGateCustomer[],
  isDeskMode: boolean,
): boolean {
  if (customers.length === 0) return false;
  return describeMissingSaveRequirement(customers, isDeskMode) === null;
}
