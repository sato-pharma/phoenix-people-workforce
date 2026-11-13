/**
 * Phoenix CRM — distances, with no I/O.
 *
 * Two owner rules read a distance (2026-09-16):
 *   - A visit saved far from the customer's validated place still saves, flagged for the manager.
 *   - Customers far apart on one plan day are never blocked; the day is highlighted to the reviewer.
 * No map service is called for a distance (owner: never buy a map API for one); straight-line distance
 * only. The streets drawn behind the Location Integrity maps are a separate thing: a Google picture since
 * 13 Nov 2026, his own choice (`src/lib/crm-integrity/integrity-case-map.ts`).
 */

import { EGYPT_CHECKIN_BOUNDS } from "@/lib/crm/checkin-coords";
import { haversineKm } from "@/lib/pharmacy-search/geo";
import type { PhoenixCrmLocationFlag } from "@/lib/phoenix-crm/types";

export type GeoPoint = { lat: number; lon: number };

/**
 * A fix inside Egypt's field range. The one set of bounds the company uses (checkin-coords.ts, proven
 * on 105,413 real check-ins with no false positive), so a (0,0) fix or a handset that lost its lock
 * never passes as a location.
 */
export function isUsableFix(lat: unknown, lon: unknown): boolean {
  if (lat === null || lat === undefined || lat === "" || lon === null || lon === undefined || lon === "") return false;
  const latitude = Number(lat);
  const longitude = Number(lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  return (
    latitude >= EGYPT_CHECKIN_BOUNDS.minLat &&
    latitude <= EGYPT_CHECKIN_BOUNDS.maxLat &&
    longitude >= EGYPT_CHECKIN_BOUNDS.minLon &&
    longitude <= EGYPT_CHECKIN_BOUNDS.maxLon
  );
}

export function distanceMeters(from: GeoPoint, to: GeoPoint): number {
  return Math.round(haversineKm({ latitude: from.lat, longitude: from.lon }, { latitude: to.lat, longitude: to.lon }) * 1000);
}

export type LocationCheck = {
  /** The validated place the visit is nearest to, or null when the customer has no place. */
  placeId: string | null;
  distanceMeters: number | null;
  flag: PhoenixCrmLocationFlag;
};

/**
 * The visit's fix against the customer's places. Far beats weak: a fix that is both far and inaccurate
 * is reported far, because that is what the manager must look at.
 */
export function checkVisitLocation(input: {
  fix: GeoPoint & { accuracyMeters: number | null };
  places: ReadonlyArray<GeoPoint & { id: string }>;
  farMeters: number;
  weakGpsMeters: number;
}): LocationCheck {
  let nearest: { id: string; distance: number } | null = null;
  for (const place of input.places) {
    const distance = distanceMeters(input.fix, place);
    if (!nearest || distance < nearest.distance) nearest = { id: place.id, distance };
  }
  const weak = input.fix.accuracyMeters !== null && input.fix.accuracyMeters > input.weakGpsMeters;
  if (!nearest) return { placeId: null, distanceMeters: null, flag: weak ? "weak_gps" : "ok" };
  if (nearest.distance > input.farMeters) return { placeId: nearest.id, distanceMeters: nearest.distance, flag: "far" };
  return { placeId: nearest.id, distanceMeters: nearest.distance, flag: weak ? "weak_gps" : "ok" };
}

export type SpreadCheck = {
  /** The greatest distance between any two customers of the day, in km (0 with fewer than two). */
  spanKm: number;
  /** True when the day spans more than the threshold. */
  spread: boolean;
  /** Items whose nearest other customer of the day is further than the threshold. */
  isolatedIds: string[];
  /** Each item's distance to its nearest other customer of the day, in km. */
  nearestKmById: Record<string, number>;
};

/**
 * How spread out a plan day is. A day flags when it spans more than the threshold; an item flags when
 * even its nearest other customer is beyond it — two clusters far apart flag the day but not their
 * members, and one outlier flags itself.
 */
export function checkDaySpread(points: ReadonlyArray<GeoPoint & { id: string }>, thresholdKm: number): SpreadCheck {
  const nearestKmById: Record<string, number> = {};
  let spanKm = 0;
  for (let left = 0; left < points.length; left += 1) {
    for (let right = left + 1; right < points.length; right += 1) {
      const km = distanceMeters(points[left], points[right]) / 1000;
      spanKm = Math.max(spanKm, km);
      const leftId = points[left].id;
      const rightId = points[right].id;
      nearestKmById[leftId] = Math.min(nearestKmById[leftId] ?? Number.POSITIVE_INFINITY, km);
      nearestKmById[rightId] = Math.min(nearestKmById[rightId] ?? Number.POSITIVE_INFINITY, km);
    }
  }
  const isolatedIds = points.length < 2 ? [] : points.filter((point) => nearestKmById[point.id] > thresholdKm).map((point) => point.id);
  return { spanKm: Math.round(spanKm * 10) / 10, spread: spanKm > thresholdKm, isolatedIds, nearestKmById };
}

/** "850 m" or "3.2 km". */
export function formatDistance(meters: number | null): string {
  if (meters === null || !Number.isFinite(meters)) return "no location";
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}
