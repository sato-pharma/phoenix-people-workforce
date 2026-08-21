/**
 * Distance maths for Pharmacy Search.
 *
 * The production database has no PostGIS and no earthdistance extension (checked 2026-08-21:
 * only plpgsql, pg_stat_statements, pgcrypto, supabase_vault, uuid-ossp, pg_trgm), so proximity
 * is computed in Node after a bounding-box prefilter narrows the candidate set. That prefilter
 * matters: `ireports360_checkins` holds 105,413 GPS rows and pulling all of them per lookup
 * would be absurd, while a 2 km box returns a few dozen.
 */

export type Point = { latitude: number; longitude: number };

const EARTH_RADIUS_KM = 6371;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Great-circle distance in km. Straight line — NOT driving distance; label it as such in UI. */
export function haversineKm(a: Point, b: Point): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Latitude/longitude window that fully contains a `radiusKm` circle around `centre`.
 *
 * The longitude span widens with latitude (degrees of longitude shrink towards the poles); at
 * Egypt's latitudes that is roughly a 15% widening, and getting it wrong would silently clip
 * doctors off the east and west edges of the box. Guard the cosine against zero so a nonsense
 * coordinate degrades to a whole-world span instead of dividing by zero.
 */
export function boundingBox(centre: Point, radiusKm: number) {
  const latitudeDelta = radiusKm / 111.32;
  const cosLatitude = Math.max(0.01, Math.cos(toRadians(centre.latitude)));
  const longitudeDelta = radiusKm / (111.32 * cosLatitude);

  return {
    maxLatitude: centre.latitude + latitudeDelta,
    maxLongitude: centre.longitude + longitudeDelta,
    minLatitude: centre.latitude - latitudeDelta,
    minLongitude: centre.longitude - longitudeDelta,
  };
}

/** True when a coordinate pair is usable. `0,0` is the null-island sentinel, not a real place. */
export function isUsablePoint(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): boolean {
  if (latitude == null || longitude == null) return false;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  if (latitude === 0 && longitude === 0) return false;
  return Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
}

/** One decimal place below a kilometre — 0.19 km reads better than 190 m at these distances. */
export function roundKm(value: number): number {
  return Math.round(value * 100) / 100;
}
