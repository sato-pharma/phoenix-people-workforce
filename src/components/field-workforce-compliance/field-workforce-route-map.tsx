"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { Card } from "@/components/ui/card";
import { utcTaggedWallClock } from "@/lib/format/cairo-zone";
import {
  importGoogleLibrary,
  loadGoogleMaps,
  type GoogleMapsApi,
  type GoogleMarkerHandle,
  type GooglePolylineHandle,
} from "@/lib/google-maps/browser";

export type RouteCheckin = {
  address: string | null;
  checkDate: string;
  contactName: string | null;
  /** A vendor check-in id, or a Phoenix CRM visit key — only ever a React key here. */
  id: number | string;
  lat: number | null;
  lon: number | null;
};

export type RouteLeg = {
  distanceKm: number | null;
  durationMinutes: number | null;
};

/**
 * The words around the map. The defaults are the iReports360 check-in trail this map was built for; Phoenix CRM's
 * admin day page draws its VISITS with it (owner, 2026-10-24) and names them so, never as check-ins.
 */
export type RouteMapCopy = {
  title: string;
  description: string;
  empty: string;
};

const CHECKIN_COPY: RouteMapCopy = {
  title: "GPS check-in route for this day",
  description:
    "Each stop is numbered in the order the rep checked in, with its check-in time. Distance and drive time between stops come from the Google Maps driving route.",
  empty: "No GPS check-ins with coordinates were recorded for this rep on this day.",
};

export type DayRoute = {
  encodedPolyline: string | null;
  legs: RouteLeg[];
};

/**
 * A labelled pin that is NOT a check-in: an arrival or departure photo, a journey stop. Drawn beside
 * the numbered check-ins and inside the same bounds, with its own letter or number on the pin
 * (owner, 2026-11-07: the whole trip on one map, every point the trip has).
 */
export type RouteMarker = {
  id: string;
  /** One or two characters, printed on the pin: "A", "D", "S2". */
  label: string;
  lat: number;
  lon: number;
  /** The tooltip, e.g. "Arrival photo · Wed 15 Oct 22:21". */
  title: string;
};

/** The declared destination, drawn as a hollow circle so a pin far from it is seen at once. */
export type RouteDestination = { lat: number; lon: number; title: string };

/** Decodes a Google encoded polyline into lat/lng points (same algorithm as the outstation map). */
function decodePolyline(encoded: string): Array<{ lat: number; lng: number }> {
  const points: Array<{ lat: number; lng: number }> = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    const latChange = result & 1 ? ~(result >> 1) : result >> 1;
    lat += latChange;
    shift = 0;
    result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    const lngChange = result & 1 ? ~(result >> 1) : result >> 1;
    lng += lngChange;
    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return points;
}

/** Compact distance + drive-time label for a route leg, e.g. "3.2 km · 8 min drive". */
function legLabel(leg: RouteLeg | undefined): string | null {
  if (!leg) return null;
  const parts: string[] = [];
  if (leg.distanceKm != null) parts.push(`${leg.distanceKm} km`);
  if (leg.durationMinutes != null) parts.push(`${leg.durationMinutes} min drive`);
  return parts.length ? parts.join(" · ") : null;
}

function hasCoords(checkin: RouteCheckin): checkin is RouteCheckin & { lat: number; lon: number } {
  return Number.isFinite(checkin.lat) && Number.isFinite(checkin.lon);
}

/**
 * A check-in clock, rendered exactly as it is stored.
 *
 * 🔴 BOTH HALVES ARE LOAD-BEARING, AND THE SECOND ONE IS WHY THIS PAGE WAS THREE HOURS OUT.
 * Every clock that reaches this component is a CAIRO WALL CLOCK (`field-activity/model.ts` rule 3),
 * so the digits must be printed as written — hence `timeZone: "UTC"`, which stops the browser's own
 * Cairo zone adding the offset a second time.
 *
 * But `timeZone: "UTC"` only prints the digits as written when `new Date` also READ them as UTC, and
 * that depends on something the caller controls: a date-time string WITHOUT an offset is parsed as
 * the browser's LOCAL time, never as UTC. Field Activity builds its value by hand —
 * `${dateIso}T${clock}`, with no `+00` — so the two halves cancelled the wrong way and every stop
 * printed exactly three hours early: B-148's 10:08:38 door on 1 September 2026 rendered as 07:08 AM,
 * on a card whose own "GPS window" fact (a plain string slice) read that same check-in correctly.
 * Measured on production 2026-10-06 across all ten of that day's stops — each one off by −3:00 to
 * the second.
 *
 * Normalising here rather than at the one caller is deliberate: this function owns the "as written"
 * contract, and no caller can be expected to know that the contract was conditional on its input
 * carrying a zone. The other two callers pass PostgREST's own `+00:00` strings and are unaffected.
 */
function formatTime(value: string) {
  const date = new Date(utcTaggedWallClock(value));
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(date);
}

/**
 * Plots a rep's GPS check-ins for one day as a numbered route: markers in time order with
 * each stop's check-in time, and the Google driving distance + drive-time between stops
 * (when available). Read-only; reuses the same Google Maps browser loader as the outstation map.
 */
const NO_MARKERS: RouteMarker[] = [];

export function FieldWorkforceRouteMap({
  checkins,
  copy = CHECKIN_COPY,
  destination = null,
  frame = "card",
  markers = NO_MARKERS,
  route,
}: {
  checkins: RouteCheckin[];
  copy?: RouteMapCopy;
  destination?: RouteDestination | null;
  /**
   * "card" is the report card this map was built as: a heading, the description and the numbered
   * trail under the map. "bare" is the map box alone, square-edged, for a page that writes its own
   * legend around it (Expense Approvals, 2026-11-07).
   */
  frame?: "bare" | "card";
  markers?: RouteMarker[];
  route?: DayRoute | null;
}) {
  const browserKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY ?? "";
  const mapRef = useRef<HTMLDivElement | null>(null);
  const markersRef = useRef<GoogleMarkerHandle[]>([]);
  const polylinesRef = useRef<GooglePolylineHandle[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [googleMaps, setGoogleMaps] = useState<GoogleMapsApi | null>(null);

  const points = useMemo(
    () => checkins
      .filter(hasCoords)
      .slice()
      .sort((left, right) => String(left.checkDate).localeCompare(String(right.checkDate))),
    [checkins],
  );

  const legs = route?.legs ?? [];
  const hasRoute = legs.length > 0;
  const totalKm = hasRoute ? Math.round(legs.reduce((sum, leg) => sum + (leg.distanceKm ?? 0), 0) * 10) / 10 : null;
  const totalMin = hasRoute ? legs.reduce((sum, leg) => sum + (leg.durationMinutes ?? 0), 0) : null;
  // Anything with a position is a reason to draw the map — a trip with photo pins and no check-in
  // is still a trip on a map.
  const pinCount = points.length + markers.length + (destination ? 1 : 0);

  useEffect(() => {
    if (!browserKey || pinCount === 0) return;
    let cancelled = false;
    void loadGoogleMaps(browserKey)
      .then((maps) => {
        if (cancelled) return;
        setGoogleMaps(maps);
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) setError("Google Maps failed to load. Check the browser key restrictions.");
      });
    return () => {
      cancelled = true;
    };
  }, [browserKey, pinCount]);

  useEffect(() => {
    const mapElement = mapRef.current;
    if (!ready || !mapElement || !googleMaps || pinCount === 0) return;
    let cancelled = false;

    const run = async () => {
      try {
        const coreLibrary = await importGoogleLibrary(googleMaps, "core", { LatLngBounds: googleMaps.LatLngBounds });
        const mapsLibrary = await importGoogleLibrary(googleMaps, "maps", { Map: googleMaps.Map, Polyline: googleMaps.Polyline });
        const markerLibrary = await importGoogleLibrary(googleMaps, "marker", { Marker: googleMaps.Marker });
        if (cancelled) return;

        const MapCtor = (mapsLibrary?.Map as GoogleMapsApi["Map"]) ?? googleMaps.Map;
        const MarkerCtor = (markerLibrary?.Marker as GoogleMapsApi["Marker"]) ?? googleMaps.Marker;
        const PolylineCtor = (mapsLibrary?.Polyline as GoogleMapsApi["Polyline"]) ?? googleMaps.Polyline;
        const LatLngBoundsCtor = (coreLibrary?.LatLngBounds as GoogleMapsApi["LatLngBounds"]) ?? googleMaps.LatLngBounds;
        if (!MapCtor) {
          setError("Google Maps loaded, but the map renderer is unavailable. Refresh and retry.");
          return;
        }

        markersRef.current.forEach((marker) => {
          if (typeof marker.setMap === "function") marker.setMap(null);
          else if ("map" in marker) marker.map = null;
        });
        markersRef.current = [];
        polylinesRef.current.forEach((polyline) => polyline.setMap?.(null));
        polylinesRef.current = [];

        const path = points.map((point) => ({ lat: point.lat, lng: point.lon }));
        // Prefer the real Google driving route (follows roads); fall back to a light
        // straight connector showing check-in order only when routing is unavailable.
        const roadPath = route?.encodedPolyline ? decodePolyline(route.encodedPolyline) : null;
        const isRealRoute = Boolean(roadPath && roadPath.length > 1);
        const linePath = isRealRoute ? roadPath! : path;
        const extraPins = [
          ...markers.map((marker) => ({ lat: marker.lat, lng: marker.lon })),
          ...(destination ? [{ lat: destination.lat, lng: destination.lon }] : []),
        ];
        const map = new MapCtor(mapElement, {
          center: path[0] ?? extraPins[0],
          mapTypeControl: false,
          streetViewControl: false,
          zoom: 12,
        });

        if (MarkerCtor) {
          points.forEach((point, index) => {
            markersRef.current.push(new MarkerCtor({
              label: String(index + 1),
              map,
              position: { lat: point.lat, lng: point.lon },
              title: `${index + 1}. ${point.contactName ?? point.address ?? "Check-in"} (${formatTime(point.checkDate)})`,
            }));
          });
          // Photo and stop pins: the same pin, its letter in the house orange so it reads apart from
          // the numbered check-ins at a glance.
          markers.forEach((marker) => {
            markersRef.current.push(new MarkerCtor({
              label: { color: "#9a3412", fontWeight: "900", text: marker.label },
              map,
              position: { lat: marker.lat, lng: marker.lon },
              title: marker.title,
            }));
          });
          if (destination) {
            markersRef.current.push(new MarkerCtor({
              icon: googleMaps.SymbolPath
                ? {
                    fillOpacity: 0,
                    path: googleMaps.SymbolPath.CIRCLE,
                    scale: 11,
                    strokeColor: "#0f172a",
                    strokeWeight: 3,
                  }
                : undefined,
              map,
              position: { lat: destination.lat, lng: destination.lon },
              title: destination.title,
              zIndex: 0,
            }));
          }
        }

        if (PolylineCtor && linePath.length > 1) {
          polylinesRef.current.push(new PolylineCtor({
            map,
            path: linePath,
            strokeColor: isRealRoute ? "#f97316" : "#94a3b8",
            strokeOpacity: isRealRoute ? 0.9 : 0.5,
            strokeWeight: isRealRoute ? 4 : 3,
          }));
        }

        const bounds = LatLngBoundsCtor ? new LatLngBoundsCtor() : null;
        linePath.forEach((point) => bounds?.extend(point));
        path.forEach((point) => bounds?.extend(point));
        extraPins.forEach((point) => bounds?.extend(point));
        if (bounds && linePath.length + path.length + extraPins.length > 1) map.fitBounds(bounds, 64);
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Google Maps could not render the route.");
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [destination, googleMaps, markers, pinCount, points, ready, route]);

  if (frame === "bare") {
    // The box alone. Square, like everything on the admin shell; the words around it are the
    // caller's. `overflow-hidden` is load-bearing: Google Maps draws absolutely-positioned internals
    // wider than their box, which pushed a 375px page sideways.
    return (
      <div className="min-w-0 overflow-hidden">
        {!browserKey ? (
          <p className="border border-slate-200 bg-slate-50 px-3 py-3 text-xs font-semibold text-slate-500">
            Route map unavailable: the Google Maps browser key is missing from the environment.
          </p>
        ) : pinCount === 0 ? (
          <p className="border border-slate-200 bg-slate-50 px-3 py-3 text-xs font-semibold text-slate-500">{copy.empty}</p>
        ) : (
          <>
            <div className="h-[360px] border border-slate-200 bg-slate-50 sm:h-[420px]" ref={mapRef} />
            {!ready ? <p className="mt-1 text-xs text-slate-500">Loading Google Maps&hellip;</p> : null}
            {error ? <p className="mt-1 text-xs text-amber-700">{error}</p> : null}
          </>
        )}
      </div>
    );
  }

  if (!browserKey) {
    return (
      <Card className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <p className="text-sm font-bold text-slate-800">Route map unavailable</p>
        <p className="mt-1 text-phx-md text-slate-500">NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY is missing from the environment.</p>
      </Card>
    );
  }

  return (
    <Card className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="mb-3">
        <span className="rounded-md bg-orange-50 px-2 py-1 text-phx-2xs font-bold uppercase tracking-wider text-orange-600">Field route</span>
        <h2 className="mt-2 text-base font-black text-slate-900 sm:text-lg">{copy.title}</h2>
        <p className="mt-1 text-phx-md leading-relaxed text-slate-500">
          {copy.description}
        </p>
        {hasRoute && (totalKm != null || totalMin != null) ? (
          <p className="mt-2 inline-flex items-center gap-2 rounded-md border border-orange-200 bg-orange-50 px-2.5 py-1 text-xs font-bold text-orange-700">
            Total driving route: {totalKm != null ? `${totalKm} km` : "—"}{totalMin != null ? ` · ${totalMin} min` : ""}
          </p>
        ) : null}
      </div>
      {points.length === 0 ? (
        <div className="rounded-md border border-slate-100 bg-slate-50/60 px-3 py-3 text-phx-md text-slate-600">
          {copy.empty}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="h-[360px] rounded-md border border-slate-100 bg-slate-50 sm:h-[420px]" ref={mapRef} />
          {!ready ? <p className="text-phx-md text-slate-500">Loading Google Maps&hellip;</p> : null}
          {error ? <p className="text-phx-md text-amber-700">{error}</p> : null}
          {/*
            This line used to read "once the Maps key is allowed to use the Routes API", which named
            a cause that is not the cause. `route` is a PROP: Field Activity passes `null` for it
            unconditionally and never asks for legs at all, so the message appeared on every day of
            that report and accused a key that answers the Routes API with 200 (measured against the
            production server key, 2026-10-06). Misdiagnosing in the UI is worse than saying less —
            it sends the reader to the wrong setting.
          */}
          {!hasRoute && points.length > 1 ? (
            <p className="text-phx-md text-slate-500">
              Driving distance and time between stops are not available for this day.
            </p>
          ) : null}
          <ol className="space-y-1">
            {points.map((point, index) => {
              const leg = index > 0 ? legLabel(legs[index - 1]) : null;
              return (
                <li key={point.id}>
                  {index > 0 && leg ? (
                    <div className="flex items-center gap-2 py-1 pl-3 text-xs font-semibold text-slate-600">
                      <span className="text-orange-500" aria-hidden>&darr;</span>
                      <span>{leg}</span>
                    </div>
                  ) : null}
                  <div className="flex items-start gap-3 rounded-md border border-slate-100 bg-white px-3 py-2 text-sm">
                    <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-orange-500 text-xs font-black text-white">{index + 1}</span>
                    <div className="min-w-0 flex-1">
                      <p className="font-bold text-slate-900">{point.contactName ?? point.address ?? "Check-in"}</p>
                      {/* Wraps, never ellipsises. A GPS check-in address is the one line that says
                          WHERE the rep stood, and the owner's no-truncation rule outranks the tidy
                          single line — the parent is already `min-w-0 flex-1`, so wrapping costs no
                          horizontal scroll at 375px. */}
                      {point.address && point.contactName ? <p className="break-words text-xs text-slate-500">{point.address}</p> : null}
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="font-semibold text-slate-900">{formatTime(point.checkDate)}</p>
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </Card>
  );
}
