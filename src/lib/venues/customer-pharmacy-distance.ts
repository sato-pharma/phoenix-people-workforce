import { type CaptureFix, distanceBetweenFixesMeters } from "@/lib/evidence/capture-trust";

// ─────────────────────────────────────────────────────────────────────────────
// THE 4 KM RULE — a pharmacy cannot be linked to a customer it could not plausibly serve.
//
// WHY THIS EXISTS. The whole purpose of marketing validation is to establish that the pharmacies
// attached to a doctor are the ones his prescriptions are actually dispensed through, because the
// request's ROI is measured from those pharmacies' sales. A shop on the other side of the country
// cannot be that, so a link across such a distance makes the ROI figure meaningless no matter how
// good the photographs are.
//
// WHY IT IS NOT THE GUARD AGAINST A WRONG CODE, and do not "improve" it into one. The two real
// incidents this rule was written alongside were BOTH wrong distributor codes on shops standing
// next to the doctor — 18 m in one case, 59 m in the other (house 74 and house 75 of the same
// street). Neither would have tripped this rule at any threshold, and a tighter threshold would
// not have caught them either; it would only have refused honest work. The wrong-code class is
// caught by the governorate comparison in `marketing-requests/service.ts`, not here.
//
// WHY 4 KM, AND WHY IT IS NOT NEGOTIABLE DOWNWARD WITHOUT THE OWNER. Set by the owner on
// 2026-09-29 after being shown what each candidate threshold would have refused across the 127
// live customer-pharmacy links carrying GPS on both sides:
//
//     > 200 m   15 links refused   11.8%
//     > 300 m   13 links refused   10.2%
//     > 500 m    5 links refused    3.9%
//     > 750 m    3 links refused    2.4%
//     > 1 km     2 links refused    1.6%
//     > 1.5 km   0 links refused
//     > 4 km     0 links refused       <- the ruling
//
// The furthest honest pair in production is 1,069 m — a clinic and its pharmacy 1 km apart inside
// one area. The median is 23 m and 80% sit within 100 m. So 4 km refuses nothing that has ever
// been captured, with a margin of nearly 4x over the worst real case. That margin IS the design:
// the owner's standing rule is that a threshold must be set so an honest rep cannot trip it,
// because a false positive accuses a real person of dishonesty and that is worse than a missed
// catch. Anyone tempted to tighten this because 4 km "feels" loose should re-measure the live
// distribution first and take the number to the owner, not edit the constant.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The furthest a pharmacy may sit from the customer it is being linked to.
 *
 * Owner ruling, 2026-09-29. See the header for the measured distribution behind it.
 */
export const VENUE_LINK_MAX_METRES = 4000;

export type VenueDistanceVerdict =
  /** One side has no coordinates, so no comparison was made. NEVER read this as "close enough". */
  | "not_comparable"
  /** Within {@link VENUE_LINK_MAX_METRES}. */
  | "within_range"
  /** Beyond the limit — the link is refused. */
  | "too_far";

export type VenueDistanceCheck = {
  /** Metres between the two captures, or null when the pair could not be compared. */
  distanceMeters: number | null;
  /** True only for `too_far`. A `not_comparable` pair is never refused. */
  refused: boolean;
  verdict: VenueDistanceVerdict;
};

/**
 * Compare a customer's capture against a pharmacy's.
 *
 * A missing fix on either side yields `not_comparable` and refuses NOTHING. That asymmetry is
 * deliberate and matches how every other gate in this module family behaves: Phoenix's own data
 * gaps must never be turned into evidence against a rep. A desk-entered customer, an older record
 * captured before GPS was required, or a handset that refused permission would otherwise become
 * un-linkable — punishing the rep for a hole in our records rather than anything he did.
 */
export function checkCustomerPharmacyDistance(
  customer: CaptureFix | null | undefined,
  pharmacy: CaptureFix | null | undefined,
): VenueDistanceCheck {
  const distanceMeters = distanceBetweenFixesMeters(customer, pharmacy);
  if (distanceMeters === null) {
    return { distanceMeters: null, refused: false, verdict: "not_comparable" };
  }
  if (distanceMeters > VENUE_LINK_MAX_METRES) {
    return { distanceMeters, refused: true, verdict: "too_far" };
  }
  return { distanceMeters, refused: false, verdict: "within_range" };
}

/**
 * What the rep is told when the link is refused.
 *
 * Says the distance and nothing else. It does NOT imply he was somewhere he should not have been,
 * does not mention checking, and does not hint that anything was recorded about him — the most
 * likely cause by far is that he picked the wrong shop from a list, and the message should read
 * that way to someone who did exactly that. Rounded to whole kilometres above 1 km so the number
 * reads as a distance rather than as a measurement of him.
 */
export function venueTooFarMessage(input: {
  customerName: string;
  distanceMeters: number;
  pharmacyName: string;
}): string {
  const km = input.distanceMeters / 1000;
  const distance = km >= 10 ? `${Math.round(km)} km` : `${km.toFixed(1)} km`;
  return `${input.pharmacyName} is ${distance} away from ${input.customerName}, so it cannot be linked to them. Please check you picked the right pharmacy.`;
}
