/**
 * The four things a direct-order venue can be missing, as one vocabulary.
 *
 * These already existed as inline counts on the registry — `pendingCount`, `uncodedCount`,
 * `unlinkedCount` — displayed and then unusable: a number tells you 37 venues have a hole, and
 * leaves you to find them by scrolling. Pulling the predicates here lets the same rule drive the
 * count AND the filter, so the chip can never say 37 while the list shows a different 37.
 *
 * WHY `pharmacist` IS NOT A VALIDATION FAILURE. A venue picked from the distributor directory has
 * no pharmacist to record — the customer map carries a name, an address and a brick, and nothing
 * about who stands behind the counter. Measured 2026-09-08: every one of the 16 venues a rep typed
 * in has a pharmacist, and 37 of the 38 that came from the catalogue do not. Requiring the field on
 * that path would not fill it; it would invent it, which is how "829575 \ 1533576" reached
 * production as a customer code. So the gap is surfaced to be filled by someone who knows, never
 * enforced at the point where nobody does.
 */

export type VenueGap = "pending" | "uncoded" | "unlinked" | "pharmacist";

/** The shape each predicate needs — a structural subset, so callers can pass their own row type. */
export type VenueGapCandidate = {
  crmContactId: number | null;
  distributorCodes: ReadonlyArray<unknown>;
  doctorName: string | null;
  venueType?: string | null;
  verificationStatus: string;
};

/**
 * Is the pharmacist missing?
 *
 * Blank counts as missing. A row saved with a space in the box is not a recorded pharmacist, and
 * treating `""` as filled is how a gap disappears from a count while still showing an empty column
 * on the report — the count and the eye would disagree, and the count would be the one believed.
 */
export function isMissingPharmacist(venue: VenueGapCandidate): boolean {
  return (venue.doctorName ?? "").trim().length === 0;
}

/** No distributor code: this venue's distributor sales cannot be attributed back to it. */
export function isMissingDistributorCode(venue: VenueGapCandidate): boolean {
  return venue.distributorCodes.length === 0;
}

/** Not linked to a CRM contact, so no trade badge reaches the rep's own list. */
export function isMissingCrmLink(venue: VenueGapCandidate): boolean {
  return venue.crmContactId === null;
}

/** Still waiting for a System Admin to confirm it. */
export function isAwaitingConfirmation(venue: VenueGapCandidate): boolean {
  return venue.verificationStatus === "pending_review";
}

const PREDICATES: Record<VenueGap, (venue: VenueGapCandidate) => boolean> = {
  pending: isAwaitingConfirmation,
  uncoded: isMissingDistributorCode,
  unlinked: isMissingCrmLink,
  pharmacist: isMissingPharmacist,
};

/** Does this venue have the named gap? One entry point, so count and filter cannot drift apart. */
export function venueHasGap(venue: VenueGapCandidate, gap: VenueGap): boolean {
  return PREDICATES[gap](venue);
}

/** Count every gap in one pass, for the chips. */
export function countVenueGaps(
  venues: ReadonlyArray<VenueGapCandidate>,
): Record<VenueGap, number> {
  const counts: Record<VenueGap, number> = { pending: 0, uncoded: 0, unlinked: 0, pharmacist: 0 };
  for (const venue of venues) {
    for (const gap of Object.keys(PREDICATES) as VenueGap[]) {
      if (PREDICATES[gap](venue)) counts[gap] += 1;
    }
  }
  return counts;
}
