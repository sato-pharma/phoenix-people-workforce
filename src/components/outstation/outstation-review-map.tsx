"use client";

import Script from "next/script";
import { useEffect, useRef, useState } from "react";

import { Card } from "@/components/ui/card";
import type { OutstationExpenseRequest } from "@/lib/outstation/types";

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
  const markersRef = useRef<any[]>([]);
  const polylineRef = useRef<any>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shouldLoadScript, setShouldLoadScript] = useState(false);

  useEffect(() => {
    if ((window as { google?: { maps?: any } }).google?.maps) {
      setReady(true);
      setShouldLoadScript(false);
      return;
    }

    const existingGoogleMapsScript = document.querySelector<HTMLScriptElement>(
      'script[src*="maps.googleapis.com/maps/api/js"]',
    );

    if (existingGoogleMapsScript) {
      const handleExistingLoad = () => setReady(true);
      existingGoogleMapsScript.addEventListener("load", handleExistingLoad, { once: true });
      setShouldLoadScript(false);
      return () => existingGoogleMapsScript.removeEventListener("load", handleExistingLoad);
    }

    setShouldLoadScript(true);
  }, []);

  useEffect(() => {
    if (!request) {
      return;
    }

    const googleMaps = (window as { google?: { maps?: any } }).google?.maps;
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
        const mapsLibrary: any = googleMaps.importLibrary
          ? await googleMaps.importLibrary("maps")
          : { Map: googleMaps.Map };
        const markerLibrary: any = googleMaps.importLibrary
          ? await googleMaps.importLibrary("marker")
          : { Marker: googleMaps.Marker };
        if (cancelled) return;

        const MapCtor = mapsLibrary?.Map;
        const useAdvancedMarkers = Boolean(mapId.trim().length > 0);
        const MarkerCtor = useAdvancedMarkers
          ? markerLibrary?.AdvancedMarkerElement ?? googleMaps.marker?.AdvancedMarkerElement
          : markerLibrary?.Marker ?? googleMaps.Marker;
        const LatLngBoundsCtor = googleMaps.LatLngBounds;
        const PolylineCtor = googleMaps.Polyline;

        if (!MapCtor || !MarkerCtor || !LatLngBoundsCtor || !PolylineCtor) {
          setError("Google Maps libraries are missing required constructors.");
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
            lat: currentRequest.residenceLatitude!,
            lng: currentRequest.residenceLongitude!,
          },
          ...(useAdvancedMarkers ? { mapId } : {}),
          mapTypeControl: false,
          streetViewControl: false,
          zoom: 8,
        });

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

        const bounds = new LatLngBoundsCtor();
        bounds.extend({ lat: currentRequest.residenceLatitude!, lng: currentRequest.residenceLongitude! });
        bounds.extend({ lat: currentRequest.capturedLatitude, lng: currentRequest.capturedLongitude });
        map.fitBounds(bounds, 72);

        if (!currentRequest.routePolyline || currentRequest.routePolyline.trim().length === 0) {
          setError("Google Maps did not return a real driving route for this trip yet.");
          return;
        }

        const path = decodePolyline(currentRequest.routePolyline);
        path.forEach((point) => bounds.extend(point));
        map.fitBounds(bounds, 72);

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
  }, [mapId, ready, request]);

  if (!browserKey) {
    return (
      <Card className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_18px_40px_rgba(15,23,42,0.06)]">
        <p className="text-sm font-semibold text-slate-900">Map unavailable</p>
        <p className="mt-2 text-sm text-slate-500">
          NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY is missing from the environment.
        </p>
      </Card>
    );
  }

  return (
    <Card className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_18px_40px_rgba(15,23,42,0.06)]">
      {shouldLoadScript ? (
        <Script
          id="phoenix-google-maps-js"
          onError={() => setError("Google Maps failed to load. Check browser key referrer restrictions.")}
          onLoad={() => setReady(true)}
          onReady={() => setReady(true)}
          src={`https://maps.googleapis.com/maps/api/js?key=${browserKey}&v=weekly&libraries=marker&loading=async`}
          strategy="afterInteractive"
        />
      ) : null}

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
          <div className="h-[420px] rounded-3xl border border-slate-200 bg-slate-50" ref={mapRef} />
          {!ready ? <p className="text-sm text-slate-500">Loading Google Maps...</p> : null}
          {error ? <p className="text-sm text-amber-700">{error}</p> : null}
        </div>
      ) : (
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-6 text-sm text-slate-600">
          Select a request with both residence and captured coordinates to review the route on the map.
        </div>
      )}
    </Card>
  );
}
