/**
 * Plausibility guard for iReports360 GPS check-in coordinates.
 *
 * The vendor forwards whatever fix the rep's handset produced, unvalidated. A handset that loses
 * its satellite lock can emit one wildly-wrong position and then recover, so a single check-in in
 * the middle of an otherwise-normal Egyptian working day can land on another continent.
 *
 * This matters beyond looking silly. Check-in matching keys on rep + contact + day, NOT on
 * distance (see checkin-match.ts), so an impossible coordinate is still accepted as GPS
 * proof-of-presence for that visit — and a Regular visit WITH a matching check-in is never
 * flagged as Campaign (see the `effective_type` column in master.ts). A bad fix therefore
 * manufactures evidence that a rep stood in front of a customer. Brick resolution is already
 * safe by accident (resolveBrickForPoint's 1.5° pre-filter matches no Egyptian centroid), but
 * proof-of-presence is not.
 *
 * The bounds below are Egypt's land extent plus roughly 50km of slack on every side. Verified
 * against the entire production mirror on 2026-08-21: all 105,413 good check-ins sit inside
 * lat 21.9–31.8 / lon 24.6–37.0, comfortably within these bounds, and exactly one row
 * (crm_checkin_id 472272 — rep B-140, geocoded to Najaf, Iraq, 1,300km away, between two Asyut
 * check-ins 1h42m apart) falls outside them. Zero false positives on eight months of real field
 * data.
 *
 * Rejection nulls the DERIVED columns only. The vendor's original lat/lon is always kept verbatim
 * in `raw_payload`, so nothing is destroyed and a wrongly-rejected fix stays fully recoverable.
 */

/** Egypt's land extent plus ~50km of slack on each side. */
export const EGYPT_CHECKIN_BOUNDS = {
  maxLat: 32,
  maxLon: 37.5,
  minLat: 21.5,
  minLon: 24,
} as const;

/** True when a coordinate pair is a usable position inside Egypt's plausible field range. */
export function isPlausibleCheckinCoordinate(
  lat: number | null | undefined,
  lon: number | null | undefined,
): boolean {
  if (typeof lat !== "number" || !Number.isFinite(lat)) return false;
  if (typeof lon !== "number" || !Number.isFinite(lon)) return false;
  // (0, 0) is the classic "no satellite fix" sentinel. The bounds already exclude it — it is in
  // the Gulf of Guinea — but it is worth naming as the failure it actually is.
  if (lat === 0 && lon === 0) return false;
  return (
    lat >= EGYPT_CHECKIN_BOUNDS.minLat &&
    lat <= EGYPT_CHECKIN_BOUNDS.maxLat &&
    lon >= EGYPT_CHECKIN_BOUNDS.minLon &&
    lon <= EGYPT_CHECKIN_BOUNDS.maxLon
  );
}

export type SanitizedCheckinCoordinates = {
  address: string | null;
  lat: number | null;
  lon: number | null;
  rejected: boolean;
};

/**
 * Keeps a plausible coordinate untouched; replaces an implausible one with nulls.
 *
 * The address goes with it. The vendor almost always sends `address: ""` and Phoenix pays
 * LocationIQ/Google to reverse-geocode the coordinate itself (see checkin-geocode.ts), so an
 * address derived from a bad fix is exactly as wrong as the fix — "Najaf, Iraq" was OUR geocode
 * of a broken handset reading, not something iReports360 ever claimed.
 *
 * A row with no coordinates at all is NOT a rejection: plenty of check-ins legitimately arrive
 * without GPS, and counting those would drown the signal in ordinary traffic.
 */
export function sanitizeCheckinCoordinates(
  lat: number | null | undefined,
  lon: number | null | undefined,
  address: string | null | undefined,
): SanitizedCheckinCoordinates {
  const safeAddress = address ?? null;
  if (typeof lat !== "number" || !Number.isFinite(lat) || typeof lon !== "number" || !Number.isFinite(lon)) {
    return { address: safeAddress, lat: null, lon: null, rejected: false };
  }
  if (!isPlausibleCheckinCoordinate(lat, lon)) {
    return { address: null, lat: null, lon: null, rejected: true };
  }
  return { address: safeAddress, lat, lon, rejected: false };
}
