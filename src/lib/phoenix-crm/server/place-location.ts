/**
 * ONE resolver for what a captured coordinate MEANS — the clean address Google read for it, the part
 * of town, the governorate, and the Phoenix brick with the distance that justifies it, plus that
 * brick's area and region.
 *
 * 🔴 IT LIVES IN ITS OWN FILE SO ITS CALLERS CAN SHARE IT WITHOUT AN IMPORT CYCLE. It was inside
 * `server/list.ts` while a validation, a move and a pharmacy's pin were the callers; a shared place is
 * the next one, and `server/shared-places.ts` is itself imported BY `list.ts` for the seating branch —
 * so leaving the resolver where it was would have made `list.ts` and `shared-places.ts` import each
 * other. A cycle between two server modules that only ever call each other's functions at request
 * time usually survives, and that is exactly what makes it a bad bet: webpack decides the
 * initialisation order, and the failure is `undefined is not a function` on one of the two entry
 * points, in production, with nothing red beforehand.
 *
 * 🔴 ONE RESOLVER, SEVERAL MAPPINGS — a doctor's place (`resolvePlaceLocation`), the pin a rep may put
 * on a pharmacy (`resolvePharmacyPinPayload`, which stays in `list.ts` because it owns that table's
 * own columns) and a shared place all read `resolvePinGeography` and nothing else, so no two of them
 * can disagree about which brick a point is in — and all four hand it the capturing seat's territory
 * (`PlaceTerritory`), which is what stops a shared junk centroid filing a capture in a neighbouring
 * area. The place mapping keeps no governorate because
 * `phoenix_crm_places` has no column for one; the pharmacy's own columns do, because the owner asked
 * for a pinned pharmacy to come back "cleaned and separated into area, brick, government"
 * (2026-10-09).
 *
 * Moved here 2026-10-09 with no change to its body. Every place row in the database was resolved by
 * this code, and the function a validation, a move, a pharmacy pin and a venue all read must stay ONE
 * function — two copies could disagree about a brick, and the row is frozen for good.
 */

import { loadBrickCentroids, resolveBrickForPoint } from "@/lib/crm/brick-geo";
import { resolveEvidenceLocation } from "@/lib/evidence/location-service";

/** A nearest brick centre further than this is not trusted as the place's brick. */
export const BRICK_TRUST_KM = 3;

/**
 * The territory the reading was taken in — the capturing seat's own area code(s).
 *
 * 🔴 IT IS A REQUIRED ARGUMENT, NOT AN OPTION, AND THAT IS THE WHOLE POINT. Without it the resolver
 * answers with the nearest brick centroid anywhere, and 34 of the live centroids sit on coordinates
 * that two different AREAS share — so which area a capture lands in is decided by array order rather
 * than by geography (`resolveBrickForPoint`, `prefer`). A new caller that could leave it out would
 * silently reinstate exactly that defect, which is invisible until a manager reads one of his own
 * customers in somebody else's district. `areaCodes` may be empty — a seat with no area in the
 * organogram is a real state — and the resolver then behaves exactly as it did before.
 */
export type PlaceTerritory = { readonly areaCodes: readonly string[] };

/** The capturing seat's territory, from the organogram seat every write path already holds. */
export function territoryOfSeat(seat: { areaCode?: string | null }): PlaceTerritory {
  return { areaCodes: seat.areaCode ? [seat.areaCode] : [] };
}

export type PinGeography = {
  readonly address: string | null;
  readonly zone: string | null;
  readonly governorate: string | null;
  readonly brickLookup: "matched" | "none_nearby" | "could_not_look";
  readonly brickId: string | null;
  readonly brickName: string | null;
  readonly brickDistanceKm: number | null;
  readonly areaCode: string | null;
  readonly areaName: string | null;
  readonly regionCode: string | null;
  readonly regionName: string | null;
};

export async function resolvePinGeography(
  point: { lat: number; lon: number; accuracyMeters: number | null },
  territory: PlaceTerritory,
): Promise<PinGeography> {
  const [centroids, located] = await Promise.all([
    loadBrickCentroids(),
    // Best-effort, exactly as the watermark treats it: a pin in the desert, a refused lookup or a
    // spent map quota leaves the clean address null. The coordinates, the photo and the brick are
    // the proof; the address is the courtesy on top of them, and a validation is never blocked on it.
    // The same remembered address the photo's stamp was given, so the address saved is the one on the picture.
    resolveEvidenceLocation(
      { accuracyMeters: point.accuracyMeters, latitude: point.lat, longitude: point.lon },
      { reuseNearbyAddress: true },
    ).catch(() => null),
  ]);
  // The seat's own area breaks a near tie, inside the SAME trust radius the match is judged by — so a
  // capture is never dragged into a territory it is further than `BRICK_TRUST_KM` from.
  const brick = resolveBrickForPoint(point.lat, point.lon, centroids, { areaCodes: territory.areaCodes, withinKm: BRICK_TRUST_KM });
  const trusted = brick && brick.distanceKm <= BRICK_TRUST_KM ? brick : null;
  // 🔴 DID ANYBODY ACTUALLY LOOK? `centroids.length === 0` is READ, never inferred from a null brick:
  // `loadBrickCentroids` degrades to an empty list on any error, deliberately outside its cache, so an
  // empty list is the ONLY tell that the brick master could not be read. Without this, "the pin is
  // nowhere near a Phoenix brick" and "we could not look" are the same null on the row — the very
  // distinction the outstation watermark makes in words because an approver needs it.
  const brickLookup = centroids.length === 0 || brick === null ? "could_not_look" : trusted ? "matched" : "none_nearby";
  return {
    address: located?.address ?? null,
    zone: located?.components.area ?? null,
    // Google's own component, never guessed from the address text: an address line holds street,
    // district and city names that read like governorates, and a wrong governorate on a pharmacy is
    // worse than none at all.
    governorate: located?.components.governorate ?? null,
    brickLookup,
    brickId: trusted?.brickId ?? null,
    brickName: trusted?.brickName ?? null,
    brickDistanceKm: brick ? Math.round(brick.distanceKm * 100) / 100 : null,
    areaCode: trusted?.areaCode ?? null,
    areaName: trusted?.areaName ?? null,
    regionCode: trusted?.regionCode ?? null,
    regionName: trusted?.regionName ?? null,
  };
}

/**
 * The geography mapped onto `phoenix_crm_places`' own column names — the location every place row
 * holds, whether it was captured at a clinic's door, moved by the Super Admin, or copied from the
 * shared place a customer is seated in.
 */
export async function resolvePlaceLocation(
  point: {
    lat: number;
    lon: number;
    accuracyMeters: number | null;
  },
  territory: PlaceTerritory,
): Promise<Record<string, unknown>> {
  const geo = await resolvePinGeography(point, territory);
  return {
    address: geo.address,
    zone: geo.zone,
    brick_lookup: geo.brickLookup,
    brick_id: geo.brickId,
    brick_name: geo.brickName,
    brick_distance_km: geo.brickDistanceKm,
    area_code: geo.areaCode,
    area_name: geo.areaName,
    region_code: geo.regionCode,
    region_name: geo.regionName,
  };
}
