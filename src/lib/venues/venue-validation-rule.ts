/**
 * The owner's rule for validating a venue, stated once so every desk enforces the same one.
 *
 * HIS WORDS, 2026-08-26: "to be validated, of course, a location and a picture, a live picture.
 * This is a must. Plus either the pharmacy code, and it is in our database, or the pharmacy
 * license, if the pharmacy code is not in our database."
 *
 * Three legs, and the third is an EITHER/OR — never both:
 *
 *   1. a GPS location            — always a must
 *   2. a live picture            — always a must
 *   3. an identity route         — the CODE when it is in our database, otherwise the LICENCE
 *
 * WHAT THE THIRD LEG IS FOR. Legs 1 and 2 answer "is this shop where the rep says it is". Neither
 * answers "is this shop WHO it says it is", and for a pharmacy that second question is normally
 * answered by somebody else: a code in a distributor's book means a real company invoiced a real
 * pharmacy under that name. A venue with no such code gets none of that, and it is precisely the
 * venue an approver is being asked to mint a brand-new identity for. The licence closes it — the
 * trade name printed on it is compared against the name on the shop sign in the storefront photo
 * the same submission already carries.
 *
 * THE LICENCE IS A ROUTE, NOT EVIDENCE. It is never required of a venue whose code already resolves;
 * that venue is identified and asking for a document as well is asking twice. This was worth writing
 * down because it had been read the other way round — "reps are not uploading licences" was called
 * the gap, and the owner corrected it.
 *
 * WHY IT IS HERE AND NOT AT EACH DESK. Two modules register venues — direct orders and marketing —
 * and before this file the rule lived in neither: measured on production 2026-08-26, three venues
 * had been approved as brand new carrying no code in the master database and no licence, two of them
 * nurseries. A rule that exists only as an instruction is a rule that fires nowhere.
 */

import { venueRequiresDistributorCode, venueTypeLabel, type VenueType } from "@/lib/venues/venue-type";

/** Leg 1. One sentence, so every capture point refuses in the same words. */
export const VENUE_LOCATION_REQUIRED_MESSAGE =
  "Turn on location and let the pin settle before you send this — where the venue stands is half of what proves it exists.";

/**
 * How leg 3 was satisfied, or that it was not satisfied at all.
 *
 * Three-valued rather than a boolean because the two ways of passing are not interchangeable to a
 * reader: "the distributor's book vouches for it" and "somebody attached a document" carry different
 * weight on the same row a year later.
 */
export type VenueIdentityRoute = "code" | "licence" | "none";

// WHAT "IN OUR DATABASE" MEANS — the note for whoever enforces leg 3 on the MARKETING side next.
//
// Direct orders answer it by looking the pair up in `source_of_sales_customer_map`; see
// `countVenueCodesInMasterDatabase`, the only caller that exists today. Marketing answers a
// different way, through `reference_status` on `marketing_pharmacy_distributor_codes`, and when that
// side is wired the judgement must be: ONLY AN EXPLICIT `not_found` IS AN ABSENCE. `ambiguous` means
// the code is in the database more than once and `pending` means the matcher has not reached it yet;
// neither is an absence, and treating them as one would demand a licence for every genuinely new
// pharmacy on the day it is added. That is the scoping the capture gate in
// `prepareMarketingRequestDraft` was given at the owner's instruction, and the same principle as the
// 2026-08-12 ruling: a gap in Phoenix's own point-in-time import must never be read as evidence
// against a rep.
//
// No predicate is exported for it here on purpose — nothing would call one yet, and a rule declared
// but invoked by nothing claims a coverage it does not have.

/**
 * Which of the two routes identifies this venue.
 *
 * The code wins when both are present. That is not a preference between documents — it is the order
 * the owner said them in, and it keeps the answer stable: a venue that resolves by code reads the
 * same before and after somebody happens to attach a licence to it.
 *
 * THE CODE ROUTE IS CLOSED TO A VENUE THAT HAS NO DISTRIBUTOR ACCOUNT, and this is the subtle half.
 * A nursery cannot hold a real code, so a code that appears to resolve for one was fabricated to get
 * past a form — and two such codes were written into `source_of_sales_customer_map`, where they now
 * resolve exactly like real ones and would otherwise hand the venue a clean pass. Verifying the code
 * against the master database is not enough on its own; the master database is where the invented
 * ones ended up.
 */
export function resolveVenueIdentityRoute(input: {
  codesInOurDatabase: number;
  hasLicenseOnFile: boolean;
  venueType: VenueType;
}): VenueIdentityRoute {
  if (venueRequiresDistributorCode(input.venueType) && input.codesInOurDatabase > 0) return "code";
  if (input.hasLicenseOnFile) return "licence";
  return "none";
}

/** Leg 3, as a yes or no. */
export function venueIdentityIsEstablished(input: {
  codesInOurDatabase: number;
  hasLicenseOnFile: boolean;
  venueType: VenueType;
}): boolean {
  return resolveVenueIdentityRoute(input) !== "none";
}

/**
 * What to say to the person who cannot proceed, or null when leg 3 is satisfied.
 *
 * Two sentences for two different venues, because the way out is genuinely different. A pharmacy has
 * both routes open and should be told so — most of the time the right answer is that the pharmacy
 * already exists under another spelling and should be matched, not minted. A NURSERY HAS ONLY ONE
 * ROUTE: it has no distributor account by its nature, so no code of its can ever be in our database,
 * and the licence is the only thing left. That is not a technicality — it is exactly how the three
 * invented nursery codes came to exist, written by people who had no other way to register a venue.
 */
export function venueIdentityGapMessage(input: {
  codesInOurDatabase: number;
  hasLicenseOnFile: boolean;
  venueType: VenueType;
}): string | null {
  if (venueIdentityIsEstablished(input)) return null;

  if (!venueRequiresDistributorCode(input.venueType)) {
    const label = venueTypeLabel(input.venueType).toLowerCase();
    return input.codesInOurDatabase > 0
      ? `A ${label} has no distributor account, so the code written against this one was invented to satisfy a form and cannot identify it. Attach the licence before approving this venue.`
      : `A ${label} has no distributor account, so a code can never identify it and the licence is the only thing that can. Attach the licence before approving this venue.`;
  }

  return "This venue has no distributor code in the master database, so nothing but the rep's own words says who it is. Match it to the real customer it already is, or attach the pharmacy licence (رخصة الصيدلية) so the trade name can be checked against the shop sign.";
}
