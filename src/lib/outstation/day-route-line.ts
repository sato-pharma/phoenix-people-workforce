/**
 * The line a trip day's map draws through its own points — every check-in, the arrival and
 * departure photos and each journey stop — in the order they happened.
 *
 * Owner, 2026-11-07, on the Expense Approvals day maps: "on map now only appears a dot but doesn't
 * appear خط السير" (the route). The map pinned the photos and stops but joined only the GPS
 * check-ins, so a day whose points were a photo and a stop showed loose dots and no route at all.
 *
 * The two kinds of point carry their time differently, and both are read as Cairo wall clock:
 *   - a CRM check-in's `checkDate` is already Cairo wall clock with no offset (utcTaggedWallClock);
 *   - a photo or stop's `at` is a real instant (ISO), moved onto Cairo's wall clock here.
 * A point with no usable time stays pinned but is left out of the line, never guessed into it.
 *
 * Pure, so the order is pinned by a test without a map.
 */

import { cairoWallClock, utcTaggedWallClock } from "@/lib/format/cairo-zone";

export type DayRoutePoint = { lat: number; lng: number };

type Timed = DayRoutePoint & { order: number; sortMs: number };

export function dayRouteLine(
  checkins: ReadonlyArray<{ checkDate: string; lat: number | null; lon: number | null }>,
  markers: ReadonlyArray<{ at?: string | null; lat: number; lon: number }>,
): DayRoutePoint[] {
  const timed: Timed[] = [];
  let order = 0;
  for (const checkin of checkins) {
    if (checkin.lat === null || checkin.lon === null) continue;
    const sortMs = Date.parse(utcTaggedWallClock(checkin.checkDate));
    if (Number.isFinite(sortMs)) timed.push({ lat: checkin.lat, lng: checkin.lon, order: order++, sortMs });
  }
  for (const marker of markers) {
    const instant = marker.at ? new Date(marker.at) : null;
    if (!instant || Number.isNaN(instant.getTime())) continue;
    timed.push({ lat: marker.lat, lng: marker.lon, order: order++, sortMs: cairoWallClock(instant).getTime() });
  }
  return timed
    .sort((left, right) => left.sortMs - right.sortMs || left.order - right.order)
    .map(({ lat, lng }) => ({ lat, lng }));
}

/**
 * The trip's own road route, as the approver's day maps draw it: the route chosen when the claim was
 * priced (the selected alternative, else the stored polyline), and the employee's home, where it
 * starts. Null when the request stores no route (a meeting, a row priced before routes were kept).
 */
export type ApproverTripRoute = {
  distanceKm: number | null;
  encodedPolyline: string;
  home: { label: string | null; lat: number; lon: number } | null;
};

export function approverTripRoute(request: {
  distanceFromResidenceKm: number | null;
  residenceArea: string | null;
  residenceCity: string | null;
  residenceLatitude: number | null;
  residenceLongitude: number | null;
  routeAlternatives?: ReadonlyArray<{ distanceKm: number | null; encodedPolyline: string | null; isSelected: boolean }>;
  routePolyline: string | null;
}): ApproverTripRoute | null {
  const selected = request.routeAlternatives?.find((route) => route.isSelected && route.encodedPolyline);
  const encodedPolyline = String(selected?.encodedPolyline ?? request.routePolyline ?? "").trim();
  if (!encodedPolyline) return null;
  const home =
    typeof request.residenceLatitude === "number" && typeof request.residenceLongitude === "number"
      ? {
          label: [request.residenceArea, request.residenceCity].filter(Boolean).join(", ") || null,
          lat: request.residenceLatitude,
          lon: request.residenceLongitude,
        }
      : null;
  return { distanceKm: selected?.distanceKm ?? request.distanceFromResidenceKm ?? null, encodedPolyline, home };
}
