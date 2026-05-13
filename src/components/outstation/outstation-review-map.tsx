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
import type { OutstationExpenseRequest } from "@/lib/outstation/types";

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

function coordinatesReady(request: OutstationExpenseRequest | null) {
  return Boolean(
    request &&
      request.residenceLatitude != null &&
      request.residenceLongitude != null &&
      Number.isFinite(request.capturedLatitude) &&
      Number.isFinite(request.capturedLongitude),
  );
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
  const polylineRef = useRef<GooglePolylineHandle | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [googleMaps, setGoogleMaps] = useState<GoogleMapsNamespace | null>(null);

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
        const useAdvancedMarkers = Boolean(mapId.trim().length > 0);
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
        if (typeof polylineRef.current?.setMap === "function") {
          polylineRef.current.setMap(null);
        }
        polylineRef.current = null;

        const map = new MapCtor(mapElement, {
          center: {
            lat: (currentRequest.residenceLatitude! + currentRequest.capturedLatitude) / 2,
            lng: (currentRequest.residenceLongitude! + currentRequest.capturedLongitude) / 2,
          },
          ...(useAdvancedMarkers ? { mapId } : {}),
          mapTypeControl: false,
          streetViewControl: false,
          zoom: 8,
        });

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

        if (!currentRequest.routePolyline || currentRequest.routePolyline.trim().length === 0) {
          setError("Google Maps did not return a real driving route for this trip yet.");
          return;
        }

        const path = decodePolyline(currentRequest.routePolyline);
        path.forEach((point) => bounds?.extend(point));
        if (bounds) {
          map.fitBounds(bounds, 72);
        }

        if (!PolylineCtor) {
          setError(null);
          return;
        }

        const polyline = new PolylineCtor({
          map,
          path,
          strokeColor:
            currentRequest.approvalRecommendation === "reject"
              ? "#dc2626"
              : currentRequest.eligibilityStatus === "not_eligible"
                ? "#f59e0b"
                : "#f97316",
          strokeOpacity: 0.9,
          strokeWeight: 5,
        });
        polylineRef.current = polyline;
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
      <Card className="rounded-[28px] border border-[#D8E0EA] bg-white/94 p-6 shadow-[0_18px_46px_rgba(15,23,42,0.08)] backdrop-blur">
        <p className="text-sm font-semibold text-slate-900">Map unavailable</p>
        <p className="mt-2 text-sm text-slate-500">
          NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY is missing from the environment.
        </p>
      </Card>
    );
  }

  return (
    <Card className="rounded-[28px] border border-[#D8E0EA] bg-white/94 p-6 shadow-[0_18px_46px_rgba(15,23,42,0.08)] backdrop-blur">
      <div className="mb-4">
        <p className="text-xs font-black uppercase tracking-[0.16em] text-orange-500">
          Route Review
        </p>
        <h2 className="mt-1 text-xl font-black tracking-[-0.03em] text-slate-950">
          Residence versus captured destination
        </h2>
      </div>

      {coordinatesReady(request) ? (
        <div className="space-y-3">
          <div className="h-[420px] rounded-[28px] border border-[#E2E8F0] bg-[#F8FAFC] shadow-[inset_0_1px_0_rgba(255,255,255,0.75)]" ref={mapRef} />
          {!ready ? <p className="text-sm text-slate-500">Loading Google Maps...</p> : null}
          {error ? <p className="text-sm text-amber-700">{error}</p> : null}
        </div>
      ) : (
        <div className="rounded-[24px] border border-[#E2E8F0] bg-[#F8FAFC] p-6 text-sm text-slate-600">
          Select a request with both residence and captured coordinates to review the route on the map.
        </div>
      )}
    </Card>
  );
}
