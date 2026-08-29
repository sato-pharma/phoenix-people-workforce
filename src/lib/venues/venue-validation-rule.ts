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
 * AMENDED 2026-08-29, AND THE AMENDMENT IS ABOUT WHO THE RULE WAS EVER ABOUT. His words: "you must
 * know that pharmacy is the one that have distributor and distributor code. Nursery does not have
 * distributor code or license. So nursery, they are validated by location and live photo, and then
 * it's approval depends on the admin."
 *
 * Leg 3 is a rule about PHARMACIES. Both of its routes are documents of the pharmacy trade — a code
 * in a distributor's book, or the pharmacy licence (رخصة الصيدلية) — and a venue that is not in that
 * trade holds neither. Reading the leg as universal is what produced the state this amendment ends:
 * a nursery was left exactly one route, that route was a document it does not have, and so the one
 * venue type that could never satisfy leg 3 was the only one required to.
 *
 * It was not a theory. Validation `05c97d18` (عياده دكتور محمد بدوي, filed 2026-08-29 16:01 Cairo by
 * rep b-94) carried a pin accurate to 20m inside the requester's area and a live storefront photo,
 * had no licence because there is no licence for it to have, and could not be approved at all — the
 * desk refused, its direct order stayed `held`, and there was no wording of the refusal a rep or an
 * admin could ever act on.
 *
 * SO FOR A VENUE WITH NO DISTRIBUTOR ACCOUNT, LEGS 1 AND 2 ARE THE WHOLE MECHANICAL GATE and the
 * identity question passes to the admin, deliberately and on the record — `resolveVenueIdentityRoute`
 * answers `"admin"` for it rather than `"none"`, so a row a year later says an approver looked at a
 * pin and a photograph and accepted it, which is the truth of what happened.
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
 * Four-valued rather than a boolean because the ways of passing are not interchangeable to a
 * reader: "the distributor's book vouches for it", "somebody attached a document" and "an admin
 * looked at a pin and a photograph and said yes" carry very different weight on the same row a year
 * later.
 *
 * `"admin"` is the one added on 2026-08-29 and it is not a weaker `"none"` — it is a POSITIVE
 * answer, recording that this venue's identity was never a documentary question in the first place.
 * It is reachable only for a venue with no distributor account, and for such a venue `"none"` is
 * now unreachable: there is no document it could produce that would move it out of that state, so
 * refusing it would be refusing it permanently.
 */
export type VenueIdentityRoute = "code" | "licence" | "admin" | "none";

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
 * ones ended up. That half of the old reading survives this amendment untouched: the fix for "a
 * nursery has no code" is that it is not ASKED for one, never that a fabricated one starts counting.
 *
 * AND THEN THE ADMIN ROUTE, last, for a venue with no distributor account. It is placed after the
 * licence rather than before it so that a document, if one genuinely exists, is still what the row
 * records — but nothing depends on that document existing, which is the whole point of the
 * 2026-08-29 amendment.
 */
export function resolveVenueIdentityRoute(input: {
  codesInOurDatabase: number;
  hasLicenseOnFile: boolean;
  venueType: VenueType;
}): VenueIdentityRoute {
  if (venueRequiresDistributorCode(input.venueType) && input.codesInOurDatabase > 0) return "code";
  if (input.hasLicenseOnFile) return "licence";
  if (!venueRequiresDistributorCode(input.venueType)) return "admin";
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
 * ONE sentence now, and only a pharmacy can ever read it. A pharmacy has both routes open and should
 * be told so — most of the time the right answer is that the pharmacy already exists under another
 * spelling and should be matched, not minted.
 *
 * THE NURSERY SENTENCES THAT USED TO LIVE HERE ARE GONE, 2026-08-29, and their absence is the
 * amendment. They told a nursery to attach a licence it does not have, which is not a way out — it
 * is a permanent refusal worded as an instruction, and it stranded a real order (see the header).
 * A venue with no distributor account now resolves to the `"admin"` route and is never refused here,
 * so this branch is unreachable for one rather than merely unlikely. What guards that venue instead
 * is `venueAdminRouteEvidenceGapMessage` below: the two legs it CAN satisfy have to actually be on
 * the row.
 */
export function venueIdentityGapMessage(input: {
  codesInOurDatabase: number;
  hasLicenseOnFile: boolean;
  venueType: VenueType;
}): string | null {
  if (venueIdentityIsEstablished(input)) return null;

  return "This venue has no distributor code in the master database, so nothing but the rep's own words says who it is. Match it to the real customer it already is, or attach the pharmacy licence (رخصة الصيدلية) so the trade name can be checked against the shop sign.";
}

/**
 * The admin route's own gate: legs 1 and 2 must actually be on the row.
 *
 * WHY THIS EXISTS AT THE DESK when both legs are already refused at capture. For a pharmacy they are
 * corroboration — the code or the licence is what identifies it, and the pin and the photo say where
 * it stands. For a venue on the admin route they are the ENTIRE evidence base, the only two things
 * the owner named, so approving one without them is approving on nothing at all. A rule whose whole
 * content is "location and live photo" has to be able to say when it does not have them.
 *
 * IT CANNOT FIRE ON ANYTHING A REP CAN SEND TODAY, and that is deliberate rather than accidental:
 * filing refuses a submission with no coordinates (`VENUE_LOCATION_REQUIRED_MESSAGE`) and cannot
 * store a row without parsing the live photo first, so both are already true of every validation in
 * production — checked 2026-08-29, all of them carry both. This is a consistency assertion standing
 * behind the capture gate, not a second demand on anybody, and it must never become one: if it ever
 * starts firing, the bug is upstream at capture and the message says so.
 *
 * Silent for a pharmacy — its identity is not this function's business, and a pharmacy that reaches
 * the desk short of a leg is already refused by `venueIdentityGapMessage`.
 */
export function venueAdminRouteEvidenceGapMessage(input: {
  venueType: VenueType;
  hasLocationOnFile: boolean;
  hasLivePhotoOnFile: boolean;
}): string | null {
  if (venueRequiresDistributorCode(input.venueType)) return null;
  if (input.hasLocationOnFile && input.hasLivePhotoOnFile) return null;

  const label = venueTypeLabel(input.venueType).toLowerCase();
  const missing =
    !input.hasLocationOnFile && !input.hasLivePhotoOnFile
      ? "neither a location nor a live photo"
      : !input.hasLocationOnFile
        ? "no location"
        : "no live photo";
  return `A ${label} is validated by its location and a live photo, and this claim has ${missing}. Ask the rep to capture the evidence again from the venue — there is nothing else that can identify a ${label}.`;
}
