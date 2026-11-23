/**
 * Expense Approvals — what each trip day's map draws.
 *
 * Rebuilt 2026-11-23 (owner: "REBUILD FROM SCRATCH"). The reviewer it replaces drew the old vendor's
 * GPS check-ins, which stopped on 6 Nov 2026. A day's map now draws what Phoenix holds:
 *
 *   - the day's Phoenix CRM visits that carry a position, numbered in the order they were SAVED;
 *   - the arrival photo (A) on the first day and the departure photo (D) on the last;
 *   - every journey stop (S2, S3 …) on the day it was captured;
 *   - the trip's road route from home on the first and the last day.
 *
 * 🔴 TIME. The map prints a pin's time as CAIRO WALL CLOCK with no offset (`utcTaggedWallClock` in the
 *    map itself). A visit's `savedAt` is a real instant, so it is moved onto Cairo's wall clock HERE,
 *    before the map sees it — handing the map the instant would print every visit two or three hours
 *    early with nothing throwing. A photo or a stop goes to the map as its instant (`at`); the map's
 *    own line-order helper does the same move for those (day-route-line.ts).
 *
 * A photo or a stop captured outside the trip's dates is drawn on the nearest trip day; its legend
 * line still carries the real time. A point with no position is listed, never guessed onto the map.
 *
 * Pure: no React, no fetch, no clock.
 */

import { cairoWallClock } from "@/lib/format/cairo-zone";

export type DeskMapVisit = {
  customer: string | null;
  place: string | null;
  point: { lat: number; lon: number } | null;
  savedAt: string | null;
};

export type DeskMapPhoto = {
  capturedAt: string | null;
  kind: "arrival" | "departure";
  label: string;
  latitude: number | null;
  longitude: number | null;
  missingNote?: string | null;
  url?: string | null;
};

export type DeskMapStop = {
  capturedAt: string;
  governorate?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  stopNumber: number;
};

/** A numbered pin: one visit. `checkDate` is Cairo wall clock with no offset, as the map reads it. */
export type DeskMapCheckin = {
  address: string | null;
  checkDate: string;
  contactName: string | null;
  id: string;
  lat: number;
  lon: number;
};

/** A lettered pin: a photo or a stop. `at` is the real instant. */
export type DeskMapMarker = { at: string | null; id: string; label: string; lat: number; lon: number; title: string };

export type DeskMapLegendLine = {
  at: string | null;
  label: string;
  name: string;
  /** Why it is not on the map, or what is missing; null when there is nothing to add. */
  note: string | null;
  point: { lat: number; lon: number } | null;
};

export type DeskDayMap = {
  checkins: DeskMapCheckin[];
  date: string;
  /** Anything at all to draw: a pin, a letter or the road route. */
  hasPoints: boolean;
  legend: DeskMapLegendLine[];
  markers: DeskMapMarker[];
  /** The pin number of each of the day's visits, in the order they were given; null = no position. */
  pins: Array<number | null>;
  /** The trip's road route is drawn on this day (its first and its last). */
  tripRoute: boolean;
  /** Visits saved with no position. */
  unplaced: number;
};

/** "2026-11-14T09:05:00" for an instant, read in Cairo; null when the value is not a date. */
export function cairoWallClockText(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return null;
  return cairoWallClock(instant).toISOString().slice(0, 19);
}

/** Which trip day an instant belongs on: its Cairo date, pulled inside the trip's own dates. */
export function tripDayOf(iso: string | null | undefined, firstDay: string, lastDay: string, fallback: string): string {
  const day = cairoWallClockText(iso)?.slice(0, 10) ?? fallback;
  if (day < firstDay) return firstDay;
  if (day > lastDay) return lastDay;
  return day;
}

const located = (lat: number | null | undefined, lon: number | null | undefined): { lat: number; lon: number } | null =>
  typeof lat === "number" && typeof lon === "number" && Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;

export function deskDayMaps(input: {
  /** Every trip day, in order. */
  dayKeys: ReadonlyArray<string>;
  /** Phoenix CRM's reading of each day; a day it does not hold simply has no visits. */
  days: ReadonlyArray<{ date: string; visits: ReadonlyArray<DeskMapVisit> }>;
  hasTripRoute: boolean;
  photos: ReadonlyArray<DeskMapPhoto>;
  stops: ReadonlyArray<DeskMapStop>;
}): DeskDayMap[] {
  const dayKeys = [...input.dayKeys];
  if (dayKeys.length === 0) return [];
  const firstDay = dayKeys[0];
  const lastDay = dayKeys[dayKeys.length - 1];

  const markers = new Map<string, DeskMapMarker[]>();
  const legend = new Map<string, DeskMapLegendLine[]>();
  const put = (day: string, line: DeskMapLegendLine, marker: DeskMapMarker | null) => {
    legend.set(day, [...(legend.get(day) ?? []), line]);
    if (marker) markers.set(day, [...(markers.get(day) ?? []), marker]);
  };

  for (const photo of input.photos) {
    const point = located(photo.latitude, photo.longitude);
    const label = photo.kind === "arrival" ? "A" : "D";
    const day = photo.kind === "arrival" ? firstDay : lastDay;
    put(
      day,
      {
        at: photo.capturedAt,
        label,
        name: photo.label,
        note: !photo.url ? (photo.missingNote ?? "No photo") : point ? null : "No GPS position, so it is not on the map",
        point,
      },
      point ? { at: photo.capturedAt, id: photo.kind, label, lat: point.lat, lon: point.lon, title: photo.label } : null,
    );
  }

  for (const stop of input.stops) {
    const point = located(stop.latitude, stop.longitude);
    const label = `S${stop.stopNumber}`;
    const name = stop.governorate ? `Stop ${stop.stopNumber} · ${stop.governorate}` : `Stop ${stop.stopNumber}`;
    put(
      tripDayOf(stop.capturedAt, firstDay, lastDay, firstDay),
      { at: stop.capturedAt, label, name, note: point ? null : "No GPS position, so it is not on the map", point },
      point ? { at: stop.capturedAt, id: `stop-${stop.stopNumber}`, label, lat: point.lat, lon: point.lon, title: name } : null,
    );
  }

  const visitsByDay = new Map(input.days.map((day) => [day.date, day.visits] as const));

  return dayKeys.map((date) => {
    const visits = visitsByDay.get(date) ?? [];
    const placed = visits
      .map((visit, index) => ({ index, point: visit.point ? located(visit.point.lat, visit.point.lon) : null, visit }))
      .filter((entry): entry is { index: number; point: { lat: number; lon: number }; visit: DeskMapVisit } => entry.point !== null)
      .map((entry) => ({ ...entry, checkDate: cairoWallClockText(entry.visit.savedAt) ?? `${date}T00:00:00` }));
    // The map numbers its pins in this order (a plain text compare of the wall clock, ties as given).
    const ordered = [...placed].sort((left, right) => left.checkDate.localeCompare(right.checkDate));
    const pins: Array<number | null> = visits.map(() => null);
    ordered.forEach((entry, order) => {
      pins[entry.index] = order + 1;
    });
    const checkins: DeskMapCheckin[] = ordered.map((entry) => ({
      address: entry.visit.place,
      checkDate: entry.checkDate,
      contactName: entry.visit.customer,
      id: `${date}-${entry.index}`,
      lat: entry.point.lat,
      lon: entry.point.lon,
    }));
    const dayMarkers = markers.get(date) ?? [];
    const tripRoute = input.hasTripRoute && (date === firstDay || date === lastDay);
    return {
      checkins,
      date,
      hasPoints: checkins.length > 0 || dayMarkers.length > 0 || tripRoute,
      legend: legend.get(date) ?? [],
      markers: dayMarkers,
      pins,
      tripRoute,
      unplaced: visits.length - placed.length,
    };
  });
}
