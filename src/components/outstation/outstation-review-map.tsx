"use client";

import { useEffect, useRef, useState } from "react";

import { Card } from "@/components/ui/card";
import {
  importGoogleLibrary,
  loadGoogleMaps,
  type GoogleMapsApi,
  type GoogleMarkerHandle,
  type GooglePolylineHandle,
} from "@/lib/google-maps/browser";
import { isUnresolvedResidenceCoordinate } from "@/lib/outstation/distance-failure";
import { buildReviewMapOptions, hasConfiguredMapId } from "@/lib/outstation/review-map-options";
import type { OutstationExpenseRequest, OutstationRouteAlternative } from "@/lib/outstation/types";

type GoogleMapsNamespace = GoogleMapsApi;

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

    points.push({
      lat: lat / 1e5,
      lng: lng / 1e5,
    });
  }

  return points;
}

/**
 * 🔴 `!= null` IS NOT ENOUGH, and the map proved it on production 2026-09-28: a request whose
 * residence coordinate was (0, 0) plotted one pin in Egypt and one in the Gulf of Guinea, under a
 * confident "FASTEST DISTANCE 209.62 KM". It is the same trap as everywhere else in this module —
 * `Number(null)` is 0 and `Number.isFinite(0)` is true — so a placeholder passes every null check
 * and is then RENDERED AS A PLACE.
 *
 * A map that draws a false origin is worse than no map at all: the number beside it looks
 * measured, so a reviewer has no reason to doubt either. Refuse to plot an unresolved origin —
 * the Egypt centroid and null island alike — and the panel simply does not render.
 */
function coordinatesReady(request: OutstationExpenseRequest | null) {
  return Boolean(
    request &&
      request.residenceLatitude != null &&
      request.residenceLongitude != null &&
      !isUnresolvedResidenceCoordinate(request.residenceLatitude, request.residenceLongitude) &&
      Number.isFinite(request.capturedLatitude) &&
      Number.isFinite(request.capturedLongitude),
  );
}

function formatMinutes(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "N/A";
  return `${Math.round(value)} mins`;
}

function formatDistance(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "N/A";
  return `${value.toFixed(2)} KM`;
}

function selectedRouteForSummary(request: OutstationExpenseRequest | null) {
  return request?.routeAlternatives?.find((route) => route.isSelected) ?? null;
}

function routesForMap(request: OutstationExpenseRequest): OutstationRouteAlternative[] {
  const alternatives = request.routeAlternatives?.filter((route) => route.encodedPolyline) ?? [];
  if (alternatives.length > 0) return alternatives;

  return request.routePolyline
    ? [{
        distanceKm: request.distanceFromResidenceKm,
        durationInTrafficMinutes: null,
        durationMinutes: request.durationMinutes,
        encodedPolyline: request.routePolyline,
        index: 0,
        isSelected: true,
        summary: null,
      }]
    : [];
}

export function OutstationReviewMap({
  request,
}: {
  request: OutstationExpenseRequest | null;
}) {
  const browserKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY ?? "";
  const mapId = process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID ?? "";
  const mapRef = useRef<HTMLDivElement | null>(null);
  const markersRef = useRef<GoogleMarkerHandle[]>([]);
  const polylinesRef = useRef<GooglePolylineHandle[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [googleMaps, setGoogleMaps] = useState<GoogleMapsNamespace | null>(null);
  const selectedRoute = selectedRouteForSummary(request);
  const routeCount = request?.routeAlternatives?.length ?? (request?.routePolyline ? 1 : 0);

  useEffect(() => {
    if (!browserKey || !coordinatesReady(request)) {
      return;
    }

    let cancelled = false;

    void loadGoogleMaps(browserKey)
      .then((maps) => {
        if (cancelled) return;
        setGoogleMaps(maps as GoogleMapsNamespace);
        setReady(true);
      })
      .catch(() => {
        if (cancelled) return;
        setError("Google Maps failed to load. Check browser key referrer restrictions.");
      });

    return () => {
      cancelled = true;
    };
  }, [browserKey, request]);

  useEffect(() => {
    if (!request) {
      return;
    }

    const mapElement = mapRef.current;

    if (
      !ready ||
      !mapElement ||
      request.residenceLatitude == null ||
      request.residenceLongitude == null ||
      // Second gate, same reason as coordinatesReady above: never plot a placeholder as a place.
      isUnresolvedResidenceCoordinate(request.residenceLatitude, request.residenceLongitude) ||
      !Number.isFinite(request.capturedLatitude) ||
      !Number.isFinite(request.capturedLongitude) ||
      !googleMaps
    ) {
      return;
    }

    let cancelled = false;
    const currentRequest = request;

    const run = async () => {
      try {
        const coreLibrary = await importGoogleLibrary(googleMaps, "core", {
          LatLngBounds: googleMaps.LatLngBounds,
        });
        const mapsLibrary = await importGoogleLibrary(googleMaps, "maps", {
          Map: googleMaps.Map,
          Polyline: googleMaps.Polyline,
        });
        const markerLibrary = await importGoogleLibrary(googleMaps, "marker", {
          AdvancedMarkerElement: googleMaps.marker?.AdvancedMarkerElement,
          Marker: googleMaps.Marker,
        });
        if (cancelled) return;

        const MapCtor = mapsLibrary?.Map as GoogleMapsNamespace["Map"];
        const useAdvancedMarkers = hasConfiguredMapId(mapId);
        const MarkerCtor = useAdvancedMarkers
          ? markerLibrary?.AdvancedMarkerElement as GoogleMapsNamespace["Marker"] ?? googleMaps.marker?.AdvancedMarkerElement
          : markerLibrary?.Marker as GoogleMapsNamespace["Marker"] ?? googleMaps.Marker;
        const LatLngBoundsCtor =
          coreLibrary?.LatLngBounds as GoogleMapsNamespace["LatLngBounds"] ??
          googleMaps.LatLngBounds;
        const PolylineCtor =
          mapsLibrary?.Polyline as GoogleMapsNamespace["Polyline"] ??
          googleMaps.Polyline;

        if (!MapCtor) {
          setError("Google Maps loaded, but the map renderer is unavailable. Refresh the page and retry.");
          return;
        }

        markersRef.current.forEach((marker) => {
          if (typeof marker.setMap === "function") {
            marker.setMap(null);
          } else if ("map" in marker) {
            marker.map = null;
          }
        });
        markersRef.current = [];
        polylinesRef.current.forEach((polyline) => polyline.setMap?.(null));
        polylinesRef.current = [];

        const map = new MapCtor(
          mapElement,
          buildReviewMapOptions({
            center: {
              lat: (currentRequest.residenceLatitude! + currentRequest.capturedLatitude) / 2,
              lng: (currentRequest.residenceLongitude! + currentRequest.capturedLongitude) / 2,
            },
            mapId,
            zoom: 8,
          }),
        );

        if (MarkerCtor) {
          const residenceMarker = new MarkerCtor({
            map,
            position: { lat: currentRequest.residenceLatitude!, lng: currentRequest.residenceLongitude! },
            title: "Registered residence",
          });
          const capturedMarker = new MarkerCtor({
            map,
            position: { lat: currentRequest.capturedLatitude, lng: currentRequest.capturedLongitude },
            title: "Captured location",
          });
          markersRef.current.push(residenceMarker, capturedMarker);
        }

        const bounds = LatLngBoundsCtor ? new LatLngBoundsCtor() : null;
        bounds?.extend({ lat: currentRequest.residenceLatitude!, lng: currentRequest.residenceLongitude! });
        bounds?.extend({ lat: currentRequest.capturedLatitude, lng: currentRequest.capturedLongitude });
        if (bounds) {
          map.fitBounds(bounds, 72);
        }

        const routes = routesForMap(currentRequest);
        if (routes.length === 0) {
          setError("Google Maps did not return a real driving route for this trip yet.");
          return;
        }

        routes.forEach((route) => {
          if (!route.encodedPolyline) return;
          decodePolyline(route.encodedPolyline).forEach((point) => bounds?.extend(point));
        });
        if (bounds) {
          map.fitBounds(bounds, 72);
        }

        if (!PolylineCtor) {
          setError(null);
          return;
        }

        routes
          .filter((route) => !route.isSelected)
          .forEach((route) => {
            if (!route.encodedPolyline) return;
            polylinesRef.current.push(new PolylineCtor({
              map,
              path: decodePolyline(route.encodedPolyline),
              strokeColor: "#94a3b8",
              strokeOpacity: 0.45,
              strokeWeight: 4,
              zIndex: 10,
            }));
          });

        routes
          .filter((route) => route.isSelected)
          .forEach((route) => {
            if (!route.encodedPolyline) return;
            polylinesRef.current.push(new PolylineCtor({
              map,
              path: decodePolyline(route.encodedPolyline),
              strokeColor:
                currentRequest.approvalRecommendation === "reject"
                  ? "#dc2626"
                  : currentRequest.eligibilityStatus === "not_eligible"
                    ? "#f59e0b"
                    : "#f97316",
              strokeOpacity: 0.95,
              strokeWeight: 6,
              zIndex: 20,
            }));
        });
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Google Maps could not render this route.");
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [googleMaps, mapId, ready, request]);

  if (!browserKey) {
    return (
      <Card className="rounded-lg border border-gray-100 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.06)] sm:p-5">
        <p className="text-sm font-semibold text-slate-800">Map unavailable</p>
        <p className="mt-1 text-phx-md text-slate-500">
          NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY is missing from the environment.
        </p>
      </Card>
    );
  }

  return (
    <Card className="rounded-lg border border-gray-100 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.06)] sm:p-5">
      <div className="mb-4">
        <span className="rounded-md bg-orange-50 px-2 py-1 text-phx-sm font-bold uppercase tracking-wider text-orange-600">
          Route review
        </span>
        <h2 className="mt-2 text-base font-bold text-slate-800 sm:text-lg">
          Residence versus captured destination
        </h2>
        <p className="mt-1 text-phx-md leading-relaxed text-slate-500">
          Calculation is based on the fastest available route. Alternative routes are shown for reference only.
        </p>
      </div>

      {coordinatesReady(request) ? (
        <div className="space-y-3">
          {request ? (
            <div className="grid grid-cols-1 divide-x divide-y divide-gray-100 overflow-hidden rounded-md border border-gray-100 text-sm sm:grid-cols-3">
              <div className="border-l-2 border-l-emerald-400 px-3 py-3">
                <p className="text-phx-sm font-semibold uppercase tracking-wider text-slate-500">
                  Fastest time
                </p>
                <p className="mt-1 text-phx-md font-semibold text-slate-800">
                  {formatMinutes(
                    selectedRoute?.durationInTrafficMinutes ??
                      selectedRoute?.durationMinutes ??
                      request.durationMinutes,
                  )}
                </p>
              </div>
              <div className="border-l-2 border-l-sky-400 px-3 py-3">
                <p className="text-phx-sm font-semibold uppercase tracking-wider text-slate-500">
                  Fastest distance
                </p>
                <p className="mt-1 text-phx-md font-semibold text-slate-800">
                  {formatDistance(selectedRoute?.distanceKm ?? request.distanceFromResidenceKm)}
                </p>
              </div>
              <div className="border-l-2 border-l-amber-400 px-3 py-3">
                <p className="text-phx-sm font-semibold uppercase tracking-wider text-slate-500">
                  Routes found
                </p>
                <p className="mt-1 text-phx-md font-semibold text-slate-800">
                  {routeCount.toLocaleString()}
                </p>
              </div>
            </div>
          ) : null}
          <div
            className="h-[360px] rounded-md border border-gray-100 bg-slate-50 sm:h-[420px]"
            ref={mapRef}
          />
          {!ready ? (
            <p className="text-phx-md text-slate-500">Loading Google Maps...</p>
          ) : null}
          {error ? <p className="text-phx-md text-amber-700">{error}</p> : null}
        </div>
      ) : (
        <div className="rounded-md border border-gray-100 bg-slate-50/60 px-3 py-3 text-phx-md text-slate-600">
          Select a request with both residence and captured coordinates to review the route on the map.
        </div>
      )}
    </Card>
  );
}
