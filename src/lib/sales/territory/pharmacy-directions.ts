// ─────────────────────────────────────────────────────────────────────────────
// WHERE A PHARMACY NAME IN THE SALES DRILLDOWN SENDS A REP (owner, 27 Nov 2026).
//
// His ask: tapping a pharmacy's name opens Google Maps directions to it, and it must never send a rep
// to the wrong place. His ruling when told only 157 of ~50,000 pharmacies had a location confirmed on
// site: "depend on ibnsina family and pos address to route through google maps". So there are two
// kinds of link, best first, and nothing else:
//
//   1. CONFIRMED ON SITE — a point a rep captured standing at the shop (a validated marketing pharmacy,
//      an approved direct-order venue, or a Phoenix CRM pharmacy place), tied to THIS distributor's
//      customer code. Directions go to the exact point.
//   2. DISTRIBUTOR ADDRESS — the shop's address on the Ibn Sina family (IS, IS-S, IS-L) or POS (PS)
//      sheet, with the brick's town added because those sheets cut an address at about 30
//      characters ("رقية شارع مستشفى المعلمين الزق"). Google finds the street live.
//
// Every other pharmacy has NO link. Geocoding the other distributors' addresses is exactly what put
// 2,482 different pharmacies on one point (a town centre) in geo_locations — a link that lands a rep
// there wastes his morning, which is the one thing the owner said this must not do.
//
// Three refusals keep a link from being wrong rather than merely missing:
//   - A card whose customer code comes from two different distributors (not two Ibn Sina channels,
//     which share one customer list) may be two shops under one number, so it gets no link at all.
//   - A confirmed point more than MAX_CONFIRMED_POINT_FROM_BRICK_KM from its brick's centre is a
//     mistyped code (the right capture tied to the wrong number), so it is not used.
//   - Confirmed points for one card that disagree by more than CONFIRMED_POINTS_AGREE_KM are not
//     used: Phoenix cannot tell which shop is the one, so it falls back to the address rule.
//
// PURE: no database, no clock. The reads live in pharmacy-directions-sources.ts.
// ─────────────────────────────────────────────────────────────────────────────

import { haversineKm, isUsablePoint, type Point } from "@/lib/pharmacy-search/geo";

import type { TerritoryPharmacyDirections } from "./types";

/** The distributors whose sheet address is trusted for directions — his ruling, by code. */
export const ADDRESS_ROUTING_DISTRIBUTORS: ReadonlySet<string> = new Set(["IS", "IS-S", "IS-L", "PS"]);

/** The Ibn Sina channels: one distributor with one customer list, so a code they share is one shop. */
const IBN_SINA_FAMILY: ReadonlySet<string> = new Set(["IS", "IS-S", "IS-L"]);

/** Beyond this a "confirmed" point is not in its own brick's district — a mistyped distributor code. */
export const MAX_CONFIRMED_POINT_FROM_BRICK_KM = 25;

/** Two captures of the same shop sit metres apart; past this they are two different places. */
export const CONFIRMED_POINTS_AGREE_KM = 0.3;

/** An address shorter than this many letters or digits says nothing Google can route to. */
const MIN_ADDRESS_CHARACTERS = 6;

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

export type PickDirectionsInput = {
  /** Every distributor row behind ONE pharmacy card (one customer code). */
  sources: readonly PharmacySourceRow[];
  /** Confirmed points for any of those (distributor, code) pairs; the picker filters them again. */
  confirmedPoints: readonly ConfirmedPharmacyPoint[];
  /** Brick id → its name (the town), for the address link. */
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

/** Google Maps directions to an exact point or to an address — the phone opens the Maps app. */
export function googleMapsDirectionsUrl(destination: Point | string): string {
  const value =
    typeof destination === "string"
      ? destination
      : `${destination.latitude.toFixed(6)},${destination.longitude.toFixed(6)}`;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(value)}`;
}

/** Collapse the spacing and stray separators a distributor sheet leaves around an address. */
function tidyAddress(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-–—,،.]+|[\s\-–—,،.]+$/g, "")
    .trim();
}

/**
 * The address a link routes to: the sheet's address, then the brick's town unless the address already
 * names it, then Egypt. Null when the address is too thin to route to (blank, a lone number).
 */
export function addressDestination(address: string | null | undefined, brickName: string | null | undefined): string | null {
  const tidy = tidyAddress(address);
  const meaningful = tidy.replace(/[^0-9A-Za-zء-ي]/g, "");
  if (meaningful.length < MIN_ADDRESS_CHARACTERS || /^\d+$/.test(meaningful)) return null;
  const town = tidyAddress(brickName);
  const parts = [tidy];
  if (town && town !== "(unmapped)" && !tidy.includes(town)) parts.push(town);
  parts.push("مصر");
  return parts.join("، ");
}

/** The one confirmed point for a card, or null when there is none it can trust. */
function pickConfirmedPoint(input: PickDirectionsInput): Point | null {
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

/** Where tapping this pharmacy's name sends a rep — or null, and then the name is not a link. */
export function pickPharmacyDirections(input: PickDirectionsInput): TerritoryPharmacyDirections | null {
  if (input.sources.length === 0) return null;
  const families = new Set(input.sources.map((source) => distributorFamily(normalizeCode(source.distributorCode))));
  if (families.size > 1) return null;

  const confirmed = pickConfirmedPoint(input);
  if (confirmed) {
    return { kind: "confirmed_on_site", url: googleMapsDirectionsUrl(confirmed), address: null };
  }

  for (const source of input.sources) {
    if (!ADDRESS_ROUTING_DISTRIBUTORS.has(normalizeCode(source.distributorCode))) continue;
    const destination = addressDestination(source.clientAddress, input.brickNames.get(source.brickId));
    if (destination) {
      return { kind: "distributor_address", url: googleMapsDirectionsUrl(destination), address: destination };
    }
  }
  return null;
}
