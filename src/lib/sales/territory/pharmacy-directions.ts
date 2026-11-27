// ─────────────────────────────────────────────────────────────────────────────
// WHERE A PHARMACY NAME IN THE SALES DRILLDOWN SENDS A REP (owner, 27 Nov 2026).
//
// His ask: tapping a pharmacy's name opens Google Maps to it, and it must never send a rep to the
// wrong place. Two kinds of link, best first:
//
//   1. CONFIRMED ON SITE — a point a rep captured standing at the shop (a validated marketing pharmacy,
//      an approved direct-order venue, or a Phoenix CRM pharmacy place), tied to THIS distributor's
//      customer code. Directions go to the exact point.
//   2. ITS OWN GOOGLE LISTING — a top pharmacy Phoenix matched ONCE to its exact Google Maps place
//      (pharmacy-place-match.ts; he chose "Free top-2,616 match"). The link opens that listing.
//   3. GOOGLE MAPS SEARCH BY NAME — every other pharmacy with a usable name opens a Google Maps search
//      for "صيدلية <its name> <its brick's town>". Google's own search runs on the rep's phone and shows
//      the shop's listing, whose name he checks before he drives.
//
// WHY NOT THE ADDRESS (the first version, his ruling "depend on ibnsina family and pos address"): on the
// PR 821 preview he reported "many of the clickables customers when press google cant find a location".
// Measured on 30 linked pharmacies in Cairo 1 and Giza 1: routing to the sheet address landed on a
// landmark (a district office, a train station, a restaurant, once 146 km away) for every one, because
// the Ibn Sina and POS sheets cut an address at about 30 characters. Searching the pharmacy's own name
// near its brick put the right shop first for about 22 of 30.
//
// WHY NOT PHOENIX MATCHING EACH SHOP ITSELF: that needs Google's paid place search, about 1,000 dollars
// for the ~35,000 drilldown pharmacies; he answered "find a way to keep it free". A search link costs
// nothing — Phoenix calls no Google service for it.
//
// Two refusals keep a confirmed point from being wrong (it then falls back to the search link):
//   - A confirmed point more than MAX_CONFIRMED_POINT_FROM_BRICK_KM from its brick's centre is a
//     mistyped code (the right capture tied to the wrong number).
//   - Confirmed points for one card that disagree by more than CONFIRMED_POINTS_AGREE_KM, or that come
//     from two different distributors under one code (not two Ibn Sina channels, which share one
//     customer list), may be two shops: Phoenix cannot tell which is the one.
//
// PURE: no database, no clock. The reads live in pharmacy-directions-sources.ts.
// ─────────────────────────────────────────────────────────────────────────────

import { haversineKm, isUsablePoint, type Point } from "@/lib/pharmacy-search/geo";

import type { TerritoryPharmacyDirections } from "./types";

/** The Ibn Sina channels: one distributor with one customer list, so a code they share is one shop. */
const IBN_SINA_FAMILY: ReadonlySet<string> = new Set(["IS", "IS-S", "IS-L"]);

/** Beyond this a "confirmed" point is not in its own brick's district — a mistyped distributor code. */
export const MAX_CONFIRMED_POINT_FROM_BRICK_KM = 25;

/** Two captures of the same shop sit metres apart; past this they are two different places. */
export const CONFIRMED_POINTS_AGREE_KM = 0.3;

/** A name with fewer letters than this says nothing Google can search for. */
const MIN_NAME_LETTERS = 3;

/**
 * Words the distributor sheets add to a customer's name that are not part of the shop's name: the
 * payment terms ("نقدي" cash, "اجل" credit) and the sheets' single-letter channel marks ("ن", "ن.م").
 * Left in, they make Google look for a shop that does not exist under that name.
 */
export const SHEET_NAME_MARKS: ReadonlySet<string> = new Set(["ن", "ن.م", "نم", "نقدي", "نقدى", "اجل", "آجل", "أجل"]);

export type PharmacySourceRow = {
  clientCode: string;
  distributorCode: string;
  clientName: string | null;
  clientAddress: string | null;
  brickId: string;
};

export type ConfirmedPharmacyPoint = Point & {
  distributorCode: string;
  clientCode: string;
};

/** A Google place Phoenix matched to one (distributor, customer code) — the place id only. */
export type MatchedPharmacyPlace = {
  distributorCode: string;
  clientCode: string;
  placeId: string;
};

export type PickDirectionsInput = {
  /** Every distributor row behind ONE pharmacy card (one customer code). */
  sources: readonly PharmacySourceRow[];
  /** The name the card shows — the name the search link looks for. */
  displayName: string;
  /** Confirmed points for any of those (distributor, code) pairs; the picker filters them again. */
  confirmedPoints: readonly ConfirmedPharmacyPoint[];
  /** Matched Google places for any of those pairs; used only when they all agree on one place. */
  matchedPlaces?: readonly MatchedPharmacyPlace[];
  /** Brick id → its name (the town), added to the search. */
  brickNames: ReadonlyMap<string, string>;
  /** Brick id → its centre, for the mistyped-code check. A brick with no centre skips that check. */
  brickCentroids: ReadonlyMap<string, Point>;
};

function normalizeCode(value: string | null | undefined): string {
  return String(value ?? "").trim().toUpperCase();
}

/** Which distributor a row belongs to for the "two shops under one number" check. */
function distributorFamily(code: string): string {
  return IBN_SINA_FAMILY.has(code) ? "IBN SINA" : code;
}

/** Google Maps directions to an exact point — the phone opens the Maps app. */
export function googleMapsDirectionsUrl(destination: Point): string {
  const value = `${destination.latitude.toFixed(6)},${destination.longitude.toFixed(6)}`;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(value)}`;
}

/**
 * One exact Google Maps listing: the search text is what shows if the place id cannot be read, the
 * place id is what Google opens. Free — no Google service is called to build it.
 */
export function googleMapsPlaceUrl(searchText: string, placeId: string): string {
  return `${googleMapsSearchUrl(searchText)}&query_place_id=${encodeURIComponent(placeId)}`;
}

/** A Google Maps search — the phone opens the Maps app on the matching listings. */
export function googleMapsSearchUrl(searchText: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(searchText)}`;
}

function tidy(value: string | null | undefined): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * What Google is asked for: "صيدلية" (unless the name already says pharmacy), the name without the
 * sheet's payment and channel marks or its dashes, then the brick's town unless the name already
 * carries it. Null when too little of a name is left to search for.
 */
export function pharmacySearchText(name: string | null | undefined, brickName: string | null | undefined): string | null {
  const words = tidy(String(name ?? "").replace(/[-–—_/\\|]+/g, " "))
    .split(" ")
    .filter((word) => word && !SHEET_NAME_MARKS.has(word));
  const core = words.join(" ");
  const letters = core.replace(/[^A-Za-zء-ي]/g, "");
  if (letters.length < MIN_NAME_LETTERS) return null;
  const parts = [/صيدل|pharm/i.test(core) ? core : `صيدلية ${core}`];
  const town = tidy(brickName);
  if (town && town !== "(unmapped)" && !core.includes(town)) parts.push(town);
  return parts.join(" ");
}

/** The one confirmed point for a card, or null when there is none it can trust. */
function pickConfirmedPoint(input: PickDirectionsInput): Point | null {
  const families = new Set(input.sources.map((source) => distributorFamily(normalizeCode(source.distributorCode))));
  if (families.size > 1) return null;
  const pairs = new Map<string, string>();
  for (const source of input.sources) {
    pairs.set(`${normalizeCode(source.distributorCode)}|${source.clientCode.trim()}`, source.brickId);
  }
  const usable: Point[] = [];
  for (const point of input.confirmedPoints) {
    const brickId = pairs.get(`${normalizeCode(point.distributorCode)}|${point.clientCode.trim()}`);
    if (brickId === undefined || !isUsablePoint(point.latitude, point.longitude)) continue;
    const centre = input.brickCentroids.get(brickId);
    if (centre && haversineKm(point, centre) > MAX_CONFIRMED_POINT_FROM_BRICK_KM) continue;
    usable.push({ latitude: point.latitude, longitude: point.longitude });
  }
  if (usable.length === 0) return null;
  const first = usable[0];
  return usable.every((point) => haversineKm(point, first) <= CONFIRMED_POINTS_AGREE_KM) ? first : null;
}

/**
 * The one matched Google place for a card, or null. Like a confirmed point, it is not trusted when the
 * card's code belongs to two distributors (two shops may share it), or when its pairs matched
 * different places.
 */
function pickMatchedPlace(input: PickDirectionsInput): string | null {
  const families = new Set(input.sources.map((source) => distributorFamily(normalizeCode(source.distributorCode))));
  if (families.size > 1) return null;
  const pairs = new Set(input.sources.map((source) => `${normalizeCode(source.distributorCode)}|${source.clientCode.trim()}`));
  const placeIds = new Set(
    (input.matchedPlaces ?? [])
      .filter((place) => place.placeId.trim() && pairs.has(`${normalizeCode(place.distributorCode)}|${place.clientCode.trim()}`))
      .map((place) => place.placeId.trim()),
  );
  return placeIds.size === 1 ? [...placeIds][0] : null;
}

/** Where tapping this pharmacy's name sends a rep — or null, and then the name is not a link. */
export function pickPharmacyDirections(input: PickDirectionsInput): TerritoryPharmacyDirections | null {
  if (input.sources.length === 0) return null;

  const confirmed = pickConfirmedPoint(input);
  if (confirmed) {
    return { kind: "confirmed_on_site", url: googleMapsDirectionsUrl(confirmed), searchText: null };
  }

  const searchText = pharmacySearchText(input.displayName, input.brickNames.get(input.sources[0].brickId));
  if (!searchText) return null;
  const placeId = pickMatchedPlace(input);
  if (placeId) return { kind: "google_place", url: googleMapsPlaceUrl(searchText, placeId), searchText };
  return { kind: "google_search", url: googleMapsSearchUrl(searchText), searchText };
}
