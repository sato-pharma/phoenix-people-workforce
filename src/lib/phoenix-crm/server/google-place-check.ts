/**
 * Phoenix CRM — asks Google Maps about the account a rep is validating, and judges the answer.
 *
 * The rules are in ../google-place-rules.ts (owner, 2026-10-03); this file only asks Google and records
 * what it said, so the Super Admin reads the same evidence the system judged on. Four outcomes:
 *   match       → the validation is saved as before, the listing kept on the audit event;
 *   mismatch    → refused at the door, nothing saved — AND the refusal is recorded, so a SECOND
 *                 mismatch on the same account is held instead of refused again (`mismatchIsHeld`);
 *   no_listing  → saved, NOT validated, and held for the Super Admin (`phoenix_crm_validation_reviews`);
 *   far_listing → the same hold: the account's pin is over 1 km off, so it moved or the pin is old.
 *
 * 🔴 A FAILED LOOKUP HOLDS, IT NEVER PASSES AND NEVER BLOCKS. With Google down or the key missing the
 * system cannot confirm the account, which is exactly the owner's "held for review" case — and blocking
 * would stop every AM validation in the field over an outage. The rep is told nothing either way.
 */

import { googlePlacesSearchAround } from "@/lib/google-maps/server";
import { googleCheckApplies, judgeGooglePlace, type GoogleListing, type GooglePlaceVerdict } from "@/lib/phoenix-crm/google-place-rules";
import type { PlacePoint } from "@/lib/phoenix-crm/entry-rules";
import type { PhoenixCrmListType } from "@/lib/phoenix-crm/types";

/** How far around the validated point Google is asked to look. A bias, not a fence. */
const SEARCH_RADIUS_METERS = 5000;
const MAX_LISTINGS = 5;
/** Inside a rep's save at the door: past this the system holds rather than keeps him waiting. */
const LOOKUP_TIMEOUT_MS = 6000;

export type GooglePlaceCheck = {
  verdict: GooglePlaceVerdict;
  /** Exactly what was searched — the customer's name on the list. */
  query: string;
  listings: GoogleListing[];
  checkedAt: string;
};

/** The check for one validation, or null when this customer does not get one (not an AM account). */
export async function checkPlaceOnGoogle(input: {
  customerName: string;
  listType: PhoenixCrmListType;
  point: PlacePoint;
}): Promise<GooglePlaceCheck | null> {
  if (!googleCheckApplies(input.listType)) return null;
  const query = input.customerName.trim();
  const found = await googlePlacesSearchAround(query, { lat: input.point.lat, lng: input.point.lon }, {
    radiusMeters: SEARCH_RADIUS_METERS,
    maxResultCount: MAX_LISTINGS,
    timeoutMs: LOOKUP_TIMEOUT_MS,
  });
  const listings: GoogleListing[] = (found ?? []).map((listing) => ({
    placeId: listing.placeId,
    name: listing.name,
    lat: listing.lat,
    lon: listing.lng,
    mapsUri: listing.mapsUri,
  }));
  return {
    verdict: judgeGooglePlace({ customerName: query, point: input.point, listings: found === null ? null : listings }),
    query,
    listings,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * What the database keeps: on the audit event for a match (`google`), on the review row for a hold
 * (`hold_review`). The point the system judged is kept with it, so the evidence reads on its own.
 */
export function googleCheckRecord(check: GooglePlaceCheck, point: PlacePoint): Record<string, unknown> {
  const verdict = check.verdict;
  return {
    verdict: verdict.kind,
    // A `mismatch` only ever reaches this record when it is being HELD rather than refused again
    // (`mismatchIsHeld`), so its reason is the one the Super Admin's board prints for it.
    reason:
      verdict.kind === "no_listing"
        ? verdict.reason
        : verdict.kind === "far_listing"
          ? "listing_far"
          : verdict.kind === "mismatch"
            ? "listing_off"
            : null,
    query: check.query,
    checkedAt: check.checkedAt,
    point: { lat: point.lat, lon: point.lon, accuracyMeters: point.accuracyMeters, source: point.source },
    listing: verdict.kind === "no_listing" ? null : verdict.listing,
    distanceMeters: verdict.kind === "no_listing" ? null : verdict.distanceMeters,
    listings: check.listings,
  };
}
