"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { Card } from "@/components/ui/card";
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
  id: number;
  lat: number | null;
  lon: number | null;
};

export type RouteLeg = {
  distanceKm: number | null;
  durationMinutes: number | null;
};

export type DayRoute = {
  encodedPolyline: string | null;
  legs: RouteLeg[];
};

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

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  // check_date is a zone-less Cairo wall-clock stored as +00 — render as-is with timeZone "UTC".
  // Without it this client component uses the browser zone (Cairo) and shows stop times 2–3h late.
  return new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(date);
}

/**
 * Plots a rep's GPS check-ins for one day as a numbered route: markers in time order with
 * each stop's check-in time, and the Google driving distance + drive-time between stops
 * (when available). Read-only; reuses the same Google Maps browser loader as the outstation map.
 */
export function FieldWorkforceRouteMap({ checkins, route }: { checkins: RouteCheckin[]; route?: DayRoute | null }) {
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

  useEffect(() => {
    if (!browserKey || points.length === 0) return;
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
  }, [browserKey, points.length]);

  useEffect(() => {
    const mapElement = mapRef.current;
    if (!ready || !mapElement || !googleMaps || points.length === 0) return;
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
        const map = new MapCtor(mapElement, {
          center: path[0],
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
        if (bounds && (linePath.length > 1 || path.length > 1)) map.fitBounds(bounds, 64);
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Google Maps could not render the route.");
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [googleMaps, points, ready, route]);

  if (!browserKey) {
    return (
      <Card className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <p className="text-sm font-bold text-slate-800">Route map unavailable</p>
        <p className="mt-1 text-[13px] text-slate-500">NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY is missing from the environment.</p>
      </Card>
    );
  }

  return (
    <Card className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="mb-3">
        <span className="rounded-md bg-orange-50 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-orange-600">Field route</span>
        <h2 className="mt-2 text-base font-black text-slate-900 sm:text-lg">GPS check-in route for this day</h2>
        <p className="mt-1 text-[13px] leading-relaxed text-slate-500">
          Each stop is numbered in the order the rep checked in, with its check-in time. Distance and drive time between stops come from the Google Maps driving route.
        </p>
        {hasRoute && (totalKm != null || totalMin != null) ? (
          <p className="mt-2 inline-flex items-center gap-2 rounded-md border border-orange-200 bg-orange-50 px-2.5 py-1 text-xs font-bold text-orange-700">
            Total driving route: {totalKm != null ? `${totalKm} km` : "—"}{totalMin != null ? ` · ${totalMin} min` : ""}
          </p>
        ) : null}
      </div>
      {points.length === 0 ? (
        <div className="rounded-md border border-slate-100 bg-slate-50/60 px-3 py-3 text-[13px] text-slate-600">
          No GPS check-ins with coordinates were recorded for this rep on this day.
        </div>
      ) : (
        <div className="space-y-3">
          <div className="h-[360px] rounded-md border border-slate-100 bg-slate-50 sm:h-[420px]" ref={mapRef} />
          {!ready ? <p className="text-[13px] text-slate-500">Loading Google Maps&hellip;</p> : null}
          {error ? <p className="text-[13px] text-amber-700">{error}</p> : null}
          {!hasRoute && points.length > 1 ? (
            <p className="text-[13px] text-slate-500">
              Driving distance and time between stops will appear here once the Maps key is allowed to use the Routes API.
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
                      {point.address && point.contactName ? <p className="truncate text-xs text-slate-500">{point.address}</p> : null}
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
