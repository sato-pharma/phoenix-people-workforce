/**
 * Phoenix CRM — a place is checked against the account's own Google Maps listing before it is accepted.
 *
 * Owner, 2026-10-03, after Delta (1)'s first morning (four Benha hospitals validated on one 2 km point):
 *   "this will be the first step when the system is accepting or rejecting validation of a place. First
 *    … you will check that this is the correct account or hospital they are validating. If you confirm
 *    this, then you will compare their validation versus the Google Maps."
 * and his answers, asked in chat the same hour:
 *   · the match line is 150 m between the validated point and the listing's pin;
 *   · a validation that does NOT match is blocked at the door;
 *   · an account Google has no listing for is held for review — "only system admin can approve or
 *     reject … show him that it's automated from system";
 *   · and, asked once more the same day, a listing that IS the account but sits more than
 *     GOOGLE_STALE_PIN_METERS away is held too, never refused ("hold it for me"). Al-Menshawy moved to
 *     the new Tanta General building in Sibirai and Google kept its pin on the old site, 3.6 km off —
 *     a refusal there could never be passed by standing anywhere, so it would lock the hospital out.
 *
 * 🔴 STEP 1 IS THE ACCOUNT, AND IT IS JUDGED ON THE CUSTOMER'S NAME FROM THE LIST, NEVER THE NAME THE REP
 * TYPED FOR THE PLACE. The label is his; a rep standing at the wrong clinic could type that clinic's
 * Google name and pass his own check. The list's name came from iReports360 or the SFE's sheet.
 *
 * 🔴 iREPORTS360 IS NOT A REFERENCE FOR ANY OF THIS (owner, the same day: "forget the ireport data,
 * never compare with it now"). Its check-ins come from the rep's own phone; Google is independent.
 *
 * AM accounts only — hospitals, health units, contracts — "especially in the AM accounts". A private
 * doctor's clinic is too often missing from Google for a hold to mean anything.
 *
 * No I/O here: the lookup lives in server/google-place-check.ts, and these rules are pinned by
 * tests/phoenix-crm-google-place-check.test.ts on the real validations of 3 Oct 2026.
 */

import { distanceMeters, type GeoPoint } from "@/lib/phoenix-crm/geo";
import type { PhoenixCrmListType } from "@/lib/phoenix-crm/types";

/** The owner's line, 2026-10-03: a validated point within this of the account's Google pin matches. */
export const GOOGLE_MATCH_METERS = 150;

/**
 * Past this the account's pin is too far to be a rep standing at the wrong door — the hospital moved or
 * Google's pin is old — so the validation is held for the Super Admin rather than refused (owner,
 * 2026-10-03). Between the two lines it is refused at the door.
 */
export const GOOGLE_STALE_PIN_METERS = 1000;

/** Which customers get the check. */
export function googleCheckApplies(listType: PhoenixCrmListType): boolean {
  return listType === "AM";
}

/** One Google Maps listing as the lookup returns it. */
export type GoogleListing = {
  placeId: string;
  name: string;
  lat: number;
  lon: number;
  mapsUri: string | null;
};

export type GooglePlaceVerdict =
  /** The account is on Google and the rep stood at it. */
  | { kind: "match"; listing: GoogleListing; distanceMeters: number }
  /** The account is on Google, and the rep's point is not at it — refused at the door. */
  | { kind: "mismatch"; listing: GoogleListing; distanceMeters: number }
  /** The account is on Google, more than GOOGLE_STALE_PIN_METERS away — held for the Super Admin. */
  | { kind: "far_listing"; listing: GoogleListing; distanceMeters: number }
  /** Google has no listing the system is sure is this account — held for the Super Admin. */
  | { kind: "no_listing"; reason: "no_confident_listing" | "lookup_failed" };

// ── Step 1: is this listing the account? ────────────────────────────────────────────────────────

const ARABIC_MARKS = /[ً-ٰٟـ]/g;

/** One spelling for the letters Arabic writes several ways: أ إ آ → ا, ى → ي, ة → ه, ؤ → و, ئ → ي. */
export function normalizeName(value: string): string {
  return value
    .normalize("NFKC")
    .replace(ARABIC_MARKS, "")
    .replace(/[إأآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Words that say what KIND of place it is, never WHICH one — "hospital", "general". A listing may drop
 * them ("مستشفى المحلة الكبرى العام" against the list's "مستشفى المحلة العام") without being another
 * account, so they never count for or against a match.
 */
const KIND_WORDS = new Set(["مستشفي", "مستشفيات", "عام", "hospital", "general", "clinic", "center", "centre"]);

/** A word with its attached prefix taken off: و, then one of بال · لل · ال · ب. Short words are left. */
export function stemWord(word: string): string {
  let stem = word;
  if (stem.startsWith("و") && stem.length > 3) stem = stem.slice(1);
  for (const prefix of ["بال", "لل", "ال", "ب"]) {
    if (stem.startsWith(prefix) && stem.length - prefix.length >= 3) return stem.slice(prefix.length);
  }
  return stem;
}

function editDistanceAtMostOne(left: string, right: string): boolean {
  if (left === right) return true;
  if (Math.abs(left.length - right.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (left.length > right.length) i += 1;
    else if (right.length > left.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  return edits + (left.length - i) + (right.length - j) <= 1;
}

/** The words that name WHICH account it is, stemmed. Empty for a name made only of kind words. */
export function distinctiveWords(name: string): string[] {
  return [...new Set(normalizeName(name).split(" ").filter(Boolean).map(stemWord))].filter((word) => !KIND_WORDS.has(word));
}

/**
 * Whether a Google listing is the customer on the list.
 *
 * Each distinctive word of the customer's name must appear in the listing — as a word, one letter off
 * for a word of four letters or more ("اشمون" / "بشمون"), or inside the listing's name with the spaces
 * taken out ("كفر الشيخ" / "كفرالشيخ"). A name of three or more distinctive words may miss one. A name
 * with no distinctive word at all matches nothing: "مستشفى" alone names no account.
 */
export function listingIsAccount(customerName: string, listingName: string): boolean {
  const wanted = distinctiveWords(customerName);
  if (wanted.length === 0) return false;
  const listingWords = normalizeName(listingName).split(" ").filter(Boolean).map(stemWord);
  const compact = normalizeName(listingName).replace(/\s+/g, "");
  const found = wanted.filter(
    (word) =>
      listingWords.some((candidate) => candidate === word || (word.length >= 4 && candidate.length >= 4 && editDistanceAtMostOne(word, candidate))) ||
      (word.length >= 3 && compact.includes(word)),
  ).length;
  return found === wanted.length || (wanted.length >= 3 && found >= wanted.length - 1);
}

// ── Step 2: did he stand at it? ─────────────────────────────────────────────────────────────────

/**
 * The verdict on one validation. `listings` are Google's answers for the customer's name searched around
 * the validated point; `null` means the lookup itself failed (no key, Google down, a timeout).
 *
 * Of the listings that ARE the account, the nearest one decides: a chain with a branch at the door is
 * never refused for its branch across town.
 */
export function judgeGooglePlace(input: { customerName: string; point: GeoPoint; listings: GoogleListing[] | null }): GooglePlaceVerdict {
  if (input.listings === null) return { kind: "no_listing", reason: "lookup_failed" };
  const sameCustomer = input.listings
    .filter((listing) => listingIsAccount(input.customerName, listing.name))
    .map((listing) => ({ listing, distance: Math.round(distanceMeters(input.point, { lat: listing.lat, lon: listing.lon })) }))
    .sort((left, right) => left.distance - right.distance);
  const nearest = sameCustomer[0];
  if (!nearest) return { kind: "no_listing", reason: "no_confident_listing" };
  if (nearest.distance <= GOOGLE_MATCH_METERS) return { kind: "match", listing: nearest.listing, distanceMeters: nearest.distance };
  if (nearest.distance > GOOGLE_STALE_PIN_METERS) return { kind: "far_listing", listing: nearest.listing, distanceMeters: nearest.distance };
  return { kind: "mismatch", listing: nearest.listing, distanceMeters: nearest.distance };
}

// ── What the rep reads ──────────────────────────────────────────────────────────────────────────

/** Where a customer's Google check stands for the rep: being checked, turned down, or nothing to say. */
export type LocationCheckState = "checking" | "not_confirmed" | null;

/**
 * The refusal at the door. It names the rule he was sent on 3 Oct 2026 ("within 150 m"), and nothing
 * about a person or a check of HIM: the place is what failed.
 */
export function googleMismatchMessage(customerName: string): string {
  return `This location is not at ${customerName} on Google Maps (it must be within ${GOOGLE_MATCH_METERS} m). Stand at its entrance, then take the photo and press Capture location again.`;
}

/**
 * A held validation, as the rep reads it. AUTOMATED, by the owner's word: "do not show the rep that a
 * person is accepting or rejecting; show him that it's automated from system". No name, no role, no
 * "review" — the system is checking, and the system answers.
 */
export const LOCATION_CHECKING_TITLE = "The system is checking the location";
export const LOCATION_CHECKING_TEXT =
  "The system checks every new place against the map before it is confirmed, and it confirms this one automatically. Until then the customer stays under To validate.";
export const LOCATION_CHECKING_PILL = "Location being checked";
export const LOCATION_NOT_CONFIRMED_PILL = "Validate again";
/** After the check could not confirm it — the customer is back under To validate. */
export const LOCATION_NOT_CONFIRMED_TEXT =
  "The system could not confirm this location. Validate the customer again, standing at the entrance with precise location on.";
